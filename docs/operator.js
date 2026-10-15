/* Live-Positionen des Betreibers (IVANTO SRS, Mandant „heag") — die einzige Quelle mit echtem GPS.
 *
 * Woher das kommt: die HEAG-Livemap (heagmobilo-live.geomobile.de) ist ein geomobile-Frontend auf der
 * IVANTO-SRS-API. `…/vehiclelivedata?tenant=heag` antwortet ohne Schlüssel und mit
 * `access-control-allow-origin: *`, sobald die Anfrage einen Origin-Kopf trägt (Browser senden ihn
 * immer) — deshalb geht der Abruf direkt aus der Seite, ohne Proxy. Gemessen 2026-10-15 (Werktag):
 *
 *   - ~150 Fahrzeuge, je Fahrzeug ein neuer `date` etwa alle 20 s; die gemeldete Position ist das ENDE
 *     von `encodedPath` (der Pfad ist das zuletzt gefahrene Stück, ~20 s).
 *   - Abdeckung: NICHT nur HEAG. Dabei sind auch DADINA-Linien (WE1–4, MO1–4, RH, BE1, GB, DG, PE,
 *     OR1 …), die RMV-Linien 671/X69/X71 und VRN 693 — zusammen 41 der 72 Linien aus meta.json.
 *     Nicht dabei: Bahn, 40, 662/672/673, X14/X15/X74, 3A, OF-73, V92. SEV-Busse der Straßenbahn
 *     heißen hier „4"/„8", im offenen Strom „4E"/„8E" (die Zuordnung macht live.js).
 *   - `delay` ist immer null, `fillLevels` immer UNKNOWN, kein Tempo-Feld, `deviation` undokumentiert
 *     → nichts davon wird benutzt. Eine Verspätung gibt es für diese Fahrzeuge also schlicht nicht.
 *   - `status` ist 1 oder 4; 4 sind vermutlich Fahrzeuge außer Dienst, die Bedeutung ist aber nicht
 *     dokumentiert. Sie werden verworfen (lieber ein Punkt zu wenig als ein Geisterfahrzeug).
 *
 * Wie live.js das benutzt — EINE QUELLE JE LINIE, nie je Fahrzeug:
 *   Eine Linie (Verkehrsart + Liniennummer), für die dieses Modul frische Fahrzeuge meldet, wird im
 *   Betriebsgebiet ausschließlich aus diesen Positionen gezeichnet; die aus Prognosen abgeleiteten
 *   Punkte derselben Linie entfallen dort. Alle anderen Linien bleiben beim offenen Strom. Es wird
 *   bewusst KEIN Fahrzeug dem anderen zugeordnet: ein früherer Versuch mit Paarung über Nähe ist
 *   gescheitert (Zwillinge lagen im Median 250–290 m, im p90 bis 1,4 km auseinander) und wurde
 *   entfernt. Dieses Modul liefert nur die Liste und den Gesundheitszustand; die Regel steht in
 *   live.js (selectSources).
 *
 * Keine harte Abhängigkeit: fehlt diese Datei oder schlägt der Abruf fehl, zeichnet live.js alles
 * aus dem offenen Strom, genau wie ohne dieses Modul.
 *
 * Kein User-Agent-Kopf möglich: Browser verbieten `User-Agent` bei fetch (forbidden header). Wir pollen
 * deshalb höflich (30 s, die App selbst aktualisiert ~20 s) und ohne zusätzliche Kopfzeilen.
 */
