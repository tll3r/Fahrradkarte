# 🚲 Fahrradkarte Sachsen-Anhalt Süd

Interaktive Fahrradkarte für den Raum Bad Schmiedeberg – Wittenberg – Kemberg (südlich der Elbe). Läuft lokal auf deinem Mac, ist im WLAN erreichbar und per `<iframe>` in jede Website einbindbar. Optimiert für Maus **und** Handy.

## Starten

```bash
cd fahrradkarte
chmod +x start.sh
./start.sh
```

- Auf dem Mac: `http://localhost:8000/`
- Im WLAN: `http://192.168.178.135:8000/` (die IP zeigt `start.sh` beim Start an)
- Demo der Einbindung: `http://192.168.178.135:8000/demo.html`

Port ändern: `PORT=8080 ./start.sh`. Beenden: `Strg+C`.

## Einbinden

```html
<iframe src="http://192.168.178.135:8000/index.html"
        width="100%" height="600"
        style="border:0; border-radius:12px;"
        title="Fahrradkarte" loading="lazy" allowfullscreen></iframe>
```

Die Karte lädt GeoJSON per `fetch` – sie muss über HTTP laufen, nicht per `file://`.

## Radweg anlegen und bearbeiten (Haupt-Workflow)

1. **➕ Radweg anlegen** antippen. Der Editor öffnet sich; die Karte bleibt daneben bedienbar.
2. **Start und Ziel festlegen**, auf zwei Arten:
   - **Adresse/Ort eintippen** → Vorschläge aus OpenStreetMap (Nominatim) und aus lokalen POIs. Antippen übernimmt die Koordinate.
   - **📍 Karte** antippen → dann auf die Karte tippen, um Start bzw. Ziel direkt zu setzen.
3. **Echtes Routing**: Sobald Start und Ziel stehen, berechnet die Karte die Strecke automatisch über das **Radwegenetz** (FOSSGIS/OSM-Router, Profil `routed-bike`). Angezeigt werden echte Länge und Fahrzeit – keine Luftlinie mehr.
4. **Zwischenstops setzen**: ein Klick auf eine freie Kartenstelle fügt einen Waypoint **genau an dieser Stelle** ein – er wird an der passenden Position in die Route einsortiert (nicht einfach hinten angehängt). Die Route wird neu berechnet und verläuft über alle Punkte.
5. **Route direkt anfassen**, jederzeit:
   - **Linie an einer beliebigen Stelle anfassen und ziehen** → dort wird ein neuer Punkt eingefügt und mitgezogen; beim Loslassen wird neu geroutet. Die Linie hat dafür eine breite, unsichtbare Grifffläche (auch per Finger bedienbar).
   - Nummerierten Punkt **ziehen** → verschieben; die Route wird nach ~0,7 s automatisch neu berechnet (erster/letzter Punkt aktualisieren auch Start/Ziel).
   - Punkt **antippen** → löschen und neu routen.
   - **Reihenfolge ändern**: In der Liste „Reihenfolge der Punkte" hat jeder Punkt **▲/▼**. Antippen tauscht ihn mit dem Nachbarn; Start (erster Punkt) und Ziel (letzter Punkt) werden direkt mitgeändert und die Route neu berechnet. Adressnamen bleiben erhalten, solange der Punkt an seiner Position bleibt – sonst wird es „Startpunkt"/„Zielpunkt".
6. **✨ POIs vorschlagen**: findet automatisch Kirchen, Trinkbrunnen, Aussichtspunkte, Fahrradparken, Toiletten usw. im Umkreis von 250 m **entlang der berechneten Route**. Anhaken übernimmt sie in den Radweg – danach gelbe Marker entlang der Strecke und Liste im Popup.
7. **Farbe wählen**: Jede Route hat ihre eigene Farbe (Palette wird reihum vergeben). Im Editor über den Farbwähler oder die Farbpunkte ändern – alternativ später in der Routenliste direkt am farbigen Kreis. Alle selbst geplanten Routen sind permanent in ihrer jeweiligen Farbe auf der Karte.
8. **Radtyp festlegen**: Anhaken, für welche Räder die Route geeignet ist (Tourenrad, Rennrad, Mountainbike, E-Bike, Cityrad, Gravel). Die Angabe erscheint im Routen-Popup und in der Liste; über das Dropdown „Alle Radtypen" lassen sich Routen filtern (auch auf der Karte).
9. **💾 Speichern**. Der Radweg steht danach unter „Eigene Radwege" mit ✏️-Button zum jederzeitigen Weiterbearbeiten.

