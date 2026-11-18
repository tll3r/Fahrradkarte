# Zusammenfassung für eine KI (und für Menschen, die schnell den Überblick brauchen)

**Projekt:** Statische interaktive Fahrradkarte für Sachsen-Anhalt südlich der Elbe
**Ordner:** `/Users/tll3r/Documents/Standardprojekt/fahrradkarte`
**Stand:** 18.11.2026 · nach dem großen Refactor

> Lesen Sie dieses Dokument **vor** jeder Änderung. Es ist absichtlich sehr konkret
> geschrieben, damit auch eine KI ohne Projektwissen keine Grundannahmen kaputt macht.

---

## 1. Was die Anwendung ist

Eine einzelne HTML-Seite mit Leaflet-Karte. **Kein Build, kein Framework, kein Modulsystem.**
Alles läuft im Browser aus statischen Dateien. Es gibt vier globale Objekte:

| Global | Datei | Zweck |
|---|---|---|
| `L` | `vendor/leaflet/leaflet.js` | Kartenbibliothek (muss zuerst geladen sein) |
| `window.FK_UTIL` | `js/utils.js` | gemeinsame Helfer (esc, Zahlen, Farben, Koordinaten) |
| `window.FK_CONFIG` | `js/config.js` | alle Einstellungen, IDs, Farben, URLs |
| `window.FK_EDITOR` | `js/editor.js` | öffentliche Editor-API für `app.js` |

**Skriptreihenfolge in `index.html` (Nicht ändern!):**
`leaflet.js` → `utils.js` → `config.js` → `editor.js` → `app.js`.

`editor.js` definiert beim Laden nur die API und greift noch nicht auf `L`/Karte zu.
`app.js` baut die Karte und startet eine `async init()`. Diese lädt fünf GeoJSON-Dateien
und ruft danach über `initEditor(deps)` (wartet notfalls kurz auf `window.FK_EDITOR`)
`FK_EDITOR.init(deps)` auf. Editor-Listener existieren also erst, wenn die Daten da sind.
**Früher stand `app.js` vor `editor.js` – das konnte bei sehr schnellem Laden einen stillen
Init-Race erzeugen. Nicht wieder zurückändern!**

---

## 2. Dateien und ihre Rolle

| Datei | Rolle | Darf man ändern? |
|---|---|---|
| `index.html` | DOM-Vertrag: ca. 68 IDs, die JS anspricht; Lade-Reihenfolge | Ja, aber IDs nicht umbenennen |
| `css/style.css` | Layout, Panels, Editor, Mobile, Touch, Attribution | Ja |
| `js/utils.js` | `FK_UTIL`: `esc`, `clone`, `num`, `coord`, `sameCoord`, `safeColor`, `safeUrl`, `fmtKm`, `fmtCoord` | Nur ergänzen |
| `js/config.js` | Zentrale Konfiguration: Kartenausschnitt, Region, Tiles, Kategorien, Router, Geocoder, Farben, Radtypen, Dateipfade | Ja – **Achtung bei IDs** |
| `js/app.js` | Hauptmodul: Karte, Layer, State, Laden, Rendering, Filter, Suche, eigene POIs, Import/Export, POI→Route, Toast, Panels | Ja |
| `js/editor.js` | Editor: Routing, Punkte setzen/ziehen/löschen/sortieren, Adresssuche, POI-Vorschläge, Speichern | Ja |
| `data/radwege-osm.geojson` | 2.434 OSM-Radwege (generiert) | Nein – wird von Skripten überschrieben |
| `data/pois-osm.geojson` | 2.669 OSM-POIs (generiert) | Nein |
| `data/bekannte-radwege.geojson` | 1.410 Abschnitte Elberadweg / Berlin–Leipzig (generiert) | Nein |
| `data/eigene-radwege.geojson` | Dauerhafte eigene Routen (Vorlage, aktuell leer) | Ja, von Hand |
| `data/eigene-pois.geojson` | Dauerhafte eigene POIs (Vorlage, aktuell leer) | Ja, von Hand |
| `overpass/*.overpass`, `overpass/raw.json` | Abfragen und Rohdaten für Offline-Refresh | Nur mit Skripten |
| `scripts/refresh_data.sh` | Holt OSM-Daten neu und baut die drei generierten GeoJSON | – |
| `scripts/build_geojson.py` | Wandelt Overpass-JSON in Radwege/POIs | – |
| `scripts/update_fernradwege.py` | Holt Fernradweg-Relationen | – |
| `start.sh` | Lokaler HTTP-Server auf Port 8000 | – |
| `demo.html` | iframe-Beispiel | – |
| `README.md` | Bedienungsanleitung | – |