(function () {
  'use strict';

  const URL = 'https://service.ivanto.de/srs/api/v1/vehiclelivedata?tenant=heag';
  const REFRESH_MS = 30000;
  const MAX_AGE_MS = 120000;              // älter -> nicht mehr als Live-Position zeichnen
  const STALE_MS = 90000;                 // so lange ohne erfolgreiche Antwort -> live.js fällt zurück
  const TIMEOUT_MS = 12000;               // Frist je Abruf (wie in live.js)

  let list = [];                          // zuletzt geholte Fahrzeuge (bereits geprüft)
  let timer = null, on = false, lastOk = 0, lastErr = null, calls = 0, startedAt = 0, inFlight = false;
  let onChange = null;

  const num = v => (typeof v === 'number' && isFinite(v)) ? v : Number(v);
  const MODE_BY_CATEGORY = { 1: 'tram', 5: 'bus' };   // gemessen: 1 = Straßenbahn, 5 = Bus

  // Reine Rechnung (testbar): Rohantwort -> geprüfte Fahrzeuge. Alles Unbrauchbare fliegt raus.
  function parse(data, nowMs) {
    const raw = (data && Array.isArray(data.vehicles)) ? data.vehicles : [];
    const t = typeof nowMs === 'number' ? nowMs : Date.now();
    const out = [];
    for (const v of raw) {
      if (!v || typeof v !== 'object' || v.offline === true) continue;
      // status 4: vermutlich nicht im Dienst — undokumentiert, deshalb vorsichtshalber verworfen.
      if (num(v.status) === 4) continue;
      const mode = MODE_BY_CATEGORY[num(v.category)] || null;
      if (!mode) continue;                                         // unbekannte Kategorie: nicht raten
      const lat = num(v.latitude), lon = num(v.longitude);
      if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0)) continue;
      const line = String(v.line == null ? '' : v.line).trim();
      if (!line) continue;
      const at = v.date ? Date.parse(v.date) : NaN;
      if (!isFinite(at)) continue;                                 // ohne Meldezeit kein Alter -> nicht live
      if (t - at > MAX_AGE_MS) continue;                           // zu alt: nicht als live zeigen
      out.push({
        line, mode, lat, lon,
        bearing: Number.isFinite(num(v.bearing)) ? num(v.bearing) : null,
        vehicleId: v.vehicleId == null ? '' : String(v.vehicleId),
        dest: String(v.direction || ''),
        at,
      });
    }
    return out;
  }

  async function tick() {
    if (inFlight) return list;
    inFlight = true;
    calls++;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const tm = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
    try {
      const res = await fetch(URL, ctrl ? { cache: 'no-store', signal: ctrl.signal } : { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const next = parse(await res.json());
      if (!next.length) throw new Error('empty');
      list = next;
      lastOk = Date.now();
      lastErr = null;
    } catch (e) {
      // Absicht: nichts löschen. Alte Einträge verfallen über MAX_AGE_MS von selbst, und nach
      // STALE_MS ohne Erfolg zeichnet live.js ohnehin wieder alles aus dem offenen Strom.
      lastErr = String((e && e.message) || e);
    } finally {
      clearTimeout(tm);
      inFlight = false;
    }
    if (typeof onChange === 'function') { try { onChange(); } catch (_) { /* Anzeige ist nicht unser Problem */ } }
    return list;
  }

  function start(cb) {
    onChange = cb || onChange;
    if (on) return;
    on = true;
    startedAt = Date.now();
    tick();
    timer = setInterval(() => { if (typeof document === 'undefined' || !document.hidden) tick(); }, REFRESH_MS);
    if (timer && timer.unref) timer.unref();
  }

  function stop() {
    on = false;
    if (timer) clearInterval(timer);
    timer = null;
  }

  // Gesundheit für live.js: stale = seit STALE_MS keine erfolgreiche Antwort (oder noch nie eine).
  function health(nowMs) {
    const t = typeof nowMs === 'number' ? nowMs : Date.now();
    return { on, lastOk, lastErr, startedAt, calls, stale: !lastOk || t - lastOk > STALE_MS };
  }

  // Nur Fahrzeuge, deren Meldung noch jung genug ist (die Liste kann nach einem Ausfall altern).
  function vehicles(nowMs) {
    const t = typeof nowMs === 'number' ? nowMs : Date.now();
    return list.filter(v => t - v.at <= MAX_AGE_MS);
  }

  window.DarmstadtOperator = {
    URL, REFRESH_MS, MAX_AGE_MS, STALE_MS,
    start, stop, tick, vehicles, health,
    _test: { parse, reset(l, ok, err) { list = l || []; lastOk = ok || 0; lastErr = err || null; } },
  };
})();
