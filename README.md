# Darmstadt Public Transport Map

Interactive **live-only** map of public transport in Darmstadt, Germany: trams, city/regional buses
and S-Bahn/regional trains. The project started from the open-source base
`agent-mili/darmstadt_nahverkehr`, whose timetable replay it replaced with a **realtime layer** driven
by the open DELFI realtime feed — plus a full **EN/DE language toggle**, a **vehicle popup** with the
upcoming stops, and a **phone-first layout**.

The timetable simulation (and its data files) was removed on 2026-10-14: the site shows live
vehicles only, so nothing on the map is ever derived from a schedule.

Live: **https://darmstadtmap.com/** (and https://alvops.github.io/darmstadt-live-map/, which redirects there)

The main page **is the operator view** since 2026-10-15: on the lines the operator reports, a dot is the
operator's own GPS position (marked with a small green dot); every other vehicle stays derived from
realtime stop prognoses. The slim view — open feed only, no operator requests — is still one parameter
away: `?hybrid=0`.

Repository: `AlvOps/darmstadt-live-map` — an **independent repository**, not a GitHub fork and not part
of any fork network. It was rebuilt as a standalone repository on 2026-10-15 (the earlier fork lives on
as the archived `AlvOps/darmstadt-nahverkehr-fork`). The app calls itself **Darmstadt Public Transport
Map** — *Nahverkehrskarte Darmstadt* in German; the repository keeps its `darmstadt-live-map` name.

**Custom domain.** The map is served at **https://darmstadtmap.com/** (and on `www.`). The certificate
is a Let's Encrypt one that GitHub Pages obtains and renews by itself — nothing to install — and
`https_enforced` is on, so `http://` as well as the `github.io` URLs redirect to the domain. DNS lives
at Cloudflare and must stay **DNS-only (grey cloud)**; the orange proxy would block GitHub's certificate
check. Records: `A @` and `A www` → 185.199.108.153, 185.199.109.153, 185.199.110.153,
185.199.111.153; `AAAA @` → 2606:50c0:8000::153, `::8001::153`, `::8002::153`, `::8003::153`.

Two traps learned here: while the records were missing, the `CNAME` file made GitHub 301 the `github.io`
URLs into a domain that did not resolve, so the site was unreachable and the domain had to be parked
until the records existed. And when checking "is the new version live", verify **on the domain itself** —
the Pages CDN caches pages for 600 s (`cache-control: max-age=600`) and a stale browser cache looks
exactly like a failed deploy.

**Branches.** `main` is the only production branch, and it is what GitHub Pages serves (`main` / `docs`).
`stable` is kept as the rollback point. The former working branches `master` and `operator-hybrid` were
deleted on 2026-10-15: the hybrid view is a **query parameter on the same page**, not a separate branch,
so nothing had to live on a branch of its own. A private mirror of the whole repository exists at
`AlvOps/darmstadt-live-map-backup`.

## What the selection does

The map answers the question "where is *my* bus?" instead of drowning it in dots:

| Selection | Vehicles | Stops |
|-----------|----------|-------|
| none | all lines, coloured | all live stops |
| **a line** (chip in the panel) | **only that line**, camera swings to it | hidden — after **10 s without any interaction** they come back, so the stripped view is never a dead end |
| **a vehicle** (clicked on the map, or a stop in its card) | **only that vehicle, plus its route line** — every other vehicle and every foreign stop disappears, there is no quiet-timer that brings them back, and zooming out does not undo it | **only that vehicle's own next stops** |

Any **tap on the map** or Escape clears the selection and restores the full view; a **drag** only
restarts the quiet timer (`state.selAt`, shared by `index.html` and `live.js`), so a highlight is never
lost just because the map moved. Picking a **line** replaces a vehicle selection: the card, the
connector and the drawn run disappear before the line is highlighted.

Open-feed positions are **interpolated locally** between polls (30 s), so movement stays smooth without
extra requests. Operator vehicles are different: their report says how old it is (roughly every 20 s), and
the marker replays the **encoded street path** between reports instead of gliding on a straight chord —
which is why a tracked tram follows the rails instead of cutting across a building.

## Features

- **The cartographic map is the start state.** Every load begins on the light OSM street map; a previously
  chosen view is deliberately **not** restored (the stored preference is discarded). The toggle cycles
  cartographic → standard (dark vector) → satellite and works within the session. Tram tracks are drawn
  from our own `docs/data/meta.json` (`tram_tracks`, 399 polylines) as a thin layer under the markers —
  OSM tiles carry no transit layer — and the map zooms to z17 so a marker and the street beneath it can be
  told apart.
