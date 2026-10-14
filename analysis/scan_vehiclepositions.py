#!/usr/bin/env python3
"""Prüft, ob der DELFI-GTFS-RT-Feed echte Fahrzeugpositionen (VehiclePosition.lat/lon) enthält.

Handgeschriebener Protobuf-Scanner (nur Python-Standardbibliothek):

  FeedMessage   { header = 1; entity = 2 (repeated) }
  FeedEntity    { id = 1; trip_update = 2; vehicle = 3; alert = 4 }
  VehiclePosition { trip = 1; position = 2; current_stop_sequence = 3; stop_id = 7 }
  Position      { latitude = 1 (fixed32/float); longitude = 2 (fixed32/float) }
"""
import struct
import sys

WT_VARINT, WT_64, WT_LEN, WT_32 = 0, 1, 2, 5


def read_varint(buf, i):
    shift = result = 0
    while True:
        b = buf[i]
        i += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result, i
        shift += 7


def fields(buf):
    """[[field_number, wire_type, value_or_bytes], ...]"""
    i, out = 0, []
    while i < len(buf):
        try:
            key, i = read_varint(buf, i)
        except IndexError:
            break
        fn, wt = key >> 3, key & 7
        try:
            if wt == WT_VARINT:
                v, i = read_varint(buf, i)
                out.append((fn, wt, v))
            elif wt == WT_64:
                out.append((fn, wt, buf[i:i + 8])); i += 8
            elif wt == WT_LEN:
                ln, i = read_varint(buf, i)
                out.append((fn, wt, buf[i:i + ln])); i += ln
            elif wt == WT_32:
                out.append((fn, wt, buf[i:i + 4])); i += 4
            else:
                break
        except (IndexError, ValueError):
            break
    return out


def main(path):
    data = open(path, "rb").read()
    print(f"Datei: {path} ({len(data)/1e6:.1f} MB)")

    entities = trip_updates = vehicles = alerts = with_position = 0
    hdr_version = None
    sample = None
    for fn, wt, val in fields(data):
        if fn == 1 and wt == WT_LEN:                      # FeedHeader
            for hfn, hwt, hval in fields(val):
                if hfn == 3 and hwt == WT_LEN:            # gtfs_realtime_version
                    hdr_version = hval.decode("utf-8", "replace")
        elif fn == 2 and wt == WT_LEN:                    # FeedEntity
            entities += 1
            for efn, ewt, eval_ in fields(val):
                if efn == 2:
                    trip_updates += 1
                elif efn == 3:                            # VehiclePosition
                    vehicles += 1
                    for vfn, vwt, vval in fields(eval_):
                        if vfn == 2 and vwt == WT_LEN:    # Position
                            lat = lon = None
                            for pfn, pwt, pval in fields(vval):
                                if pfn == 1 and pwt == WT_32:
                                    lat = struct.unpack("<f", pval)[0]
                                elif pfn == 2 and pwt == WT_32:
                                    lon = struct.unpack("<f", pval)[0]
                            if lat is not None and lon is not None:
                                with_position += 1
                                if sample is None:
                                    sample = (lat, lon)
                elif efn == 4:
                    alerts += 1

    print(f"  Feed-Version        : {hdr_version}")
    print(f"  Entities            : {entities}")
    print(f"  TripUpdates         : {trip_updates}")
    print(f"  VehiclePositions    : {vehicles}")
    print(f"  Alerts              : {alerts}")
    print(f"  davon mit Koordinaten: {with_position}")
    if sample:
        print(f"  Beispielkoordinate  : {sample[0]:.5f}, {sample[1]:.5f}")


if __name__ == "__main__":
    main(sys.argv[1])
