# Darmstadt Live Map

Interactive map of public transport in Darmstadt, Germany: trams, city/regional buses and
S-Bahn/regional trains. This fork of `agent-mili/darmstadt_nahverkehr` adds a **realtime layer**
driven by the open DELFI realtime feed — plus a full **EN/DE language toggle**, a **vehicle popup**
with the upcoming stops, and a **phone-first layout**.

Live: https://alvops.github.io/darmstadt_nahverkehr/

## Two modes

| Mode | Content | Source |
|------|---------|--------|
| **Realtime** (default) | Vehicles with **realtime data only**, their delay, and the delay distribution | DELFI realtime prognoses via Transitous/MOTIS |
| **Timetable (simulation)** | Replay of the published timetable (weekday/Saturday/Sunday), playback speed, daily profile | static GTFS (DELFI via gtfs.de) |

In realtime mode positions are **interpolated locally** between polls, so a 30 s poll interval
still yields smooth movement.

## Features

- **Realtime only.** Only vehicles that actually carry realtime data are drawn. Vehicles without
  realtime are dropped — a position derived solely from the timetable would be invented, not observed.
- **Vehicle popup.** Tap a vehicle: line badge in its line colour, delay status
  (`on time` / `+N min late` / `−N min early`), operator, and the **next stops** with their
  clock times and per-stop delay (fetched on demand from `/api/v1/trip`).
- **EN/DE toggle** in the top-right corner. English is the default; the choice is remembered
  (`localStorage`). Everything switches — panels, legend, tooltips, popup, banner, histogram caption.
- **Phone-first UI.** Compact header on small screens, bottom-sheet popup, ≥40 px touch targets,
  safe-area insets for notched displays, and no hover-only tooltips on touch devices.
- **Honest labelling.** The popup states that positions are derived from realtime stop prognoses,
  because the open feed contains no GPS.

## Files

```
docs/index.html      UI, map (MapLibre + deck.gl), timetable simulation
docs/i18n.js         EN/DE strings + toggle + apply/set logic
docs/live.js         realtime module (polling, vehicles, positions, layers, popup, stats)
docs/data/meta.json  lines, colours, stops, tram tracks (used by both modes)
docs/data/*.json     static timetable data (simulation mode only)
analysis/            scripts that established and verify the API's data model
```

Realtime mode needs only `meta.json` from `docs/data/`; the timetable files load when the
timetable mode is selected.

## Data sources and licences

| Data | Origin | Licence |
|------|--------|---------|
| Realtime (prognoses) | DELFI e.V., via `api.transitous.org` (MOTIS) | **CC BY-SA 4.0** |
| Timetable (simulation) | DELFI via gtfs.de | **CC BY 4.0** |
| Route geometries | generated with pfaedle | — |
| Base map | CARTO dark-matter, © OpenStreetMap contributors | ODbL |

**Attribution is required** (CC BY / CC BY-SA); the UI names the sources in the map attribution
and the header panel. Redistributing the data requires the same terms (share-alike).

## How the realtime API works — and what it does not provide

Established by direct measurement; every claim is reproducible with the scripts in `analysis/`.

* **There is no GPS.** A `GET /api/v1/map/trips` entry is a **stop-to-stop hop** of a trip, not a
  vehicle position: `from`/`to` (stops with `lat`/`lon`), `departure`/`arrival` (actual times),
  `scheduledDeparture`/`scheduledArrival`, `realTime`, `polyline` (the hop's geometry),
  `trips[0].tripId`, `routeShortName`. The polyline starts exactly at `from` and ends exactly at
  `to` (0–3 m deviation, measured) — it carries **no** position.
* **No coordinates anywhere in the feed.** A brute-force scan of the 50 MB national DELFI realtime
  protobuf finds **zero** plausible float32/double latitude/longitude pairs
  (`analysis/brute_coords.py`). The content is stop-level SIRI-ET prognoses (stop ids, times).
  German-language sources confirm this: every DELFI realtime offering is *SIRI ET*; there is no
  open *SIRI VM* vehicle-position feed for Darmstadt.
* **Position is therefore derived:** progress `u = (now − departure) / (arrival − departure)`,
  the point at `u` along the hop's real geometry. Because `departure`/`arrival` are the *actual*
  times where `realTime: true`, the vehicle moves at its real (delayed) pace. Vehicles without
  realtime are not drawn at all.
* **Parameters:** `min`/`max` must be ordered **`lat,lon`** (reversed returns an empty list);
  `zoom`, `startTime` and `endTime` are required. Keep the window small: 1 min ≈ 280 kB,
  30 min ≈ 1.2 MB — longer windows only add future hops.
* **Oversized areas** can return HTTP 422, so the module clamps the bbox span (`MAX_SPAN`) and zoom.
* **User-Agent:** the API rejects generic/missing user-agents with HTTP 403
  ("Generic user-agent headers are not allowed, please set your own"). Browsers send their own;
  your own scripts must set one.
* **Long-distance excluded:** ICE/IC (`HIGHSPEED_RAIL`, `LONG_DISTANCE`), long-distance coaches
  (`COACH`) and aircraft have hops with thousands of geometry points reaching Stuttgart or
  Nuremberg — deliberately not drawn, matching the scope of the timetable simulation.
* Vehicles outside the visible map view are dropped as well.

## Run locally

```bash
cd docs && python3 -m http.server 8080
# http://localhost:8080/
```

No build step; MapLibre and deck.gl come from jsDelivr.

## Verify

```bash
node analysis/test_live.js        # loads docs/live.js, fetches real data, checks vehicles/positions/layers
node analysis/test_ui.js          # checks realtime-only filtering, the popup and the EN/DE toggle
python3 analysis/where_is_vehicle.py   # proves: polyline == hop geometry, no position field
python3 analysis/hop_structure.py      # hop/vehicle structure, payload per time window
python3 analysis/poll_shape.py         # payload vs. time window and bbox limits
python3 analysis/brute_coords.py       # proves: zero coordinates in the realtime feed
python3 analysis/diag_feed.py          # shows what the feed entities actually contain
```

The Node tests stub the DOM/deck.gl and run headless. A pixel-level check in a real browser is
separate — note that headless browsers on a desktop Linux box often lack working WebGL or
outbound networking, so verify in a normal browser window.
