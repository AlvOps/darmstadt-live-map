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
 * deshalb ohne zusätzliche Kopfzeilen, alle 10 s (die App selbst fragt jede Sekunde; je Fahrzeug kommt
 * etwa alle 20 s eine neue Meldung), und nur bei sichtbarem Tab.
 */
(function () {
  'use strict';

  const URL = 'https://service.ivanto.de/srs/api/v1/vehiclelivedata?tenant=heag';
  // 10 s statt 30 s: die Meldung je Fahrzeug frischt ohnehin nur alle ~20 s auf (gemessen), aber der
  // Abruf bestimmt, wie spät eine neue Meldung bei uns ankommt. Gemessen: ~49 kB je Antwort, also
  // ~17 MB/Stunde. 2 s wären 86 MB/Stunde und 68 % der Antworten wären inhaltsgleich — zu teuer.
  const REFRESH_MS = 10000;
  const MAX_AGE_MS = 120000;              // älter -> nicht mehr als Live-Position zeichnen
  const STALE_MS = 90000;                 // so lange ohne erfolgreiche Antwort -> live.js fällt zurück
  const TIMEOUT_MS = 12000;               // Frist je Abruf (wie in live.js)

  let list = [];                          // zuletzt geholte Fahrzeuge (bereits geprüft)
  let timer = null, on = false, lastOk = 0, lastErr = null, calls = 0, startedAt = 0, inFlight = false;
  let onChange = null;

  const num = v => (typeof v === 'number' && isFinite(v)) ? v : Number(v);
  const MODE_BY_CATEGORY = { 1: 'tram', 5: 'bus' };   // gemessen: 1 = Straßenbahn, 5 = Bus

  // Reine Rechnung (testbar): Rohantwort -> geprüfte Fahrzeuge. Alles Unbrauchbare fliegt raus.
  // Je Fahrzeug wird der rohe `encodedPath` mitgegeben (das zuletzt gefahrene Stück, endet an der
  // gemeldeten Position) und die Empfangszeit dieser Meldung (`seenAt`): live.js spielt den Pfad ab
  // dort ab, so wie die Betreiber-App (Abspiellogik und Herleitung stehen bei opPosAt in live.js).
  // `prev` = die Liste des letzten Abrufs, `nowMs` = Empfangszeit (Vorgabe: jetzt).
  function parse(data, prev, nowMs) {
    const before = new Map();
    for (const p of (Array.isArray(prev) ? prev : [])) {
      if (p && p.vehicleId) before.set(p.vehicleId, p);
    }
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
      const path = typeof v.encodedPath === 'string' ? v.encodedPath : '';
      const vid = v.vehicleId == null ? '' : String(v.vehicleId);
      const was = before.get(vid);
      // Dieselbe Meldung wie beim letzten Abruf (~68 % der Abrufe, gleiche Zeit, gleicher Ort, gleicher
      // Pfad): die Empfangszeit BEHALTEN, sonst finge das Abspielen bei jedem 10-s-Abruf von vorn an.
      // Neue Meldung (oder erstes Mal gesehen): Empfang = jetzt.
      const same = !!was && was.at === at && was.lat === lat && was.lon === lon && was.encodedPath === path &&
        Number.isFinite(was.seenAt);
      out.push({
        line, mode, lat, lon,
        encodedPath: path, seenAt: same ? was.seenAt : t,
        bearing: Number.isFinite(num(v.bearing)) ? num(v.bearing) : null,
        vehicleId: vid,
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
      const next = parse(await res.json(), list, Date.now());   // list = letzter Abruf (Empfangszeit je Meldung)
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
