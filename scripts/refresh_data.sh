#!/bin/bash
# Holt aktuelle Radwege und POIs aus OpenStreetMap und baut die GeoJSON-Dateien neu.
# Achtung: data/radwege-osm.geojson und data/pois-osm.geojson werden überschrieben.
# Eigene Daten in data/eigene-*.geojson bleiben unangetastet.
set -e
cd "$(dirname "$0")/.."

OVERPASS="https://overpass.openstreetmap.fr/api/interpreter"

echo "Lade Radwege ..."
curl -sS --max-time 300 -X POST "$OVERPASS" \
  -H 'Content-Type: application/x-www-form-urlencoded; charset=UTF-8' \
  -H 'Accept: application/json' \
  -H 'User-Agent: Fahrradkarte/1.0' \
  --data-urlencode 'data@overpass/query.overpass' \
  -o overpass/raw.json

echo "Lade POIs ..."
curl -sS --max-time 300 -X POST "$OVERPASS" \
  -H 'Content-Type: application/x-www-form-urlencoded; charset=UTF-8' \
  -H 'Accept: application/json' \
  -H 'User-Agent: Fahrradkarte/1.0' \
  --data-urlencode 'data@overpass/pois_query.overpass' \
  -o overpass/pois_raw.json

echo "Konvertiere ..."
python3 scripts/build_geojson.py

echo "Lade bekannte Fernradwege ..."
python3 scripts/update_fernradwege.py
echo "Fertig."
