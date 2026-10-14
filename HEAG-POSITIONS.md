# HEAG live positions (IVANTO SRS) — integrated

Where the only **true vehicle coordinates** in this map come from, and what they are not.

## Source

`https://heagmobilo-live.geomobile.de/` is a geomobile frontend on top of the **IVANTO SRS** API. The
map consumes

```
GET https://service.ivanto.de/srs/api/v1/vehiclelivedata?tenant=heag
```

- **Keyless** and **`access-control-allow-origin: *`** on preflight and GET — re-measured 2026-10-14,
  so a browser page can call it directly, no proxy. Only `tenant=heag` answers; other tenants 404.
- Returns `{timestamp, vehicles:[…]}`: `latitude`, `longitude`, `bearing`, `vehicleId`, `line`,
  `direction`, `category`, `date`, `status`, `deviation`, `fillLevels`, `encodedPath`.
- The operator's own refresh interval measured ~20 s, so this map polls every **30 s**.
- A browser cannot send its own `User-Agent` (forbidden header) — the request carries the normal one,
  no extra headers, and nothing is fetched more often than needed.

## What it does *not* provide

| Field | Measured | Consequence |
|---|---|---|
| `delay` | `null` on every vehicle | punctuality still comes from the DELFI prognoses, never from here |
| `fillLevels` | `["UNKNOWN"]` on every vehicle | not used; would show "unknown" and nothing else |
| `deviation` | 0, −10, +40, +70, +130, −200 … | unit undocumented → **not used** |
| `category` | 1 = tram, 5 = bus | used to place the dot in the right mode layer |
| coverage | HEAG's own fleet only (trams + the buses HEAG runs) | RMV/DADINA buses and all rail are absent — an enhancement for part of the map, never a replacement |

Polled at night it yields ~73 vehicles; the counted split was 25 trams / 48 buses.

## The three rules this integration follows

1. **One source per vehicle, never two dots.** A twin is matched by line + proximity (< 350 m): the
   operator dot replaces the derived one and *inherits* its delay and stop list. Only if no twin
   exists does an operator-only dot appear — then the card says that delays and stops are unknown.
2. **Provenance is labelled per vehicle, in both languages.** Operator dots read
   *"Position: reported live by the operator (HEAG mobilo)."*; derived dots keep
   *"Position derived from realtime stop prognoses (the open feed carries no GPS)."* Both are bold and
   in the accent colour, and the credits box states the mix in one line.
3. **No hard dependency.** If the endpoint fails, is rate-limited or changes shape, nothing is
   deleted: entries simply age out (`MAX_AGE_MS`, 2 min) and the map draws the derived positions
   again exactly as it did before this feature.

## Licence

This is the operator's app backend, not a published open-data feed. There is no licence text we can
rely on. The credits box names it as an operator feed for that reason. If HEAG objects or the endpoint
closes, the switch is a one-liner: stop calling `DarmstadtHeag.start()`.
