# Darmstadt Live Map

Interactive **live-only** map of public transport in Darmstadt, Germany: trams, city/regional buses
and S-Bahn/regional trains. This fork of `agent-mili/darmstadt_nahverkehr` replaced the original
timetable replay with a **realtime layer** driven by the open DELFI realtime feed — plus a full
**EN/DE language toggle**, a **vehicle popup** with the upcoming stops, and a **phone-first layout**.

The timetable simulation (and its data files) was removed on 2026-10-14: the site shows live
vehicles only, so nothing on the map is ever derived from a schedule.

Live: https://alvops.github.io/darmstadt-live-map/

Repository: `AlvOps/darmstadt-live-map` (renamed from `darmstadt_nahverkehr` on 2026-10-14; GitHub
redirects the old repository and Pages URLs, but the current address is the one above).

## What the selection does

The map answers the question "where is *my* bus?" instead of drowning it in dots:

| Selection | Vehicles | Stops |
|-----------|----------|-------|
| none | all lines, coloured | all live stops |
| **a line** (chip in the panel) | **only that line**, camera swings to it | hidden — after **10 s without any interaction** they come back, so the stripped view is never a dead end |
| **a vehicle** (clicked on the map, or a stop in its card) | that vehicle highlighted, the rest faded | **only that vehicle's own next stops** |

Any tap on the map, a drag or Escape clears the selection and restores the full view. The 10 s quiet
timer lives in `state.selAt` and is shared by `index.html` and `live.js`.

In realtime mode positions are **interpolated locally** between polls, so a 30 s poll interval
still yields smooth movement.

## Features

- **Realtime only.** Only vehicles that actually carry realtime data are drawn. Vehicles without
  realtime are dropped — a position derived solely from the timetable would be invented, not observed.
- **Vehicle popup.** Tap a vehicle: line badge in its line colour, delay status
  (`on time` / `+N min late` / `−N min early`), operator, and the **next 3 stops** with their
  clock times and per-stop delay (fetched on demand from `/api/v1/trip`). The card opens next to
  the dot, follows the vehicle as it moves and stays inside the viewport.
- **Connector line.** A thin dashed line runs from the card's bottom-left corner to the exact dot it
  belongs to, so there is never a doubt which vehicle a card is describing.
- **Movable card (mouse).** Drag the card to shove it somewhere convenient; it keeps its offset,
  stays attached to its dot and is **clamped to the viewport**, so it can never be pushed off the
  top edge where it could not be grabbed again. On touch the card is held as a bottom sheet instead —
  no dragging there.
- **Stations on the map.** Live mode draws the stops the feed publishes for the current view
  (`/api/v1/map/stops`) — real stop coordinates and stop ids, not our timetable dump. Tapping one
  moves the camera onto it and opens a card with the **next departures**: line badge in the line
  colour, destination, clock time, relative arrival and delay (from `/api/v1/stoptimes`). Tapping a
  stop inside a vehicle card jumps **instantly** (no camera animation) to that station and opens it.
- **Short camera follow (desktop only).** On a computer, tapping a vehicle zooms onto it and follows
  it for 2 s, then releases; a wheel, drag, tap or Escape releases it immediately. On a phone there
  is **no sticky follow** — a tap centres the vehicle once, **above the bottom sheet** so the bus you
  picked is actually visible, and the map then belongs to you. Picking a line swings the camera to
  the vehicles of that line.
- **Delay histogram.** The bar under the map shows the live clock and the current spread of delays
  across the vehicles in view (`#tl`, drawn by `live.js`).
- **EN/DE toggle** in the top-right corner. English is the default (also for German browsers);
  the choice is remembered (`localStorage`). Everything switches — panels, legend, tooltips, popup,
  banner, histogram caption, `aria-label`s, document title and the map attribution.
  `analysis/test_i18n.js` fails if a key is missing in one language or if markup/JS contains
  hardcoded human-readable text.
- **Phone-first UI.** Touch is detected by **pointer**, not just width — a landscape phone is wider
  than 700 px and used to miss the drawer entirely. The panel is a **drawer** with a handle that
  always sits in the same place (top-left, directly above the panel) and says what it does:
  `☰ Lines` opens, `✕ Close panel` closes. Tapping a vehicle *or picking a line* slides the panel
  away, so the map shows what you just chose. The header switches between *Lines* and
  *Status & filters* so both fit without scrollbars, the card becomes a bottom sheet, all touch
  targets are ≥40 px, safe-area insets are respected and hover-only tooltips are disabled on touch
  devices.
- **Honest labelling.** The popup states that positions are derived from realtime stop prognoses,
  because the open feed contains no GPS.
- **Bounded map.** The map is not the world: it is bounded to the region the project actually
  covers — Darmstadt with Frankfurt/Wiesbaden/Mainz to the north and west, Aschaffenburg/Miltenberg
  to the east and Weinheim/Heidelberg to the south (`maxBounds [[7.85, 49.15], [9.45, 50.35]]`,
  `minZoom: 9`, `renderWorldCopies: false`). Panning was unbounded before, so you could drag north
  forever. The numbers come from measurement, not taste: `analysis/measure_extent.js` scans the feed
  over a grid wider than the expected data space and reports where the lines we draw really end.
  Note that the feed returns *whole trips*, so a through-running train brings hop geometry from far
  away — another reason to bound the view (our own metadata spans lat 49.29–50.23, lon 8.24–9.28).

