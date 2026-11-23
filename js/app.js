(function () {
  'use strict';

  const C = window.FK_CONFIG;
  const U = window.FK_UTIL;
  const LS_POIS = 'fk_own_pois_v1';
  const LS_WAYS = 'fk_own_ways_v1';

  const $ = (id) => document.getElementById(id);
  const esc = U.esc;

  /* ---------------- Karte ---------------- */
  const map = L.map('map', {
    center: C.center, zoom: C.zoom, minZoom: C.minZoom, maxZoom: C.maxZoom,
    maxBounds: C.maxBounds, maxBoundsViscosity: 0.6, preferCanvas: true, zoomControl: false
  });
  // Feste Position: sonst überlappt die Zoom-Control nach dem Drehen des Geräts die Layer-Control.
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  const baseLayers = {};
  let defaultLayerAdded = false;
  Object.values(C.tileLayers).forEach((t) => {
    // maxNativeZoom =zoom, bis zu dem echte Kacheln existieren; maxZoom = Karten-Zoom.
    // Ohne maxNativeZoom zeigt OpenTopoMap oberhalb von 17 ein leeres Raster.
    const layer = L.tileLayer(t.url, {
      attribution: t.attribution,
      maxNativeZoom: t.maxZoom || C.maxZoom,
      maxZoom: C.maxZoom
    });
    baseLayers[t.label] = layer;
    if (t.default && !defaultLayerAdded) { layer.addTo(map); defaultLayerAdded = true; }
  });
  L.control.layers(baseLayers, null, { collapsed: true, position: 'topright' }).addTo(map);

  const wayGroups = {};
  C.wayCategories.forEach((c) => { wayGroups[c.id] = L.layerGroup(); });
  const poiGroups = {};
  C.poiGroups.forEach((g) => { poiGroups[g.id] = L.layerGroup(); });
  const routePoiGroup = L.layerGroup().addTo(map);
  const highlightLayer = L.layerGroup().addTo(map);

  // Region-Hervorhebung entfernt (war nicht gewünscht): keine Kreis-/Masken-Overlay.
  const regionLayer = L.layerGroup();

  /* ---------------- Zustand ---------------- */
  function loadArr(key) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || '[]');
      // Alte, beschädigte Bestände dürfen keine null-Löcher in die Renderer bringen.
      return Array.isArray(v) ? v.filter(Boolean) : [];
    } catch (e) { return []; }
  }
  function saveArr(key, arr) {
    try { localStorage.setItem(key, JSON.stringify(arr)); }
    catch (e) { toast('Speichern im Browser fehlgeschlagen.'); }
  }

  const state = {
    waysOsm: [], poisOsm: [], waysFile: [], poisFile: [], fernways: [],
    ownPois: loadArr(LS_POIS).filter((f) => (f.properties && f.properties.typ) !== 'bench'), ownWays: loadArr(LS_WAYS),
    searchables: [], namedPois: [],
    routePoisSuppressed: false,   // Editor aktiv: gelbe App-Marker ausblenden
    routePoiCats: new Set()       // Kategorien, die tatsächlich Routen-POIs haben
  };

  async function loadGeoJSON(url) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      return json.type === 'FeatureCollection' ? json.features : [];
    } catch (e) {
      console.warn('Konnte ' + url + ' nicht laden:', e);
      return [];
    }
  }

  function ensureRouteColors() {
    let changed = false;
    const before = state.ownWays.length;
    state.ownWays = state.ownWays.filter(Boolean);
    if (state.ownWays.length !== before) changed = true;
    const used = new Set(state.ownWays.map((w) => w.properties && w.properties.color).filter(Boolean));
    state.ownWays.forEach((w, i) => {
      if (!w.properties) { w.properties = {}; changed = true; }
      const fallback = C.routeColors.find((c) => !used.has(c)) || C.routeColors[i % C.routeColors.length];
      const color = U.safeColor(w.properties.color, null);
      if (!color) {
        w.properties.color = fallback;
        used.add(fallback);
        changed = true;
      } else if (color !== w.properties.color) {
        w.properties.color = color;
        changed = true;
      }
      if (!Array.isArray(w.properties.bikeTypes)) { w.properties.bikeTypes = []; changed = true; }
    });
    if (changed) saveArr(LS_WAYS, state.ownWays);
  }

  /** Editor darf bei destruktiven Aktionen nicht offen sein (sonst überschreibt er beim Speichern). */
  function editorIsOpen() {
    return !!(window.FK_EDITOR && window.FK_EDITOR.isOpen && window.FK_EDITOR.isOpen());
  }
  function requireEditorClosed() {
    if (editorIsOpen()) {
      toast('Bitte zuerst den Editor schließen.');
      return false;
    }
    return true;
  }

  /** Alle Datenänderungen laufen hier durch: normalisieren -> Filter bauen -> neu rendern. */
  function commitDataChange() {
    highlightLayer.clearLayers();
    ensureRouteColors();
    buildFilters();
    renderAll();
  }

  /** Editor-API abwarten: auch wenn Daten aus dem Cache extrem schnell kommen. */
  async function initEditor(deps) {
    for (let i = 0; i < 50 && !window.FK_EDITOR; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!window.FK_EDITOR) {
      console.warn('FK_EDITOR nicht geladen – Editor-Funktionen sind deaktiviert.');
      return;
    }
    window.FK_EDITOR.init(deps);
  }

  /** POI-Verweise: bevorzugt stabiler key, sonst Koordinaten (für Altdaten ohne key). */
  function poiRefMatches(p, target) {
    if (!p || !target) return false;
    if (p.key && target.key) return p.key === target.key;
    if (p.key || target.key) return false;
    return p.typ === target.typ &&
      typeof p.lat === 'number' && typeof p.lng === 'number' &&
      Math.abs(p.lat - target.lat) < 1e-6 && Math.abs(p.lng - target.lng) < 1e-6;
  }

  /* ---------------- POI-Namen und -Identität ---------------- */
  function allWays() { return state.waysOsm.concat(state.waysFile, state.fernways, state.ownWays); }
  function allPois() { return state.poisOsm.concat(state.poisFile, state.ownPois).filter((f) => (f.properties && f.properties.typ) !== 'bench'); }

  // Eigene Routen aus data/eigene-radwege.geojson sind dauerhaft sichtbar,
  // bleiben aber getrennt von den bearbeitbaren localStorage-Routen.
  function fileEigenWays() {
    return state.waysFile.filter((f) => {
      const k = (f.properties && f.properties.kategorie) || 'eigen';
      return k === 'eigen';
    });
  }

  function buildNamedPois() {
    const ignore = new Set(C.editor.poiSuggestIgnoreTypes);
    state.namedPois = allPois().filter((f) => {
      const p = f.properties || {};
      return p.name && p.name !== p.typ && !ignore.has(p.typ);
    });
  }

  // Unbenannte POIs (v. a. Bänke) bekommen einen Kontext-Namen: "Rastbank bei St. Marien"
  function displayPoiName(f) {
    const p = f.properties || {};
    if (p.name && p.name !== p.typ) return p.name;
    const c = f.geometry && f.geometry.coordinates;
    if (!c) return p.typ || 'POI';
    const group = C.poiGroups.find((g) => g.id === p.typ);
    const base = group ? group.label : (p.typ || 'POI');
    let best = null, bestDist = 250;
    state.namedPois.forEach((o) => {
      const oc = o.geometry.coordinates;
      const d = Math.hypot((oc[0] - c[0]) * 78000, (oc[1] - c[1]) * 111000);
      if (d < bestDist) { bestDist = d; best = o; }
    });
    return best ? base + ' bei ' + best.properties.name : base;
  }

  function poiKeyOnly(f) {
    const c = f.geometry.coordinates;
    const p = f.properties || {};
    return String(f.id || p.id || [p.typ, p.name, c[0], c[1]].join(':'));
  }

  function poiIdentity(f) {
    const c = f.geometry.coordinates;
    const p = f.properties || {};
    return {
      key: poiKeyOnly(f),
      name: displayPoiName(f),
      typ: p.typ || 'eigen',
      lat: c[1],
      lng: c[0]
    };
  }

  function poiLabel(typ) {
    const g = C.poiGroups.find((x) => x.id === typ);
    return g ? g.icon + ' ' + g.label : (typ || 'POI');
  }

  /* ---------------- Popups ---------------- */
  function popupWay(p) {
    const art = C.wayCategories.find((c) => c.id === p.kategorie);
    let html = '<div class="popup-title">' + (esc(p.name) || 'Radweg ohne Namen') + '</div><div class="popup-meta">';
    html += 'Typ: ' + esc(art ? art.label : (p.kategorie || 'Radweg')) + '<br>';
    if (p.start) html += 'Start: ' + esc(p.start.name) + '<br>';
    if (p.ziel) html += 'Ziel: ' + esc(p.ziel.name) + '<br>';
    if (p.distance) html += 'Länge: ' + esc(U.fmtKm(p.distance)) + '<br>';
    if (p.durationMin) html += 'Fahrzeit: ca. ' + U.num(p.durationMin) + ' min<br>';
    if (p.bikeTypes && p.bikeTypes.length) {
      const labels = p.bikeTypes.map((id) => {
        const b = C.bikeTypes.find((x) => x.id === id);
        return b ? b.icon + ' ' + b.label : id;
      });
      html += 'Geeignet für: ' + esc(labels.join(', ')) + '<br>';
    }
    if (p.surface) html += 'Belag: ' + esc(p.surface) + '<br>';
    if (p.smoothness) html += 'Zustand: ' + esc(p.smoothness) + '<br>';
    const url = U.safeUrl(p.url);
    if (url && !p.eigen) html += '<a href="' + esc(url) + '" target="_blank" rel="noopener">In OpenStreetMap öffnen →</a>';
    html += '</div>';
    if (p.notiz) html += '<div class="popup-note">' + esc(p.notiz) + '</div>';
    if (p.pois && p.pois.length) {
      html += '<div class="popup-pois"><b>POIs unterwegs (' + p.pois.length + ')</b>';
      p.pois.forEach((poi) => {
        if (!poi) return;
        html += '<span>' + esc(poiLabel(poi.typ)) + ' · ' + esc(poi.name) + (poi.dist ? ' (' + U.num(poi.dist) + ' m)' : '') + '</span>';
      });
      html += '</div>';
    }
    return html;
  }

  function popupPoi(f) {
    const p = f.properties || {};
    const ident = poiIdentity(f);
    let html = '<div class="popup-title">' + esc(poiLabel(p.typ)) + ' · ' + esc(ident.name) + '</div><div class="popup-meta">';
    const url = U.safeUrl(p.url);
    if (url && !p.eigen) html += '<a href="' + esc(url) + '" target="_blank" rel="noopener">In OpenStreetMap öffnen →</a>';
    else html += 'Eigener POI';
    html += '</div>';
    if (p.notiz) html += '<div class="popup-note">' + esc(p.notiz) + '</div>';
    if (state.ownWays.length) {
      html += '<button type="button" class="popup-action" data-add-poi="' + esc(ident.key) + '">➕ Zu Radweg hinzufügen</button>';
    }
    return html;
  }

  function poiIcon(g) {
    return L.divIcon({
      className: 'poi-icon',
      html: '<span style="color:' + U.safeColor(g.color, '#2d7ff9') + '">' + esc(g.icon) + '</span>',
      iconSize: [24, 24], iconAnchor: [12, 12], popupAnchor: [0, -12]
    });
  }

  /* ---------------- Rendering ---------------- */
  function routeVisible(f) {
    const filter = $('bike-filter').value;
    if (!filter) return true;
    return (f.properties && f.properties.bikeTypes || []).includes(filter);
  }

  function bindWay(layer, f, c) {
    layer.bindPopup(popupWay(f.properties || {}));
    layer.on('mouseover', () => layer.setStyle({ weight: c.weight + 2, opacity: 1 }));
    layer.on('mouseout', () => layer.setStyle({ weight: c.weight, opacity: 0.85 }));
  }

  function renderRoutePois() {
    routePoiGroup.clearLayers();
    state.routePoiCats = new Set();
    allWays().forEach((f) => {
      if (!routeVisible(f)) return;
      const pois = f.properties && f.properties.pois;
      if (!pois || !pois.length) return;
      state.routePoiCats.add((f.properties && f.properties.kategorie) || 'eigen');
      pois.forEach((p) => {
        if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number') return;

        const m = L.marker([p.lat, p.lng], {
          icon: L.divIcon({
            className: 'route-poi-icon',
            html: '<span>' + esc((C.poiGroups.find((g) => g.id === p.typ) || {}).icon || '📍') + '</span>',
            iconSize: [22, 22], iconAnchor: [11, 11]
          })
        }).addTo(routePoiGroup);
        m.bindPopup('<div class="popup-title">' + esc(p.name) + '</div><div class="popup-meta">' +
          esc(poiLabel(p.typ)) + (p.dist ? '<br>' + U.num(p.dist) + ' m ab Route' : '') + '</div>');
      });
    });
  }

  function renderOwnWaysOnly() {
    wayGroups.eigen.clearLayers();
    const c = C.wayCategories.find((x) => x.id === 'eigen');
    // Sowohl localStorage-Routen als auch dauerhafte Routes aus der Datei zeichnen.
    state.ownWays.concat(fileEigenWays()).filter(routeVisible).forEach((f) => {
      const color = U.safeColor(f.properties && f.properties.color, C.routeColors[0]);
      L.geoJSON(f, {
        style: () => ({ color: color, weight: c.weight + 1, opacity: 0.95, lineCap: 'round', lineJoin: 'round', smoothFactor: 1.2 }),
        onEachFeature: (feature, layer) => bindWay(layer, feature, { weight: c.weight + 1 })
      }).addTo(wayGroups.eigen);
    });
    renderRoutePois();
    applyFilters();
  }

  function renderWays() {
    const buckets = {};
    C.wayCategories.forEach((c) => { buckets[c.id] = []; });
    allWays().forEach((f) => {
      if (f.properties && f.properties.kategorie === 'eigen') return;
      const key = (f.properties && f.properties.kategorie) || 'eigen';
      (buckets[key] || buckets.eigen).push(f);
    });

    Object.values(wayGroups).forEach((g) => g.clearLayers());
    C.wayCategories.forEach((c) => {
      if (c.id === 'eigen' || !buckets[c.id].length) return;
      L.geoJSON({ type: 'FeatureCollection', features: buckets[c.id] }, {
        style: () => ({ color: c.color, weight: c.weight, opacity: 0.85, lineCap: 'round', smoothFactor: 1.5 }),
        onEachFeature: (f, layer) => bindWay(layer, f, c)
      }).addTo(wayGroups[c.id]);
    });
    renderOwnWaysOnly();
    $('count-ways').textContent = allWays().length;
    renderOwnWayList();
  }

  function buildBikeFilter() {
    const sel = $('bike-filter');
    const current = sel.value;
    sel.innerHTML = '<option value="">Alle Radtypen</option>';
    C.bikeTypes.forEach((b) => {
      const opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = b.icon + ' ' + b.label;
      sel.appendChild(opt);
    });
    sel.value = current;
  }

  function renderOwnWayList() {
    const box = $('own-way-list');
    box.innerHTML = '';
    $('count-own').textContent = state.ownWays.length;
    if (!state.ownWays.length) {
      box.innerHTML = '<div class="own-way-empty">Noch keine eigenen Radwege angelegt.</div>';
      return;
    }
    const visible = state.ownWays.filter(routeVisible);
    if (!visible.length) {
      box.innerHTML = '<div class="own-way-empty">Keine Route für diesen Radtyp.</div>';
      return;
    }
    visible.forEach((f) => {
      const i = state.ownWays.indexOf(f);
      const row = document.createElement('div');
      row.className = 'own-way-item';

      const color = document.createElement('input');
      color.type = 'color';
      color.className = 'color-dot';
      color.value = U.safeColor(f.properties && f.properties.color, C.routeColors[0]);
      color.title = 'Farbe dieser Route ändern';
      // Während des Ziehens nur die Linie umfärben; der komplette Neuaufbau
      // erst beim Loslassen (change), sonst ruckelt die Karte bei jedem Pixel.
      color.addEventListener('input', () => {
        f.properties.color = color.value;
        wayGroups.eigen.eachLayer((layer) => {
          if (layer.feature === f && layer.setStyle) layer.setStyle({ color: color.value });
        });
      });
      color.addEventListener('change', () => {
        saveArr(LS_WAYS, state.ownWays);
        renderOwnWaysOnly();
      });

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = (f.properties && f.properties.name) || 'Radweg ohne Namen';

      const bike = document.createElement('span');
      bike.className = 'bike-mini';
      bike.textContent = ((f.properties && f.properties.bikeTypes) || []).map((id) => {
        const b = C.bikeTypes.find((x) => x.id === id);
        return b ? b.icon : '';
      }).join('');

      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = ((f.geometry && f.geometry.coordinates && f.geometry.coordinates.length) || 0) + ' Pkte';

      const btn = document.createElement('button');
      btn.className = 'btn tiny';
      btn.textContent = '✏️';
      btn.title = 'Radweg bearbeiten';
      btn.setAttribute('aria-label', 'Radweg bearbeiten: ' + name.textContent);
      btn.addEventListener('click', () => window.FK_EDITOR.open(i));

      const del = document.createElement('button');
      del.className = 'del-way';
      del.type = 'button';
      del.textContent = '🗑️';
      del.title = 'Radweg löschen';
      del.setAttribute('aria-label', 'Radweg löschen: ' + name.textContent);
      del.addEventListener('click', () => deleteOwnWay(i));

      row.appendChild(color);
      row.appendChild(name);
      row.appendChild(bike);
      row.appendChild(meta);
      row.appendChild(btn);
      row.appendChild(del);
      box.appendChild(row);
    });
  }

  function deleteOwnWay(index) {
    if (!requireEditorClosed()) return;
    const way = state.ownWays[index];
    if (!way) return;
    const name = (way.properties && way.properties.name) || 'Radweg ohne Namen';
    if (!confirm('Radweg „' + name + '“ löschen?')) return;
    state.ownWays = state.ownWays.filter((_, i) => i !== index);
    saveArr(LS_WAYS, state.ownWays);
    commitDataChange();
    toast('Radweg „' + name + '“ gelöscht.');
  }

  $('btn-clear-ways').addEventListener('click', () => {
    if (!requireEditorClosed()) return;
    if (!state.ownWays.length) { toast('Es gibt keine eigenen Routen.'); return; }
    if (!confirm('Alle ' + state.ownWays.length + ' eigenen Routen löschen? Eigene POIs bleiben erhalten.')) return;
    state.ownWays = [];
    saveArr(LS_WAYS, []);
    commitDataChange();
    toast('Alle eigenen Routen gelöscht.');
  });

  function renderPois() {
    Object.values(poiGroups).forEach((g) => g.clearLayers());
    const buckets = {};
    C.poiGroups.forEach((g) => { buckets[g.id] = []; });
    allPois().forEach((f) => {
      let key = (f.properties && f.properties.typ) || 'eigen';
      if (!buckets[key]) key = 'eigen';
      buckets[key].push(f);
    });

    C.poiGroups.forEach((g) => {
      const features = buckets[g.id];
      if (!features.length) return;
      // Canvas-Kreise statt DOM-Marker: deutlich schneller bei vielen POIs.
      const color = U.safeColor(g.color, '#2d7ff9');
      L.geoJSON({ type: 'FeatureCollection', features: features }, {
        pointToLayer: (f, ll) => L.circleMarker(ll, {
          radius: 6, color: '#ffffff', weight: 1.5,
          fillColor: color, fillOpacity: 0.9
        }),
        onEachFeature: (f, layer) => layer.bindPopup(() => popupPoi(f))
      }).addTo(poiGroups[g.id]);
    });
    $('count-pois').textContent = allPois().length;
    applyFilters();
  }

  /* ---------------- Filter ---------------- */
  function buildFilters() {
    // Aktuelle Haken merken, damit Datenänderungen die Filterstellung nicht zurücksetzen.
    const wayChecked = {}, poiChecked = {};
    document.querySelectorAll('[data-way]').forEach((cb) => { wayChecked[cb.dataset.way] = cb.checked; });
    document.querySelectorAll('[data-poi]').forEach((cb) => { poiChecked[cb.dataset.poi] = cb.checked; });

    const wCounts = {}, pCounts = {};
    allWays().forEach((f) => { const k = f.properties?.kategorie || 'eigen'; wCounts[k] = (wCounts[k] || 0) + 1; });
    allPois().forEach((f) => {
      let k = f.properties?.typ || 'eigen';
      if (!C.poiGroups.some((g) => g.id === k)) k = 'eigen';
      pCounts[k] = (pCounts[k] || 0) + 1;
    });

    const wBox = $('way-filters');
    wBox.innerHTML = '';
    C.wayCategories.forEach((c) => {
      const checked = Object.prototype.hasOwnProperty.call(wayChecked, c.id) ? wayChecked[c.id] : c.defaultOn;
      const label = document.createElement('label');
      label.className = 'filter-item';
      label.innerHTML = '<input type="checkbox" data-way="' + c.id + '"' + (checked ? ' checked' : '') + '>' +
        '<span class="swatch" style="background:' + U.safeColor(c.color, '#2d7ff9') + '"></span>' +
        '<span class="filter-label">' + esc(c.label) + '</span>' +
        '<span class="filter-count">' + (wCounts[c.id] || 0) + '</span>';
      label.querySelector('input').addEventListener('change', applyFilters);
      wBox.appendChild(label);
    });

    const pBox = $('poi-filters');
    pBox.innerHTML = '';
    C.poiGroups.forEach((g) => {
      const checked = Object.prototype.hasOwnProperty.call(poiChecked, g.id) ? poiChecked[g.id] : g.defaultOn;
      const label = document.createElement('label');
      label.className = 'filter-item';
      label.innerHTML = '<input type="checkbox" data-poi="' + g.id + '"' + (checked ? ' checked' : '') + '>' +
        '<span class="swatch poi" style="color:' + U.safeColor(g.color, '#2d7ff9') + '">' + esc(g.icon) + '</span>' +
        '<span class="filter-label">' + esc(g.label) + '</span>' +
        '<span class="filter-count">' + (pCounts[g.id] || 0) + '</span>';
      label.querySelector('input').addEventListener('change', applyFilters);
      pBox.appendChild(label);
    });
  }

  function applyFilters() {
    let poisVisible = false;
    document.querySelectorAll('[data-way]').forEach((cb) => {
      const layer = wayGroups[cb.dataset.way];
      if (!layer) return;
      if (cb.checked) { if (!map.hasLayer(layer)) layer.addTo(map); }
      else if (map.hasLayer(layer)) map.removeLayer(layer);
      // POI-Marker gehören zur Kategorie ihrer Route, nicht immer zu "eigen".
      if (cb.checked && state.routePoiCats.has(cb.dataset.way)) poisVisible = true;
    });
    document.querySelectorAll('[data-poi]').forEach((cb) => {
      const layer = poiGroups[cb.dataset.poi];
      if (!layer) return;
      if (cb.checked) { if (!map.hasLayer(layer)) layer.addTo(map); }
      else if (map.hasLayer(layer)) map.removeLayer(layer);
    });
    // Der Editor blendet gelbe App-Marker aktiv aus; ein Render darf das nicht rückgängig machen.
    if (poisVisible && !state.routePoisSuppressed) {
      if (!map.hasLayer(routePoiGroup)) routePoiGroup.addTo(map);
    } else if (map.hasLayer(routePoiGroup)) map.removeLayer(routePoiGroup);
  }

  $('bike-filter').addEventListener('change', () => {
    renderOwnWaysOnly();
    renderOwnWayList();
  });

  /* ---------------- Suche ---------------- */
  function buildSearchIndex() {
    state.searchables = [];
    allWays().concat(allPois()).forEach((f) => {
      const name = f.properties?.name;
      if (!name) return;
      const g = f.geometry;
      let c = null;
      if (g && g.type === 'Point') c = U.coord(g.coordinates);
      else if (g && (g.type === 'LineString' || g.type === 'MultiLineString')) {
        const cs = g.type === 'LineString' ? g.coordinates : (g.coordinates && g.coordinates[0]);
        if (Array.isArray(cs) && cs.length) c = U.coord(cs[Math.floor(cs.length / 2)]);
      }
      if (!c) return;
      state.searchables.push({
        name: String(name), latlng: L.latLng(c[1], c[0]), feature: f,
        kind: f.properties.kategorie || f.properties.typ || 'Eigen'
      });
    });
  }

  function runSearch(term) {
    const box = $('search-results');
    const q = String(term || '').trim().toLowerCase();
    box.innerHTML = '';
    if (!q) { box.hidden = true; highlightLayer.clearLayers(); return; }
    const hits = state.searchables
      .filter((x) => x.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, 'de'))
      .slice(0, 25);

    if (!hits.length) {
      box.innerHTML = '<div class="empty">Keine Treffer</div>';
      box.hidden = false;
      return;
    }
    hits.forEach((hit) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.innerHTML = esc(hit.name) + '<span class="kind">' + esc(hit.kind) + '</span>';
      btn.addEventListener('click', () => {
        highlightLayer.clearLayers();
        L.geoJSON(hit.feature, {
          style: { color: '#ffd166', weight: 9, opacity: 0.95 },
          pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 10, color: '#ffd166', weight: 4, fillOpacity: 0.5 })
        }).addTo(highlightLayer);
        map.setView(hit.latlng, Math.max(map.getZoom(), 15), { animate: true });
        box.hidden = true;
      });
      box.appendChild(btn);
    });
    box.hidden = false;
  }
  $('search').addEventListener('input', (e) => runSearch(e.target.value));

  /* ---------------- POI -> Radweg zuordnen ---------------- */
  let assignTarget = null;

  function openAssignDialog(key) {
    if (!requireEditorClosed()) return;
    const poi = allPois().find((f) => poiKeyOnly(f) === key);
    if (!poi) return;
    assignTarget = poiIdentity(poi);
    $('assign-poi-name').textContent = poiLabel(assignTarget.typ) + ' · ' + assignTarget.name;
    const box = $('assign-way-list');
    box.innerHTML = '';
    if (!state.ownWays.length) {
      box.innerHTML = '<div class="assign-empty">Noch keine eigenen Radwege vorhanden. Lege zuerst einen an.</div>';
    }
    state.ownWays.forEach((w) => {
      const pois = (w.properties && w.properties.pois) || [];
      const has = pois.some((p) => poiRefMatches(p, assignTarget));
      const row = document.createElement('label');
      row.className = 'assign-way-item';
      row.innerHTML =
        '<input type="checkbox"' + (has ? ' checked' : '') + '>' +
        '<span class="color-dot" style="background:' + U.safeColor(w.properties && w.properties.color, C.routeColors[0]) + '"></span>' +
        '<span class="txt">' + esc((w.properties && w.properties.name) || 'Radweg ohne Namen') + '</span>' +
        '<span class="cnt">' + pois.length + ' POIs</span>';
      box.appendChild(row);
    });
    $('assign-backdrop').hidden = false;
  }

  async function saveAssign() {
    if (!assignTarget) return;
    if (!requireEditorClosed()) return;
    const btn = $('assign-save');
    const boxes = $('assign-way-list').querySelectorAll('input');
    const changed = [];
    const next = state.ownWays.map((w, i) => {
      const copy = U.clone(w);
      copy.properties = copy.properties || {};
      const oldPois = copy.properties.pois || [];
      const pois = oldPois.filter((p) => !poiRefMatches(p, assignTarget));
      const had = oldPois.length !== pois.length;
      const wants = !!(boxes[i] && boxes[i].checked);
      if (wants) pois.push(Object.assign({}, assignTarget));
      copy.properties.pois = pois;
      if (wants !== had) changed.push(i);
      return copy;
    });

    btn.disabled = true;
    $('assign-poi-name').textContent = 'Route wird über das Radwegenetz neu geplant …';
    let replanned = 0, failed = 0;
    for (const i of changed) {
      try {
        const result = window.FK_EDITOR && window.FK_EDITOR.rerouteWay
          ? await window.FK_EDITOR.rerouteWay(next[i]) : null;
        if (result) {
          next[i].geometry = { type: 'LineString', coordinates: result.coordinates };
          next[i].properties.distance = Math.round(result.distance);
          next[i].properties.durationMin = Math.round(result.duration / 60);
          replanned++;
        } else { failed++; }
      } catch (e) {
        console.warn('Neurouting fehlgeschlagen:', e);
        failed++;
      }
    }

    state.ownWays = next;
    saveArr(LS_WAYS, next);
    $('assign-backdrop').hidden = true;
    $('assign-poi-name').textContent = '';
    btn.disabled = false;
    assignTarget = null;
    commitDataChange();
    toast('POI zugeordnet.' +
      (replanned ? ' ' + replanned + ' Route(n) neu geplant.' : '') +
      (failed ? ' ' + failed + ' Route(n) konnten nicht neu geplant werden.' : ''));
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-add-poi]');
    if (btn) openAssignDialog(btn.getAttribute('data-add-poi'));
  });
  $('assign-cancel').addEventListener('click', () => {
    $('assign-backdrop').hidden = true;
    assignTarget = null;
  });
  $('assign-save').addEventListener('click', saveAssign);
  $('assign-backdrop').addEventListener('click', (e) => {
    if (e.target === $('assign-backdrop')) $('assign-cancel').click();
  });

  /* ---------------- Toast / Panel ---------------- */
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 3500);
  }

  function closePanels() {
    $('panel').hidden = true;
    $('tour-panel').hidden = true;
    $('panel-open').hidden = false;
    $('tour-panel-open').hidden = false;
  }

  function openPanel(which) {
    const tour = which === 'tour';
    $('panel').hidden = tour;
    $('tour-panel').hidden = !tour;
    $('panel-open').hidden = true;
    $('tour-panel-open').hidden = true;
  }

  function hidePanel() {
    // Editor und Touren-Panel überlagern sich; Panels grundsätzlich schließen.
    closePanels();
  }

  $('panel-toggle').addEventListener('click', closePanels);
  $('tour-toggle').addEventListener('click', closePanels);
  $('panel-open').addEventListener('click', () => openPanel('filter'));
  $('tour-panel-open').addEventListener('click', () => openPanel('tour'));
  $('to-tour').addEventListener('click', () => openPanel('tour'));
  $('to-filter').addEventListener('click', () => openPanel('filter'));

  // Region-Hervorhebung entfernt: Schalter und Abschnitt ausblenden.
  const regionRow = $('region-toggle') ? $('region-toggle').closest('.switch-row') : null;
  const regionSection = regionRow ? regionRow.closest('section') : null;
  if (regionSection) regionSection.hidden = true;

  /* ---------------- Eigene POIs ---------------- */
  const state2 = { mode: null, pendingLatLng: null, dialogKind: null };

  function resetMode() {
    state2.mode = null;
    state2.pendingLatLng = null;
    map.getContainer().style.cursor = '';
  }

  $('btn-new-way').addEventListener('click', () => {
    if (window.FK_EDITOR) window.FK_EDITOR.open(-1);
  });

  $('btn-add-poi').addEventListener('click', () => {
    if (!requireEditorClosed()) return;
    state2.mode = 'poi';
    map.getContainer().style.cursor = 'crosshair';
    toast('Auf die Karte tippen, um einen POI zu setzen.');
    hidePanel();
  });

  map.on('click', (e) => {
    if (state2.mode === 'poi') {
      state2.pendingLatLng = e.latlng;
      openPoiDialog();
    }
  });

  function openPoiDialog() {
    state2.dialogKind = 'poi';
    $('dialog-title').textContent = 'Neuer POI';
    const sel = $('f-type');
    sel.innerHTML = '';
    C.poiGroups.forEach((g) => {
      const opt = document.createElement('option');
      opt.value = g.id;
      opt.textContent = g.label;
      sel.appendChild(opt);
    });
    // Ohne ausdrücklichen Default wird sonst der erste OSM-Typ (Trinkbrunnen) gewählt.
    if (Array.from(sel.options).some((o) => o.value === 'eigen')) sel.value = 'eigen';
    $('f-name').value = '';
    $('f-note').value = '';
    $('dialog-backdrop').hidden = false;
    $('f-name').focus();
  }

  function closePoiDialog() {
    $('dialog-backdrop').hidden = true;
    state2.dialogKind = null;
  }

  $('f-cancel').addEventListener('click', () => { closePoiDialog(); resetMode(); });
  $('dialog-backdrop').addEventListener('click', (e) => {
    if (e.target === $('dialog-backdrop')) $('f-cancel').click();
  });

  $('entry-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (state2.dialogKind !== 'poi' || !state2.pendingLatLng) return;
    const ll = state2.pendingLatLng;
    state.ownPois.push({
      type: 'Feature',
      properties: {
        name: $('f-name').value.trim() || 'Ohne Namen',
        typ: $('f-type').value || 'eigen',
        notiz: $('f-note').value.trim(),
        eigen: true,
        erstellt: new Date().toISOString()
      },
      geometry: { type: 'Point', coordinates: [ll.lng, ll.lat] }
    });
    saveArr(LS_POIS, state.ownPois);
    closePoiDialog();
    resetMode();
    commitDataChange();
    toast('POI gespeichert.');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Dialoge haben Vorrang: der Editor darf dadurch nicht ungewollt mitgeschlossen werden.
    if (!$('dialog-backdrop').hidden) {
      e.stopImmediatePropagation();
      $('f-cancel').click();
      return;
    }
    if (!$('assign-backdrop').hidden) {
      e.stopImmediatePropagation();
      $('assign-cancel').click();
      return;
    }
    if (state2.mode) resetMode();
    $('search-results').hidden = true;
    highlightLayer.clearLayers();
  });

  /* ---------------- Import / Export ---------------- */
  function download(name, text) {
    const blob = new Blob([text], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  $('btn-export').addEventListener('click', () => {
    const features = state.ownPois.concat(state.ownWays);
    if (!features.length) { toast('Noch keine eigenen Daten zum Exportieren.'); return; }
    download('eigene-fahrradkarten-daten.geojson', JSON.stringify({
      type: 'FeatureCollection',
      name: 'Eigene Daten – Fahrradkarte Sachsen-Anhalt Süd',
      features: features
    }, null, 2));
    toast('Export gestartet.');
  });

  $('btn-import').addEventListener('click', () => $('file-input').click());

  /** Importierte Features auf das von der App erwartete Minimalformat bringen. */
  function normalizeImportedFeature(f) {
    if (!f || !f.geometry) return null;
    const c = f.geometry.coordinates;
    if (!Array.isArray(c) || c.length < 2) return null;
    const first = U.coord(c);
    f.properties = f.properties || {};
    f.properties.eigen = true;

    if (f.geometry.type === 'Point') {
      if (!first) return null;
      f.geometry.coordinates = first;
      return 'poi';
    }
    if (f.geometry.type === 'LineString') {
      if (!Array.isArray(c[0]) || !U.coord(c[0]) || !U.coord(c[c.length - 1])) return null;
      f.geometry.coordinates = c.map(U.coord).filter(Boolean);
      if (f.geometry.coordinates.length < 2) return null;
      f.properties.kategorie = 'eigen';
      return 'way';
    }
    return null;
  }

  $('file-input').addEventListener('change', (e) => {
    if (!requireEditorClosed()) { e.target.value = ''; return; }
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = JSON.parse(reader.result);
        const features = json.type === 'FeatureCollection' ? json.features : (Array.isArray(json) ? json : []);
        const addPois = [], addWays = [];
        (features || []).forEach((f) => {
          const kind = normalizeImportedFeature(f);
          if (kind === 'poi') addPois.push(f);
          else if (kind === 'way') addWays.push(f);
        });
        const nextPois = state.ownPois.concat(addPois);
        const nextWays = state.ownWays.concat(addWays);
        saveArr(LS_POIS, nextPois);
        saveArr(LS_WAYS, nextWays);
        state.ownPois = nextPois;
        state.ownWays = nextWays;
        commitDataChange();
        toast('Importiert: ' + addPois.length + ' POIs, ' + addWays.length + ' Radwege.');
      } catch (err) {
        toast('Datei konnte nicht als GeoJSON gelesen werden.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  $('btn-reset').addEventListener('click', () => {
    if (!requireEditorClosed()) return;
    if (!state.ownPois.length && !state.ownWays.length) { toast('Es sind keine eigenen Daten vorhanden.'); return; }
    if (!confirm('Alle selbst erstellten POIs und Radwege aus diesem Browser löschen?')) return;
    state.ownPois = [];
    state.ownWays = [];
    saveArr(LS_POIS, []);
    saveArr(LS_WAYS, []);
    commitDataChange();
    toast('Eigene Daten gelöscht.');
  });

  /* ---------------- Start ---------------- */
  function renderAll() {
    buildNamedPois();
    renderWays();
    renderPois();
    buildSearchIndex();
  }

  function afterSave() {
    commitDataChange();
  }

  (async function init() {
    const [waysOsm, poisOsm, waysFile, poisFile, fernways] = await Promise.all([
      loadGeoJSON(C.dataFiles.waysOsm),
      loadGeoJSON(C.dataFiles.poisOsm),
      loadGeoJSON(C.dataFiles.waysOwn),
      loadGeoJSON(C.dataFiles.poisOwn),
      loadGeoJSON(C.dataFiles.fernwege)
    ]);
    state.waysOsm = waysOsm;
    state.poisOsm = poisOsm;
    state.waysFile = waysFile;
    state.poisFile = poisFile;
    state.fernways = fernways;

    await initEditor({
      C: C, L: L, map: map,
      getAllPois: allPois,
      getOwnWays: () => state.ownWays,
      saveOwnWays: (ways) => { state.ownWays = ways; saveArr(LS_WAYS, ways); },
      afterSave: afterSave,
      toast: toast,
      hidePanel: hidePanel,
      cancelPoiMode: resetMode,
      displayPoiName: displayPoiName,
      poiKey: poiKeyOnly,
      routeColor: (i) => C.routeColors[i % C.routeColors.length],
      hideRoutePois: () => {
        state.routePoisSuppressed = true;
        if (map.hasLayer(routePoiGroup)) map.removeLayer(routePoiGroup);
      },
      showRoutePois: () => {
        state.routePoisSuppressed = false;
        applyFilters();
      }
    });

    buildBikeFilter();
    commitDataChange();

    // Auf kleinen Geräten starten beide Panels geschlossen; zwei Buttons bleiben übrig.
    if (window.innerWidth <= 700) closePanels();
  })();
})();
