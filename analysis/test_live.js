/* Integrationstest für docs/live.js ohne Browser:
 * lädt das Original-Modul, stubbed DOM/deck/map, holt echte Echtzeitdaten und prüft
 * Fahrzeuge, Positionen, Ebenen und UI-Ausgaben. */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const DOCS = path.join(__dirname, '..', 'docs');
const META = JSON.parse(fs.readFileSync(path.join(DOCS, 'data', 'meta.json'), 'utf8'));

const captured = { layers: null, handlers: null, canvasCalls: 0 };
const elements = {};

function el(id) {
  if (elements[id]) return elements[id];
  return (elements[id] = {
    id, textContent: '', innerHTML: '', hidden: false, style: {}, dataset: {},
    clientWidth: 900, clientHeight: 46, width: 0, height: 0,
    classList: { toggle() {}, add() {}, remove() {} },
    getContext() {
      return {
        setTransform() {}, clearRect() {}, fillRect() { captured.canvasCalls++; },
        fillText() { captured.canvasCalls++; }, set fillStyle(v) {}, set font(v) {},
      };
    },
  });
}

const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const fmt = s => { s = ((s % 86400) + 86400) % 86400; return String(Math.floor(s / 3600)).padStart(2, '0') + ':' + String(Math.floor(s % 3600 / 60)).padStart(2, '0'); };
const shortStop = n => String(n).replace(/^Darmstadt[- ]/, '');
const MODE_RGB = { tram: [255, 107, 107], bus: [46, 196, 182], rail: [199, 125, 255] };

class Layer { constructor(props) { Object.assign(this, props); } }

const sandbox = {
  console, Math, JSON, Date, Number, String, Array, Object, Map, Set, parseInt, parseFloat, isNaN, isFinite,
  setTimeout, clearTimeout, setInterval, clearInterval, Promise, Float64Array, Error, Uint16Array,
  // Die API verlangt einen eigenen User-Agent; im Browser erledigt das der Browser selbst.
  fetch: (url, opts) => fetch(url, { ...(opts || {}), headers: { ...((opts && opts.headers) || {}), 'User-Agent': 'hermes-darmstadt-live-test/1.0' } }),
  document: { getElementById: el, addEventListener() {}, hidden: false },
  deck: { PathLayer: Layer, ScatterplotLayer: Layer },
};
sandbox.window = sandbox;
sandbox.devicePixelRatio = 1;

const code = fs.readFileSync(path.join(DOCS, 'live.js'), 'utf8');
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const map = {
  getBounds: () => ({ getWest: () => 8.63, getSouth: () => 49.86, getEast: () => 8.68, getNorth: () => 49.89 }),
  getZoom: () => 14, on() {},
};
const overlay = { setProps(p) { captured.layers = p.layers; captured.handlers = p; } };
const state = { modes: { tram: true, bus: true, rail: true }, selLine: null };

sandbox.window.DarmstadtLive.attach({
  map, overlay, deck: sandbox.deck, META, state, hex, fmt, shortStop, MODE_RGB, selectLine: () => {},
});

