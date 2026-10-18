"""
Sightings as files: GeoJSON (a FeatureCollection of Points, lon/lat order
as RFC 7946 requires) and CSV. Both carry lat, lon, class, score, time,
accuracy and model; thumbnails are left out (they are for the screen).
"""
from __future__ import annotations

import csv
import io
from datetime import datetime, timezone
from typing import Iterable, Optional

CSV_FIELDS = ["lat", "lon", "class", "score", "first_seen_utc", "last_seen_utc", "count",
              "accuracy_m", "model", "source", "id"]

NOTE = ("Positions are estimates from the drone's GPS, height and camera angle on "
        "flat ground; accuracy_m is the typical error in metres.")


def _iso(t: Optional[float]) -> Optional[str]:
    if t is None:
        return None
    return datetime.fromtimestamp(float(t), tz=timezone.utc).isoformat()


def _row(s: dict) -> dict:
    return {
        "lat": round(float(s["lat"]), 7), "lon": round(float(s["lon"]), 7),
        "class": s.get("label"), "score": s.get("best_score"),
        "first_seen_utc": _iso(s.get("first_seen")), "last_seen_utc": _iso(s.get("last_seen")),
        "count": s.get("count"), "accuracy_m": s.get("accuracy_m"),
        "model": s.get("model_name"), "source": s.get("source"), "id": s.get("id"),
    }


def to_geojson(sightings: Iterable[dict], **meta) -> dict:
    feats = []
    for s in sightings:
        r = _row(s)
        props = {k: v for k, v in r.items() if k not in ("lat", "lon")}
        feats.append({"type": "Feature",
                      "geometry": {"type": "Point", "coordinates": [r["lon"], r["lat"]]},
                      "properties": props})
    return {"type": "FeatureCollection", "features": feats,
            "properties": {"note": NOTE, **{k: v for k, v in meta.items() if v is not None}}}


def to_csv(sightings: Iterable[dict]) -> str:
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=CSV_FIELDS, lineterminator="\n")
    w.writeheader()
    for s in sightings:
        w.writerow(_row(s))
    return buf.getvalue()
