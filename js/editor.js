/**
 * Radweg-Editor mit echtem Fahrrad-Routing (FOSSGIS / OSM).
 * Waypoints werden vom Nutzer gesetzt und verschoben; die Linie dazwischen
 * wird automatisch über das Radwegenetz berechnet.
 */
(function () {
  'use strict';

  let D = null, C = null, L = null, map = null;
  let editLayer = null, routePoiLayer = null;
  const U = window.FK_UTIL;

  const S = {
    active: false,
    collapsed: false,
    index: -1,
    coords: [],        // Waypoints: [lng, lat]
    routeCoords: [],   // berechnete Routen-Geometrie: [lng, lat]
    routeMeta: null,   // { distance, duration } aus dem Router
    routeBusy: false,
    routeTimer: null,
    routeAbort: null,
    routeTimeout: null,
    routeSeq: 0,
    fitOnNextRoute: true,
    lastRouteErrorAt: 0,
    start: null,
    end: null,
    color: '#e4572e',
    bikeTypes: [],
    suggestTypes: new Set(),
    pois: [],
    suggestions: [],
    pick: null,
    geoTimers: { start: null, end: null },
    geoSeq: { start: 0, end: 0 },
    line: null,
    visibleLine: null,
    drag: null,          // { index, moved } – Linie wird gezogen
    lastDragEnd: 0,
    vertices: []
  };

  const $ = (id) => document.getElementById(id);
  const esc = U.esc;

  /* ---------- Geometrie ---------- */

  function routeLine() {
    return S.routeCoords.length >= 2 ? S.routeCoords : S.coords;
  }

  // Kürzeste Entfernung (Meter) von einem Punkt zur Polyline, lokal approxymiert
  function distanceToPolyline(p, latlngs) {
    if (latlngs.length < 2) return Infinity;
    const R = 6371000;
    const cosLat = Math.cos(p.lat * Math.PI / 180);
    const toXY = (q) => [
      (q.lng - p.lng) * Math.PI / 180 * R * cosLat,
      (q.lat - p.lat) * Math.PI / 180 * R
    ];
    let best = Infinity;
    for (let i = 0; i < latlngs.length - 1; i++) {
      const [ax, ay] = toXY(latlngs[i]);
      const [bx, by] = toXY(latlngs[i + 1]);
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 ? (-(ax) * dx - (ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < best) best = d;
    }
    return best;
  }

  // Wichtig: identisch zu app.js poiKeyOnly(), sonst sind schon zugeordnete
  // POIs in der Vorschlagsliste nicht mehr als ausgewählt erkennbar.
  function poiKey(f) {
    if (D && D.poiKey) return D.poiKey(f);
    if (f && f.id) return String(f.id);
    const p = (f && f.properties) || {};
    const c = (f && f.geometry && f.geometry.coordinates) || [0, 0];
    return String(p.id || [p.typ, p.name, c[0], c[1]].join(':'));
  }

  function roundCoord(c) {
    return [Math.round(U.num(c[0]) * 1e6) / 1e6, Math.round(U.num(c[1]) * 1e6) / 1e6];
  }

  function requestCoord(c) {
    return U.num(c[0]).toFixed(6) + ',' + U.num(c[1]).toFixed(6);
  }

  function pointLabel(i) {
    if (i === 0 && i === S.coords.length - 1) return 'Start / Ziel';
    if (i === 0) return 'Start';
    if (i === S.coords.length - 1) return 'Ziel';
    return 'Zwischenpunkt';
  }

  /** Nach Ziehen/Löschen passt die alte Adresse nicht mehr zum Punkt. */
  function neutralizeEndpoint(which) {
    const obj = which === 'start' ? S.start : S.end;
    if (!obj || !S.coords.length) return;
    const c = which === 'start' ? S.coords[0] : S.coords[S.coords.length - 1];
    obj.name = which === 'start' ? 'Startpunkt' : 'Zielpunkt';
    obj.lat = c[1];
    obj.lng = c[0];
  }

  /* ---------- Routing ---------- */

  function setRouteControls() {
    const busy = !!S.routeBusy;
    const save = $('ed-save'), suggest = $('ed-suggest');
    if (save) save.disabled = busy;
    if (suggest) suggest.disabled = busy || S.coords.length < 2;
  }

  /** Laufende Routing-Arbeit verwerfen: alte Geometrie darf nie gespeichert werden. */
  function cancelRouteWork() {
    clearTimeout(S.routeTimer);
    S.routeTimer = null;
    S.routeSeq++;
    if (S.routeAbort) { try { S.routeAbort.abort(); } catch (e) {} S.routeAbort = null; }
    clearTimeout(S.routeTimeout);
    S.routeTimeout = null;
    S.routeBusy = false;
    setRouteControls();
  }

  /** Geometrie geändert: veraltete Route und Metriken sofort ungültig machen. */
  function invalidateRoute() {
    cancelRouteWork();
    S.routeCoords = [];
    S.routeMeta = null;
    S.routeBusy = true;
    redrawLine();
    updateTrackInfo();
    setRouteControls();
  }

  function scheduleRoute() {
    invalidateRoute();
    S.routeTimer = setTimeout(computeRoute, C.editor.router.debounceMs);
  }

  function routeErrorToast(msg) {
    const now = Date.now();
    if (now - S.lastRouteErrorAt > 4000) {
      S.lastRouteErrorAt = now;
      D.toast(msg);
    }
  }

  async function computeRoute() {
    clearTimeout(S.routeTimer);
    S.routeTimer = null;
    const seq = ++S.routeSeq;
    if (S.coords.length < 2) {
      S.routeCoords = [];
      S.routeMeta = null;
      S.routeBusy = false;
      redrawLine();
      updateTrackInfo();
      setRouteControls();
      return;
    }

    if (S.routeAbort) { try { S.routeAbort.abort(); } catch (e) {} }
    clearTimeout(S.routeTimeout);
    const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    S.routeAbort = controller;
    let timedOut = false;
    if (controller) {
      S.routeTimeout = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
    }

    const shouldFit = S.fitOnNextRoute;
    S.fitOnNextRoute = false;
    S.routeBusy = true;
    updateTrackInfo();

    try {
      const points = S.coords.map(requestCoord).join(';');
      const url = C.editor.router.url + points + '?' + C.editor.router.options;
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: controller ? controller.signal : undefined
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (seq !== S.routeSeq) return;
      if (json.code !== 'Ok' || !json.routes || !json.routes.length) throw new Error('Keine Route');

      const route = json.routes[0];
      const cs = (route.geometry && route.geometry.coordinates) || [];
      S.routeCoords = cs.map((c) => [U.num(c[0]), U.num(c[1])]);
      S.routeMeta = { distance: route.distance, duration: route.duration };
      redrawLine();
      if (shouldFit && S.routeCoords.length > 1) {
        map.fitBounds(L.latLngBounds(S.routeCoords.map((c) => [c[1], c[0]])), {
          padding: [55, 55], maxZoom: 14
        });
      }
      // Vorschläge immer gegen die fertige Route berechnen, nie gegen die alte Linie.
      if (!$('ed-suggestions').hidden) suggestPois();
    } catch (e) {
      if (seq !== S.routeSeq) return;
      if (e && e.name === 'AbortError' && !timedOut) return; // neuere Anfrage hat abgelöst
      S.routeCoords = S.coords.map((c) => c.slice());
      S.routeMeta = null;
      redrawLine();
      routeErrorToast(timedOut
        ? 'Routing dauert zu lange – gerade Verbindung als Fallback.'
        : 'Routing nicht erreichbar – gerade Verbindung als Fallback.');
    } finally {
      // Nur der aktuelle Request darf seine eigenen Timer aufräumen.
      if (seq === S.routeSeq) {
        if (S.routeAbort === controller) {
          clearTimeout(S.routeTimeout);
          S.routeTimeout = null;
          S.routeAbort = null;
        }
        S.routeBusy = false;
        updateTrackInfo();
        setRouteControls();
      }
    }
  }

  /* ---------- Gespeicherte Route mit POIs neu berechnen ---------- */

  // Position eines Punktes (Meter) entlang der bestehenden Routen-Geometrie.
  function alongDistance(point, latlngs) {
    if (latlngs.length < 2) return 0;
    let acc = 0, bestPos = 0, bestDist = Infinity;
    for (let i = 0; i < latlngs.length - 1; i++) {
      const a = latlngs[i], b = latlngs[i + 1];
      const dx = b.lng - a.lng, dy = b.lat - a.lat;
      const len2 = dx * dx + dy * dy;
      let t = len2 ? ((point.lng - a.lng) * dx + (point.lat - a.lat) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const proj = L.latLng(a.lat + t * dy, a.lng + t * dx);
      const d = map.distance(point, proj);
      if (d < bestDist) { bestDist = d; bestPos = acc + t * map.distance(a, b); }
      acc += map.distance(a, b);
    }
    return bestPos;
  }

  // Basis-Waypoints + alle POIs in ihrer Reihenfolge entlang der Route zusammenführen.
  // Die Basis-Waypoints bleiben unverändert, daher ist das wiederholbar.
  function orderedWaypoints(base, pois, geometry) {
    const coords = (geometry && geometry.coordinates) || [];
    const line = coords.map((c) => L.latLng(c[1], c[0]));
    if (line.length < 2 || !base || base.length < 2) return (base || []).map((c) => c.slice());

    const items = [];
    base.forEach((c, i) => {
      items.push({ c: [c[0], c[1]], pos: alongDistance(L.latLng(c[1], c[0]), line), order: i });
    });
    (pois || []).forEach((p, i) => {
      if (typeof p.lat !== 'number' || typeof p.lng !== 'number') return;
      items.push({ c: [p.lng, p.lat], pos: alongDistance(L.latLng(p.lat, p.lng), line), order: 10000 + i });
    });
    items.sort((a, b) => a.pos - b.pos || a.order - b.order);
    return items.map((x) => x.c);
  }

  // Route einer gespeicherten Tour neu berechnen (z. B. nach POI-Zuordnung).
  // Gibt {coordinates, distance, duration} zurück oder null bei zu wenig Punkten.
  async function rerouteWay(way) {
    if (!C || !way) return null;
    const p = way.properties || {};
    let base = Array.isArray(p.waypoints) && p.waypoints.length >= 2 ? p.waypoints : null;
    const gcs = way.geometry && way.geometry.coordinates;
    if (!base && Array.isArray(gcs) && gcs.length >= 2) base = [gcs[0], gcs[gcs.length - 1]];
    const pts = orderedWaypoints(base, p.pois, way.geometry)
      .map((c) => U.coord(c)).filter(Boolean);
    if (pts.length < 2) return null;

    const points = pts.map(requestCoord).join(';');
    const url = C.editor.router.url + points + '?' + C.editor.router.options;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (json.code !== 'Ok' || !json.routes || !json.routes.length) throw new Error('Keine Route');
    const route = json.routes[0];
    return {
      coordinates: route.geometry.coordinates.map((c) => [c[0], c[1]]),
      distance: route.distance,
      duration: route.duration
    };
  }

  /* ---------- Punkte direkt auf der Route einfügen ---------- */

  function eventLatLng(e) {
    if (e.latlng) return e.latlng;
    const oe = e.originalEvent || e;
    const t = oe.touches && oe.touches[0];
    if (t) return map.mouseEventToLatLng(t);
    if (typeof oe.clientX === 'number') return map.mouseEventToLatLng(oe);
    return null;
  }

  // Fügt einen Punkt an der Stelle ein, an der er entlang der Route liegt
  // (statt ihn einfach hinten anzuhängen).
  function insertWaypointAt(latlng) {
    const line = (S.routeCoords.length >= 2 ? S.routeCoords : S.coords)
      .map((c) => L.latLng(c[1], c[0]));
    let index = S.coords.length;
    if (line.length >= 2 && S.coords.length >= 2) {
      const pos = alongDistance(latlng, line);
      let best = -1, bestPos = -1;
      S.coords.forEach((c, i) => {
        const p = alongDistance(L.latLng(c[1], c[0]), line);
        if (p <= pos && p > bestPos) { bestPos = p; best = i; }
      });
      index = best >= 0 ? best + 1 : 0;
    }
    S.coords.splice(index, 0, [latlng.lng, latlng.lat]);
    return index;
  }

  function onLineDragStart(e) {
    if (!S.active || S.drag) return;
    const ll = eventLatLng(e);
    if (!ll) return;
    if (e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);

    const index = insertWaypointAt(ll);
    S.drag = { index: index, moved: false };
    map.dragging.disable();
    map.getContainer().classList.add('route-dragging');
    map.getContainer().style.cursor = 'grabbing';
    S.routeCoords = []; // während des Ziehens gerade Verbindung anzeigen
    S.routeMeta = null;
    draw();

    // Auf document, damit das Loslassen auch außerhalb der Karte ankommt
    L.DomEvent.on(document, 'mousemove touchmove', onLineDragMove);
    L.DomEvent.on(document, 'mouseup touchend touchcancel', onLineDragEnd);
  }

  function onLineDragMove(e) {
    if (!S.drag) return;
    const ll = eventLatLng(e);
    if (!ll) return;
    if (e.type === 'touchmove') L.DomEvent.preventDefault(e);
    else if (e.originalEvent && e.originalEvent.type === 'touchmove') {
      L.DomEvent.preventDefault(e.originalEvent);
    }
    S.coords[S.drag.index] = [ll.lng, ll.lat];
    S.drag.moved = true;
    redrawLine();
    drawVertices();
  }

  function onLineDragEnd() {
    L.DomEvent.off(document, 'mousemove touchmove', onLineDragMove);
    L.DomEvent.off(document, 'mouseup touchend touchcancel', onLineDragEnd);
    map.dragging.enable();
    map.getContainer().classList.remove('route-dragging');
    map.getContainer().style.cursor = '';
    S.lastDragEnd = Date.now();
    if (!S.drag) return;

    const i = S.drag.index;
    const moved = S.drag.moved;
    S.drag = null;
    if (i === 0) neutralizeEndpoint('start');
    if (i === S.coords.length - 1) neutralizeEndpoint('end');
    renderPointList();
    scheduleRoute();
    D.toast(moved
      ? 'Punkt verschoben – Route wird neu berechnet.'
      : 'Punkt zur Route hinzugefügt – Route wird neu berechnet.');
  }

  /* ---------- Zeichnen ---------- */

  function redrawLine() {
    if (S.line) { editLayer.removeLayer(S.line); S.line = null; }
    if (S.visibleLine) { editLayer.removeLayer(S.visibleLine); S.visibleLine = null; }
    const pts = routeLine();
    if (pts.length < 2) return;
    const latlngs = pts.map((c) => [c[1], c[0]]);

    // Unsichtbare, dicke Linie als Grifffläche (auch für Finger)
    S.line = L.polyline(latlngs, {
      color: '#2d7ff9', weight: 22, opacity: 0.001,
      lineCap: 'round', lineJoin: 'round', className: 'route-drag-line'
    }).addTo(editLayer);
    S.line.on('mousedown touchstart', onLineDragStart);
    // Bei Canvas-Rendering gibt es kein SVG-Element für den Cursor
    S.line.on('mouseover', () => {
      if (!S.drag && !S.pick) map.getContainer().style.cursor = 'grab';
    });
    S.line.on('mouseout', () => {
      if (!S.drag && !S.pick) map.getContainer().style.cursor = '';
    });

    S.visibleLine = L.polyline(latlngs, {
      color: S.color || '#2d7ff9', weight: 6, opacity: 0.9,
      lineCap: 'round', lineJoin: 'round', interactive: false
    }).addTo(editLayer);
  }

  function drawVertices() {
    S.vertices.forEach((m) => editLayer.removeLayer(m));
    S.vertices = [];
    S.coords.forEach((c, i) => {
      const isFirst = i === 0;
      const isLast = i === S.coords.length - 1;
      const m = L.marker([c[1], c[0]], {
        draggable: true,
        zIndexOffset: 1000,
        icon: L.divIcon({
          className: 'vertex-icon' + (isFirst ? ' first' : (isLast ? ' last' : '')),
          html: '<span>' + (i + 1) + '</span>',
          iconSize: [22, 22], iconAnchor: [11, 11]
        })
      }).addTo(editLayer);

      m.on('drag', () => {
        const p = m.getLatLng();
        S.coords[i] = [p.lng, p.lat];
      });
      m.on('dragend', () => {
        if (i === 0) neutralizeEndpoint('start');
        if (i === S.coords.length - 1) neutralizeEndpoint('end');
        S.routeCoords = [];
        S.routeMeta = null;
        renderPointList();
        scheduleRoute();
      });
      m.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        if (S.coords.length <= 2) { D.toast('Mindestens Start und Ziel sind nötig.'); return; }
        S.coords.splice(i, 1);
        if (i === 0) neutralizeEndpoint('start');
        if (i === S.coords.length) neutralizeEndpoint('end');
        S.routeCoords = [];
        S.routeMeta = null;
        draw();
        scheduleRoute();
        D.toast('Zwischenpunkt entfernt – Route wird neu berechnet.');
      });
      S.vertices.push(m);
    });
  }

  function drawRoutePois() {
    routePoiLayer.clearLayers();
    S.pois.forEach((p) => {
      const g = C.poiGroups.find((x) => x.id === p.typ);
      const m = L.marker([p.lat, p.lng], {
        icon: L.divIcon({
          className: 'route-poi-icon',
          html: '<span>' + (g ? g.icon : '📍') + '</span>',
          iconSize: [22, 22], iconAnchor: [11, 11]
        })
      }).addTo(routePoiLayer);
      m.bindPopup('<div class="popup-title">' + (g ? g.icon + ' ' : '') + esc(p.name) + '</div>' +
        '<div class="popup-meta">' + esc(g ? g.label : (p.typ || 'POI')) +
        (p.dist ? '<br>' + U.num(p.dist) + ' m ab Route' : '') + '</div>');
    });
  }

  function updateCompactInfo() {
    const km = S.routeMeta ? U.fmtKm(S.routeMeta.distance) : '';
    $('editor-compact').textContent = S.coords.length + ' Punkte' + (km ? ' · ' + km : '');
  }

  function updateTrackInfo() {
    if (S.collapsed) updateCompactInfo();
    const el = $('ed-track-info');
    if (S.routeBusy) {
      el.textContent = 'Route wird über das Radwegenetz berechnet …';
      return;
    }
    if (S.coords.length < 2) {
      el.textContent = 'Start und Ziel setzen – die Route wird dann automatisch berechnet.';
      return;
    }
    let text = S.coords.length + (S.coords.length === 2 ? ' Punkte' : ' Punkte (inkl. Zwischenstops)') + ' · ';
    if (S.routeMeta) {
      const min = Math.round(U.num(S.routeMeta.duration) / 60);
      text += esc(U.fmtKm(S.routeMeta.distance)) + ' · ca. ' + min + ' min mit dem Rad';
    } else {
      let air = 0;
      for (let i = 0; i < S.coords.length - 1; i++) {
        air += map.distance([S.coords[i][1], S.coords[i][0]], [S.coords[i + 1][1], S.coords[i + 1][0]]);
      }
      text += U.fmtKm(air) + ' Luftlinie';
    }
    el.textContent = text;
    setRouteControls();
  }

  function updateEndpointLabels() {
    const set = (id, label, val) => {
      const el = $(id);
      el.textContent = val ? val.name : label;
      el.className = val ? 'set' : 'muted';
    };
    set('ed-start-label', 'Noch nicht gesetzt', S.start);
    set('ed-end-label', 'Noch nicht gesetzt', S.end);
  }

  /* ---------- Reihenfolge der Punkte ---------- */

  function renderPointList() {
    const box = $('ed-point-list');
    if (!box) return;
    box.innerHTML = '';

    if (!S.coords.length) {
      box.innerHTML = '<div class="point-empty">Noch keine Punkte gesetzt.</div>';
      return;
    }

    S.coords.forEach((c, i) => {
      const isFirst = i === 0;
      const isLast = i === S.coords.length - 1;
      const row = document.createElement('div');
      row.className = 'point-row';

      const nr = document.createElement('span');
      nr.className = 'point-nr';
      nr.textContent = String(i + 1);

      const txt = document.createElement('span');
      txt.className = 'ptxt';
      txt.textContent = pointLabel(i);

      const coord = document.createElement('span');
      coord.className = 'pcoord';
      coord.textContent = U.fmtCoord(c);

      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'mv-btn';
      up.textContent = '▲';
      up.title = 'Punkt ' + (i + 1) + ' nach oben verschieben';
      up.setAttribute('aria-label', up.title);
      up.disabled = isFirst;
      up.addEventListener('click', () => movePoint(i, -1));

      const down = document.createElement('button');
      down.type = 'button';
      down.className = 'mv-btn';
      down.textContent = '▼';
      down.title = 'Punkt ' + (i + 1) + ' nach unten verschieben';
      down.setAttribute('aria-label', down.title);
      down.disabled = isLast;
      down.addEventListener('click', () => movePoint(i, 1));

      row.appendChild(nr);
      row.appendChild(txt);
      row.appendChild(coord);
      row.appendChild(up);
      row.appendChild(down);
      box.appendChild(row);
    });
  }

  function sameCoord(a, b) {
    return !!a && !!b && Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  }

  // Start/Ziel gehören zur Position: wenn ein anderer Punkt erster/letzter wird,
  // bekommt er einen neutralen Namen statt der alten Adresse.
  function syncEndpoints(oldFirst, oldLast) {
    const first = S.coords[0];
    const last = S.coords[S.coords.length - 1];
    if (!first || !last) return;

    if (S.start) {
      if (!sameCoord(first, oldFirst)) S.start.name = 'Startpunkt';
      S.start.lat = first[1];
      S.start.lng = first[0];
    }
    if (S.end) {
      if (!sameCoord(last, oldLast)) S.end.name = 'Zielpunkt';
      S.end.lat = last[1];
      S.end.lng = last[0];
    }
  }

  function movePoint(i, delta) {
    if (!S.active) return;
    const j = i + delta;
    if (j < 0 || j >= S.coords.length) return;

    const oldFirst = S.coords[0].slice();
    const oldLast = S.coords[S.coords.length - 1].slice();
    const tmp = S.coords[i];
    S.coords[i] = S.coords[j];
    S.coords[j] = tmp;

    syncEndpoints(oldFirst, oldLast);
    S.routeCoords = []; // alte Geometrie gehört zur alten Reihenfolge
    draw();
    scheduleRoute();
    D.toast('Reihenfolge geändert – Route wird neu berechnet.');
  }

  function draw() {
    editLayer.clearLayers();
    S.vertices = [];
    redrawLine();
    drawVertices();
    drawRoutePois();
    updateEndpointLabels();
    updateTrackInfo();
    renderPointList();
  }

  /* ---------- Start / Ziel ---------- */

  function setEndpoint(which, value) {
    S[which] = value;
    if (which === 'start') {
      if (!S.coords.length) S.coords.push([value.lng, value.lat]);
      else S.coords[0] = [value.lng, value.lat];
    } else {
      if (!S.coords.length) S.coords.push([S.start ? S.start.lng : value.lng, S.start ? S.start.lat : value.lat]);
      if (S.coords.length < 2) S.coords.push([value.lng, value.lat]);
      else S.coords[S.coords.length - 1] = [value.lng, value.lat];
    }
    cancelPick();
    S.routeCoords = [];
    S.routeMeta = null;
    draw();
    scheduleRoute();
  }

  function startPick(which) {
    S.pick = which;
    map.getContainer().style.cursor = 'crosshair';
    $('ed-pick-start').classList.toggle('active', which === 'start');
    $('ed-pick-end').classList.toggle('active', which === 'end');
    D.toast('Jetzt auf die Karte tippen, um ' + (which === 'start' ? 'den Start' : 'das Ziel') + ' zu setzen.');
  }

  function cancelPick() {
    S.pick = null;
    map.getContainer().style.cursor = '';
    $('ed-pick-start').classList.remove('active');
    $('ed-pick-end').classList.remove('active');
  }

  function shortName(display) {
    return String(display || '').split(',')[0].trim() || display;
  }

  function localMatches(q) {
    const term = q.toLowerCase();
    const out = [];
    D.getAllPois().forEach((f) => {
      const n = f.properties && f.properties.name;
      if (!n || !n.toLowerCase().includes(term)) return;
      const c = f.geometry && f.geometry.coordinates;
      if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return;
      out.push({ name: n, lat: c[1], lng: c[0], label: 'POI vor Ort' });
    });
    return out.slice(0, 4);
  }

  function clearGeoTimers() {
    Object.keys(S.geoTimers).forEach((k) => {
      clearTimeout(S.geoTimers[k]);
      S.geoTimers[k] = null;
    });
  }

  function geoSearch(which, q) {
    const box = $(which === 'start' ? 'ed-start-results' : 'ed-end-results');
    const input = $(which === 'start' ? 'ed-start-search' : 'ed-end-search');
    const term = String(q || '').trim();
    if (term.length < 3) {
      clearTimeout(S.geoTimers[which]);
      S.geoTimers[which] = null;
      box.hidden = true;
      return;
    }
    clearTimeout(S.geoTimers[which]);
    const seq = ++S.geoSeq[which];
    S.geoTimers[which] = setTimeout(async () => {
      const results = localMatches(term);
      try {
        const url = C.editor.geocodeUrl + encodeURIComponent(term);
        const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
        if (res.ok) {
          const list = await res.json();
          (list || []).forEach((item) => {
            const lat = parseFloat(item.lat), lng = parseFloat(item.lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
            results.push({ name: shortName(item.display_name), lat: lat, lng: lng, label: 'Adresse' });
          });
        }
      } catch (e) { /* offline: lokale Treffer bleiben */ }

      // Nur noch Antworten der aktuellen Suche anzeigen.
      if (seq !== S.geoSeq[which] || input.value.trim() !== term) return;
      box.innerHTML = '';
      const usable = results.filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
      if (!usable.length) {
        box.innerHTML = '<div class="empty">Keine Treffer – alternativ auf die Karte tippen.</div>';
        box.hidden = false;
        return;
      }
      usable.slice(0, 6).forEach((r) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.innerHTML = esc(r.name) + '<br><span class="kind">' + esc(r.label) + '</span>';
        b.addEventListener('click', () => {
          setEndpoint(which, { name: r.name, lat: r.lat, lng: r.lng });
          box.hidden = true;
        });
        box.appendChild(b);
      });
      box.hidden = false;
    }, 400);
  }

  /* ---------- POI-Vorschläge ---------- */

  function suggestPois() {
    if (S.coords.length < 2) { D.toast('Erst Start und Ziel setzen.'); return; }
    const latlngs = routeLine().map((c) => L.latLng(c[1], c[0]));
    const found = [];
    D.getAllPois().forEach((f) => {
      const p = f.properties || {};
      if (C.editor.poiSuggestIgnoreTypes.indexOf(p.typ) !== -1) return;
      if (!S.suggestTypes.has(p.typ)) return;
      const c = f.geometry && f.geometry.coordinates;
      if (!c) return;
      const dist = distanceToPolyline(L.latLng(c[1], c[0]), latlngs);
      if (dist <= C.editor.poiSuggestRadius) found.push({ feature: f, dist: dist });
    });

    found.sort((a, b) => {
      const pa = C.editor.preferredPoiTypes.indexOf(a.feature.properties.typ);
      const pb = C.editor.preferredPoiTypes.indexOf(b.feature.properties.typ);
      if (pa !== pb) return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb);
      return a.dist - b.dist;
    });
    S.suggestions = found.slice(0, C.editor.poiSuggestLimit);
    renderSuggestions();
    $('ed-suggestions').hidden = false;
    if (!S.suggestions.length) D.toast('Keine POIs entlang der Route gefunden.');
  }

  function renderSuggestions() {
    const box = $('ed-suggestion-list');
    box.innerHTML = '';
    const selected = new Set(S.pois.map((p) => p.key));
    S.suggestions.forEach((s) => {
      const f = s.feature, props = f.properties || {};
      const key = poiKey(f);
      const g = C.poiGroups.find((x) => x.id === props.typ);
      const row = document.createElement('label');
      row.className = 'suggestion-item';
      const displayName = D.displayPoiName ? D.displayPoiName(f) : (props.name || 'POI');
      row.innerHTML =
        '<input type="checkbox"' + (selected.has(key) ? ' checked' : '') + '>' +
        '<span class="ico">' + (g ? g.icon : '📍') + '</span>' +
        '<span class="txt"><b>' + esc(displayName) + '</b><small>' + esc(g ? g.label : (props.typ || 'POI')) + '</small></span>' +
        '<span class="dist">' + Math.round(s.dist) + ' m</span>';
      const cb = row.querySelector('input');
      cb.addEventListener('change', () => {
        if (cb.checked) {
          if (!S.pois.some((p) => p.key === key)) {
            S.pois.push({
              key: key,
              name: displayName,
              typ: props.typ || 'eigen',
              lat: f.geometry.coordinates[1],
              lng: f.geometry.coordinates[0],
              dist: Math.round(s.dist)
            });
          }
        } else {
          S.pois = S.pois.filter((p) => p.key !== key);
        }
        drawRoutePois();
      });
      box.appendChild(row);
    });
    $('ed-suggest-count').textContent = S.suggestions.length;
  }

  /* ---------- Öffnen / Schließen / Speichern ---------- */

  function open(index) {
    if (!D) return;
    if (S.active && !confirm('Ungespeicherte Änderungen verwerfen und einen anderen Radweg öffnen?')) return;
    cancelRouteWork();
    clearGeoTimers();
    if (D.cancelPoiMode) D.cancelPoiMode();
    const own = D.getOwnWays();
    const f = index >= 0 ? own[index] : null;

    S.active = true;
    S.index = f ? index : -1;
    const savedWaypoints = f && f.properties && f.properties.waypoints;
    if (Array.isArray(savedWaypoints)) {
      S.coords = savedWaypoints.map((c) => U.coord(c)).filter(Boolean);
    }
    if (S.coords.length < 2 && f && f.geometry && Array.isArray(f.geometry.coordinates)) {
      const cs = f.geometry.coordinates;
      const a = U.coord(cs[0]), b = U.coord(cs[cs.length - 1]);
      S.coords = (a && b) ? [a, b] : [];
    }
    S.routeCoords = [];
    S.routeMeta = (f && f.properties && f.properties.distance)
      ? { distance: f.properties.distance, duration: (f.properties.durationMin || 0) * 60 }
      : null;
    S.fitOnNextRoute = true;
    S.lastDragEnd = 0;
    S.name = f ? (f.properties.name || '') : '';
    S.note = f ? (f.properties.notiz || '') : '';
    S.start = f && f.properties.start ? Object.assign({}, f.properties.start) : null;
    S.end = f && f.properties.ziel ? Object.assign({}, f.properties.ziel) : null;
    S.pois = f && f.properties.pois ? f.properties.pois.map((p) => Object.assign({}, p)) : [];
    S.color = U.safeColor(f && f.properties && f.properties.color,
      U.safeColor(D.routeColor(D.getOwnWays().length), C.routeColors[0]));
    S.bikeTypes = (f && Array.isArray(f.properties.bikeTypes)) ? f.properties.bikeTypes.slice() : [];
    S.suggestTypes = new Set(C.editor.poiSuggestDefaultTypes);
    S.suggestions = [];
    cancelPick();

    $('editor-title').textContent = f ? 'Radweg bearbeiten' : 'Neuer Radweg';
    $('editor-subtitle').textContent = f ? 'Punkte ziehen, Routing passt sich an' : 'Start, Ziel und Zwischenstops festlegen';
    $('ed-name').value = S.name;
    $('ed-note').value = S.note;
    $('ed-color').value = S.color;
    renderColorSwatches();
    renderBikeOptions();
    renderSuggestTypeChips();
    $('ed-start-search').value = '';
    $('ed-end-search').value = '';
    $('ed-start-results').hidden = true;
    $('ed-end-results').hidden = true;
    $('ed-suggestions').hidden = true;
    $('ed-suggestion-list').innerHTML = '';
    S.collapsed = false;
    $('editor').classList.remove('collapsed');
    $('editor-min').textContent = '▾';
    $('editor-min').title = 'Editor einklappen';
    $('editor-compact').hidden = true;
    $('editor').hidden = false;

    D.hidePanel();
    D.hideRoutePois();
    draw();

    if (S.coords.length >= 2) {
      computeRoute();
      if (S.pois.length) suggestPois();
    } else {
      map.setView(C.center, C.zoom);
    }
  }

  function close() {
    S.active = false;
    S.index = -1;
    cancelRouteWork();
    clearGeoTimers();
    if (S.drag) {
      S.drag = null;
      L.DomEvent.off(document, 'mousemove touchmove', onLineDragMove);
      L.DomEvent.off(document, 'mouseup touchend touchcancel', onLineDragEnd);
      map.dragging.enable();
      map.getContainer().classList.remove('route-dragging');
      map.getContainer().style.cursor = '';
    }
    cancelPick();
    editLayer.clearLayers();
    routePoiLayer.clearLayers();
    S.vertices = [];
    S.line = null;
    S.visibleLine = null;
    S.coords = [];
    S.routeCoords = [];
    S.routeMeta = null;
    S.pois = [];
    S.lastDragEnd = 0;
    setRouteControls();
    S.collapsed = false;
    $('editor').classList.remove('collapsed');
    $('editor-compact').hidden = true;
    $('editor').hidden = true;
    D.showRoutePois();
  }

  function save() {
    if (!S.active) return;
    if (S.coords.length < 2) { D.toast('Bitte Start und Ziel setzen.'); return; }
    if (S.routeBusy || S.routeTimer) {
      D.toast('Route wird noch berechnet – bitte kurz warten.');
      return;
    }
    const own = D.getOwnWays();
    // Index-Drift (z. B. durch Löschen) darf nie null-Löcher erzeugen.
    const targetIndex = (S.index >= 0 && S.index < own.length) ? S.index : -1;
    const previous = targetIndex >= 0 ? own[targetIndex] : null;
    const geometry = routeLine().length >= 2 ? routeLine() : S.coords;
    const feature = {
      type: 'Feature',
      properties: {
        name: $('ed-name').value.trim() || 'Radweg ohne Namen',
        kategorie: 'eigen',
        notiz: $('ed-note').value.trim(),
        start: S.start ? Object.assign({}, S.start) : null,
        ziel: S.end ? Object.assign({}, S.end) : null,
        waypoints: S.coords.map(roundCoord),
        color: S.color,
        bikeTypes: S.bikeTypes.slice(),
        distance: S.routeMeta ? Math.round(S.routeMeta.distance) : null,
        durationMin: S.routeMeta ? Math.round(S.routeMeta.duration / 60) : null,
        pois: S.pois.map((p) => Object.assign({}, p)),
        eigen: true,
        erstellt: (previous && previous.properties && previous.properties.erstellt) || new Date().toISOString(),
        geaendert: new Date().toISOString()
      },
      geometry: { type: 'LineString', coordinates: geometry.map(roundCoord) }
    };
    const hasRoute = !!S.routeMeta;
    const next = own.slice();
    if (targetIndex >= 0) next[targetIndex] = feature;
    else next.push(feature);
    D.saveOwnWays(next);
    D.afterSave();
    close();
    D.toast('Radweg gespeichert' + (hasRoute ? ' (über das Radwegenetz berechnet).' : '.'));
  }

  /* ---------- Farbe, Radtyp, Vorschlags-Filter ---------- */

  function renderColorSwatches() {
    const box = $('ed-color-swatches');
    box.innerHTML = '';
    C.routeColors.forEach((color) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch-btn' + (color.toLowerCase() === String(S.color).toLowerCase() ? ' selected' : '');
      b.style.background = color;
      b.title = color;
      b.addEventListener('click', () => {
        S.color = color;
        $('ed-color').value = color;
        renderColorSwatches();
        redrawLine();
      });
      box.appendChild(b);
    });
  }

  function renderBikeOptions() {
    const box = $('ed-bike-types');
    box.innerHTML = '';
    C.bikeTypes.forEach((b) => {
      const label = document.createElement('label');
      const active = S.bikeTypes.indexOf(b.id) !== -1;
      label.className = 'bike-chip' + (active ? ' active' : '');
      label.innerHTML = '<input type="checkbox"' + (active ? ' checked' : '') + '>' + b.icon + ' ' + b.label;
      const cb = label.querySelector('input');
      cb.addEventListener('change', () => {
        if (cb.checked) { if (S.bikeTypes.indexOf(b.id) === -1) S.bikeTypes.push(b.id); }
        else S.bikeTypes = S.bikeTypes.filter((x) => x !== b.id);
        label.classList.toggle('active', cb.checked);
      });
      box.appendChild(label);
    });
  }

  function renderSuggestTypeChips() {
    const box = $('ed-suggest-type-filter');
    box.innerHTML = '';
    C.poiGroups.filter((g) => C.editor.poiSuggestIgnoreTypes.indexOf(g.id) === -1).forEach((g) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'type-chip' + (S.suggestTypes.has(g.id) ? ' active' : '');
      b.textContent = g.icon + ' ' + g.label;
      b.addEventListener('click', () => {
        if (S.suggestTypes.has(g.id)) S.suggestTypes.delete(g.id);
        else S.suggestTypes.add(g.id);
        b.classList.toggle('active', S.suggestTypes.has(g.id));
        if (!$('ed-suggestions').hidden) suggestPois();
      });
      box.appendChild(b);
    });
  }

  /* ---------- Initialisierung ---------- */

  function init(deps) {
    D = deps; C = deps.C; L = deps.L; map = deps.map;
    editLayer = L.layerGroup().addTo(map);
    routePoiLayer = L.layerGroup().addTo(map);

    $('editor-close').addEventListener('click', close);
    $('editor-min').addEventListener('click', () => {
      S.collapsed = !S.collapsed;
      $('editor').classList.toggle('collapsed', S.collapsed);
      $('editor-min').textContent = S.collapsed ? '▴' : '▾';
      $('editor-min').title = S.collapsed ? 'Editor ausklappen' : 'Editor einklappen';
      $('editor-compact').hidden = !S.collapsed;
      if (S.collapsed) updateCompactInfo();
    });
    $('ed-save').addEventListener('click', save);
    $('ed-suggest').addEventListener('click', suggestPois);
    $('ed-pick-start').addEventListener('click', () => startPick('start'));
    $('ed-pick-end').addEventListener('click', () => startPick('end'));
    $('ed-color').addEventListener('input', (e) => {
      S.color = e.target.value;
      renderColorSwatches();
      redrawLine();
    });
    $('ed-start-search').addEventListener('input', (e) => geoSearch('start', e.target.value));
    $('ed-end-search').addEventListener('input', (e) => geoSearch('end', e.target.value));

    map.on('click', (e) => {
      if (!S.active) return;
      // Nach dem Ziehen der Linie keinen versehentlichen Klick auslösen
      if (S.drag || Date.now() - S.lastDragEnd < 400) { S.lastDragEnd = 0; return; }
      if (S.pick) {
        setEndpoint(S.pick, { name: S.pick === 'start' ? 'Startpunkt' : 'Zielpunkt', lat: e.latlng.lat, lng: e.latlng.lng });
        return;
      }
      insertWaypointAt(e.latlng);
      S.routeCoords = [];
      S.routeMeta = null;
      draw();
      scheduleRoute();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !S.active) return;
      // Ein offener Dialog hat Vorrang (app.js stops die Propagation zusätzlich).
      if (!$('dialog-backdrop').hidden || !$('assign-backdrop').hidden) return;
      close();
    });
  }

  window.FK_EDITOR = {
    init: init, open: open, close: close, isOpen: () => S.active, rerouteWay: rerouteWay
  };
})();
