#!/usr/bin/env python3
"""Find a cheap polling shape: short time windows, dedup by tripId, and the bbox/zoom limit that triggers 422."""
import datetime
import json
import urllib.request
from collections import Counter

NOW = datetime.datetime.now(datetime.timezone.utc)


def fetch(bbox, zoom, minutes):
    t0 = NOW.strftime("%Y-%m-%dT%H:%M:%SZ")
    t1 = (NOW + datetime.timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")
    url = f"https://api.transitous.org/api/v1/map/trips?{bbox}&zoom={zoom}&startTime={t0}&endTime={t1}"
    try:
        raw = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "hermes-analysis"}), timeout=60).read()
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}"
    return raw, json.loads(raw)


def parse(ts):
    return datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))


CENTRAL = "min=49.86,8.63&max=49.89,8.68"
LOCAL_MODES = {"TRAM", "BUS", "SUBURBAN", "SUBWAY", "REGIONAL_RAIL", "HIGHSPEED_RAIL", "LONG_DISTANCE", "NIGHT_RAIL"}

print("=== payload vs time-window length (central Darmstadt, zoom 14) ===")
for minutes in (1, 2, 5, 10, 30):
    raw, d = fetch(CENTRAL, 14, minutes)
    if d is None:
        print(f"  {minutes:3d} min -> {raw}"); continue
    local = [t for t in d if t.get("mode") in LOCAL_MODES]
    inprog = [t for t in local if parse(t["departure"]) <= NOW <= parse(t["arrival"])]
    by_trip = {}
    for t in sorted(inprog, key=lambda x: x["departure"]):
        tid = (t.get("trips") or [{}])[0].get("tripId")
        by_trip.setdefault(tid, t)
    print(f"  {minutes:3d} min -> {len(raw)/1024:7.0f} KB | entries {len(d):5d} | local {len(local):5d} | "
          f"in progress {len(inprog):4d} | unique vehicles {len(by_trip):4d}")

print("\n=== how big a bbox/zoom is accepted? ===")
tests = [
    ("central", "min=49.86,8.63&max=49.89,8.68", 14),
    ("wider", "min=49.83,8.60&max=49.93,8.75", 13),
    ("whole city", "min=49.78,8.55&max=49.98,8.80", 12),
    ("big", "min=49.70,8.45&max=50.05,8.95", 11),
    ("huge", "min=49.30,8.25&max=50.25,9.15", 11),
]
for name, bbox, zoom in tests:
    raw, d = fetch(bbox, zoom, 2)
    if d is None:
        print(f"  {name:12s} zoom {zoom} -> {raw}")
    else:
        print(f"  {name:12s} zoom {zoom} -> {len(raw)/1024:7.0f} KB | entries {len(d)}")

print("\n=== sample: what one vehicle looks like after dedup (1-min window) ===")
raw, d = fetch(CENTRAL, 14, 1)
local = [t for t in d if t.get("mode") in LOCAL_MODES and parse(t["departure"]) <= NOW <= parse(t["arrival"])]
for t in local[:4]:
    tr = (t.get("trips") or [{}])[0]
    delay = int((parse(t["departure"]) - parse(t["scheduledDeparture"])).total_seconds() // 60)
    print(f"  {t['mode']:5s} L{str(tr.get('routeShortName')):4s} delay {delay:+3d} | "
          f"{(t.get('from') or {}).get('name')} -> {(t.get('to') or {}).get('name')} | "
          f"{t['departure']}..{t['arrival']} | rt={t.get('realTime')} | color={t.get('routeColor')}")
