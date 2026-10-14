/* Integrationstest für die neuen Funktionen (ohne Browser):
 *  - nur Fahrzeuge mit realTime=true werden gezeichnet
 *  - Klick-Popup holt Fahrtdetails und listet kommende Halte
 *  - Sprachumschaltung EN/DE übersetzt Oberfläche und Popup
 * Läuft gegen die echte API, mit gestubbtem DOM/deck/map. */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const DOCS = path.join(__dirname, '..', 'docs');
const META = JSON.parse(fs.readFileSync(path.join(DOCS, 'data', 'meta.json'), 'utf8'));

const cap = { layers: null };
const els = {};
function el(id) {
  if (els[id]) return els[id];
  return (els[id] = {
    id, textContent: '', innerHTML: '', hidden: false, style: {}, dataset: {},
    clientWidth: 900, clientHeight: 46, width: 0, height: 0,
    classList: { _s: new Set(), toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    querySelector(sel) { return el(id + sel); },
    getContext() { return { setTransform() {}, clearRect() {}, fillRect() {}, fillText() {}, set fillStyle(v) {}, set font(v) {} }; },
  });
}

const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const fmt = s => { s = ((s % 86400) + 86400) % 86400; return String(Math.floor(s / 3600)).padStart(2, '0') + ':' + String(Math.floor(s % 3600 / 60)).padStart(2, '0'); };
const shortStop = n => String(n).replace(/^Darmstadt[- ]/, '');
const MODE_RGB = { tram: [255, 107, 107], bus: [46, 196, 182], rail: [199, 125, 255] };
class Layer { constructor(p) { Object.assign(this, p); } }

const store = {};
const sandbox = {
  console, Math, JSON, Date, Number, String, Array, Object, Map, Set, parseInt, parseFloat, isNaN, isFinite,
  setTimeout, clearTimeout, setInterval, clearInterval, Promise, Float64Array, Error, Uint16Array, CustomEvent: class {},
  navigator: { language: 'en-GB' },
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
  fetch: (url, opts) => fetch(url, { ...(opts || {}), headers: { ...((opts && opts.headers) || {}), 'User-Agent': 'hermes-darmstadt-ui-test/1.0' } }),
  document: {
    getElementById: el, addEventListener() {}, hidden: false, documentElement: { lang: '' }, title: '',
    querySelectorAll: () => [], createElement: () => el('tmp'),
  },
  deck: { PathLayer: Layer, ScatterplotLayer: Layer },
};
sandbox.window = sandbox;
sandbox.devicePixelRatio = 1;
sandbox.matchMedia = () => ({ matches: false });      // Touch-Verhalten
sandbox.dispatchEvent = () => {};

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(DOCS, 'i18n.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(DOCS, 'live.js'), 'utf8'), sandbox);

const map = {
  getBounds: () => ({ getWest: () => 8.63, getSouth: () => 49.86, getEast: () => 8.68, getNorth: () => 49.89 }),
  getZoom: () => 14, on() {},
};
const overlay = { setProps(p) { cap.layers = p.layers; } };
const state = { modes: { tram: true, bus: true, rail: true }, selLine: null };

sandbox.I18N.init();
sandbox.DarmstadtLive.attach({ map, overlay, deck: sandbox.deck, META, state, hex, fmt, shortStop, MODE_RGB, selectLine: () => {} });

const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fails = 0;
  const check = (name, cond, extra) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (!cond) fails++; };

  sandbox.DarmstadtLive.setOn(true);
  for (let i = 0; i < 60 && !sandbox.DarmstadtLive.info().lastOk; i++) await wait(500);

  const info = sandbox.DarmstadtLive.info();
  console.log('\n=== Fahrzeuge ===');
  console.log(`  Anzahl: ${info.count} | Fehler: ${info.lastErr}`);
  check('Fahrzeuge vorhanden', info.count > 0);

  sandbox.DarmstadtLive.render(true);
  const heads = cap.layers[1].data;
  console.log(`  Ebenen: ${cap.layers.map(l => l.id).join(' + ')} | Punkte: ${heads.length}`);
  check('jedes Fahrzeug hat realTime', heads.every(d => d.v.realTime === true));
  check('keine ungültigen Koordinaten', heads.every(d => isFinite(d.pos[0]) && isFinite(d.pos[1])));
  check('jedes Fahrzeug bringt Restgeometrie mit', heads.every(d => Array.isArray(d.rest)));

  console.log('\n=== Popup (Klick auf ein Fahrzeug) ===');
  const v = heads[0].v;
  console.log(`  Fahrzeug: Linie ${v.lineName} | Verspätung ${v.delayMin} min | tripId ${v.tripId}`);
  await sandbox.DarmstadtLive.openPopup(v);
  const pi = sandbox.DarmstadtLive.info();
  const html = el('popup').innerHTML;
  check('Popup ist geöffnet', pi.popupOpen === true);
  check('Popup listet kommende Halte', (pi.popupStops || 0) > 0, `${pi.popupStops} Halte`);
  check('Popup nennt die Linie', html.includes(String(v.lineName)));
  check('Popup nennt Verspätungsstatus', /min|pünktlich|on time|late|early/i.test(html));
  check('Popup weist die Ableitung aus (kein GPS)', html.includes(sandbox.I18N.t('popup.positionNote')));
  const stopMatches = html.match(/class="st-name"/g);
  console.log(`  Haltezeilen im Popup: ${stopMatches ? stopMatches.length : 0}`);

  console.log('\n=== Sprachumschaltung ===');
  const enTitle = el('livestat').innerHTML;
  sandbox.I18N.set('de');
  sandbox.DarmstadtLive.setLang();
  const deTitle = el('livestat').innerHTML;
  console.log(`  EN: ${enTitle.replace(/<[^>]+>/g, '')}`);
  console.log(`  DE: ${deTitle.replace(/<[^>]+>/g, '')}`);
  check('livestat ist deutsch', /Fahrzeuge unterwegs/.test(deTitle));
  check('livestat war englisch', /vehicles en route/.test(enTitle));
  check('Popup wurde übersetzt', el('popup').innerHTML.includes('Nächste Halte'));
  check('Sprachwahl gespeichert', store['darmstadt-live-lang'] === 'de');
  check('Dokumentensprache gesetzt', sandbox.document.documentElement.lang === 'de');

  sandbox.DarmstadtLive.closePopup();
  check('Popup schließt', sandbox.DarmstadtLive.info().popupOpen === false);

  console.log(`\nRESULT: ${fails === 0 ? 'PASS' : 'FAIL (' + fails + ')'}`);
  process.exit(fails === 0 ? 0 : 1);
})();
