#!/usr/bin/env python3
"""Diagnose: welche Felder stecken wirklich in den Entities des DELFI-GTFS-RT-Feeds?"""
import struct
import sys

WT_VARINT, WT_64, WT_LEN, WT_32 = 0, 1, 2, 5


def read_varint(buf, i):
    shift = result = 0
    while True:
        b = buf[i]; i += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result, i
        shift += 7


def fields(buf):
    i, out = 0, []
    while i < len(buf):
        try:
            key, i = read_varint(buf, i)
        except IndexError:
            break
        fn, wt = key >> 3, key & 7
        try:
            if wt == WT_VARINT:
                v, i = read_varint(buf, i); out.append((fn, wt, v))
            elif wt == WT_64:
                out.append((fn, wt, buf[i:i + 8])); i += 8
            elif wt == WT_LEN:
                ln, i = read_varint(buf, i); out.append((fn, wt, buf[i:i + ln])); i += ln
            elif wt == WT_32:
                out.append((fn, wt, buf[i:i + 4])); i += 4
            else:
                break
        except (IndexError, ValueError):
            break
    return out


data = open(sys.argv[1], "rb").read()
top = fields(data)
print("Top-Level-Felder:", [(fn, wt) for fn, wt, _ in top][:6])

ents = [v for fn, wt, v in top if fn == 2 and wt == WT_LEN]
print("Entities:", len(ents))

for e in ents[:4]:
    sub = fields(e)
    kinds = {}
    ident = None
    for fn, wt, v in sub:
        kinds.setdefault(fn, 0)
        kinds[fn] += 1
        if fn == 1 and wt == WT_LEN and ident is None:
            ident = v.decode("utf-8", "replace")[:60]
    print(f"\nEntity id={ident!r} Felder={sorted(kinds)}")
    for fn, wt, v in sub:
        if fn in (2, 3, 4) and wt == WT_LEN:
            inner = fields(v)
            print(f"   Feld {fn} (len {len(v)}) -> Felder {[(a, b) for a, b, _ in inner][:12]}")
            # bei Feld 2/3 nach 'position' (Feld 2) und lat/lon suchen
            for a, b, c in inner:
                if b == WT_LEN and a == 2:
                    pos = fields(c)
                    vals = []
                    for pf, pw, pv in pos:
                        if pw == WT_32:
                            vals.append((pf, struct.unpack("<f", pv)[0]))
                        elif pw == WT_VARINT:
                            vals.append((pf, pv))
                    if vals:
                        print(f"       -> verschachtelt (Feld {a}) Werte: {vals[:6]}")
