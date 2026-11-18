/**
 * Kleine gemeinsame Hilfsfunktionen für app.js und editor.js.
 * Wird VOR config.js, app.js und editor.js geladen (siehe index.html).
 * Keine externen Abhängigkeiten – läuft in jedem modernen Browser.
 */
(function () {
  'use strict';

  const U = {};

  /** HTML-Zeichen maskieren (überall dort, wo Text in innerHTML landet). */
  U.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  /** Einfache tiefe Kopie (reicht für reine GeoJSON-Daten). */
  U.clone = function (v) {
    return v == null ? v : JSON.parse(JSON.stringify(v));
  };

  /** Zahl erzwingen; ungültige Werte werden auf fallback gesetzt. */
  U.num = function (v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
  };

  /** [lng, lat] normalisieren. Gibt null zurück, wenn kein gültiges Paar vorliegt. */
  U.coord = function (c) {
    if (!Array.isArray(c) || c.length < 2) return null;
    const lng = U.num(c[0], NaN), lat = U.num(c[1], NaN);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    return [lng, lat];
  };

  /** Zwei Koordinatenpaare vergleichen (Standard-Toleranz 1e-9 Grad). */
  U.sameCoord = function (a, b, tol) {
    if (!a || !b) return false;
    const t = tol === undefined ? 1e-9 : tol;
    return Math.abs(U.num(a[0], NaN) - U.num(b[0], NaN)) < t &&
           Math.abs(U.num(a[1], NaN) - U.num(b[1], NaN)) < t;
  };

  /** Nur gültige CSS-Farben durchlassen, damit importierte Daten kein HTML/JS einschleusen. */
  U.safeColor = function (v, fallback) {
    const s = String(v == null ? '' : v).trim();
    return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s) ? s : (fallback || '#2d7ff9');
  };

  /** Nur http(s)-Links zulassen (z. B. für OSM-Popups). */
  U.safeUrl = function (v) {
    const s = String(v == null ? '' : v).trim();
    return /^https?:\/\//i.test(s) ? s : '';
  };

  /** Meter -> "12,3 km" (deutsches Dezimalkomma). */
  U.fmtKm = function (meters) {
    return (U.num(meters, 0) / 1000).toFixed(1).replace('.', ',') + ' km';
  };

  /** [lng, lat] -> "51.6884, 12.7409" für die Punkteliste. */
  U.fmtCoord = function (c) {
    if (!c) return '–';
    return U.num(c[1]).toFixed(4) + ', ' + U.num(c[0]).toFixed(4);
  };

  window.FK_UTIL = U;
})();