- **A short start, in your language.** On the first visit the page asks *Choose language* (the same
  EN | DE toggle as the header, only bigger to hit) and then shows the guide: what the two kinds of dots
  are, what the times are, that this is a personal project and not an official app. The guide returns on
  every visit; the language question only until a language has been chosen once. The four-step tour that
  used to follow the guide is currently switched off — its strings stay in `docs/i18n.js` for later.
- **Stop search.** The field beside the pane switcher searches the stops we ship plus the live stops
  of the current view: umlaut- and case-folded, ranked name-start > word-start > mid-name, duplicates
  dropped, capped at 7. Picking a hit jumps the camera to that stop instantly and opens its card (the
  stop is resolved against the feed, so departures work too). On a phone the panel steps aside for the
  jump; on a computer it stays where it is.
- **Favourites.** A third pane holds saved stops (star on a stop card) and saved lines (star in the
  selected-line row), both removable, both one tap away again. Stored in `localStorage` — this is a
  static page with no server that could receive a cookie (`docs/search.js`, key `darmstadt-live-favs`).
- **Proof of provenance, twice.** Every vehicle card and the credits box (`ⓘ`) say which kind of position
  is shown, in bold, in the accent colour and in both languages: the operator's own **GPS fix** on the
  lines HEAG reports (with the age of that report), or a position **derived from realtime stop prognoses**
  where only the open feed speaks — that feed carries no GPS at all. The credits are where a reader checks
  the source, so the note lives there too, not only in the card.
- **Labelled vehicle markers, always on.** Every vehicle is a rounded pill carrying a mode pictogram
  (bus / tram / rail as inline SVG) and its line number in dark text. The pill takes the **colour of
  its mode** — tram red, bus turquoise, rail purple, the same colours as the switches in the panel —
  not the line's own colour: `meta.json` only carries three colours for 72 lines, so per-mode colour is
  the honest description and keeps the map readable on a dark basemap. In the overview the pills shrink
  slightly below zoom 14 so they do not pile up. They are drawn **by MapLibre itself** (a GeoJSON source
  plus a symbol layer whose image is one pill rasterised per line in `live.js`), not as DOM elements:
  nothing is re-positioned per frame, a pan or pinch is plain map gesture, and a tap is resolved with
  `queryRenderedFeatures` — vehicle before the stop behind it.
- **Stops are circled letters,** like the sign on the street: **H** in German (*Haltestelle*), **S** in
  English (*station*) — one per stop, never per platform. The visible circle is ~13 px; its tap target is
  an invisible 26 px circle (WCAG 2.2 asks for 24 px).
- **Click a vehicle: the whole run of its line.** Besides the card, the map draws every stop of that
  trip in order — the stretches already covered included — using the trip's own **street geometry**
  (`legGeometry`, decoded at 1e7), and removes it again when the card closes. Straight stop-to-stop
  segments remain only as a fallback for trips that carry no geometry.
- **Two sources, one per line — and the panel says which.** The page merges HEAG's own vehicle reports
  (IVANTO SRS) with the open feed: on the lines the operator reports, the marker is the operator's GPS fix;
  every other line stays derived from stop prognoses. Each **line chip** in the panel carries a dot —
  **green** = this line has an operator GPS vehicle, **blue** = it runs from prognoses only, **red** = it is
  not running at all right now — with a matching legend beside the header's realtime badge. Red is a
  network-wide statement: it comes from a separate, slow city-wide poll (one request per minute), not from
  whatever happens to be visible in the current view. Its limits are properties of the data: the snapshot
  can be a minute old, a line running without realtime data still shows red, and "city-wide" is the
  Darmstadt + Umland box. The feed measurements and the merge rule are in
  [`HEAG-POSITIONS.md`](HEAG-POSITIONS.md).
- **Big, tappable markers.** A pill is roughly 30 × 22 px with 12.5 px text, so a thumb hits the right
  vehicle without zooming first — much easier than the 6.5 px dots this replaced.
- **The drawn line follows the streets.** Tapping a vehicle shows its whole line using the trip's own
  geometry (`legGeometry`, 419 points at 6.3 m spacing on a measured tram line) instead of straight
  stop-to-stop segments, which were 52× coarser and 8% short. Stops are only the fallback when a trip
  carries no geometry. Two encodings are involved — section polylines from `/map/trips` at 1e5, trip
  geometry from `/trip` at 1e7 — so the factor is passed at each call site and asserted in the tests.
- **Realtime only.** Only vehicles that actually carry realtime data are drawn. Vehicles without
  realtime are dropped — a position derived solely from the timetable would be invented, not observed.
