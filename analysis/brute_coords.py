#!/usr/bin/env python3
"""Brute-Force-Test: enthält der Feed überhaupt gültige Koordinaten (float32 lat/lon)?

Unabhängig vom Protobuf-Schema: sucht im Rohdatenstrom nach zwei aufeinanderfolgenden
float32-Werten, die als Breite/Länge im Raum Darmstadt plausibel sind.
"""
import struct
import sys

LAT_MIN, LAT_MAX = 49.0, 50.6
LON_MIN, LON_MAX = 7.9, 9.6

path = sys.argv[1]
data = open(path, "rb").read()
print(f"Datei: {path} ({len(data)/1e6:.1f} MB)")

hits = []
i = 0
n = len(data)
while i < n - 8:
    lat = struct.unpack_from("<f", data, i)[0]
    if LAT_MIN < lat < LAT_MAX:
        lon = struct.unpack_from("<f", data, i + 4)[0]
        if LON_MIN < lon < LON_MAX:
            hits.append((i, lat, lon))
            i += 8
            continue
    i += 1

print(f"Plausible lat/lon-Paare gefunden: {len(hits)}")
for off, lat, lon in hits[:10]:
    print(f"   Offset {off}: {lat:.5f}, {lon:.5f}")

# Gegenprobe: kommen Koordinaten auch als double vor?
hits_d = 0
i = 0
while i < n - 16 and hits_d < 3:
    lat = struct.unpack_from("<d", data, i)[0]
    if LAT_MIN < lat < LAT_MAX:
        lon = struct.unpack_from("<d", data, i + 8)[0]
        if LON_MIN < lon < LON_MAX:
            print(f"   double-Koordinate bei {i}: {lat:.5f}, {lon:.5f}")
            hits_d += 1
            i += 16
            continue
    i += 1
print(f"double-Koordinaten: {hits_d}")

# Woraus besteht eine Entity? Rohbytes der ersten beiden zeigen
entities = 0
i = 0
print("\n--- Rohbytes der ersten Entities ---")
while i < n - 4 and entities < 2:
    key = data[i]
    if key == 0x12:                      # Feld 2, len -> Entity
        j = i + 1
        ln = 0
        shift = 0
        while True:
            b = data[j]; j += 1
            ln |= (b & 0x7F) << shift
            if not (b & 0x80):
                break
            shift += 7
        body = data[j:j + ln]
        print(f"Entity {entities}: {ln} Bytes | hex: {body[:80].hex()}")
        print(f"          ascii: {''.join(chr(c) if 32 <= c < 127 else '.' for c in body[:80])}")
        entities += 1
        i = j + ln
        continue
    i += 1