---

## 3. Starten und Testen

```bash
cd /Users/tll3r/Documents/Standardprojekt/fahrradkarte
./start.sh
```

Danach im Browser:

- `http://localhost:8000/index.html`
- Im WLAN: `http://192.168.178.135:8000/`

**Nie `file://index.html` öffnen** – `fetch()` lädt die GeoJSON-Dateien sonst nicht.

Nach **jeder** Änderung: **Cmd+R** im Browser drücken (Cache ist zwar `no-store`, aber JS wird trotzdem aus dem Speicher wiederholt).

Syntax schneller prüfen:

```bash
cd /Users/tll3r/Documents/Standardprojekt/fahrradkarte
for f in utils.js config.js app.js editor.js; do
  osascript -l JavaScript -e "ObjC.import('Foundation'); var d=\$.NSData.dataWithContentsOfFile('$PWD/js/$f'); var s=\$.NSString.alloc.initWithDataEncoding(d,4).js; try { new Function(s); 'OK' } catch(e) { 'FEHLER: '+e.message }"
done
```

Headless-Chrome-Muster für Regressionstests:

```
'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  --headless=new --disable-gpu --no-sandbox --disable-dev-shm-usage \
  --window-size=1440,1000 --virtual-time-budget=6000 \
  --user-data-dir=/tmp/fk-chrome-test \
  --dump-dom http://localhost:8000/_test_xyz.html
```

Für Editor-Tests `window.fetch` stubben, sonst wartet der Test auf den externen Router.

---

## 4. Datenmodell

### 4.1 Zwei Persistenzquellen

1. **Statische Dateien** (`data/eigene-*.geojson`): werden nur gelesen, nie zurückgeschrieben.
2. **localStorage**: `fk_own_ways_v1` und `fk_own_pois_v1` – hier landen alle Änderungen des Nutzers.

Beide werden in `app.js` im `state` zusammengeführt:

```js
state = {
  waysOsm, poisOsm,          // aus generierten Dateien
  waysFile, poisFile,        // aus data/eigene-*.geojson
  fernways,                  // bekannte Radwege
  ownWays, ownPois,          // aus localStorage (bearbeitbar)
  searchables, namedPois,
  routePoisSuppressed,       // Editor aktiv -> gelbe Marker aus
  routePoiCats               // Set: Kategorien mit Routen-POIs
}
```

Aggregatoren:

- `allWays()` = `waysOsm + waysFile + fernways + ownWays`
- `allPois()` = `poisOsm + poisFile + ownPois`
- `fileEigenWays()` = nur `waysFile` mit `kategorie === 'eigen'` – **wird in `renderOwnWaysOnly()` mitgezeichnet**, sonst wären dateibasierte Routen in Zählern/Suche sichtbar, aber nicht auf der Karte.

**Wichtig:** `data/eigene-*.geojson` sind readings only. „Alle Routen löschen“ löscht nur localStorage.

### 4.2 Feature-Formate

Radweg (LineString):

```js
{
  type: 'Feature',
  properties: {
    name, kategorie: 'eigen', notiz, eigen: true,
    color: '#e4572e', bikeTypes: ['trekking'],
    waypoints: [[lng, lat], ...],   // vom Nutzer gesetzte Punkte
    start: {name, lat, lng}, ziel: {name, lat, lng},
    pois: [{key, name, typ, lat, lng, dist}, ...],
    distance, durationMin, erstellt, geaendert
  },
  geometry: { type: 'LineString', coordinates: [[lng, lat], ...] }
}
```

POI (Point): `properties.typ` **muss** mit einer `id` aus `C.poiGroups` übereinstimmen,
sonst landet der POI im Bucket `eigen`.

**Koordinaten sind immer `[lng, lat]`**, Leaflet will aber `[lat, lng]`. An jeder
Übergabe umdrehen – das ist die häufigste Fehlerquelle.

---

## 5. Die wichtigsten Regeln / Invarianten

1. **`wayCategories[].id` ↔ `properties.kategorie`** und **`poiGroups[].id` ↔ `properties.typ`**.
   Unbekannte Werte fallen in den `eigen`-Bucket. IDs in `config.js` und GeoJSON müssen zusammenpassen.