(async () => {
  sandbox.window.DarmstadtLive.setOn(true);
  sandbox.window.DarmstadtLive.refresh();

  // auf die echte API-Antwort warten
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    const i = sandbox.window.DarmstadtLive.info();
    if (i.lastOk || i.lastErr) break;
    await new Promise(r => setTimeout(r, 500));
  }
  const info = sandbox.window.DarmstadtLive.info();
  console.log('=== Abruf ===');
  console.log('  Fahrzeuge:', info.count, '| letzter Erfolg:', info.lastOk ? new Date(info.lastOk).toISOString() : null,
              '| Fehler:', info.lastErr, '| Fehlversuche:', info.failures);
  if (!info.count) {
    // Ausdrücklich: ein API-Ausfall ist kein Bestehen. Fehler wird benannt, Ergebnis FAIL.
    console.log(`FAIL: keine Fahrzeuge berechnet (${info.lastErr ? 'API nicht erreichbar: ' + info.lastErr : 'API lieferte keine Echtzeitfahrzeuge'})`);
    process.exit(1);
  }

  sandbox.window.DarmstadtLive.render(true);
  const [trails, heads] = captured.layers;
  console.log('\n=== Ebenen ===');
  console.log('  Ebenen gesetzt:', captured.layers.map(l => l.id).join(', '));
  console.log('  Trails:', trails.data.length, '| Heads:', heads.data.length, '| Canvas-Zeichenaufrufe:', captured.canvasCalls);

  // Positionen aller Fahrzeuge einsammeln
  const pos = heads.data.map(d => d.pos);
  const lats = pos.map(p => p[1]), lons = pos.map(p => p[0]);
  const inBox = pos.filter((p, i) => lons[i] > 8.5 && lons[i] < 8.9 && lats[i] > 49.75 && lats[i] < 50.0).length;
  console.log('\n=== Positionen ===');
  console.log('  lat:', Math.min(...lats).toFixed(4), '..', Math.max(...lats).toFixed(4),
              '| lon:', Math.min(...lons).toFixed(4), '..', Math.max(...lons).toFixed(4));
  console.log('  im Raum Darmstadt:', inBox, '/', pos.length);
  const nan = pos.filter(p => !isFinite(p[0]) || !isFinite(p[1])).length;
  console.log('  ungültige Koordinaten:', nan);

  const delays = heads.data.map(d => d.v.delayMin);
  const rt = heads.data.filter(d => d.v.realTime).length;
  console.log('\n=== Verspätungen ===');
  console.log('  Bereich:', Math.min(...delays), 'bis', Math.max(...delays), 'min | Echtzeit-Daten:', rt, '/', heads.data.length);
  const byMode = heads.data.reduce((a, d) => (a[d.v.mode] = (a[d.v.mode] || 0) + 1, a), {});
  console.log('  Modi:', JSON.stringify(byMode));
  const unmatched = heads.data.filter(d => d.v.lineIdx < 0).length;
  console.log('  Linien ohne meta.json-Treffer:', unmatched, '/', heads.data.length);

  console.log('\n=== UI-Ausgaben ===');
  console.log('  #n-tram/#n-bus/#n-rail:', el('n-tram').textContent, '/', el('n-bus').textContent, '/', el('n-rail').textContent);
  console.log('  #livestat:', el('livestat').innerHTML.replace(/<[^>]+>/g, ''));
  console.log('  #livestat2:', el('livestat2').innerHTML.replace(/<[^>]+>/g, ''));
  console.log('  #clock:', el('clock').textContent);

  console.log('\n=== Beispiele ===');
  for (const d of heads.data.slice(0, 6)) {
    console.log(`  ${d.v.mode.padEnd(5)} ${String(d.v.lineName).padEnd(4)} ${String(d.v.delayMin).padStart(3)} min @ ${d.pos[0].toFixed(5)},${d.pos[1].toFixed(5)}  ${shortStop(d.v.fromName).slice(0, 24)} -> ${shortStop(d.v.dest).slice(0, 24)}  Restpunkte=${d.rest.length}`);
  }

  const rtOnly = heads.data.every(d => d.v.realTime === true);
  console.log('\n=== Geprüft ===');
  console.log(`  Fahrzeuge > 0: ${info.count > 0} | ungültige Koordinaten = 0: ${nan === 0} | alle im Raum Darmstadt: ${inBox === pos.length}`);
  console.log(`  Trails == Heads: ${trails.data.length === heads.data.length} | nur realTime===true: ${rtOnly}`);
  sandbox.window.DarmstadtLive.setOn(false);
  const off = sandbox.window.DarmstadtLive.info();
  console.log(`  nach setOn(false): active=${off.active} polling=${off.polling}`);

  console.log('\n=== EN/DE-Abdeckung ===');
  let i18nFails = 0;
  require('./test_i18n').run((n, c, e) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${!c && e ? ' — ' + e : ''}`); if (!c) i18nFails++; });

  const ok = info.count > 0 && nan === 0 && inBox === pos.length && trails.data.length === heads.data.length &&
    rtOnly && !off.active && !off.polling && i18nFails === 0;
  console.log('\nRESULT:', ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})();
