#!/usr/bin/env python3
"""Determine where the realtime polyline places the vehicle (current position vs. stop geometry)."""
import datetime
import json
import math
import urllib.request

BBOX = "min=49.86,8.63&max=49.89,8.68"  # Darmstadt centre
T0 = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
T1 = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
URL = f"https://api.transitous.org/api/v1/map/trips?{BBOX}&zoom=14&startTime={T0}&endTime={T1}"

req = urllib.request.Request(URL, headers={"User-Agent": "hermes-analysis"})
d = json.loads(urllib.request.urlopen(req, timeout=60).read())
print("trips:", len(d))


def dec(s):
    i = lat = lon = 0
    out = []
    while i < len(s):
        for which in (0, 1):
            r = sh = 0
            while True:
                b = ord(s[i]) - 63
                i += 1
                r |= (b & 0x1F) << sh
                sh += 5
                if b < 0x20:
                    break
            dv = ~(r >> 1) if r & 1 else (r >> 1)
            lat += dv if which == 0 else 0
            lon += dv if which == 1 else 0
        out.append((lat * 1e-5, lon * 1e-5))
    return out


def meters(a, b):
    (la1, lo1), (la2, lo2) = a, b
    kx = 111320 * math.cos(math.radians((la1 + la2) / 2))
    return math.hypot((lo2 - lo1) * kx, (la2 - la1) * 110540)


print("\n=== full structure of one trip (from/to/trips included) ===")
print(json.dumps(d[0], indent=1)[:1200])
print("\n=== from/to keys across sample ===")
fk, tk = set(), set()
for t in d[:200]:
    fk |= set((t.get("from") or {}).keys())
    tk |= set((t.get("to") or {}).keys())
print("from keys:", sorted(fk))
print("to keys:", sorted(tk))

print("\n=== geometry check: polyline endpoints vs from/to stops ===")
n = 0
for t in d:
    pts = dec(t.get("polyline") or "")
    fr, to = t.get("from") or {}, t.get("to") or {}
    if len(pts) < 2 or "lat" not in fr or "lat" not in to:
        continue
    start_stop, end_stop = (fr["lat"], fr["lon"]), (to["lat"], to["lon"])
    d_start = meters(pts[0], start_stop)
    d_end = meters(pts[-1], end_stop)
    d_start_to_poly_start = meters(pts[0], start_stop)
    link = meters(start_stop, end_stop)
    print(f"  {t['mode']:5s} L{str((t.get('trips') or [{}])[0].get('routeShortName')):4s} "
          f"pts={len(pts):3d} poly[0]→from={d_start:7.0f}m poly[-1]→to={d_end:7.0f}m "
          f"stop-to-stop={link:7.0f}m dist_field={t.get('distance'):7.0f}")
    n += 1
    if n >= 10:
        break
