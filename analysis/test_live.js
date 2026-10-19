/* Integrationstest für docs/live.js ohne Browser:
 * lädt das Original-Modul, stubbed DOM/deck/map, holt echte Echtzeitdaten und prüft
 * Fahrzeuge, Positionen, Ebenen und UI-Ausgaben. */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { canvas2d, installGl, Path2D } = require('./gl_stub');

const DOCS = path.join(__dirname, '..', 'docs');
const META = JSON.parse(fs.readFileSync(path.join(DOCS, 'data', 'meta.json'), 'utf8'));

const captured = { layers: null, handlers: null, canvasCalls: 0 };
const elements = {};

function el(id) {
  if (elements[id]) return elements[id];
  const o = {
    id, textContent: '', innerHTML: '', hidden: false, style: {}, dataset: {},
    clientWidth: 900, clientHeight: 46, width: 0, height: 0,
    classList: { _s: new Set(), toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
                 add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
                 contains(c) { return this._s.has(c); } },
    children: [],
    appendChild(c) {
      if (c.parentNode && c.parentNode.children) {          // wie im DOM: verschieben, nicht duplizieren
        const i = c.parentNode.children.indexOf(c);
        if (i >= 0) c.parentNode.children.splice(i, 1);
      }
      c.parentNode = o; o.children.push(c); return c;
    },
    remove() { const p = o.parentNode; if (p) { const i = p.children.indexOf(o); if (i >= 0) p.children.splice(i, 1); } o.removed = true; },
    querySelector() { return null; },
    getContext() {
      // Canvas 2D mit Mitschrift (die Pillen werden damit gerastert); Zeichenaufrufe werden gezählt.
      const c = canvas2d(o), fr = c.fillRect, ft = c.fillText;
      c.fillRect = (...a) => { captured.canvasCalls++; return fr.apply(c, a); };
      c.fillText = (...a) => { captured.canvasCalls++; return ft.apply(c, a); };
      return c;
    },
  };
  let cn = '';
  Object.defineProperty(o, 'className', {
    get: () => Array.from(o.classList._s).join(' ') || cn,
    set: v => { cn = String(v == null ? '' : v); o.classList._s = new Set(cn.split(/\s+/).filter(Boolean)); },
  });
  elements[id] = o;
  return o;
}


const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const fmt = s => { s = ((s % 86400) + 86400) % 86400; return String(Math.floor(s / 3600)).padStart(2, '0') + ':' + String(Math.floor(s % 3600 / 60)).padStart(2, '0'); };
const shortStop = n => String(n).replace(/^Darmstadt[- ]/, '');
const MODE_RGB = { tram: [255, 107, 107], bus: [46, 196, 182], rail: [199, 125, 255] };

class Layer { constructor(props) { Object.assign(this, props); } }