Gespeichert wird die berechnete Strecke als GeoJSON-`LineString`, zusätzlich `waypoints`, `start`, `ziel`, `color`, `bikeTypes`, `distance`, `durationMin` und `pois` in den Properties. Import/Export funktioniert ohne Datenverlust; beim Bearbeiten wird aus den Waypoints neu geroutet.

**Routen löschen:** In der Liste unter „Eigene Radwege" löscht das 🗑️ direkt neben einer Route genau diese (mit Rückfrage). Der Button „🗑️ Alle Routen löschen" unter der Liste entfernt alle eigenen Routen auf einmal – eigene POIs bleiben erhalten. „Eigene löschen" unter „Weitere Daten" entfernt POIs und Routen zusammen. Solange der Editor offen ist, wird vor dem Löschen zum Schließen aufgefordert.

## POI zu einem Radweg hinzufügen

Einen beliebigen POI auf der Karte antippen → im Popup auf **➕ Zu Radweg hinzufügen** klicken. Es erscheinen **alle selbst geplanten Routen** mit ihrer Farbe, vorhandenen POI-Anzahl und einer Checkbox. Anhaken und „Übernehmen" – der POI wird in die ausgewählten Routen eingetragen (mehrfach möglich).

**Die betroffenen Routen werden danach automatisch neu geplant**: Der POI wird als Zwischenpunkt an der passenden Stelle in die bestehenden Waypoints eingefügt und die Strecke über das Radwegenetz neu berechnet (inkl. neuer Länge/Fahrzeit). Beim Abhaken über denselben Dialog verschwindet der Umweg wieder. Das Speichern bleibt ohne Zutun erhalten – die Route wird nur neu gezeichnet, wenn der Router erreichbar ist; andernfalls bleibt die alte Geometrie und es erscheint ein Hinweis.

## Bekannte Fernradwege

Zwei überregionale Routen sind als eigene Kategorien in der Legende enthalten und standardmäßig sichtbar:

- **Elberadweg (D10)** – blau, Abschnitte Dessau–Elster und Elster–Belgern (linkselbisch/rechtselbisch) inkl. Elbquerungen
- **Radweg Berlin–Leipzig (RBL)** – violett, Abschnitte Brandenburg, Sachsen-Anhalt und Sachsen

Die Daten liegen in `data/bekannte-radwege.geojson` und enthalten nur die Mitgliedswege innerhalb des Kartenausschnitts (876 + 534 Wege). Sie lassen sich in der Legende einzeln ein-/ausschalten; ein Klick zeigt Name und OSM-Relation.

## Region Bad Schmiedeberg

Im Filter-Panel schaltet der Schalter **„30 km um Bad Schmiedeberg"** einen grauen, halbtransparenten Kreis mit beschriftetem Zentrum ein oder aus. Damit ist auf einen Blick klar, welche Region die Karte abdeckt. Zentrum und Radius stehen in `js/config.js` unter `region` (Standard: 51,6884 / 12,7409 · 30.000 m · an).

## POI-Vorschläge filtern

Unbenannte OSM-POIs (vor allem Bänke – 1.577 Stück ohne Namen und ohne Adresse) erhalten automatisch einen **Kontext-Namen** wie „Rastbank bei St. Marien", indem der nächste benannte POI in der Nähe gesucht wird.

Zusätzlich gibt es zwei Filter:
- **Global**: Bänke, Spielplätze und Unterstände werden nie als Routenvorschlag angeboten (`poiSuggestIgnoreTypes` in `js/config.js`) und sind in der POI-Legende standardmäßig aus.
- **Pro Route**: Im Editor unter den Vorschlägen lassen sich die gewünschten POI-Kategorien per Chips ein-/ausschalten (z. B. nur Kirchen + Trinkbrunnen). Die Auswahl wirkt sofort auf die Vorschlagsliste.

Falls der Router gerade nicht erreichbar ist, wird vorübergehend eine gerade Verbindung als Fallback gezeigt und ein Hinweis eingeblendet. Die Adresssuche hat zusätzlich einen lokalen POI-Fallback.

## Bedienung auf dem Handy

- Unten links liegen zwei Buttons: **☰ Filter** und **🧭 Touren**. Tourenplanen (eigene Radwege, POI setzen, Import/Export) ist damit aus dem Filter-Menü herausgelöst und hat ein eigenes Sheet. Im Sheet-Wechsel geht es mit den kleinen Knöpfen ☰ / 🧭 direkt hin und zurück.
- Der Editor liegt ebenfalls unten als Sheet. Mit **▾** im Editor-Kopf klappst du das Formular zu einer schmalen Leiste ein — **▴** klappt es wieder aus. Der Bearbeitungsmodus bleibt dabei aktiv, die Karte wird wieder groß und die Route lässt sich bequem anfassen und ziehen. In der Leiste stehen Punktzahl und Streckenlänge.
- Alle Buttons und Checkboxen sind touch-groß (≥ 22 px bzw. 44 px), Eingabefelder nutzen die Handy-Tastatur.
- Zoomen per Pinch oder über die +-Buttons oben rechts.
- Kirchen sind als ⛪ in der POI-Liste (Standard: an) und werden auch als Vorschläge entlang der Route angeboten.

