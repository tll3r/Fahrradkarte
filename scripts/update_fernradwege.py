#!/usr/bin/env python3
"""
Holt die Abschnitte bekannter Fernradwege aus OpenStreetMap, die unseren
Kartenausschnitt beruehren, und schreibt data/bekannte-radwege.geojson.

Aufruf:
    python3 scripts/update_fernradwege.py

Die OSM-Routen sind Relationen. Fuer jede Relation werden nur die Mitgliedswege
innerhalb des Kartenausschnitts geladen, damit die Datei klein bleibt.
"""
import json
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OVERPASS = "https://overpass.openstreetmap.fr/api/interpreter"
BB = (51.40, 12.00, 52.05, 13.10)  # S, W, N, O

ROUTES = [
    {
        "key": "elberadweg",
        "label": "Elberadweg (D10)",
        "relations": [2087672, 2599026, 2599028, 7758087, 8632725, 8632715],
    },
    {
        "key": "berlin-leipzig",
        "label": "Radweg Berlin–Leipzig (RBL)",
        "relations": [5449281, 5449279, 13320, 3114903],
    },
]


def query(relation_id):
    q = (
        "[out:json][timeout:120];"
        f"rel(id:{relation_id});"
        f"way(r)({BB[0]},{BB[1]},{BB[2]},{BB[3]});"
        "out geom;"
    )
    data = urllib.parse.urlencode({"data": q}).encode("utf-8")
    req = urllib.request.Request(
        OVERPASS,
        data=data,
        headers={
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "Accept": "application/json",
            "User-Agent": "Fahrradkarte/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=180) as res:
        return json.load(res).get("elements", [])


def relation_tags(relation_id):
    q = f"[out:json][timeout:60];rel(id:{relation_id});out tags;"
    data = urllib.parse.urlencode({"data": q}).encode("utf-8")
    req = urllib.request.Request(
        OVERPASS,
        data=data,
        headers={"User-Agent": "Fahrradkarte/1.0", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as res:
            els = json.load(res).get("elements", [])
            return els[0].get("tags", {}) if els else {}
    except Exception:
        return {}


def main():
    features = []
    for route in ROUTES:
        seen = set()
        count = 0
        for rid in route["relations"]:
            tags = relation_tags(rid)
            name = tags.get("name") or route["label"]
            ref = tags.get("ref", "")
            for el in query(rid):
                wid = el.get("id")
                geom = el.get("geometry") or []
                if wid in seen or len(geom) < 2:
                    continue
                seen.add(wid)
                coords = [
                    [round(p["lon"], 6), round(p["lat"], 6)]
                    for p in geom
                    if "lon" in p and "lat" in p
                ]
                if len(coords) < 2:
                    continue
                features.append({
                    "type": "Feature",
                    "id": f"fern/{rid}/{wid}",
                    "properties": {
                        "id": wid,
                        "kategorie": route["key"],
                        "route": route["label"],
                        "name": name,
                        "ref": ref,
                        "highway": el.get("tags", {}).get("highway", ""),
                        "url": f"https://www.openstreetmap.org/relation/{rid}",
                    },
                    "geometry": {"type": "LineString", "coordinates": coords},
                })
                count += 1
        print(f"  {route['label']}: {count} Wege")

    collection = {
        "type": "FeatureCollection",
        "name": "Bekannte Fernradwege (OSM)",
        "metadata": {
            "quelle": "OpenStreetMap (ODbL)",
            "abgerufen": date.today().isoformat(),
            "bbox": BB,
            "hinweis": "Nur Abschnitte im Kartenausschnitt. Wird von scripts/update_fernradwege.py erzeugt.",
        },
        "features": features,
    }
    out = ROOT / "data/bekannte-radwege.geojson"
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as f:
        json.dump(collection, f, ensure_ascii=False, indent=1)
    print(f"  -> {out.relative_to(ROOT)}: {len(features)} Features")


if __name__ == "__main__":
    main()