const sandbox = {
  console, Math, JSON, Date, Number, String, Array, Object, Map, Set, parseInt, parseFloat, isNaN, isFinite,
  setTimeout, clearTimeout, setInterval, clearInterval, Promise, Float64Array, Error, Uint16Array, Path2D,
  // Die API verlangt einen eigenen User-Agent; im Browser erledigt das der Browser selbst.
  fetch: (url, opts) => fetch(url, { ...(opts || {}), headers: { ...((opts && opts.headers) || {}), 'User-Agent': 'hermes-darmstadt-live-test/1.0' } }),
  document: { getElementById: el, addEventListener() {}, hidden: false,
    createElement: tag => el('new-' + tag), querySelectorAll: () => [] },
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
  // the live module now anchors the popup to the vehicle and may move the camera: stub those too,
  // otherwise render() would throw once a popup is open
  getContainer: () => ({ clientWidth: 1280, clientHeight: 800, addEventListener() {} }),
  project: p => ({ x: 640, y: 400 }),
  easeTo() {},
  isMoving: () => false,
};
const gl = installGl(map);              // die Pillen sind Kartenebenen: Quellen/Ebenen/Bilder wie MapLibre
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

  const L = sandbox.window.DarmstadtLive;
  L.render(true);
  // Fahrzeugmarken und Halte sind MapLibre-Ebenen (unten geprüft), deck.gl zeichnet nur noch Linien —
  // die Daten kommen aus der Modul-API, die deck-Ebenen sind Verlauf und (nach Klick) die Linienlänge.
  const byId = id => captured.layers.find(l => l.id === id) || { data: [] };
  const trails = byId('live-trails'), heads = { data: L._test.markers() }, stations = { data: L._test.stops() };
  console.log('\n=== Ebenen ===');
  console.log('  Ebenen gesetzt:', captured.layers.map(l => l.id).join(', '));
  console.log('  Trails:', trails.data.length, '| Heads:', heads.data.length,
              '| Halte:', stations.data.length, '| Canvas-Zeichenaufrufe:', captured.canvasCalls);

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
  // Der Punkt je Linie darf nur grün sein, wo wirklich ein Fahrzeug per Betreiber-GPS gemeldet ist:
  // grün = Betreiber, blau = nur Prognose. Abwesenheit in der Karte heißt rot in der Liste.
  let lineStatusOk = false;
  {
    const st = (L.lineStatus ? L.lineStatus() : null) || {};
    const opDrawn = heads.data.filter(d => d.v.source === 'operator').length;
    const drawnIdx = [...new Set(heads.data.map(d => d.v.lineIdx).filter(i => i >= 0))];
    const green = Object.values(st).filter(v => v === 'gps').length;
    lineStatusOk = !!L.lineStatus && (opDrawn > 0 ? green > 0 : green === 0);
    console.log(`  ${lineStatusOk ? 'PASS' : 'FAIL'}  lineStatus(): grün genau dann, wenn ein` +
      ` Betreiberfahrzeug vorliegt (gezeichnet ${heads.data.length}, Betreiber ${opDrawn}, grüne Linien ${green})` +
      ` [diag: keys=${Object.keys(st).length} drawnIdx=${drawnIdx.length}]`);
    // Der stadtweite Teil (offene Linien) kommt aus coveragePoll; hier geprüft, dass er einfließt.
    const cov = { 3: 'feed', 4: 'feed' };
    L._test.setCoverage(cov);
    const st2 = L.lineStatus();
    lineStatusOk = lineStatusOk && st2[3] === 'feed' && st2[4] === 'feed';
    console.log(`  ${st2[3] === 'feed' && st2[4] === 'feed' ? 'PASS' : 'FAIL'}  lineStatus() nimmt den` +
      ` stadtweiten Stand als Grundlage (Probe: Linien 3/4 = ${st2[3]}/${st2[4]})`);
    L._test.setCoverage({});
  }
  console.log('  Linien ohne meta.json-Treffer:', unmatched, '/', heads.data.length);

  console.log('\n=== UI-Ausgaben ===');
  console.log('  #n-tram/#n-bus/#n-rail:', el('n-tram').textContent, '/', el('n-bus').textContent, '/', el('n-rail').textContent);
  console.log('  #livestat:', el('livestat').innerHTML.replace(/<[^>]+>/g, ''));
  console.log('  #livestat2:', el('livestat2').innerHTML.replace(/<[^>]+>/g, ''));

  console.log('\n=== Beispiele ===');
  for (const d of heads.data.slice(0, 6)) {
    console.log(`  ${d.v.mode.padEnd(5)} ${String(d.v.lineName).padEnd(4)} ${String(d.v.delayMin).padStart(3)} min @ ${d.pos[0].toFixed(5)},${d.pos[1].toFixed(5)}  ${shortStop(d.v.fromName).slice(0, 24)} -> ${shortStop(d.v.dest).slice(0, 24)}  Restpunkte=${d.rest.length}`);
  }

  // Kartenebenen statt DOM: jedes gezeichnete Fahrzeug ist ein Feature mit label/mode/source/pillimg,
  // jede Linie hat ihr Bild in beiden Größen (und den Fokus), und im DOM steht keine Marke.
  const C = L._test.CANVAS;
  const feats = gl.features(C.VEHICLE_SOURCE), stopFeats = gl.features(C.STOP_SOURCE);
  const labels = [...new Set(feats.map(f => f.properties.label))];
  const noImg = labels.filter(l => !['pill-', 'pills-', 'pillf-'].every(pre => gl.images.has(pre + l)));
  const domMarks = Object.values(elements).filter(n => n && n.classList && (n.classList.contains('mk') || n.classList.contains('stopmk'))).length;
  const canvasOk = feats.length === heads.data.length && feats.length > 0 && noImg.length === 0 && domMarks === 0 &&
    feats.every(f => typeof f.properties.label === 'string' && ['tram', 'bus', 'rail'].includes(f.properties.mode) &&
      ['open', 'operator'].includes(f.properties.source) && f.properties.pillimg === 'pill-' + f.properties.label) &&
    stopFeats.length === stations.data.length;
  console.log('\n=== Kartenebenen ===');
  console.log(`  ${canvasOk ? 'PASS' : 'FAIL'}  Features ${feats.length} (Fahrzeuge ${heads.data.length}), Linien ${labels.length},` +
    ` Bilder ${gl.images.size}, Linien ohne Bildsatz ${noImg.length}, Halte-Features ${stopFeats.length}/${stations.data.length}, DOM-Marken ${domMarks}`);

  const rtOnly = heads.data.every(d => d.v.realTime === true);
  console.log('\n=== Geprüft ===');
  console.log(`  Fahrzeuge > 0: ${info.count > 0} | ungültige Koordinaten = 0: ${nan === 0} | alle im Raum Darmstadt: ${inBox === pos.length}`);
  console.log(`  Trails == Heads: ${trails.data.length === heads.data.length} | nur realTime===true: ${rtOnly}`);
  console.log(`  Halte besitzen Koordinaten und stopId: ${stations.data.length > 0 && stations.data.every(s => isFinite(s.lat) && isFinite(s.lon) && !!s.stopId)}`);
  sandbox.window.DarmstadtLive.setOn(false);
  const off = sandbox.window.DarmstadtLive.info();
  console.log(`  nach setOn(false): active=${off.active} polling=${off.polling}`);

  console.log('\n=== EN/DE-Abdeckung ===');
  let i18nFails = 0;
  require('./test_i18n').run((n, c, e) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${!c && e ? ' — ' + e : ''}`); if (!c) i18nFails++; });

  const ok = lineStatusOk && canvasOk && info.count > 0 && nan === 0 && inBox === pos.length && trails.data.length === heads.data.length &&
    rtOnly && !off.active && !off.polling && i18nFails === 0 &&
    stations.data.length > 0 && stations.data.every(s => isFinite(s.lat) && isFinite(s.lon) && !!s.stopId);
  console.log('\nRESULT:', ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})();