## Weitere Funktionen

- **Suche** über Weg- und POI-Namen, mit Hervorhebung und Zoom zum Treffer.
- **Filter** als Legende: 7 Radweg-Kategorien (inkl. zwei Fernradwege), 14 POI-Gruppen. Bänke/Spielplätze sind standardmäßig aus.
- **Kartenstil**: OpenStreetMap oder OpenTopoMap (Höhenlinien) – Umschalter oben rechts.
- **📍 POI setzen**: Item auf der Karte platzieren, Name/Typ/Notiz eingeben.
- **Export/Import**: eigene POIs und Radwege als GeoJSON. Im Browser gespeichert und zusätzlich als Datei nutzbar.

## Eigene Daten dauerhaft in Dateien

Für alle Geräte: `data/eigene-pois.geojson` und `data/eigene-radwege.geojson` editieren. Beispiele:

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": {
        "name": "Meine Elbtal-Runde",
        "kategorie": "eigen",
        "start": { "name": "Bahnhof Bad Schmiedeberg", "lat": 51.685, "lng": 12.518 },
        "ziel": { "name": "Marktplatz Wittenberg", "lat": 51.867, "lng": 12.646 },
        "pois": [
          { "name": "St. Marien", "typ": "kirche", "lat": 51.866, "lng": 12.643, "dist": 120 }
        ]
      },
      "geometry": {
        "type": "LineString",
        "coordinates": [[12.518, 51.685], [12.560, 51.705], [12.646, 51.867]]
      }
    }
  ]
}
```

POI-Typen: `kirche`, `drinking_water`, `bicycle_parking`, `viewpoint`, `toilets`, `camp_site`, `information`, `bicycle_repair_station`, `shelter`, `eigen`, …

## OSM-Daten aktualisieren

```bash
./scripts/refresh_data.sh
```

Zieht Radwege und POIs neu (inkl. Kirchen) und schreibt `data/radwege-osm.geojson` / `data/pois-osm.geojson`. Danach holt `scripts/update_fernradwege.py` die Fernradwege nach `data/bekannte-radwege.geojson`. Eigene Dateien bleiben unangetastet.

Aktueller Stand (Nov. 2026): **2.434 Radwege**, **2.669 POIs** davon **196 Kirchen**, **1.410 Fernradweg-Abschnitte** (876 Elberadweg / 534 Berlin–Leipzig).

## Anpassen

- `js/config.js`: Ausschnitt, Region (30 km), Farben, Kategorien, POI-Icons, Routing-URL/Profil, Editor-Radius (250 m), Nominatim-URL
- `css/style.css`: Layout, Mobile-Sheet, Touch-Größen
- `overpass/*.overpass`: Was aus OSM geholt wird
- `scripts/build_geojson.py`: Aufbereitung der Rohdaten
- `scripts/update_fernradwege.py`: Fernradweg-Relationen laden und auf den Ausschnitt zuschneiden

## Für KI / Refactoring

Vor Änderungen bitte **[ZUSAMMENFASSUNG_FUER_AI.md](ZUSAMMENFASSUNG_FUER_AI.md)** lesen:
Dateirollen, State-Formate, Invarianten, Start-/Testbefehle und eine Checkliste.

## Dateistruktur

```
fahrradkarte/
├── index.html / demo.html
├── start.sh
├── css/style.css
├── js/utils.js         gemeinsame Hilfsfunktionen (FK_UTIL)
├── js/config.js        Einstellungen
├── js/app.js           Karte, Filter, Suche, eigene POIs
├── js/editor.js        Radweg-Editor
├── ZUSAMMENFASSUNG_FUER_AI.md  Wissensbasis für Refactoring
├── data/*.geojson      Radwege, POIs, eigene Daten
├── overpass/           Abfragen + Rohdaten
├── scripts/            Datenaktualisierung
└── vendor/leaflet/     Kartenbibliothek (lokal)
```

## Lizenz

Daten © [OpenStreetMap](https://www.openstreetmap.org/copyright)-Mitwirkende (ODbL) · [Leaflet](https://leafletjs.com) (BSD-2) · [OpenTopoMap](https://opentopomap.org) (CC-BY-SA) · Adresssuche: [Nominatim](https://nominatim.org).
