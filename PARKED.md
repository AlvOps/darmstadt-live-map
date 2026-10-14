# Parked ideas

Deliberately **not** built yet, with the reasoning recorded so nothing has to be rediscovered.

## HEAG live positions from the IVANTO SRS API

**What was found (2026-10-14):** `https://heagmobilo-live.geomobile.de/` is a geomobile frontend on
top of the **IVANTO SRS** API. `https://service.ivanto.de/srs/api/v1/vehiclelivedata?tenant=heag`
answers **without a key** and with **`access-control-allow-origin: *`** on both the preflight and the
GET — so it is callable straight from this page, no proxy. It returns real coordinates plus
`bearing`, `vehicleId`, `line`, `direction`, `encodedPath`, `status`, `deviation`, `fillLevels`; the
own refresh interval measured ~20 s, and `tenant` must be `heag` (other tenants 404).

**Caveats measured, not assumed:**

- `delay` is `null` on every vehicle → the feed carries **no punctuality** at all.
- `fillLevels` is `["UNKNOWN"]` on every vehicle → the field exists, HEAG publishes no occupancy.
- `deviation` (0, −10, +40, +70, +130, −200 …) looks like a schedule deviation in seconds, but the
  unit is undocumented — cross-check it against our own delay for the same vehicle before using it.
- It covers **HEAG's own fleet only** (its trams and the buses it runs). Not RMV/DADINA/other
  regional buses, not rail. So it is an enhancement for part of the map, never a replacement.
- It is the operator's app backend: no published licence, no terms we can rely on. That is the
  open question and it is the operator's call, not ours.

**If it is built, these three rules apply:**

1. **One source per vehicle, never two dots.** Prefer the operator position when fresh (< ~60 s),
   fall back to our derived position otherwise. Two dots for one tram is worse than any label.
2. **Label provenance per vehicle, in EN and DE** ("Position: operator live" vs "Position: derived
   from realtime stop prognoses"). Same colour and shape for both — the text carries the
   difference, so nothing has to be decoded on a phone.
3. **Never a hard dependency.** If IVANTO stops answering (CORS could tighten, the endpoint is
   undocumented), the map keeps running exactly as it does today. Poll politely (~30 s), send a
   proper User-Agent, and state the caveat in the credits.

The payoff: a real dot for the HEAG fleet paired with **our** delay values — real position and real
punctuality, each labelled with its source, claiming nothing more than we have.
