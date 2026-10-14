/* Verhaltensprüfungen für die Fehler aus der Überprüfung (offline, deterministisch).
 *
 * Warum diese Datei: die vorhandenen Suiten prüfen überwiegend Quelltext (reguläre Ausdrücke über
 * docs/*.js). Genau deshalb waren M1 (Straßengeometrie fällt weg), M8 (Kamerafahrt auf NaN) und die
 * falsche Pillenfarbe unentdeckt. Hier wird JEDE Korrektur einmal von außen durch die öffentliche
 * Schnittstelle gefahren, mit festen Fixtures statt der Live-API:
 *
 *   M1  Straßenlinie wird gezeichnet (legGeometry kommt bis zur Karte durch)
 *   M2  verspätete /trip-Antwort zeichnet keine Linie (Geisterzug)
 *   M3  Linienwahl räumt die Fahrzeugauswahl weg (public clearVehicle + Verdrahtung in index.html)
 *   M4  Fahrzeug an einem Halt überlebt den Abruf (Abschnittslücke)
 *   M5  Abfahrten: Ausfall und reine Fahrplanzeit sind gekennzeichnet
 *   M6  Frischezustand der Daten ist berechenbar (frisch/veraltet/überholt)
 *   M8  Linienwahl schwenkt die Kamera auf echte Positionen (nicht auf NaN)
 *   M9  Halte einer offenen Karte wechseln mit dem Fahrzeug (Cache-Schlüssel)
 *   M10 hängender Abruf blockiert nicht: ein Abruf währenddessen wird nachgeholt
 *   M12 fehlende Soll-Zeit ergibt "Verspätung unbekannt", nicht 0 ("On time")
 *   Tok alle fünf Versionskennungen stehen auf demselben Wert
 *   M7  Marken hängen im Karten-Container (Gesten erreichen MapLibre)
 *
 * Usage: node analysis/test_behaviour.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const DOCS = path.join(__dirname, '..', 'docs');
const read = f => fs.readFileSync(path.join(DOCS, f), 'utf8');
const html = read('index.html'), liveSrc = read('live.js'), i18nSrc = read('i18n.js');
const META = JSON.parse(read(path.join('data', 'meta.json')));

// ---------- DOM-Attrappe (wie in test_ui.js, ohne Netz)
const els = {};
let newEls = 0;
function el(id) {
  if (els[id]) return els[id];
  const o = {
    id, textContent: '', innerHTML: '', hidden: false, style: {}, dataset: {},
    clientWidth: 900, clientHeight: 46, width: 0, height: 0,
    children: [],
    appendChild(c) {
      if (c.parentNode && c.parentNode.children) {
        const i = c.parentNode.children.indexOf(c);
        if (i >= 0) c.parentNode.children.splice(i, 1);
      }
      c.parentNode = o; o.children.push(c); return c;
    },
    remove() { const p = o.parentNode; if (p) { const i = p.children.indexOf(o); if (i >= 0) p.children.splice(i, 1); } o.removed = true; },
    classList: { _s: new Set(),
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); } },
    querySelector(sel) { return el(id + sel); },
    querySelectorAll() { return []; },
    getContext() { return { setTransform() {}, clearRect() {}, fillRect() {}, fillText() {}, set fillStyle(v) {}, set font(v) {} }; },
  };
  let cn = '';
  Object.defineProperty(o, 'className', {
    get: () => Array.from(o.classList._s).join(' ') || cn,
    set: v => { cn = String(v == null ? '' : v); o.classList._s = new Set(cn.split(/\s+/).filter(Boolean)); },
  });
  els[id] = o;
  return o;
}

const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const shortStop = n => String(n).replace(/^Darmstadt[- ]/, '');
const MODE_RGB = { tram: [255, 107, 107], bus: [46, 196, 182], rail: [199, 125, 255] };
class Layer { constructor(p) { Object.assign(this, p); } }

// ---------- Fixtures
const iso = ms => new Date(Date.now() + ms).toISOString();
function encPath(pts, factor) {          // [[lat, lon], …] -> Google-Polyline in der Präzision factor
  let out = '', pl = 0, pn = 0;
  const e = v => { v = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const [lat, lon] of pts) {
    const a = Math.round(lat * factor), b = Math.round(lon * factor);
    out += e(a - pl) + e(b - pn); pl = a; pn = b;
  }
  return out;
}
const line = (n, lat, lon, dLat, dLon) =>
  Array.from({ length: n }, (_, i) => [lat + dLat * i / (n - 1), lon + dLon * i / (n - 1)]);
const STREET = line(150, 49.8700, 8.6500, 0.0040, 0.0100);      // "Straße": 150 Stützpunkte
const sec = o => Object.assign({
  mode: 'TRAM', realTime: true, polyline: encPath(STREET, 1e5),
  departure: iso(-60000), arrival: iso(120000), scheduledDeparture: iso(-60000),
  from: { name: 'Darmstadt Schloss', stopId: 'de-DELFI_de:06411:1', lat: STREET[0][0], lon: STREET[0][1] },
  to: { name: 'Darmstadt Luisenplatz', stopId: 'de-DELFI_de:06411:2', lat: 49.874, lon: 8.660 },
  trips: [{ tripId: 'T-A', routeShortName: '4' }],
}, o);

// Fahrten für /trip: A mit Straßengeometrie (150 Punkte), B kurz (3 Punkte) und anderer Halteliste
const stopsOf = (tag, lat, lon) => [{ name: 'Halt ' + tag + ' 1', departure: iso(60000), scheduledDeparture: iso(60000), lat, lon, stopId: 'st-' + tag + '-1' },
  { name: 'Halt ' + tag + ' 2', departure: iso(120000), scheduledDeparture: iso(120000), lat: lat + 0.001, lon: lon + 0.002, stopId: 'st-' + tag + '-2' }];
const LEGS = {
  'T-A': { tripId: 'T-A', routeShortName: '4', agencyName: 'HEAG', startTime: iso(30000), endTime: iso(200000),
    scheduledStartTime: iso(30000), scheduledEndTime: iso(200000),
    legGeometry: { points: encPath(STREET, 1e7) },
    from: { name: 'Darmstadt Schloss', lat: STREET[0][0], lon: STREET[0][1], stopId: 'st-A-0' },
    intermediateStops: stopsOf('A', 49.872, 8.655),
    to: { name: 'Darmstadt Luisenplatz', lat: 49.874, lon: 8.660, stopId: 'st-A-3' } },
  'T-B': { tripId: 'T-B', routeShortName: '9', agencyName: 'HEAG', startTime: iso(30000), endTime: iso(200000),
    scheduledStartTime: iso(30000), scheduledEndTime: iso(200000),
    legGeometry: { points: encPath(line(3, 49.8800, 8.6700, 0.0010, 0.0020), 1e7) },
    from: { name: 'Anderer Start', lat: 49.8800, lon: 8.6700, stopId: 'st-B-0' },
    intermediateStops: stopsOf('B', 49.881, 8.672),
    to: { name: 'Anderes Ziel', lat: 49.882, lon: 8.674, stopId: 'st-B-3' } },
};
const DEPARTURES = [
  { routeShortName: '4', headsign: 'Luisenplatz', routeColor: 'ffbe3c',
    place: { departure: iso(120000), scheduledDeparture: iso(60000) } },                    // verspätet
  { routeShortName: '9', headsign: 'Böllenfalltor', place: { departure: iso(180000), scheduledDeparture: iso(180000) } },
  { routeShortName: 'F', headsign: 'fällt aus', place: { departure: iso(240000), scheduledDeparture: iso(240000), cancelled: true } },
  { routeShortName: 'K', headsign: 'ohne Echtzeit', place: { departure: iso(300000), scheduledDeparture: iso(300000), realTime: false } },
];
const TRIP_FIXTURE = { legs: [LEGS['T-A']] };

// ---------- Sandkasten
const net = { calls: [], hold: null };
const store = {};
function fixtureFor(url) {
  if (url.includes('/api/v1/map/trips')) return [sec()];
  if (url.includes('/api/v1/map/stops')) return [];
  if (url.includes('/api/v1/trip?')) {
    const id = decodeURIComponent((url.match(/tripId=([^&]+)/) || [])[1] || '');
    return { legs: LEGS[id] ? [LEGS[id]] : [] };
  }
  if (url.includes('/api/v1/stoptimes')) return { stopTimes: DEPARTURES };
  return {};
}
const sandbox = {
  console, Math, JSON, Date, Number, String, Array, Object, Map, Set, parseInt, parseFloat, isNaN, isFinite,
  setTimeout, clearTimeout, setInterval, clearInterval, Promise, Float64Array, Error, Uint16Array, CustomEvent: class {},
  navigator: { language: 'en-GB' },
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
  fetch: async (url) => {
    net.calls.push(url);
    if (net.hold && url.includes('/api/v1/map/trips')) await net.hold;
    return { ok: true, status: 200, json: async () => fixtureFor(url) };
  },
  document: {
    getElementById: el, addEventListener() {}, hidden: false, documentElement: { lang: '' }, title: '',
    querySelectorAll: () => [], createElement: tag => el('new-' + tag + '-' + (++newEls)),
  },
  deck: { PathLayer: Layer, ScatterplotLayer: Layer, TextLayer: Layer },
};
sandbox.window = sandbox;
sandbox.devicePixelRatio = 1;
sandbox.matchMedia = () => ({ matches: false });          // Touch-Verhalten (kein Hover, kein Popup-Follow)
sandbox.dispatchEvent = () => {};

// MapLibre-Attrappe: fängt die Schwenk-Punkte ab, damit focusLine prüfbar wird
const fit = { pts: null, calls: 0 };
sandbox.maplibregl = { LngLatBounds: class { constructor(a, b) { this._p = [a, b]; } extend(p) { this._p.push(p); } } };
sandbox.window.maplibregl = sandbox.maplibregl;

vm.createContext(sandbox);
vm.runInContext(read('i18n.js'), sandbox);
vm.runInContext(liveSrc, sandbox);

const mapHandlers = {};
const mapContainer = { clientWidth: 1280, clientHeight: 800, addEventListener() {} };
const map = {
  getBounds: () => ({ getWest: () => 8.63, getSouth: () => 49.86, getEast: () => 8.68, getNorth: () => 49.89 }),
  getZoom: () => 14, on(ev, fn) { mapHandlers[ev] = fn; }, getContainer: () => mapContainer,
  project: ([lon, lat]) => ({ x: 640 + (lon - 8.652) * 9000, y: 400 - (lat - 49.872) * 9000 }),
  easeTo() {}, isMoving: () => false,
  fitBounds(b, opts) { fit.calls++; fit.pts = ((b && b._p) || []).slice(); fit.opts = opts; },
};
const overlay = { setProps(p) { overlay.cap = p; } };
const state = { modes: { tram: true, bus: true, rail: true }, selLine: null, selAt: 0 };

sandbox.I18N.init();
const L = sandbox.DarmstadtLive, X = L._test;
L.attach({ map, overlay, deck: sandbox.deck, META, state, hex, shortStop, MODE_RGB, selectLine: () => {}, hidePanel: () => {} });

const wait = ms => new Promise(r => setTimeout(r, ms));
const shownStopGeo = () => ((X.markerNode() || { children: [] }).children || [])
  .filter(n => n.classList.contains('stopmk')).map(n => (n._geo || []).map(v => v.toFixed(4)).join(','));

(async () => {
  let fails = 0;
  const check = (name, cond, extra) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (!cond) fails++; };

  console.log('\n=== M1: Straßengeometrie kommt bis zur Karte durch ===');
  const built = X.buildVehicles([sec()]);
  check('Fahrzeug gebaut', built.length === 1);
  X.setVehicles(built);
  const vA = built[0];
  await L.openPopup(vA);
  const chain = X.chain();
  check('Linie liegt in der Ebene live-line-chain', chain.length === 1);
  check('Linie hat die echten Straßenpunkte (150), nicht die 2 Halte-Luftlinie',
    chain.length === 1 && chain[0].length === 150, chain.length ? `${chain[0].length} Stützpunkte` : 'keine Linie');
  check('die Linie verläuft nicht als gerade Linie von Halt zu Halt',
    chain.length === 1 && !(chain[0].length <= 4), chain.length ? `${chain[0].length} Halte-Punkte` : '-');
  L.closePopup();

  console.log('\n=== M2: verspätete /trip-Antwort zeichnet keine Linie ===');
  {
    X.setVehicles(built);
    let release; net.hold = new Promise(r => { release = r; });
    const pA = L.openPopup(vA);                       // Antwort für A wird festgehalten
    await L.openPopup(Object.assign({}, vA, { tripId: 'T-B', lineName: '9' }));   // B antwortet sofort
    release(); await pA; net.hold = null;
    const c = X.chain();
    const n = c.length === 1 ? c[0].length : -1;
    check('die späte Antwort setzt die Linie nicht um (kein Geisterzug)', n === 3 || n === 0, `${n} Stützpunkte`);
    check('die Karte gehört weiterhin der zuletzt angetippten Fahrt',
      L.info().popupOpen && el('popup').innerHTML.includes('9'));
    L.closePopup();
  }

  console.log('\n=== M4: Fahrzeug am Halt überlebt den Abruf ===');
  {
    const gap = [sec({ departure: iso(-120000), arrival: iso(-20000), trips: [{ tripId: 'T-GAP', routeShortName: '4' }] }),
                 sec({ departure: iso(60000), arrival: iso(200000), trips: [{ tripId: 'T-GAP', routeShortName: '4' }] })];
    const held = X.buildVehicles(gap);
    check('das wartende Fahrzeug bleibt in der Liste', held.length === 1, `${held.length} Fahrzeuge`);
    check('es ist als wartend markiert', held.length === 1 && held[0].holding === true && held[0].running === false);
    X.setVehicles(held);
    const at = X.vehiclesAt(Date.now());
    const head = STREET[0];
    check('es wird an seinem Halt gezeichnet (u=0), nicht mitten auf der Strecke',
      at.length === 1 && Math.abs(at[0].pos[0] - head[1]) < 1e-6 && Math.abs(at[0].pos[1] - head[0]) < 1e-6,
      at.length ? at[0].pos.map(v => v.toFixed(5)).join(',') : 'keine Position');
    X.setVehicles(built);
  }

  console.log('\n=== M9: Halte einer offenen Karte wechseln mit dem Fahrzeug ===');
  {
    const vB = { tripId: 'T-B', mode: 'tram', running: true, lineName: '9', headsign: 'X', dest: 'Darmstadt X',
      fromName: 'Y', dep: Date.now() - 30000, arr: Date.now() + 300000, delayMin: 1, realTime: true,
      routeColor: '', path: [[8.67, 49.88], [8.672, 49.881]], cd: [0, 100], total: 100, lineIdx: -1 };
    await L.openPopup(vA); L.render(true);
    const geoA = shownStopGeo();
    await L.openPopup(vB); L.render(true);
    const geoB = shownStopGeo();
    check('erst die Halte der Fahrt A', geoA.length === 3, `${geoA.length}: ${geoA.join(' | ')}`);
    check('nach dem Wechsel die Halte der Fahrt B (gleiche Anzahl, andere Orte)',
      geoB.length === 3 && geoB.join('|') !== geoA.join('|'), `${geoB.length}: ${geoB.join(' | ')}`);
    check('die Koordinaten gehören zu B', geoB.some(g => g.includes('49.88')), geoB.join(' | '));
    L.closePopup(); L.render(true);
  }

  console.log('\n=== M8: Linienwahl schwenkt auf echte Positionen ===');
  {
    X.setVehicles(built);
    const withIdx = built.map(v => Object.assign({}, v, { lineIdx: 0 }));
    X.setVehicles(withIdx);
    fit.calls = 0; fit.pts = null;
    X.focusLine(0, X.vehiclesAt(Date.now()));
    check('die Kamera wird auf die Fahrzeuge der Linie geschwenkt', fit.calls === 1);
    check('und zwar auf endliche Koordinaten aus der Position, nicht auf NaN',
      !!fit.pts && fit.pts.length > 0 && fit.pts.every(p => Number.isFinite(p[0]) && Number.isFinite(p[1])),
      JSON.stringify(fit.pts));
    check('mit dem gewohnten Rahmen (padding 72, maxZoom 14.5)',
      !!fit.opts && fit.opts.padding === 72 && fit.opts.maxZoom === 14.5, JSON.stringify(fit.opts));
    X.setVehicles(built);
  }

  console.log('\n=== M5 / M12: Abfahrten sagen die Wahrheit ===');
  {
    sandbox.I18N.set('en');
    const rows = DEPARTURES.map(d => X.departureRow(d)).join('\n');
    check('Ausfall ist gekennzeichnet (gestrichen + Warnzeichen)', /st-cancel/.test(rows) && rows.includes('⚠'));
    check('Ausfall steht als Text da, nicht als normale Abfahrt', rows.includes(sandbox.I18N.t('station.cancelled')));
    check('reine Fahrplanzeit (realTime:false) bekommt ein Kennzeichen', rows.includes(sandbox.I18N.t('popup.scheduled')));
    check('verspätete Abfahrt zeigt +1 (2 Min. Ist, 1 Min. Soll)', /\+1</.test(rows));
    const noSched = X.departureRow({ routeShortName: '7', headsign: 'x', place: { departure: iso(120000) } });
    check('ohne Soll-Zeit: "–" und Klasse unknown (nicht "pünktlich")',
      /st-dly unknown">–</.test(noSched) && !/st-dly ontime/.test(noSched), noSched.slice(noSched.indexOf('st-dly')));
    const veh = X.buildVehicles([sec({ scheduledDeparture: undefined })])[0];
    check('Fahrzeug ohne Soll-Zeit: Verspätung unbekannt',
      !!veh && veh.delayMin === null && X.delayText(veh.delayMin) === 'Delay unknown' && X.delayClass(veh.delayMin) === 'unknown');
    const late = X.buildVehicles([sec({ scheduledDeparture: iso(-180000) })])[0];
    check('Fahrzeug mit Soll-Zeit: Verspätung wird berechnet', !!late && late.delayMin === 2, late && String(late.delayMin));
  }

  console.log('\n=== M6: Frischezustand ist berechenbar ===');
  check('frisch < 45 s', X.freshness(10000) === 'fresh');
  check('veraltet 45 s .. 2 min', X.freshness(60000) === 'stale' && X.freshness(45000) === 'fresh');
  check('überholt > 2 min', X.freshness(120001) === 'expired');
  check('ohne Daten: waiting', X.freshness(null) === 'waiting');
  check('die Statuszeile setzt das Badge (data-state)', /badge\.dataset\.state = state/.test(liveSrc) &&
    /id="livebadge" data-state="waiting"/.test(html));
  check('ein Ausfall lässt das Badge nicht weiter pulsieren', /\.badge-live\[data-state="stale"\][^}]*animation: none/.test(html.replace(/\n/g, ' ')));

  console.log('\n=== M3: Linienwahl räumt die Fahrzeugauswahl weg ===');
  {
    sandbox.matchMedia = q => ({ matches: /hover/.test(String(q)) });   // Rechner: Kamera begleitet
    await L.openPopup(vA);
    X.tapVehicle(vA);
    check('Klick auf ein Fahrzeug begleitet und öffnet', L.info().popupOpen === true && X.following() === true);
    L.clearVehicle();
    check('clearVehicle schließt die Karte', L.info().popupOpen === false);
    check('clearVehicle beendet das Begleiten', X.following() === false);
    check('clearVehicle räumt die Linie weg', X.chain().length === 0);
    check('index.html ruft es bei der Linienwahl', /window\.DarmstadtLive\.clearVehicle\(\)/.test(html) &&
      /if \(state\.selLine !== null && window\.DarmstadtLive/.test(html));
  }

  console.log('\n=== M10: ein Abruf während eines Abrufs wird nachgeholt ===');
  {
    L.setOn(true);
    await wait(50);
    const base = net.calls.filter(u => u.includes('/map/trips')).length;
    let release; net.hold = new Promise(r => { release = r; });
    const p1 = L.refresh();
    await wait(10);
    await L.refresh();                      // Kartenbewegung während des Abrufs
    release(); await p1; net.hold = null;
    await wait(60);                         // der nachgeholte Abruf läuft im nächsten Tick
    const after = net.calls.filter(u => u.includes('/map/trips')).length;
    check('der zweite Abruf geht nicht verloren', after - base >= 2, `${after - base} Abrufe`);
    check('jede Anfrage bekommt eine Frist (AbortController)', /new AbortController\(\)/.test(liveSrc) &&
      /REQUEST_TIMEOUT_MS/.test(liveSrc));
    L.setOn(false);
  }

  console.log('\n=== Versionskennungen ===');
  {
    const tokens = [
      (liveSrc.match(/const VERSION = '([^']+)'/) || [])[1],
      (html.match(/const APP_V = '([^']+)'/) || [])[1],
      ...[...html.matchAll(/<script src="[\w.]+\.js\?v=([^"]+)"/g)].map(m => m[1]),
    ];
    check('alle fünf Kennungen sind gleich', new Set(tokens).size === 1 && !!tokens[0], tokens.join(' / '));
  }

  console.log('\n=== M7: Marken hängen im Karten-Container ===');
  check('das Marken-Element liegt im Markup', /<div id="markers" aria-hidden="true"><\/div>/.test(html));
  check('index.html hängt es in den Karten-Container (Gesten erreichen MapLibre)',
    /map\.getCanvasContainer\(\)/.test(html) && /canvasBox\.appendChild\(host\)/.test(html));
  check('live.js findet die Marken weiterhin über die Kennung', /getElementById\('markers'\)/.test(liveSrc));

  console.log(`\nRESULT: ${fails === 0 ? 'PASS' : 'FAIL (' + fails + ')'}`);
  process.exit(fails === 0 ? 0 : 1);
})();
