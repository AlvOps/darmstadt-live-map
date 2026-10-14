#!/usr/bin/env python3
"""How do hops relate to vehicles? Check duplicate tripIds, time windows, modes, payload size."""
import datetime
import json
import urllib.request
from collections import Counter

NOW = datetime.datetime.now(datetime.timezone.utc)


def fetch(bbox, zoom, minutes=30):
    t0 = NOW.strftime("%Y-%m-%dT%H:%M:%SZ")
    t1 = (NOW + datetime.timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")
    url = f"https://api.transitous.org/api/v1/map/trips?{bbox}&zoom={zoom}&startTime={t0}&endTime={t1}"
    raw = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "hermes-analysis"}), timeout=60).read()
    return len(raw), json.loads(raw)


def parse(ts):
    return datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))


for label, bbox, zoom in [
    ("central Darmstadt", "min=49.86,8.63&max=49.89,8.68", 14),
    ("wider Darmstadt", "min=49.83,8.60&max=49.93,8.75", 13),
    ("network-wide", "min=49.30,8.25&max=50.25,9.15", 11),
]:
    size, d = fetch(bbox, zoom)
    modes = Counter(t.get("mode") for t in d)
    trip_ids = Counter((t.get("trips") or [{}])[0].get("tripId") for t in d)
    dupes = {k: v for k, v in trip_ids.items() if v > 1}
    ids = [t.get("trips") or [{}] for t in d]
    with_id = sum(1 for x in ids if x[0].get("tripId"))
    in_progress = sum(1 for t in d if parse(t["departure"]) <= NOW <= parse(t["arrival"]))
    future = sum(1 for t in d if parse(t["departure"]) > NOW)
    rt = sum(1 for t in d if t.get("realTime"))
    print(f"\n=== {label} (zoom {zoom}) ===")
    print(f"  payload: {size/1024:.0f} KB | entries: {len(d)} | with tripId: {with_id} | realTime: {rt}")
    print(f"  distinct tripIds: {len(trip_ids)} | tripIds with >1 hop: {len(dupes)} (max hops {max(dupes.values()) if dupes else 0})")
    print(f"  hops in progress now: {in_progress} | future hops: {future}")
    print("  modes:", dict(modes.most_common(10)))
    multi = [k for k, v in dupes.items() if v > 1][:2]
    for tid in multi:
        hops = [t for t in d if (t.get("trips") or [{}])[0].get("tripId") == tid]
        print(f"   sample dup tripId hops: {len(hops)}")
        for h in hops[:4]:
            print(f"      {h['departure']} -> {h['arrival']}  {(h.get('from') or {}).get('name')} -> {(h.get('to') or {}).get('name')}  rt={h.get('realTime')}")