## Files

```
docs/index.html      UI, map (MapLibre + deck.gl), line browser, drawer, card + connector
docs/i18n.js         EN/DE strings + toggle + apply/set logic
docs/live.js         realtime module (polling, vehicles, stations, popup, camera follow, layers, stats)
docs/data/meta.json  lines, colours, endpoints — the only data file left (no timetable data)
docs/favicon.svg     site icon (vector, used for the browser tab and the manifest)
docs/apple-touch-icon.png, docs/icon-192.png, docs/icon-512.png   opaque PNG icons
docs/manifest.webmanifest   web app manifest (relative start_url/scope "./")
analysis/            scripts that established and verify the API's data model
```

Scripts and styles carry a `?v=…` cache buster so a push reaches phones immediately instead of
being served from the 10-minute asset cache. GitHub Pages caches the **HTML** the same way, and a
cached page paired with a fresh `live.js` is exactly how a shipped feature can look missing — so
`index.html` compares its own version constant with `DarmstadtLive.VERSION` (loaded fresh) and, on a
mismatch, moves itself to a versioned URL that cannot be cached.

### Icon

`favicon.svg` is a hand-written, self-contained SVG (no text, no external references): a dark
rounded square in the app background colour `#0b0d12` with a tram-red route curve between a white
stop ring and a yellow "live" dot — legible at 16×16. The PNGs (180/192/512 px, opaque RGB, since
iOS ignores transparency) are drawn from the same geometry with Python Pillow, because no SVG
rasteriser (rsvg-convert/ImageMagick/cairosvg) was available on the build machine. All icon paths are
relative so they work under the GitHub Pages subpath.

## Data sources and licences

| Data | Origin | Licence |
|------|--------|---------|
| Realtime (prognoses) | DELFI e.V., via `api.transitous.org` (MOTIS) | **CC BY-SA 4.0** |
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
* **No coordinates anywhere in the feed** — not even inside its `VehiclePosition` messages.
  Measured on the national DELFI GTFS-RT feed (53.9 MB, 2026-10-14): 237,062 entities, every one of
  them a `FeedEntity.vehicle`, and **0** of them carrying a `Position` (latitude/longitude). An
  independent brute-force scan of the same bytes finds **0** plausible float32 or double lat/lon
  pairs anywhere in the file. What the entities actually carry are stop ids (`de:06411:…`) and times.
  All three checks are reproducible from this repository:

  ```bash
  curl -A 'darmstadt-live-map/1.0' -o /tmp/gtfsrt.pb https://germany.motis-project.org/gtfsrt
  python3 analysis/scan_vehiclepositions.py /tmp/gtfsrt.pb  # 237062 vehicle entries, 0 with coordinates
  python3 analysis/brute_coords.py          /tmp/gtfsrt.pb  # 0 plausible coordinate pairs (float32/double)
  python3 analysis/diag_feed.py             /tmp/gtfsrt.pb  # raw entity fields: stop ids and times only
  ```

  This matches the feed's SIRI-ET nature: stop-level prognoses, no vehicle positions. German-language
  sources confirm there is no open SIRI-VM vehicle-position feed for Darmstadt.
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
  Nuremberg — deliberately not drawn.
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
node analysis/test_ui.js          # realtime-only filtering, popup (races, timers, failures), XSS escaping,
                                  # malformed API records, polling stop, + test_i18n + test_static
node analysis/test_i18n.js        # EN/DE key coverage + hardcoded-string scan (offline)
node analysis/test_static.js      # CSS for phones/scrollbars/legend sizing, status-pill contrast, assets,
                                  # icons, basemap zoom cap (offline)
node analysis/check_tile_ceiling.js    # ONLINE: measures the basemap's real tile ceiling and fails if the
                                       # cap baked into index.html no longer matches
node analysis/check_stations.js       # ONLINE: compares our station coordinates with the positions the
                                      # feed publishes for the same stops (median deviation 10 m)
node analysis/measure_extent.js       # ONLINE: scans the feed over a wide grid and reports how far the
                                      # lines we draw actually reach (source of the map's maxBounds)
python3 analysis/where_is_vehicle.py   # proves: polyline == hop geometry, no position field
python3 analysis/hop_structure.py      # hop/vehicle structure, payload per time window
python3 analysis/poll_shape.py         # payload vs. time window and bbox limits
# the three feed scans need the national raw feed first (53.9 MB):
curl -A 'darmstadt-live-map/1.0' -o /tmp/gtfsrt.pb https://germany.motis-project.org/gtfsrt
python3 analysis/scan_vehiclepositions.py /tmp/gtfsrt.pb   # vehicle messages: 0 of them carry coordinates
python3 analysis/brute_coords.py          /tmp/gtfsrt.pb   # independent brute-force coordinate scan
python3 analysis/diag_feed.py             /tmp/gtfsrt.pb   # raw entity fields (stop ids, times)
```

The Node tests stub the DOM/deck.gl and run headless. A pixel-level check in a real browser is
separate — note that headless browsers on a desktop Linux box often lack working WebGL or
outbound networking, so verify in a normal browser window.
