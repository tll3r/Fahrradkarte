/**
 * Zentrale Konfiguration der Fahrradkarte.
 * Farben, Kartenausschnitt und Kategorien lassen sich hier ohne Code-Kenntnisse anpassen.
 */
window.FK_CONFIG = {
  // Kartenausschnitt: Bad Schmiedeberg / Wittenberg / Kemberg, südlich der Elbe
  center: [51.755, 12.55],
  zoom: 11,
  minZoom: 9,
  maxZoom: 18,
  maxBounds: [[51.45, 12.05], [52.00, 13.05]],

  // Hervorhebung der Region: 30-km-Radius um Bad Schmiedeberg
  region: {
    name: 'Bad Schmiedeberg',
    center: [51.6883775, 12.7409236],
    radius: 30000,
    defaultOn: true
  },

  tileLayers: {
    osm: {
      label: 'OpenStreetMap',
      url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-Mitwirkende',
      maxZoom: 19,
      default: true
    },
    topo: {
      label: 'OpenTopoMap',
      url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      attribution: '&copy; <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a> (CC-BY-SA), Daten: OSM',
      maxZoom: 17
    }
  },

  // Radweg-Kategorien. `id` muss mit dem Feld `kategorie` in den GeoJSON-Dateien übereinstimmen.
  wayCategories: [
    { id: 'radweg',           label: 'Ausgewiesener Radweg',      color: '#e4572e', weight: 5, defaultOn: true },
    { id: 'fahrradstrasse',   label: 'Fahrradstraße / designated', color: '#c1440e', weight: 4, defaultOn: true },
    { id: 'radweg-markierung',label: 'Radweg an der Straße',      color: '#f2a03d', weight: 4, defaultOn: true },
    { id: 'bicycle-yes',      label: 'Radfreundlicher Weg',       color: '#7b9b3a', weight: 3, defaultOn: true },
    { id: 'elberadweg',       label: 'Elberadweg (D10)',          color: '#0088cc', weight: 7, defaultOn: true },
    { id: 'berlin-leipzig',   label: 'Radweg Berlin–Leipzig',     color: '#6a1b9a', weight: 7, defaultOn: true },
    { id: 'eigen',            label: 'Eigene Radwege',            color: '#2d7ff9', weight: 6, defaultOn: true }
  ],

  // POI-Gruppen. `id` entspricht dem Feld `typ` in den GeoJSON-Dateien.
  poiGroups: [
    { id: 'drinking_water',        label: 'Trinkbrunnen',       icon: '💧', color: '#2f80ed', defaultOn: false },
    { id: 'bicycle_parking',       label: 'Fahrradparken',      icon: '🅿️', color: '#3d7cf3', defaultOn: false },
    { id: 'bicycle_repair_station',label: 'Reparaturstation',   icon: '🔧', color: '#d35400', defaultOn: false },
    { id: 'bicycle',               label: 'Fahrradladen',       icon: '🚲', color: '#8e44ad', defaultOn: false },
    { id: 'viewpoint',             label: 'Aussichtspunkt',     icon: '🔭', color: '#16a085', defaultOn: true },
    { id: 'toilets',               label: 'Toilette',           icon: '🚻', color: '#7f8c8d', defaultOn: false },
    { id: 'camp_site',             label: 'Camping',            icon: '🏕️', color: '#27ae60', defaultOn: false },
    { id: 'information',           label: 'Information',        icon: 'ℹ️', color: '#2980b9', defaultOn: false },
    { id: 'bicycle_rental',        label: 'Verleih',            icon: '🚲', color: '#8e44ad', defaultOn: false },
    { id: 'shelter',               label: 'Unterstand',         icon: '🏠', color: '#95a5a6', defaultOn: false },
    { id: 'playground',            label: 'Spielplatz',         icon: '🧒', color: '#e67e22', defaultOn: false },
    { id: 'kirche',                label: 'Kirche',             icon: '⛪', color: '#7d3c98', defaultOn: true },
    { id: 'eigen',                 label: 'Eigene POIs',        icon: '⭐', color: '#2d7ff9', defaultOn: false }
  ],

  // Einstellungen für den Radweg-Editor
  editor: {
    // Echtes Fahrrad-Routing über die öffentliche FOSSGIS/OSM-Routing-API (kein API-Key nötig)
    router: {
      url: 'https://routing.openstreetmap.de/routed-bike/route/v1/driving/',
      options: 'overview=full&geometries=geojson&steps=false&annotations=false',
      debounceMs: 700
    },
    // POIs innerhalb dieses Radius (Meter) um die Route werden als Vorschlag angeboten
    poiSuggestRadius: 250,
    // Maximale Anzahl Vorschläge
    poiSuggestLimit: 25,
    // Diese Typen werden nie als Routen-Vorschlag angeboten (zu viele Einträge / wenig Nutzen)
    poiSuggestIgnoreTypes: ['playground', 'shelter'],
    // In der Vorschlagsliste standardmäßig aktive Kategorien
    poiSuggestDefaultTypes: ['kirche', 'drinking_water', 'viewpoint', 'bicycle_parking', 'toilets', 'camp_site', 'information', 'bicycle_repair_station', 'bicycle_rental', 'eigen'],
    // Bevorzugte Kategorien stehen in der Vorschlagsliste oben
    preferredPoiTypes: ['kirche', 'drinking_water', 'viewpoint', 'bicycle_parking', 'toilets', 'camp_site'],

    // Adresssuche über OpenStreetMap (Nominatim)
    geocodeUrl: 'https://nominatim.openstreetmap.org/search?format=jsonv2&accept-language=de&countrycodes=de&limit=6&viewbox=12.05,52.00,13.05,51.45&bounded=1&q='
  },

  // Farben für selbst geplante Routen (werden reihum vergeben, einzeln änderbar)
  routeColors: ['#e4572e', '#2d7ff9', '#27ae60', '#8e44ad', '#f39c12', '#16a085', '#d35400', '#c0392b', '#2980b9', '#606c7a'],

  // Für welche Radarten eine Route geeignet sein kann
  bikeTypes: [
    { id: 'tourenrad', label: 'Tourenrad', icon: '🚴' },
    { id: 'rennrad',   label: 'Rennrad',   icon: '🏁' },
    { id: 'mtb',       label: 'Mountainbike', icon: '🏔️' },
    { id: 'e-bike',    label: 'E-Bike',    icon: '⚡' },
    { id: 'cityrad',   label: 'Cityrad',   icon: '🏙️' },
    { id: 'gravel',    label: 'Gravel',    icon: '🪨' }
  ],

  dataFiles: {
    waysOsm:   'data/radwege-osm.geojson',
    poisOsm:   'data/pois-osm.geojson',
    fernwege:  'data/bekannte-radwege.geojson',
    waysOwn:   'data/eigene-radwege.geojson',
    poisOwn:   'data/eigene-pois.geojson'
  }
};