2. `buildBikeFilter()` **vor** `renderAll()` aufrufen. `routeVisible()` liest direkt
   `$('bike-filter').value` aus dem DOM.
3. `buildFilters()` **vor** `renderAll()` aufrufen. `applyFilters()` liest die Checkboxen aus dem DOM.
4. Alle Datenänderungen laufen über `commitDataChange()` in `app.js`:
   Highlight leeren → `ensureRouteColors()` → `buildFilters()` → `renderAll()`.
   `buildFilters()` merkt sich vorher die Haken, damit Datenänderungen die Filterstellung nicht zurücksetzen.
5. `renderAll()` = `buildNamedPois()` → `renderWays()` → `renderPois()` → `buildSearchIndex()`.
   `renderWays()` ruft `renderOwnWaysOnly()`, das `renderRoutePois()` und `applyFilters()` aufruft.
6. Editor und destruktive Aktionen schließen sich aus. `requireEditorClosed()` in `app.js`
   blockiert Löschen, Import, Reset und POI-Zuordnung, solange `FK_EDITOR.isOpen()` wahr ist.
7. Der Editor darf während des Routings nie speichern: `S.routeBusy` deaktiviert `#ed-save`
   und `#ed-suggest`. Jede Geometrieänderung geht über `invalidateRoute()` /
   `scheduleRoute()`: alte Geometrie und alte Metriken werden **sofort** verworfen.
8. POI-Zuordnung nutzt `poiRefMatches()` in `app.js`: primär der stabile `key`, nur für
   Altdaten ohne `key` ein Koordinatenvergleich. **Nie wieder name+typ vergleichen** –
   das verwechselt gleichnamige Bänke.
9. `poiKey()` in `editor.js` delegiert an `D.poiKey` (= `poiKeyOnly` aus `app.js`).
   Nicht duplizieren!
10. HTML-Ausgaben immer durch `esc()` (aus `FK_UTIL`), Farben durch `U.safeColor()`,
    Links durch `U.safeUrl()`, Zahlen durch `U.num()`. Importierte GeoJSONs sind nicht vertrauenswürdig.
11. Der Editor blendet gelbe App-POI-Marker über `state.routePoisSuppressed` aus.
    `applyFilters()` darf das nicht rückgängig machen; `showRoutePois()` setzt das Flag zurück.
12. Escape-Priorität: Dialog > Editor > POI-Modus > Suche. `app.js` ruft bei Dialogen
    `e.stopImmediatePropagation()`, damit der Editor nicht mitschließt.
13. Erster Waypoint = Start, letzter = Ziel. Nach Ziehen/Löschen eines Endpunkts
    `neutralizeEndpoint()` aufrufen, sonst steht eine alte Adresse an einer neuen Koordinate.
14. Errors werden bewusst geschluckt (`loadGeoJSON`, Geosuche, Routing-Fallback). Die App
    bleibt bedienbar; das ist gewollt.

---

## 6. Editor-Zustand `S` (`js/editor.js`)

```js
S = {
  active, collapsed, index,        // index = Position in state.ownWays, -1 = neu
  coords: [[lng,lat], ...],        // Waypoints
  routeCoords: [[lng,lat], ...],   // berechnete Routen-Geometrie
  routeMeta: {distance, duration}, // Meter, Sekunden
  routeBusy, routeTimer, routeAbort, routeTimeout,
  routeSeq, fitOnNextRoute, lastRouteErrorAt,
  start, end, color, bikeTypes, suggestTypes,
  pois, suggestions,
  pick, geoTimers, geoSeq,
  line, visibleLine, drag, lastDragEnd, vertices
}
```

- `routeLine()` liefert `routeCoords`, wenn ≥2 vorhanden, sonst `coords`.
- `routeSeq` + `AbortController` verhindern, dass eine alte Router-Antwort neue Daten überschreibt.
- Router: `https://routing.openstreetmap.de/routed-bike/route/v1/driving/`
  (aus `C.editor.router`), Debounce 700 ms, Timeout 15 s.
- Geosuche: lokal aus `allPois()` + Nominatim, 400 ms Debounce, **getrennte Timer pro Feld**
  (`geoTimers.start` / `geoTimers.end`) und Antwort-Validierung gegen den aktuellen Suchbegriff.

**Öffentliche API:**

```js
window.FK_EDITOR = { init, open, close, isOpen, rerouteWay };
```