- **Vehicle popup.** Tap a vehicle: line badge in its mode colour, delay status
  (`on time` / `+N min late` / `−N min early`; **no scheduled time means “delay unknown”**, never a
  claimed “on time”), operator, and the **next 3 stops** with their
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
  moves the camera onto it. With the optional local RMV proxy, the card uses RMV HAFAS rows exclusively:
  line, direction, planned and realtime time, platform/changed track, cancellation and board-message text,
  with RMV attribution. If the proxy is off or cannot resolve that stop, the existing MOTIS card remains
  the fallback; sources are never mixed within a card. The RMV proxy is called only on a visible card
  action, with a 60-second cache and no background polling. Tapping a stop inside a vehicle card jumps
  **instantly** (no camera animation) to that station and opens it.
- **Short camera follow (desktop only).** On a computer, tapping a vehicle zooms onto it and follows
  it for 2 s, then releases; a wheel, drag, tap or Escape releases it immediately. On a phone there
  is **no sticky follow** — a tap centres the vehicle once, **above the bottom sheet** so the bus you
  picked is actually visible, and the map then belongs to you. Picking a line swings the camera to
  the vehicles of that line.
- **EN/DE toggle** in the top-right corner. **German is the default** — it is a Darmstadt map, and the
  first visit asks before anything else is shown; English comes after an explicit choice. The choice is
  remembered (`localStorage`). Everything switches — panels, legend, tooltips, popup, banner, histogram
  caption, `aria-label`s, document title and the map attribution.
  `analysis/test_i18n.js` fails if a key is missing in one language or if markup/JS contains
  hardcoded human-readable text.
- **The corner.** Bottom left: a small pill with the live clock (tabular figures, so it does not jitter
  between minutes) and the ⓘ that opens the source and licence list — BMVI/DELFI (CC BY-SA 4.0),
  OpenStreetMap (ODbL), CARTO, Esri for the satellite layer, and HEAG mobilo/IVANTO for the operator
  positions. The optional RMV issue bar appears only when the local RMV proxy is reachable and filtered
  notices are returned; it collapses to one compact row and is never polled in the background.
- **Phone-first UI.** Touch is detected by **pointer**, not just width — a landscape phone is wider
  than 700 px and used to miss the drawer entirely. The panel is a **drawer** with a handle that
  always sits in the same place (top-left, directly above the panel) and says what it does:
  `☰ Lines` opens, `✕ Close panel` closes. Tapping a vehicle *or picking a line* slides the panel
  away, so the map shows what you just chose. The header switches between *Lines* and
  *Status & filters* so both fit without scrollbars, the card becomes a bottom sheet, every **button**
  is at least 40 px tall (stop dots are 13 px on screen with a 33 px tap target), safe-area insets are
  respected and hover-only tooltips are disabled on touch devices.
- **Honest labelling.** The popup states where the position comes from: the operator's GPS fix with its age,
  or a position derived from realtime stop prognoses, because the open feed itself contains no GPS. The header badge and the status line say how old the data
  really is: **fresh** (< 45 s, pulsing), **stale** (45 s – 2 min, grey and *not* pulsing) or
  **out of date** (> 2 min, red, no pulse) — an outage can no longer look like a live feed. The status
  line reports the **fetch** time (“fetched N s ago”), not the age of the data upstream, and a hop that
  ended more than 90 s ago is dropped from the map instead of being drawn as if it were current.
  The thresholds live in `live.js` (`STALE_MS`, `EXPIRED_MS`, `LEG_GRACE_MS`) and are named in the
  credits box.
- **Bounded map.** The map is not the world: it is bounded to the region the project actually
  covers — Darmstadt with Frankfurt/Wiesbaden/Mainz to the north and west, Aschaffenburg/Miltenberg
  to the east and Weinheim/Heidelberg to the south (`maxBounds [[7.85, 49.15], [9.45, 50.35]]`,
  `minZoom: 9`, `renderWorldCopies: false`). Panning was unbounded before, so you could drag north
  forever. The numbers come from measurement, not taste: `analysis/measure_extent.js` scans the feed
  over a grid wider than the expected data space and reports where the lines we draw really end.
  Note that the feed returns *whole trips*, so a through-running train brings hop geometry from far
  away — another reason to bound the view (our own metadata spans lat 49.29–50.23, lon 8.24–9.28).

## Privacy, measurement and sharing

