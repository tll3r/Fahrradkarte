#!/usr/bin/env python3
"""
Konvertiert die Overpass-Rohdaten in saubere GeoJSON-Dateien.

Aufruf:
    python3 scripts/build_geojson.py

Eingabe:
    overpass/raw.json       (Radwege)
    overpass/pois_raw.json  (POIs)

Ausgabe:
    data/radwege-osm.geojson
    data/pois-osm.geojson

Die erzeugten Dateien sind ganz normales GeoJSON und können mit einem
Texteditor oder QGIS bearbeitet werden.
"""
import json
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BB = [12.25, 51.55, 12.85, 51.90]  # W, S, O, N


def kategorie(tags):
    """Ordnet einen Weg einer von vier Kategorien zu (Priorität: spezifisch -> allgemein)."""
    if tags.get("highway") == "cycleway":
        return "radweg"
    if "bicycle" in tags and tags["bicycle"] == "designated":
        return "fahrradstrasse"
    if "cycleway" in tags:
        return "radweg-markierung"
    if "bicycle" in tags and tags["bicycle"] == "yes":
        return "bicycle-yes"
    return "sonstige"


def way_to_feature(el):
    geom = el.get("geometry")
    if not geom or len(geom) < 2:
        return None
    tags = el.get("tags", {})
    coords = [[round(p["lon"], 6), round(p["lat"], 6)] for p in geom]
    return {
        "type": "Feature",
        "id": f"way/{el['id']}",
        "properties": {
            "id": el["id"],
            "kategorie": kategorie(tags),
            "name": tags.get("name", ""),
            "highway": tags.get("highway", ""),
            "cycleway": tags.get("cycleway", ""),
            "bicycle": tags.get("bicycle", ""),
            "surface": tags.get("surface", ""),
            "smoothness": tags.get("smoothness", ""),
            "lit": tags.get("lit", ""),
            "maxspeed": tags.get("maxspeed", ""),
            "url": f"https://www.openstreetmap.org/way/{el['id']}",
        },
        "geometry": {"type": "LineString", "coordinates": coords},
    }


def poi_to_feature(el):
    tags = el.get("tags", {})
    if el["type"] == "node":
        lon, lat = el["lon"], el["lat"]
    elif el.get("center"):
        lon, lat = el["center"]["lon"], el["center"]["lat"]
    else:
        return None

    typ = (
        tags.get("amenity")
        or tags.get("shop")
        or tags.get("tourism")
        or tags.get("information")
        or tags.get("leisure")
        or tags.get("building")
        or "sonstiges"
    )
    # Kirchen können unterschiedlich getaggt sein - alles auf eine Kategorie bringen
    if (
        typ == "place_of_worship"
        or tags.get("building") in ("church", "cathedral", "chapel", "basilica")
        or tags.get("historic") == "church"
        or typ in ("church", "cathedral", "chapel", "basilica")
    ):
        typ = "kirche"

    # Bänke sind keine POIs mehr (komplett entfernt)
    if typ == "bench":
        return None
    name = tags.get("name", "")
    if not name:
        name = {
            "drinking_water": "Trinkbrunnen",
            "bicycle_parking": "Fahrradparken",
            "bicycle_repair_station": "Reparaturstation",
            "viewpoint": "Aussichtspunkt",
            "toilets": "Toilette",
            "shelter": "Unterstand",
            "kirche": "Kirche",
        }.get(typ, typ)

    return {
        "type": "Feature",
        "id": f"{el['type']}/{el['id']}",
        "properties": {
            "id": el["id"],
            "typ": typ,
            "name": name,
            "website": tags.get("website", ""),
            "url": f"https://www.openstreetmap.org/{el['type']}/{el['id']}",
        },
        "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
    }


def read_elements(path):
    if not path.exists():
        print(f"  ! {path.name} fehlt - wird übersprungen")
        return []
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    return data.get("elements", [])


def write_collection(path, features, name, extra=None):
    # Nach ID deduplizieren (ein Weg kann mehreren OSM-Abfragekriterien entsprechen)
    seen = set()
    unique = []
    for feat in features:
        fid = feat["properties"]["id"]
        if fid not in seen:
            seen.add(fid)
            unique.append(feat)

    collection = {
        "type": "FeatureCollection",
        "name": name,
        "metadata": {
            "quelle": "OpenStreetMap (ODbL)",
            "abgerufen": date.today().isoformat(),
            "bbox": BB,
            "hinweis": "Frei editierbar. Anpassungen gehen beim erneuten Ausführen dieses Skripts verloren - bitte in data/eigene-*.geojson eintragen.",
            **(extra or {}),
        },
        "features": unique,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(collection, f, ensure_ascii=False, indent=1)
    print(f"  -> {path.relative_to(ROOT)}: {len(unique)} Features")
    return len(unique)


def main():
    print("Konvertiere Overpass-Daten ...")

    ways = read_elements(ROOT / "overpass/raw.json")
    features = [f for f in (way_to_feature(e) for e in ways) if f]
    write_collection(
        ROOT / "data/radwege-osm.geojson",
        features,
        "Radwege Sachsen-Anhalt Süd (OSM)",
        {"kategorien": ["radweg", "radweg-markierung", "fahrradstrasse", "bicycle-yes"]},
    )

    pois = read_elements(ROOT / "overpass/pois_raw.json")
    features = [f for f in (poi_to_feature(e) for e in pois) if f]
    write_collection(ROOT / "data/pois-osm.geojson", features, "Rad-POIs (OSM)")


if __name__ == "__main__":
    main()
