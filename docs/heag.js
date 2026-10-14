/* Echte HEAG-Fahrzeugpositionen (IVANTO SRS) — die einzige Position-Quelle, die es hier gibt.
 *
 * Woher das kommt: die HEAG-Livemap (heagmobilo-live.geomobile.de) ist ein geomobile-Frontend auf der
 * IVANTO-SRS-API. `…/vehiclelivedata?tenant=heag` antwortet ohne Schlüssel und mit
 * `access-control-allow-origin: *` (gemessen 2026-10-14, Preflight und GET) — deshalb geht der Abruf
 * direkt aus der Seite, ohne Proxy. Eigenschaften, die den Entwurf bestimmen:
 *
 *   - Es deckt die HEAG-Flotte ab (Straßenbahnen + HEAG-Busse), nichts sonst: kein RMV/DADINA-Bus,
 *     keine Bahn. Es ist damit eine Ergänzung, kein Ersatz für den offenen Strom.
 *   - `delay` ist immer null → Verspätung kommt weiter von uns, nur die Position vom Betreiber.
 *   - `fillLevels` ist überall `["UNKNOWN"]`, `deviation` ist undokumentiert → wird nicht benutzt.
 *   - Kein veröffentlichter Lizenztext: App-Backend, kein Open-Data-Feed. Der Hinweis dazu steht in
 *     der Quellenangabe der Karte.
 *
 * Drei Regeln, die dieses Modul einhält: (1) eine Quelle je Fahrzeug — live.js ersetzt die abgeleitete
 * Position desselben Fahrzeugs, zeichnet nie zwei Punkte; (2) die Herkunft steht in jeder Fahrzeugkarte;
 * (3) keine harte Abhängigkeit — schlägt der Abruf fehl, bleibt alles wie ohne dieses Modul.
 *
 * Kein User-Agent-Kopf möglich: Browser verbieten `User-Agent` bei fetch (forbidden header). Wir pollen
 * deshalb höflich (30 s, die App selbst aktualisiert ~20 s) und ohne zusätzliche Kopfzeilen.
 */
(function () {
  'use strict';

  const URL = 'https://service.ivanto.de/srs/api/v1/vehiclelivedata?tenant=heag';
  const REFRESH_MS = 30000;
  const MAX_AGE_MS = 120000;              // älter -> nicht mehr als Live-Position zeichnen

  let list = [];                          // zuletzt geholte Fahrzeuge (bereits geprüft)
  let timer = null, on = false, lastOk = 0, lastErr = null, calls = 0;
  let onChange = null;

  const num = v => (typeof v === 'number' && isFinite(v)) ? v : Number(v);
  const MODE_BY_CATEGORY = { 1: 'tram', 5: 'bus' };   // gemessen: 1 = Straßenbahn, 5 = Bus

  function parse(data) {
    const raw = (data && Array.isArray(data.vehicles)) ? data.vehicles : [];
    const t = Date.now();
    const out = [];
    for (const v of raw) {
      if (!v || v.offline === true) continue;
      const lat = num(v.latitude), lon = num(v.longitude);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const at = v.date ? Date.parse(v.date) : NaN;
      if (isFinite(at) && t - at > MAX_AGE_MS) continue;          // zu alt: nicht als live zeigen
      out.push({
        line: String(v.line == null ? '' : v.line).trim(),
        lat, lon,
        bearing: Number.isFinite(num(v.bearing)) ? num(v.bearing) : null,
        vehicleId: v.vehicleId,
        category: num(v.category),
        mode: MODE_BY_CATEGORY[num(v.category)] || null,
        dest: String(v.direction || ''),
        at: isFinite(at) ? at : null,
      });
    }
    return out;
  }

  async function tick() {
    calls++;
    try {
      const res = await fetch(URL, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const next = parse(await res.json());
      if (!next.length) throw new Error('leer');
      list = next;
      lastOk = Date.now();
      lastErr = null;
    } catch (e) {
      // Absicht: nichts löschen. Alte Einträge verfallen über MAX_AGE_MS von selbst, und fällt die
      // Quelle dauerhaft aus, zeichnet live.js einfach wieder die abgeleiteten Positionen.
      lastErr = String((e && e.message) || e);
    }
    if (typeof onChange === 'function') { try { onChange(); } catch (_) {} }
    return list;
  }

  function start(cb) {
    if (on) return;
    on = true;
    onChange = cb || null;
    tick();
    timer = setInterval(tick, REFRESH_MS);
    if (timer && timer.unref) timer.unref();
  }

  function stop() {
    on = false;
    if (timer) clearInterval(timer);
    timer = null;
  }

  window.DarmstadtHeag = {
    URL, REFRESH_MS,
    start, stop, tick,
    list: () => list,
    info: () => ({ on, count: list.length, lastOk, lastErr, calls }),
    _test: { parse, MAX_AGE_MS, reset(l, err) { list = l || []; lastErr = err || null; } },
  };
})();