- **Nothing is measured before you agree.** Google Analytics 4 (`G-GTEHNPPMW6`) is not part of the page:
  the consent card at the bottom left loads the tag only after *Accept*, and *Only necessary* leaves it
  out completely. The answer is stored in `localStorage` (`darmstadt-live-consent`); the card stays away
  afterwards and only returns when that key is gone (private window, cleared storage).
- **Everything else stays on your device.** This is a static page with no server of its own: language
  (`darmstadt-live-lang`), favourites (`darmstadt-live-favs`) and the consent answer live in
  `localStorage`. The page itself sets no cookies; the hosted map requests map tiles and transit feeds,
  and — after consent — Google. In local development only, the optional RMV proxy receives on-demand
  station requests and keeps the access key on the machine running the proxy.
- **Search engines and sharing.** `docs/robots.txt` allows the whole site and points at
  `docs/sitemap.xml`; the map page carries a canonical URL, a description and Open Graph tags
  (`docs/og-image.png` for link previews, German as `og:locale` with English as the alternate), and
  `/hybrid/` is a short cut marked `noindex` so it never competes with the real address.

## Files

```
docs/index.html      UI, map (MapLibre + deck.gl), line browser, drawer, card + connector
docs/i18n.js         EN/DE strings + toggle + apply/set logic
docs/live.js         realtime module (polling, vehicles, stations, popup, camera follow, layers, stats)
docs/rmv.js          optional browser client for the key-holding local RMV proxy
analysis/rmv-proxy.js local Node proxy for on-demand RMV HAFAS boards and notices
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

HEAG mobilo's own app backend (IVANTO SRS) additionally serves **true coordinates for HEAG's own fleet**
— keyless and CORS-open, but without delays and without a published licence. It is **not** part of this
map: merging it with the open feed produced two markers for the same vehicle, which is worse than a
derived position. The measurements and the clean rule for a retry ("one source per line") are recorded
in [`HEAG-POSITIONS.md`](HEAG-POSITIONS.md).

## How the realtime API works — and what it does not provide

Established by direct measurement; every claim is reproducible with the scripts in `analysis/`.

* **There is no GPS in the open feed.** A `GET /api/v1/map/trips` entry is a **stop-to-stop hop** of a
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

The map runs without RMV: station cards fall back to MOTIS and the notice bar stays hidden. For optional
RMV HAFAS departures and service notices, start the local proxy in one terminal and the static site in another:

```bash
node analysis/rmv-proxy.js                   # reads ~/.config/rmv/accessId; never serves the key
cd docs && python3 -m http.server 8099
# http://127.0.0.1:8099/
```

The proxy listens on `127.0.0.1:8790`, allows only the two local origins on port 8099, caches each query
for 60 seconds and enforces the RMV limits (600 upstream calls/hour, 5000/day). It makes RMV requests only
when a visible station card is opened; it does not poll in the background. The browser sees only the proxy's
slim board/notices response and has no RMV credential. The proxy is optional; stop it and the map continues
working with MOTIS. Its address can be overridden with `?rmv=URL` or `window.DLM_RMV`.

No build step; MapLibre and deck.gl come from jsDelivr.

## Verify

```bash
node analysis/test_behaviour.js   # OFFLINE, deterministic: one end-to-end check per fixed defect
                                  # (street geometry reaches the map, a late /trip draws no line,
                                  # a dwelling vehicle survives the poll, departing rows tell the truth,
                                  # camera swing on real positions, stop cache follows the vehicle,
                                  # a refresh during a refresh is not dropped, version tokens in sync,
                                  # and the page's own inline script: picking a line runs without an
                                  # uncaught exception — selection field + favourite star update)
node analysis/test_static.js      # OFFLINE: CSS for phones/scrollbars/legend sizing, status-pill contrast,
                                  # assets, icons, basemap zoom cap
node analysis/test_i18n.js        # OFFLINE: EN/DE key coverage + hardcoded-string scan
node analysis/test_rmv.js         # OFFLINE: proxy shaping, cache, CORS, limits, disabled client
node analysis/test_live.js        # ONLINE: loads docs/live.js, fetches real data, checks vehicles/positions/layers
node analysis/test_ui.js          # ONLINE (real API): realtime-only filtering, popup (races, timers,
                                  # failures), XSS escaping, malformed API records, polling stop,
                                  # + test_i18n + test_static
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

For the full round trip (real Chromium over CDP, real feed, page served statically) there is an
opt-in smoke that is not part of the checks above; it fails on any uncaught exception on the page:

```bash
cd docs && python3 -m http.server 8099 &       # Pages-style static server
node analysis/smoke_browser.js http://127.0.0.1:8099/    # CHROME=/path/to/chrome to override
```
