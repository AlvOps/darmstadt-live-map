# Architecture — Darmstadt Live Map

Short, factual description of how the site works and where the numbers come from. Code comments are
German (as everywhere in this repository); README, UI text and documentation are English.

## Files and layers

```
docs/index.html   markup + CSS + the app shell: creates the MapLibre map, the deck.gl overlay,
                  the panel/pane switcher, search wiring, favourites, drawer, attribution.
                  It owns `state` (mode switches, selected line index, quiet-timer `state.selAt`).
docs/live.js      the realtime module (one IIFE, exposed as `window.DarmstadtLive`):
                  feed client → vehicle model → interpolation → DOM markers → cards → camera → stats.
docs/i18n.js      EN/DE string table, `I18N.t/detect/apply/set`, `langchange` event.
docs/search.js    pure functions: stop matching + favourites in localStorage (`darmstadt-live-favs`).
docs/data/meta.json  72 lines (name, mode, agency, colour, endpoints) and the station dump.
docs/manifest.webmanifest, favicon.svg, icon-192/512.png, apple-touch-icon.png
analysis/         measurement scripts, the four suites, and `test_behaviour.js` (offline behaviour).
```

No build step, no bundler, no server: every file is a classic `window.*` script loaded by
`index.html` (they are **not** ES modules), and GitHub Pages serves `master`/`docs` as-is.

## Data flow

```
GET /api/v1/map/trips  (bbox + zoom + 1 min window) ─┐
GET /api/v1/map/stops  (same bbox, static content)  ─┤ every 30 s, and 700 ms after a map move
                                                     ▼
                                    buildVehicles()  →  running hop per trip
                                                     ▼
       DOM markers (one element per vehicle)     vehiclesAt(t) → interpolated [lon, lat] per frame
                                                     ▼
   click: GET /api/v1/trip?tripId=…  → stop sequence + street geometry (drawn run, next 3 stops)
   click a stop: GET /api/v1/stoptimes?stopId=… → next departures
   unknown stop name: GET /api/v1/geocode?text=…&type=STOP
```

Every request goes through `timedFetch()` with a 12 s deadline (`AbortController`): one hung request
must not keep `refreshInFlight` set and block all later polls. A refresh requested while another is in
flight is remembered (`pendingRefresh`) and repeated once the current one finishes.

## Rules that are not negotiable

1. **No invented positions.** Only `realTime === true` hops are drawn; the position is the progress
   `u = (now − departure) / (arrival − departure)` along the hop's *real* polyline. Vehicles without
   realtime are dropped — a purely scheduled position would be a hallucination, not an observation.
2. **Dwelling is drawn, gaps are not.** Between two hops of a trip the feed carries no running hop.
   The next hop is already in the payload, so the vehicle is held at its stop (`u = 0`, `holding: true`)
   for up to `HOLD_MS` (2.5 min) instead of vanishing on every poll. A hop that ended more than
   `LEG_GRACE_MS` (90 s) ago is dropped.
3. **Two polyline encodings.** `/map/trips` `polyline` is precision **1e5**, `/trip` `legGeometry.points`
   is **1e7**. The factor is passed at each call site and asserted in `test_static.js`. A wrong factor
   puts every point far outside the view and the map stays empty.
4. **One source per line.** Only the open DELFI feed (via Transitous/MOTIS). Operator positions
   (HEAG IVANTO) are not used — see `HEAG-POSITIONS.md`.
5. **Honest freshness.** `lastOk` is the *fetch* time, not the age of the upstream data, so the status
   line says "fetched N s ago". The badge/status line distinguish fresh (< `STALE_MS` 45 s, pulsing),
   stale (45 s – `EXPIRED_MS`), and out of date (> 2 min); a failed attempt counts as "not fresh"
   immediately, so an outage never looks like a live feed. Missing scheduled times yield
   "delay unknown", never "on time".
6. **Never raw API text in HTML.** All feed strings are escaped (`esc`) before they reach `innerHTML`.

## Selection model

One shared state: `state.selLine` + `state.selAt` (quiet timer) and, inside `live.js`, `popupVehicle`.

| Selection | Vehicles drawn | Stops drawn |
|---|---|---|
| none | all, filtered by the mode switches | all stops in view |
| a line (panel chip) | only that line | hidden for `RELAX_MS` (10 s) after the last interaction, then back |
| a vehicle | that one highlighted, the rest faded | only its own next hops |

A tap on a vehicle clears the line selection (`selectLine(null)`); picking a line calls
`DarmstadtLive.clearVehicle()`, which closes the card, its connector and the drawn run. Gestures and
Escape release the desktop camera follow after `FOLLOW_MS` (2 s).

## Markers

Markers and stop dots are DOM buttons (round pills, mode-coloured, with an inline SVG pictogram), not
deck.gl layers: deck.gl cannot draw a rounded background or a per-mode symbol. `#markers` is moved into
`map.getCanvasContainer()` at start-up, so a pan/pinch/wheel gesture that begins **on a marker** still
reaches MapLibre's handlers while taps go to the marker first. Positions come from `map.project()` and
are refreshed in every animation frame (`syncMarkers()`), decoupled from the throttled layer rebuild.

## Tests and CI

* `analysis/test_behaviour.js` — offline, deterministic, one end-to-end check per fixed defect
  (fixtures instead of the live API). This is where a new feature gets its behaviour check.
* `analysis/test_static.js`, `test_i18n.js` — offline source/markup checks (CSS facts, key parity).
* `analysis/test_live.js`, `test_ui.js` — hit the real API; `test_live` is time-of-day dependent.
* `.github/workflows/tests.yml` — the three offline suites on every push and pull request, plus a
  scheduled, non-blocking `test_live` and `check_tile_ceiling` run.

Rule of thumb: a regex over the source text may only assert what is not observable in behaviour
(markup, CSS facts, file layout). Anything that moves, loads, draws or answers gets a behavioural test
through the public API — that is exactly the gap that let the "street-following line", the camera
swing and the drawn-run colour ship broken while `test_static` stayed green.
