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
 *   Reg Linienwahl/Sprachwechsel laufen ohne Ausnahme (Stern + Auswahlfeld; Inline-Skript der Seite)
 *   Bas Karte ⇄ Satellit, Bedienleiste (Grundkarte über Kippen, Ortung auch am Rechner), Suche oben rechts
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

// ---------- Seitenstart: das INLINE-Skript aus docs/index.html in einer eigenen DOM-Attrappe.
// Die Prüfungen oben fahren live.js; die Verdrahtung IN index.html — selectLine() ruft den Stern, und
// i18n set() -> render -> selectLine bei jedem Sprachwechsel — blieb damit ungeprüft. Genau dort lag
// der unbeachtete ReferenceError "paintLineStar is not defined" (selectLine stand eine Ebene über der
// Favoritenlogik). openPage() startet deshalb die echte Seite und klickt eine Linie an.
// opts: { touch: Telefon-Layout, store: vorbelegter localStorage } — für die Bedienleiste und die Suche.
function openPage(seedFavs, opts = {}) {
  const pe = {}, pall = [], pstore = Object.assign({}, opts.store || {});
  let pn = 0;
  if (seedFavs) pstore['darmstadt-live-favs'] = JSON.stringify(seedFavs);
  const pageEl = id => {
    if (pe[id]) return pe[id];
    const o = {
      id, textContent: '', innerHTML: '', hidden: false, style: {}, dataset: {},
      clientWidth: 900, clientHeight: 46, offsetHeight: 0, width: 0, height: 0,
      children: [], attrs: {},
      appendChild(c) {
        if (c.parentNode && c.parentNode.children) {
          const i = c.parentNode.children.indexOf(c);
          if (i >= 0) c.parentNode.children.splice(i, 1);
        }
        c.parentNode = o; o.children.push(c); return c;
      },
      remove() { const p = o.parentNode; if (p) { const i = p.children.indexOf(o); if (i >= 0) p.children.splice(i, 1); } o.removed = true; },
      setAttribute(k, v) { o.attrs[k] = String(v); },
      closest(sel) { return (o.parentNode && o.parentNode.tag === sel.replace(/^\./, '')) ? o.parentNode : pageEl(id + sel); },
      scrollIntoView() {}, listeners: {},
      addEventListener(ev, fn) { (o.listeners[ev] = o.listeners[ev] || []).push(fn); },
      fire(ev, e) { (o.listeners[ev] || []).forEach(f => f(e || {})); },
      focus() { sb.document.activeElement = o; },
      contains(n) { for (let x = n; x; x = x.parentNode) if (x === o) return true; return false; },
      classList: { _s: new Set(), toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
        add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
      querySelector(sel) { return pageEl(id + sel); },
      querySelectorAll() { return []; },
      getContext() { return { setTransform() {}, clearRect() {}, fillRect() {}, fillText() {}, set fillStyle(v) {}, set font(v) {} }; },
    };
    let cn = '';
    Object.defineProperty(o, 'className', {
      get: () => Array.from(o.classList._s).join(' ') || cn,
      set: v => { cn = String(v == null ? '' : v); o.classList._s = new Set(cn.split(/\s+/).filter(Boolean)); },
    });
    pe[id] = o; pall.push(o); return o;
  };
  const chips = () => pall.filter(n => n.classList.contains('chip'));
  const chipFor = i => chips().find(c => String(c.dataset.line) === String(i));
  const sb = {
    console, Math, JSON, Date, Number, String, Array, Object, Map, Set, parseInt, parseFloat, isNaN, isFinite,
    setTimeout, clearTimeout, setInterval, clearInterval, Promise, Float64Array, Uint16Array, Error,
    CustomEvent: class { constructor(t) { this.type = t; } },
    navigator: { language: 'en-GB', geolocation: { getCurrentPosition() {}, watchPosition: () => 1, clearWatch() {} } },
    localStorage: { getItem: k => (k in pstore ? pstore[k] : null), setItem: (k, v) => { pstore[k] = String(v); } },
    sessionStorage: { getItem: () => null, setItem() {} },
    location: { pathname: '/darmstadt-live-map/', replace() {} },
    fetch: async url => ({ ok: true, status: 200, json: async () => (String(url).includes('meta.json') ? META : {}) }),
    requestAnimationFrame: () => 0,
    document: {
      body: pageEl('body'), documentElement: { lang: '', dataset: {}, style: { setProperty() {} } }, title: '', activeElement: null,
      getElementById: pageEl, addEventListener() {},
      createElement: tag => { const e = pageEl('new-' + tag + '-' + (++pn)); e.tag = tag; return e; },
      querySelectorAll: sel => (sel === '.chip' ? chips() : []),
      querySelector: sel => {
        const m = sel.match(/^\.chip\[data-line="(\d+)"\]$/);
        return m ? chipFor(m[1]) : pageEl('q:' + sel);
      },
    },
    deck: { MapboxOverlay: class { constructor(p) { Object.assign(this, p); } setProps(p) { this.props = p; } },
      PathLayer: Layer, ScatterplotLayer: Layer, TextLayer: Layer },
  };
  sb.window = sb;
  sb.devicePixelRatio = 1;
  sb.matchMedia = () => ({ matches: !!opts.touch });   // Vorgabe Rechner: kein Schubladen-Layout
  sb.dispatchEvent = () => {};
  const wh = {};
  sb.addEventListener = (ev, fn) => { (wh[ev] = wh[ev] || []).push(fn); };
  const container = { clientWidth: 1280, clientHeight: 800, addEventListener() {}, appendChild(c) { return c; } };
  // Karte mit einem kleinen, aber echten Stil: Quellen und Ebenen werden wirklich angelegt und
  // umgeschaltet, addControl ruft onAdd wie MapLibre (die Reihenfolge ist die Spalte unten rechts).
  const controls = [], mh = {}, setStyleCalls = [];
  const style = { sources: { carto: { url: 'x' } }, layers: [
    { id: 'background', type: 'background' },
    { id: 'water', type: 'fill', source: 'carto' },
    { id: 'roads', type: 'line', source: 'carto' },
    { id: 'hidden-by-style', type: 'line', source: 'carto', layout: { visibility: 'none' } },
  ] };
  sb.maplibregl = {
    Map: class { constructor(o) { Object.assign(this, o); }
      getCanvasContainer() { return container; } getCanvas() { return container; } getContainer() { return container; }
      getStyle() { return style; }
      addControl(c, pos) { const el = c && c.onAdd ? c.onAdd(this) : null; controls.push({ name: c && c.constructor && c.constructor.name, pos, el }); }
      on(ev, fn) { (mh[ev] = mh[ev] || []).push(fn); }
      getSource(id) { return style.sources[id]; } addSource(id, s) { style.sources[id] = s; }
      getLayer(id) { return style.layers.find(l => l.id === id); }
      addLayer(l, before) { const i = before ? style.layers.findIndex(x => x.id === before) : -1; style.layers.splice(i < 0 ? style.layers.length : i, 0, l); }
      removeLayer(id) { const i = style.layers.findIndex(l => l.id === id); if (i >= 0) style.layers.splice(i, 1); }
      removeSource(id) { delete style.sources[id]; }
      setLayoutProperty(id, k, v) { const l = this.getLayer(id); if (!l) throw new Error('no layer ' + id); l.layout = Object.assign({}, l.layout, { [k]: v }); }
      getLayoutProperty(id, k) { const l = this.getLayer(id); return l && l.layout ? l.layout[k] : undefined; }
      getPitch() { return 0; }
      loaded() { return false; } getBounds() { return { getWest: () => 8.63, getSouth: () => 49.86, getEast: () => 8.68, getNorth: () => 49.89 }; }
      getZoom() { return 14; } project() { return { x: 640, y: 400 }; } easeTo() {} isMoving() { return false; } fitBounds() {} setStyle(s, o) { setStyleCalls.push(o); } },
    LngLatBounds: class { constructor(a, b) { this._p = [a, b]; } extend(p) { this._p.push(p); } },
    NavigationControl: class {},
  };
  if (opts.hybrid) sb.location.search = '?hybrid=1';   // Hybridbetrieb (wie /?hybrid=1)
  vm.createContext(sb);
  vm.runInContext(read('i18n.js'), sb);
  vm.runInContext(read('search.js'), sb);
  vm.runInContext(liveSrc, sb);
  const blocks = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  blocks.forEach(b => vm.runInContext(b, sb));         // ALLE Inline-Skripte, in Reihenfolge wie im Browser
  return { el: pageEl, chips, chipFor, all: pall, fire: ev => (wh[ev] || []).forEach(f => f()),
    sb, controls, style, store: pstore, setStyleCalls, mapFire: ev => (mh[ev] || []).forEach(f => f()),
    t: k => sb.I18N.t(k), ready: new Promise(r => setTimeout(r, 40)) };
}

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
    check('erst die Halte der Fahrt A (Karte zeigt alle kommenden)', geoA.length >= 3 && geoA.length <= 25, `${geoA.length}: ${geoA.join(' | ')}`);
    check('nach dem Wechsel die Halte der Fahrt B (gleiche Anzahl, andere Orte)',
      geoB.length === geoA.length && geoB.join('|') !== geoA.join('|'), `${geoB.length}: ${geoB.join(' | ')}`);
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
    check('mit Rand für Panel bzw. Bottom-Sheet (statt 72 px rundum)',
      !!fit.opts && fit.opts.padding && typeof fit.opts.padding === 'object' &&
      fit.opts.padding.top >= 60 && fit.opts.padding.bottom >= 100 && fit.opts.maxZoom === 15,
      JSON.stringify(fit.opts));
    // Wunsch 2026-10-15: die Linienwahl muss auch Fahrzeuge AUSSERHALB des Ausschnitts zeigen —
    // sonst passierte nichts, wenn man woanders hin gepannt hatte.
    await X.focusLineWide(0);
    const wideCall = net.calls.find(u => u.includes('min=49.79'));
    check('die Linienwahl fragt den weiten Stadtausschnitt ab (nicht nur die sichtbaren Fahrzeuge)',
      !!wideCall, String(wideCall || net.calls[net.calls.length - 1] || '').slice(0, 120));
    check('und der weite Ausschnitt deckt Darmstadt samt Umland ab',
      /min=49\.79,8\.56&max=49\.95,8\.78/.test(String(wideCall || '')), String(wideCall || '').slice(0, 120));
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

  console.log('\n=== Regression: Linienwahl und Sprachwechsel ohne Ausnahme (Stern + Auswahlfeld) ===');
  {
    // Linie 0 ist bereits Favorit: damit unterscheidet der Stern-Test "der Stern wurde nachgezogen"
    // von "der Stern steht noch auf dem Stand vor der Wahl" — genau die Wirkung des ReferenceErrors.
    const page = openPage({ stations: [], lines: [0] });
    await page.ready;
    const chip0 = page.chipFor(0);
    check('die Linienleiste der Seite ist aufgebaut (Linie 0 ist ein Chip)',
      !!chip0, `${page.chips().length} Chips`);
    let err = null;
    try { chip0.onclick(); } catch (e) { err = e; }
    check('die Linienwahl läuft ohne Ausnahme durch (kein "paintLineStar is not defined")',
      !err, err ? err.message : '');
    check('nach der Wahl steht das Auswahlfeld (#selinfo) auf flex',
      page.el('selinfo').style.display === 'flex', String(page.el('selinfo').style.display));
    check('der Stern zeigt die gewählte Linie als Favorit (★), nicht den Stand davor (☆)',
      page.el('selfav').textContent === '★' &&
      page.el('selfav').title === page.t('favRemove') &&
      page.el('selfav').attrs['aria-label'] === page.t('favRemove'),
      `${page.el('selfav').textContent} / ${page.el('selfav').title}`);
    let err2 = null;
    try { page.fire('langchange'); } catch (e) { err2 = e; }        // i18n set -> render -> selectLine
    check('der Sprachwechsel läuft ohne Ausnahme durch', !err2, err2 ? err2.message : '');
    let err3 = null;
    try { page.el('selclear').onclick(); } catch (e) { err3 = e; }  // abwählen: selLine === null ruft den Stern ebenfalls
    check('das Abwählen räumt das Auswahlfeld weg, ohne Ausnahme',
      !err3 && page.el('selinfo').style.display === 'none',
      err3 ? err3.message : String(page.el('selinfo').style.display));
  }

  console.log('\n=== Bas: Bedienleiste unten rechts (Grundkarte über Kippen, Ortung überall) ===');
  {
    const names = p => p.controls.filter(c => c.pos === 'bottom-right').map(c => c.name);
    const desk = openPage(null, { hybrid: true }), phone = openPage(null, { touch: true, hybrid: true });
    await desk.ready; await phone.ready;
    const dn = names(desk), pn = names(phone);
    check('a basemap toggle is registered and starts on the standard dark view',
      dn.includes('BasemapButton') && desk.sb.basemap() === 'normal' &&
      desk.sb.document.documentElement.dataset.basemap === 'normal', dn.join(' > '));
    check('the basemap toggle is registered directly before the tilt button (renders above it)',
      dn.indexOf('BasemapButton') >= 0 && dn.indexOf('TiltButton') === dn.indexOf('BasemapButton') + 1);
    check('the locate control is registered on desktop as well (no touch gate)', dn.includes('LocateButton'));
    check('phone and desktop get the identical control column (one rule, no layout branch)',
      dn.join('>') === pn.join('>'), pn.join(' > '));
    const btn = (desk.controls.find(c => c.name === 'BasemapButton') || {}).el;
    check('the toggle is symbol-only with a translated label and an off state',
      !!btn && btn.attrs['data-i18n-aria'] === 'basemapTitle' && btn.attrs['aria-pressed'] === 'false' &&
      btn.attrs['data-i18n-title'] === 'basemapToSatellite' && btn.title === desk.t('basemapToSatellite') && !btn.textContent);

    console.log('\n=== Bas: Karte ⇄ Satellit schaltet nur Sichtbarkeit ===');
    const vis = (p, id) => { const l = p.style.layers.find(x => x.id === id); return l ? ((l.layout && l.layout.visibility) || 'visible') : 'missing'; };
    desk.mapFire('style.load');                        // erstes Laden: Satellit + Kachel-Patch
    desk.mapFire('style.load');                        // gepatchter Stil
    const sat = desk.style.sources.sat, cim = desk.style.sources.cartoimg;
    check('both basemap rasters exist, hidden, and sit ABOVE the style layers (never under its background)',
      !!sat && sat.type === 'raster' && /World_Imagery\/MapServer\/tile\/\{z\}\/\{y\}\/\{x\}$/.test(sat.tiles[0]) &&
      !!cim && cim.type === 'raster' && /rastertiles\/voyager\/\{z\}\/\{x\}\/\{y\}\.png$/.test(cim.tiles[0]) &&
      vis(desk, 'sat') === 'none' && vis(desk, 'cartoimg') === 'none' &&
      desk.style.layers.filter(l => l.id === 'sat').length === 1 &&
      desk.style.layers.filter(l => l.id === 'cartoimg').length === 1 &&
      desk.style.layers[0].id !== 'sat',
      desk.style.layers.map(l => l.id).join(','));
    check('the tile cap still runs exactly once (one setStyle, from the patch)',
      desk.setStyleCalls.length === 1 && desk.style.sources.carto.maxzoom === 14 && !desk.style.sources.carto.url);
    desk.style.layers.push({ id: 'me-dot', type: 'circle', source: 'me' });   // „Wo bin ich?“ ist an
    btn.onclick();
    check('toggling switches visibility of the two basemaps and persists the choice',
      desk.sb.basemap() === 'satellite' && vis(desk, 'sat') === 'visible' &&
      ['background', 'water', 'roads', 'hidden-by-style'].every(id => vis(desk, id) === 'none') &&
      desk.store['dlm-basemap'] === 'satellite');
    check('satellite mode flags <html> (credit line + pill outline) and presses the button',
      desk.sb.document.documentElement.dataset.basemap === 'satellite' && btn.attrs['aria-pressed'] === 'true' &&
      btn.attrs['data-i18n-title'] === 'basemapToMap');
    check('the own location dot is never hidden by the switch', vis(desk, 'me-dot') === 'visible');
    btn.onclick();
    check('the second click shows the light cartographic map, style layers still hidden',
      desk.sb.basemap() === 'carto' && vis(desk, 'cartoimg') === 'visible' && vis(desk, 'sat') === 'none' &&
      vis(desk, 'roads') === 'none' && vis(desk, 'water') === 'none' &&
      desk.store['dlm-basemap'] === 'carto' &&
      desk.sb.document.documentElement.dataset.basemap === 'carto' &&
      btn.attrs['aria-pressed'] === 'true' && btn.attrs['data-i18n-title'] === 'basemapToNormal');
    check('the cartographic state is flagged for pill contrast but is not the satellite state',
      desk.sb.document.documentElement.dataset.basemap === 'carto');
    btn.onclick();
    check('the third click returns to the standard dark map with every style layer as the style had it',
      desk.sb.basemap() === 'normal' && vis(desk, 'sat') === 'none' && vis(desk, 'cartoimg') === 'none' &&
      vis(desk, 'water') === 'visible' && vis(desk, 'roads') === 'visible' &&
      vis(desk, 'hidden-by-style') === 'none' && desk.store['dlm-basemap'] === 'normal' &&
      desk.sb.document.documentElement.dataset.basemap === 'normal' &&
      btn.attrs['aria-pressed'] === 'false' && btn.attrs['data-i18n-title'] === 'basemapToSatellite');

    const stored = openPage(null, { hybrid: true, store: { 'dlm-basemap': 'satellite' } });
    await stored.ready;
    const sbtn = (stored.controls.find(c => c.name === 'BasemapButton') || {}).el;
    check('a stored satellite choice is flagged before the style loads',
      stored.sb.basemap() === 'satellite' && stored.sb.document.documentElement.dataset.basemap === 'satellite' &&
      !!sbtn && sbtn.attrs['aria-pressed'] === 'true');
    stored.mapFire('style.load'); stored.mapFire('style.load');
    check('a stored satellite choice is applied at boot',
      vis(stored, 'sat') === 'visible' && vis(stored, 'cartoimg') === 'none' && vis(stored, 'roads') === 'none');

    const storedCarto = openPage(null, { hybrid: true, store: { 'dlm-basemap': 'carto' } });
    await storedCarto.ready;
    storedCarto.mapFire('style.load'); storedCarto.mapFire('style.load');
    check('a stored cartographic choice is applied at boot',
      storedCarto.sb.basemap() === 'carto' && vis(storedCarto, 'cartoimg') === 'visible' &&
      vis(storedCarto, 'sat') === 'none' && vis(storedCarto, 'roads') === 'none');
    const legacy = openPage(null, { hybrid: true, store: { 'dlm-basemap': 'map' } });
    await legacy.ready;
    check('the legacy stored value "map" migrates to the standard dark view',
      legacy.sb.basemap() === 'normal');

    console.log('\n=== Bas: Suche oben rechts, Telefon hinter der Lupe ===');
    const prod = openPage(null), prodPhone = openPage(null, { touch: true });
    await prod.ready; await prodPhone.ready;
    check('the published page keeps the old UI: no basemap toggle, no location on the desktop',
      !names(prod).includes('BasemapButton') && !names(prod).includes('LocateButton') &&
      names(prodPhone).includes('LocateButton'), names(prod).join(' > '));
    check('the published page keeps the search inside the left panel (and never flags hybrid)',
      !prod.sb.document.documentElement.dataset.hybrid &&
      prod.el('searchbar').parentNode === prod.el('panelbar') &&
      prod.sb.document.documentElement.dataset.search === 'panel');

    const bar = phone.el('searchbar'), open = phone.el('searchopen'), input = phone.el('search'), res = phone.el('results');
    input.parentNode = phone.el('searchwrap'); phone.el('searchwrap').parentNode = bar;
    check('the magnifier is wired', typeof open.onclick === 'function');
    open.onclick && open.onclick();
    check('the magnifier expands the search box and focuses the field',
      bar.classList.contains('open') && open.attrs['aria-expanded'] === 'true' && phone.sb.document.activeElement === input);
    input.fire('keydown', { key: 'Escape' });
    check('Escape collapses it again', !bar.classList.contains('open') && open.attrs['aria-expanded'] === 'false');
    open.onclick();
    bar.fire('focusout');
    await wait(200);
    check('focus staying inside keeps it open', bar.classList.contains('open'));
    phone.sb.document.activeElement = phone.el('body');
    bar.fire('focusout');
    await wait(200);
    check('focus leaving the box collapses it', !bar.classList.contains('open') && open.attrs['aria-expanded'] === 'false');
    open.onclick();
    let jumped = null;
    phone.sb.DarmstadtLive.openStation = s => { jumped = s; };
    input.value = 'Luisenplatz';
    input.fire('input');
    const first = (res.children[0] && res.children[0].children[0]) || null;
    check('searching still finds a stop after the move (ids unchanged)',
      res.hidden === false && !!first && /Luisenplatz/.test(first.textContent), first ? first.textContent : 'kein Treffer');
    if (first) first.onclick();
    check('picking a result jumps there and collapses the box',
      !!jumped && /Luisenplatz/.test(jumped.name) && !bar.classList.contains('open') && res.hidden === true);
    open.onclick();
    phone.mapFire('click');
    check('tapping the map collapses it', !bar.classList.contains('open'));
  }

  console.log(`\nRESULT: ${fails === 0 ? 'PASS' : 'FAIL (' + fails + ')'}`);
  process.exit(fails === 0 ? 0 : 1);
})();