`app.js` übergibt an `init(deps)`:
`C, L, map, getAllPois, getOwnWays, saveOwnWays, afterSave, toast, hidePanel,
cancelPoiMode, displayPoiName, poiKey, routeColor, hideRoutePois, showRoutePois`.

---

## 7. Wichtige Abläufe

### Route anlegen / bearbeiten
`btn-new-way` oder ✏️ → `FK_EDITOR.open(index)` → Waypoints aus `properties.waypoints`
sonst erste/letzte Geometriekoordinate → `draw()` → `computeRoute()`.
Klick/Karte ziehen/Punkt ziehen/▲▼ → `scheduleRoute()` → Router → `redrawLine()`.
`Speichern` → Feature bauen → `D.saveOwnWays(next)` → `D.afterSave()` → `close()`.

### POI zu Route hinzufügen
POI-Popup-Button `data-add-poi` → `openAssignDialog(key)` → Checkboxen je eigener Route →
`saveAssign()` → `rerouteWay(way)` für geänderte Routen (neue Geometrie, Distanz, Dauer) →
`commitDataChange()`.

### Filter
Checkboxen `data-way` / `data-poi` → `applyFilters()` fügt/entfernt die `layerGroup`s.
`routePoiGroup` richtet sich nach `routePoiCats`, nicht pauschal nach „eigen“.

### Suche
`buildSearchIndex()` → `runSearch()` (max. 25 Treffer) → Klick erzeugt gelben Highlight in
`highlightLayer` und zoomt auf ≥15. Leeres Feld, Escape und Datenänderung löschen den Highlight.

---

## 8. Externe Abhängigkeiten (müssen erreichbar sein)

| Zweck | Dienst |
|---|---|
| Kacheln | OpenStreetMap, OpenTopoMap |
| Fahrrad-Routing | FOSSGIS / OSRM `routed-bike` |
| Adresssuche | Nominatim |
| Offline-Datenrefresh (nur Skripte) | Overpass `https://overpass.openstreetmap.fr/api/interpreter` |

Kein API-Key nötig. Nominatim bitte nicht mit Dauer-Anfragen quälen (400 ms Debounce ist eingebaut).

---

## 9. Dumme-AI-Checkliste – vor jedem Commit abhaken

- [ ] Ich habe dieses Dokument gelesen.
- [ ] Ich habe **nicht** `file://` zum Testen benutzt.
- [ ] Ich habe die Skriptreihenfolge in `index.html` nicht verändert.
- [ ] Ich habe keine DOM-ID umbenannt, ohne alle `$(...)`-Aufrufe mitzuziehen.
- [ ] Ich habe keine Kategorie-ID in `config.js` geändert, ohne die GeoJSON-Zeilen mitzuziehen.
- [ ] Neue Datenänderung läuft über `commitDataChange()`.
- [ ] Neue HTML-Ausgabe benutzt `esc()` / `U.safeColor()` / `U.safeUrl()` / `U.num()`.
- [ ] Koordinaten an Leaflet-Grenzen umgedreht (`[lng,lat]` → `[lat,lng]`).
- [ ] Editor-Änderungen rufen `scheduleRoute()` und nicht direkt `computeRoute()` auf.
- [ ] Ich habe `Cmd+R` gedrückt und die Konsole auf Fehler geprüft.
- [ ] Syntaxcheck (siehe Abschnitt 3) war „OK“ für alle JS-Dateien.
- [ ] Ich habe die Karte auf dem Handy geprüft (Panels, Editor-Einklappen, Attribution sichtbar).

---

## 10. Bekannte bewusste Vereinfachungen

- Keine Testsuite im Repo; Tests werden ad hoc per Headless-Chrome gemacht.
- Einzelne eigene POIs können nicht bearbeitet/gelöscht werden – nur alle gemeinsam
  (`Eigene löschen`). Ein POI, der einer Route zugeordnet wurde, bleibt als Kopie in
  `properties.pois[]` der Route enthalten. Das ist bekannt und gewollt, damit die Route
  weiterhin nachvollziehbar bleibt.
- `state2` in `app.js` (`mode`, `pendingLatLng`, `dialogKind`) ist ein kleiner Sonderzustand
  für „POI setzen“. Nicht mit `state` verwechseln.
- Die Index-basierte Farbvergabe wurde auf „erste freie Farbe aus dem Set“ umgestellt;
  trotzdem können Altdaten doppelte Farben enthalten.
- `scripts/__pycache__/` ist ein generiertes Artefakt, kein funktionaler Bestandteil.
