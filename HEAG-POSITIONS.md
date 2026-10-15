> Status: **implemented as a test page, switched off by default.** The rule kept from the failed
> attempt below is *one source per line* — lines the operator covers are drawn only from operator
> positions, every other line from the open feed. That removes duplicates by construction instead of
> matching dots after the fact. The published page is unchanged (no operator calls at all); the test
> page runs the same code with the switch on.

## The operator feed

The livemap at `heagmobilo-live.geomobile.de` is a geomobile front end on the IVANTO SRS API. The
feed behind it:

    https://service.ivanto.de/srs/api/v1/vehiclelivedata?tenant=heag

Keyless, `access-control-allow-origin: *` when the request carries an `Origin` header (browsers
always do), so the page calls it directly — no proxy, and the static no-server design survives.
Measured 2026-10-15 (weekday morning): ~49 kB, 151–155 vehicles, a per-vehicle `date` that advances
every ~20 s; the reported position is the end of `encodedPath`, i.e. the last ~20 s travelled.

Fields: `date`, `lineId`, `category` (1 = tram, 5 = bus), `direction`, `status`, `latitude`,
`longitude`, `bearing`, `type`, `line`, `vehicleId`, `encodedPath`, `deviation`, `offline`.
**`delay` is always null**, `fillLevels` is always `UNKNOWN`, and there is no speed field. Only
`tenant=heag` answers; other tenants 404. A keyed official API exists (`apidoc.portal.ivanto.de`,
`portal.ivanto.de/api/v0/vehicles/location`, `X-API-KEY`, 401 without a key) but a key cannot be
hidden in a static page.

## Coverage — wider than the fleet, and not "HEAG only"

~145 vehicles on 50 (mode, line) keys, covering **41 of the 72 lines in `docs/data/meta.json`**:
HEAG trams and buses plus DADINA lines (WE1–4, MO1–4, RH, BE1, GB, DG, PE, OR1…), RMV-branded
671/X69/X71 and VRN 693. **Not** covered: rail, 40, 662/672/673, X14/X15/X74, 3A, OF-73, V92 — those
keep the prognosis-based dots, which is exactly the split wanted here. Trams 4/5/7/8 are currently
replaced by buses, reported as BUS 4 / BUS 8.

## The rule (`selectSources`, pure and unit-tested)

1. **Coverage key** = mode + normalised line name. A key counts as covered when a fresh operator
   report (≤ 90 s old) for it was seen within the last 10 minutes.
2. **Alias table** `OP_ALIAS`: operator BUS `4` ≡ open BUS `4E`, operator BUS `8` ≡ `8E` (the SEV
   replacement runs; the twins sat 60–540 m apart). Without it, 4–6 dots per line appear twice.
3. **Scope gate**: a derived dot of a covered line is dropped **only** inside the operator's area —
   within 2 km of a current operator vehicle of the same key. Lines 1/3/4/6/8 also run in Offenbach
   ~35 km away and must stay visible there.
4. **Global fallback**, not per line: after 90 s without a successful operator response the operator
   data is ignored entirely, everything is drawn from the open feed, and a bilingual banner says so.
5. **Provenance** is the point: operator dots are labelled as the operator's own live report (with
   report age) and never show a delay (the feed sends none); derived dots keep the prognosis
   labelling. `status == 4` vehicles are filtered — their meaning is undocumented.

Operator sources lose the delay and the upcoming-stop list on their cards: `delay` is null and the
feed carries no stop sequence, and recovering it would mean pairing vehicles to trips — the approach
that failed. If card detail matters more than true positions, this trade is not worth making.

## Why the earlier attempt failed (do not rebuild it)

The removed version paired vehicles per trip: a twin was matched by line + proximity < 350 m and the
operator dot replaced the derived one. Measured twin distances between the two sources were median
250–290 m with p90 0.9–1.4 km, so no proximity threshold can separate a true twin from a different
vehicle. Removed in `6d649d8`; the module that did it (`docs/heag.js`) is gone.

## Switching it on

* Published page (`/`): off. No operator request is made at all.
* Test page: `/hybrid/` (equivalent to `/?hybrid=1`). Set by `?hybrid=1` in the URL or
  `window.DLM_OPERATOR = true`; `live.js` reads it in one place, and `operatorModule()` returns
  `null` while it is off, so start/stop, fallback and vehicle input are all gated together.
* Promoting it later is a wording/flag decision, not a rewrite — the wording is already in
  `docs/i18n.js` under the `*Operator` keys.

## Still unverified

Evening, night and weekend behaviour (all sampling was weekday-morning); what `status 4` and
`deviation` mean; whether the persistent RH/WE3 holes are real hidden buses; and the behaviour on a
real phone in a real browser (all probing was curl and the Node harness).
