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
    querySelectorAll() { return []; },        // live.js verdrahtet Klick-Ziele in den Popup-Zeilen
    getContext() { return { setTransform() {}, clearRect() {}, fillRect() {}, fillText() {}, set fillStyle(v) {}, set font(v) {} }; },
  });
}

const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const fmt = s => { s = ((s % 86400) + 86400) % 86400; return String(Math.floor(s / 3600)).padStart(2, '0') + ':' + String(Math.floor(s % 3600 / 60)).padStart(2, '0'); };
const shortStop = n => String(n).replace(/^Darmstadt[- ]/, '');
const MODE_RGB = { tram: [255, 107, 107], bus: [46, 196, 182], rail: [199, 125, 255] };
class Layer { constructor(p) { Object.assign(this, p); } }

const store = {};
const net = { calls: [], hold: null };   // zählt echte Abrufe; hold = Promise, auf das /trip-Antworten warten
const realFetch = (url, opts) => fetch(url, { ...(opts || {}), headers: { ...((opts && opts.headers) || {}), 'User-Agent': 'hermes-darmstadt-ui-test/1.0' } });
const sandbox = {
  console, Math, JSON, Date, Number, String, Array, Object, Map, Set, parseInt, parseFloat, isNaN, isFinite,
  setTimeout, clearTimeout, setInterval, clearInterval, Promise, Float64Array, Error, Uint16Array, CustomEvent: class {},
  navigator: { language: 'en-GB' },
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
  fetch: async (url, opts) => {
    net.calls.push(url);
    if (url.includes('tripId=__nolegs__')) return { ok: true, status: 200, json: async () => ({ legs: [] }) };
    if (url.includes('tripId=__xss__')) return { ok: true, status: 200, json: async () => ({ legs: [{ tripId: '__xss__',
      agencyName: '<img src=x onerror=alert(1)>', from: { name: '<b>A</b>' }, to: { name: 'Z\"><script>x</script>' },
      startTime: new Date(Date.now() + 60000).toISOString(), endTime: new Date(Date.now() + 600000).toISOString(),
      scheduledStartTime: 'garbage', intermediateStops: [{ name: '<svg onload=1>', departure: new Date(Date.now() + 120000).toISOString() }] }] }) };
    if (net.hold && url.includes('/api/v1/trip?')) await net.hold;
    return realFetch(url, opts);
  },
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

const mapHandlers = {};
const easeCalls = [];
const containerListeners = {};
const mapContainer = {
  clientWidth: 1280, clientHeight: 800,
  addEventListener: (ev, fn) => { (containerListeners[ev] = containerListeners[ev] || []).push(fn); },
};
const map = {
  getBounds: () => ({ getWest: () => 8.63, getSouth: () => 49.86, getEast: () => 8.68, getNorth: () => 49.89 }),
  getZoom: () => 14, on(ev, fn) { mapHandlers[ev] = fn; },
  getContainer: () => mapContainer,
  // lineare Näherung um Darmstadt, damit die Popup-Platzierung nachrechenbar ist
  project: ([lon, lat]) => ({ x: 640 + (lon - 8.652) * 9000, y: 400 - (lat - 49.872) * 9000 }),
  easeTo: opts => { easeCalls.push(opts); },
  isMoving: () => false,
};
const overlay = { setProps(p) { cap.layers = p.layers; if (p.onClick) cap.onClick = p.onClick; } };
const state = { modes: { tram: true, bus: true, rail: true }, selLine: null, selAt: 0 };
let hideCalls = 0;                          // zählt, ob die Karte auf dem Telefon das Panel wegschickt

sandbox.I18N.init();
sandbox.DarmstadtLive.attach({ map, overlay, deck: sandbox.deck, META, state, hex, fmt, shortStop, MODE_RGB, selectLine: () => {},
  hidePanel: () => { hideCalls++; } });

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
  const heads = (cap.layers.find(l => l.id === 'live-heads') || { data: [] }).data;
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
  check('Popup nennt Verspätungsstatus', /class="pop-delay (late|ontime|early|unknown)">(Delayed|On time|Early|Delay unknown)/.test(html));
  check('Popup weist die Ableitung aus (kein GPS)', html.includes(sandbox.I18N.t('popup.positionNote')));
  const stopMatches = html.match(/class="st-name"/g);
  console.log(`  Haltezeilen im Popup: ${stopMatches ? stopMatches.length : 0}`);

  console.log('\n=== Verspätungsstatus im Popup (explizites Wort) ===');
  const lateV = heads.map(d => d.v).find(x => x.delayMin >= 1);
  const okV = heads.map(d => d.v).find(x => x.delayMin === 0);
  const earlyV = heads.map(d => d.v).find(x => x.delayMin <= -1);
  for (const [label, cand, wantWord, wantCls] of [
    ['verspätet', lateV, /Delayed/, 'late'],
    ['pünktlich', okV, /On time/, 'ontime'],
    ['verfrüht', earlyV, /Early/, 'early'],
  ]) {
    if (!cand) { console.log(`  (kein ${label}es Fahrzeug in der Liste — übersprungen)`); continue; }
    await sandbox.DarmstadtLive.openPopup(cand);
    const m = el('popup').innerHTML.match(/class="pop-delay ([a-z]+)">([^<]*)</);
    console.log(`  ${label.padEnd(11)} Verspätung=${String(cand.delayMin).padStart(3)} min  Klasse=${m[1]}  Text="${m[2]}"`);
    check(`${label}: Statuswort und Klassenfarbe`, !!m && wantWord.test(m[2]) && m[1] === wantCls);
  }
  console.log('\n=== Popup sitzt am Fahrzeug (nächste 3 Halte, Uhrzeiten) ===');
  {
    sandbox.matchMedia = () => ({ matches: true });     // Desktop: Popup folgt dem Punkt
    const pv = heads.map(d => d.v)[0];
    await sandbox.DarmstadtLive.openPopup(pv);
    const p = el('popup');
    const left = parseFloat(p.style.left), top = parseFloat(p.style.top);
    console.log(`  Position: left=${p.style.left} top=${p.style.top} (Fenster 1280x800)`);
    check('Popup ist am Punkt platziert statt in einer festen Ecke',
      Number.isFinite(left) && Number.isFinite(top) && left > 0 && top > 0 && left < 1280 && top < 800);
    const rows = (p.innerHTML.match(/class="st-name"/g) || []).length;
    console.log(`  Haltezeilen im Popup: ${rows}`);
    check('Popup zeigt höchstens die nächsten drei Halte', rows >= 1 && rows <= 3);
    check('Popup nennt die Uhrzeiten der Halte', /class="st-clock"/.test(p.innerHTML));
    check('Popup nennt Status und Verspätung als Wort', /On time|Delayed|Early/.test(p.innerHTML));
    sandbox.DarmstadtLive.render(true);          // Ebenen neu bauen, damit der Ring entsteht
    const focusLayer = cap.layers.find(l => l.id === 'live-focus');
    const focusR = focusLayer && focusLayer.data.length === 1
      ? (typeof focusLayer.getRadius === 'function' ? focusLayer.getRadius(focusLayer.data[0]) : focusLayer.getRadius) : 0;
    check('angeklicktes Fahrzeug bekommt einen deutlich sichtbaren Ring (pulsierend, >= 13px)',
      !!focusLayer && focusLayer.data.length === 1 && focusR >= 13, `radius ${focusR}px`);

    console.log('\n=== Kamera folgt dem Fahrzeug, gibt nach 2 s frei ===');
    easeCalls.length = 0;
    cap.onClick({ object: { v: pv } });
    const zoom = easeCalls.length ? Math.max(...easeCalls.map(c => c.zoom || 0)) : 0;
    console.log(`  easeTo beim Klick: ${easeCalls.length} Aufruf(e), Zoom ${zoom}`);
    check('Klick zoomt auf das Fahrzeug', easeCalls.length > 0 && zoom >= 14.8);
    await wait(300);
    sandbox.DarmstadtLive.render(true);
    const during = easeCalls.length;
    check('Kamera begleitet den Punkt weiter', during > 1, `${during} Aufrufe`);
    await wait(2100);
    sandbox.DarmstadtLive.render(true);
    const after = easeCalls.length;
    sandbox.DarmstadtLive.render(true);
    check('nach 2 s ist die Kamera wieder frei', easeCalls.length === after, `${easeCalls.length - after} Nachläufer`);
    cap.onClick({ object: { v: pv } });
    const nb = easeCalls.length;
    (containerListeners.wheel || []).forEach(f => f({}));
    sandbox.DarmstadtLive.render(true);
    check('eigene Geste beendet das Begleiten sofort', easeCalls.length === nb, `${easeCalls.length - nb} Aufrufe nach dem Rad`);

    // Touch-Gerät: das Popup bleibt Bottom-Sheet, es wird nicht am Punkt verschoben
    sandbox.matchMedia = () => ({ matches: false });
    await sandbox.DarmstadtLive.openPopup(pv);
    const pt = el('popup');
    check('auf Touch bleibt das Popup im Bottom-Sheet (keine Inline-Position)',
      !pt.style.left && !pt.style.top, `${pt.style.left || '-'}/${pt.style.top || '-'}`);
    // Auf dem Telefon wird nicht mitgefahren (Wunsch des Betreibers), am Rechner schon
    sandbox.DarmstadtLive._test.resetFollow();
    cap.onClick({ object: { v: pv } });
    const phoneFollow = sandbox.DarmstadtLive._test.following();
    const phoneEase = easeCalls[easeCalls.length - 1];
    sandbox.matchMedia = () => ({ matches: true });
    sandbox.DarmstadtLive._test.resetFollow();
    cap.onClick({ object: { v: pv } });
    const pcFollow = sandbox.DarmstadtLive._test.following();
    console.log(`  Begleiten: Telefon ${phoneFollow} (Versatz ${JSON.stringify(phoneEase && phoneEase.offset)}) | Rechner ${pcFollow}`);
    check('auf dem Telefon wird das Fahrzeug NICHT begleitet', phoneFollow === false);
    check('am Rechner wird es weiterhin begleitet', pcFollow === true);
    check('auf dem Telefon wird der Bus beim Klick einmal gezeigt — und zwar über dem Sheet',
      !!phoneEase && phoneEase.center && phoneEase.offset && phoneEase.offset[1] < 0,
      `offset ${JSON.stringify(phoneEase && phoneEase.offset)}`);
    sandbox.DarmstadtLive._test.resetFollow();
    sandbox.DarmstadtLive.closePopup();                 // sonst erbt der Haltestellen-Test nur dessen Halte
    sandbox.matchMedia = () => ({ matches: true });     // Popup wird später erneut geöffnet (Sprachprüfung)
  }

  console.log('\n=== Haltestellen aus dem Feed (echte Positionen, Klick bewegt die Kamera) ===');
  {
    sandbox.DarmstadtLive.render(true);
    const layer = cap.layers.find(l => l.id === 'live-stations');
    const sts = (layer && layer.data) || [];
    console.log(`  Halte im Ausschnitt: ${sts.length} (Modul meldet ${sandbox.DarmstadtLive.info().stops})`);
    check('Haltestellen-Ebene existiert und ist befüllt', !!layer && sts.length > 0);
    check('Halte haben echte Koordinaten und eine stopId',
      sts.length > 0 && sts.every(s => Number.isFinite(s.lat) && Number.isFinite(s.lon) && !!s.stopId));
    check('Halte liegen im Darmstadt-Ausschnitt (keine Fantasiekoordinaten)',
      sts.length > 0 && sts.every(s => s.lat > 49.6 && s.lat < 50.2 && s.lon > 8.3 && s.lon < 9.0));
    const hit = cap.layers.find(l => l.id === 'live-stations-hit');
    const hitR = hit ? (typeof hit.getRadius === 'function' ? hit.getRadius(sts[0]) : hit.getRadius) : 0;
    check('Halte haben eine großzügige Trefferfläche zum Tippen',
      !!hit && hit.data.length === sts.length && hitR >= 8 && hit.pickable === true,
      hit ? `radius ${hitR}px` : 'fehlt');

    let found = null, deps = null;
    for (const cand of sts.slice(0, 6)) {                 // erster Halt mit gemeldeten Abfahrten
      easeCalls.length = 0;
      await sandbox.DarmstadtLive.openStation(cand);
      const n = sandbox.DarmstadtLive.info().popupDepartures;
      if (typeof n === 'number' && n > 0) { found = cand; deps = n; break; }
    }
    const target = found || sts[0];
    if (!found) { easeCalls.length = 0; await sandbox.DarmstadtLive.openStation(target); }
    const inf = sandbox.DarmstadtLive.info();
    console.log(`  Halt "${target.name}": Kamera-Zoom ${easeCalls.length ? easeCalls[0].zoom : '-'} | Abfahrten ${inf.popupDepartures}`);
    check('Klick auf einen Halt bewegt die Kamera genau dorthin',
      easeCalls.length > 0 && Array.isArray(easeCalls[0].center) &&
      Math.abs(easeCalls[0].center[0] - target.lon) < 1e-9 && Math.abs(easeCalls[0].center[1] - target.lat) < 1e-9);
    check('Popup ist als Haltestelle geöffnet', inf.popupKind === 'station' && inf.popupOpen === true);
    check('Haltestellenkarte listet Abfahrten', typeof inf.popupDepartures === 'number' && inf.popupDepartures >= 1,
      `popupDepartures=${inf.popupDepartures}`);
    const sh = el('popup').innerHTML;
    check('Karte nennt Halt, Abfahrtsüberschrift und Linienbadge',
      /class="st-line"/.test(sh) && sh.includes(sandbox.I18N.t('station.departures')));
    check('Karte nennt Uhrzeiten der Abfahrten', /class="st-clock"/.test(sh));
    check('Karte weist die Quelle der Positionen aus', sh.includes(sandbox.I18N.t('station.mapNote')));
    // Für die folgende Sprachprüfung eine Fahrzeugkarte geöffnet lassen (dort steht "Nächste Halte")
    await sandbox.DarmstadtLive.openPopup(heads.map(d => d.v)[0]);
  }

  console.log('\n=== Halt in der Fahrzeugkarte anklicken -> dorthin springen ===');
  {
    await sandbox.DarmstadtLive.openPopup(heads.map(d => d.v)[0]);
    const list = sandbox.DarmstadtLive._test.popupStopList();
    const withCoords = list.find(s => s.lat !== null && s.lon !== null);
    console.log(`  Halte in der Karte: ${list.length}, davon mit Koordinaten: ${list.filter(s => s.lat !== null && s.lon !== null).length}`);
    check('Halte der Fahrzeugkarte bringen Koordinaten und Kennung mit', !!withCoords && !!withCoords.stopId);
    if (withCoords) {
      easeCalls.length = 0;
      sandbox.DarmstadtLive._test.goToStop(list.indexOf(withCoords));
      const inf = sandbox.DarmstadtLive.info();
      console.log(`  Sprung zu "${withCoords.full}": Kamera ${easeCalls.length ? JSON.stringify(easeCalls[0].center) : '-'} | Art ${inf.popupKind} | Abfahrten ${inf.popupDepartures}`);
      check('Klick auf einen Halt springt genau dorthin',
        easeCalls.length > 0 && Math.abs(easeCalls[0].center[0] - withCoords.lon) < 1e-9 && Math.abs(easeCalls[0].center[1] - withCoords.lat) < 1e-9);
      check('und zwar ohne Kamera-Animation (sofort)', easeCalls.length > 0 && easeCalls[0].duration === 0);
      check('und öffnet die Haltestellenkarte', inf.popupKind === 'station');
    }
    sandbox.DarmstadtLive.closePopup();
    await sandbox.DarmstadtLive.openPopup(heads.map(d => d.v)[0]);   // für die Sprachprüfung offen lassen
  }

  console.log('\n=== Linie wählen -> nur diese Linie auf der Karte ===');
  {
    const byLine = new Map();
    for (const d of heads) if (d.v.lineIdx >= 0) byLine.set(d.v.lineIdx, (byLine.get(d.v.lineIdx) || 0) + 1);
    const pick = [...byLine.entries()].sort((a, b) => b[1] - a[1])[0];
    check('mindestens eine Linie mit Fahrzeugen vorhanden', !!pick);
    if (pick) {
      const [lineIdx, before] = pick;
      state.selLine = lineIdx; state.selAt = Date.now();   // wie ein Klick auf den Chip im Panel
      sandbox.DarmstadtLive.closePopup();
      sandbox.DarmstadtLive.render(true);
      const shown = (cap.layers.find(l => l.id === 'live-heads') || { data: [] }).data;
      const st = (cap.layers.find(l => l.id === 'live-stations') || { data: [] }).data;
      console.log(`  Linie ${META.lines[lineIdx].name}: ${before} Fahrzeuge vorher, ${shown.length} gezeichnet, Halte ${st.length}`);
      check('nur Fahrzeuge der gewählten Linie werden gezeichnet', shown.length > 0 && shown.every(d => d.v.lineIdx === lineIdx));
      check('und keine Haltestellen (kein Rauschen)', st.length === 0);

      await sandbox.DarmstadtLive.openPopup(shown[0].v);
      sandbox.DarmstadtLive.render(true);
      const st2 = (cap.layers.find(l => l.id === 'live-stations') || { data: [] }).data;
      console.log(`  Fahrzeug markiert: nur dessen Halte (${st2.length}), alle als Fokus: ${st2.every(s => s.focus === true)}`);
      check('markiertes Fahrzeug zeigt nur seine eigenen Halte', st2.length > 0 && st2.every(s => s.focus === true));

      sandbox.DarmstadtLive.closePopup(); state.selLine = null;
      sandbox.DarmstadtLive.render(true);
      const st3 = (cap.layers.find(l => l.id === 'live-stations') || { data: [] }).data;
      check('ohne Auswahl erscheinen wieder alle Halte', st3.length > 0 && !st3.some(s => s.focus));

      // Nach 10 s ohne Interaktion dürfen die Halte zurückkommen (Ruheuhr in state.selAt)
      state.selLine = lineIdx; state.selAt = Date.now();
      sandbox.DarmstadtLive.render(true);
      const stHidden = (cap.layers.find(l => l.id === 'live-stations') || { data: [] }).data.length;
      sandbox.DarmstadtLive._test.setRelaxAt(Date.now() - sandbox.DarmstadtLive._test.RELAX_MS - 1000);
      sandbox.DarmstadtLive.render(true);
      const stBack = (cap.layers.find(l => l.id === 'live-stations') || { data: [] }).data.length;
      console.log(`  Ruheuhr: Halte sofort ${stHidden} -> nach 10 s ${stBack}`);
      check('sofort nach der Linienwahl keine Halte', stHidden === 0);
      check('nach 10 s ohne Interaktion kommen die Halte zurück', stBack > 0);
      state.selLine = null;
      sandbox.DarmstadtLive.render(true);
      await sandbox.DarmstadtLive.openPopup(heads.map(d => d.v)[0]);   // für die Sprachprüfung offen lassen
    }
  }

  console.log('\n=== Verbindungslinie, ziehbare Karte, Telefon-Schublade ===');
  {
    const t = sandbox.DarmstadtLive._test;
    check('Verbindungslinie rechnet von Ecke zu Punkt',
      t.leaderD({ x: 10, y: 20 }, { x: 30, y: 40 }) === 'M 10.0 20.0 L 30.0 40.0');

    // bevorzugt rechts über dem Punkt; am rechten Rand links daneben, oben kein Platz -> darunter
    const right = t.layoutPopup({ x: 100, y: 400 }, 300, 200, 1280, 800, 8);
    const leftEdge = t.layoutPopup({ x: 1270, y: 400 }, 300, 200, 1280, 800, 8);
    const topEdge = t.layoutPopup({ x: 600, y: 5 }, 300, 200, 1280, 800, 8);
    console.log(`  Karte: rechts ${JSON.stringify(right)} | Rand rechts ${JSON.stringify(leftEdge)} | am oberen Rand ${JSON.stringify(topEdge)}`);
    check('Karte sitzt rechts über dem Punkt', right.x === 118 && right.y === 188);
    check('am rechten Rand wechselt sie nach links', leftEdge.x + 300 <= 1272 && leftEdge.x < 1270 - 100);
    check('am oberen Rand rutscht sie unter den Punkt', topEdge.y === 23);
    check('Karte bleibt im Bild (>= 8px Rand)',
      [right, leftEdge, topEdge].every(p => p.x >= 8 && p.y >= 8 && p.x + 300 <= 1272 && p.y + 200 <= 792));

    // Vom Nutzer gezogene Karte: gleicher Punkt, aber um den Versatz verschoben
    await sandbox.DarmstadtLive.openPopup(heads.map(d => d.v)[0]);
    const el = sandbox.DarmstadtLive._test;
    el.setDrag(null); sandbox.DarmstadtLive.render(true);
    const baseL = parseFloat(sandbox.document.getElementById('popup').style.left);
    const baseT = parseFloat(sandbox.document.getElementById('popup').style.top);
    el.setDrag({ dx: -80, dy: 45 }); sandbox.DarmstadtLive.render(true);
    const dragL = parseFloat(sandbox.document.getElementById('popup').style.left);
    const dragT = parseFloat(sandbox.document.getElementById('popup').style.top);
    console.log(`  Versatz: vorher (${baseL},${baseT}) -> gezogen (${dragL},${dragT})`);
    check('gezogene Karte wandert genau um den Versatz (und bleibt am Punkt)',
      Math.abs((dragL - baseL) + 80) < 1.5 && Math.abs((dragT - baseT) - 45) < 1.5);

    // Tippen auf die Karte schließt auf dem Telefon das Panel
    const before = hideCalls;
    cap.onClick({ object: null });
    check('Tipp auf die Karte schließt das Panel (Telefon-Haken wird gerufen)', hideCalls === before + 1);
    check('und startet die 10-s-Ruheuhr neu', typeof state.selAt === 'number' && state.selAt > 0);
    sandbox.DarmstadtLive.closePopup();
    await sandbox.DarmstadtLive.openPopup(heads.map(d => d.v)[0]);   // für die Sprachprüfung offen lassen
  }

  console.log('\n=== Sprachumschaltung ===');
  const enTitle = el('livestat').innerHTML;
  sandbox.I18N.set('de');
  sandbox.DarmstadtLive.setLang();
  const deTitle = el('livestat').innerHTML;
  console.log(`  EN: ${enTitle.replace(/<[^>]+>/g, '')}`);
  console.log(`  DE: ${deTitle.replace(/<[^>]+>/g, '')}`);
  check('livestat ist deutsch', /Fahrzeuge unterwegs/.test(deTitle));
  check('livestat war englisch', /vehicles en route/.test(enTitle));
  console.log(`  Popup-Text (de): ${el('popup').innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 130)}`);
  check('Popup wurde übersetzt', el('popup').innerHTML.includes('Nächste Halte'));
  check('Sprachwahl gespeichert', store['darmstadt-live-lang'] === 'de');
  check('Dokumentensprache gesetzt', sandbox.document.documentElement.lang === 'de');

  sandbox.DarmstadtLive.closePopup();
  check('Popup schließt', sandbox.DarmstadtLive.info().popupOpen === false);
  check('Popup-Timer nach dem Schließen gestoppt', sandbox.DarmstadtLive.info().popupTimer === false);
  sandbox.I18N.set('en');

  const L = sandbox.DarmstadtLive, X = L._test;
  const iso = ms => new Date(Date.now() + ms).toISOString();
  const enc = pts => {                      // Google-Polyline-Kodierung (lat, lon)
    let out = '', pl = 0, pn = 0;
    const e = v => { v = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
    for (const [lat, lon] of pts) { const a = Math.round(lat * 1e5), b = Math.round(lon * 1e5); out += e(a - pl) + e(b - pn); pl = a; pn = b; }
    return out;
  };
  const POLY = enc([[49.872, 8.650], [49.873, 8.655], [49.874, 8.660]]);
  const rec = o => Object.assign({ mode: 'TRAM', realTime: true, polyline: POLY, departure: iso(-30000), arrival: iso(60000),
    scheduledDeparture: iso(-90000), from: { name: 'Darmstadt Schloss', stopId: 's1' }, to: { name: 'Darmstadt Luisenplatz' },
    trips: [{ tripId: 't-' + Math.random(), routeShortName: '4' }] }, o);

  console.log('\n=== Nur Echtzeit (synthetische Datensätze) ===');
  const rt = X.buildVehicles([rec({ realTime: false }), rec({ realTime: 'true' }), rec({ realTime: undefined }), rec({})]);
  check('realTime=false/"true"/fehlend werden verworfen, nur realTime===true bleibt', rt.length === 1 && rt[0].realTime === true, `${rt.length} gebaut`);

  console.log('\n=== Fehlerhafte API-Datensätze ===');
  let built, threw = null;
  try {
    built = X.buildVehicles([null, 7, 'x', {}, rec({ trips: null }), rec({ trips: 'nope' }), rec({ polyline: 12345 }),
      rec({ departure: 'kaputt' }), rec({ arrival: 'kaputt' }), rec({ polyline: '@@' }),
      rec({ scheduledDeparture: 'kaputt', trips: [{ tripId: 'badsched', routeShortName: 5 }] }),
      rec({ routeColor: 'zz<x>z', trips: [{ tripId: 'badcolor' }] }), rec({ from: null, to: null, trips: [{ tripId: 'nostops' }] })]);
  } catch (e) { threw = e; }
  check('fehlerhafte Datensätze werfen keine Ausnahme', !threw, threw && threw.message);
  built = built || [];
  console.log(`  gebaut: ${built.map(v => v.tripId.slice(0, 10) + ':' + v.delayMin).join(', ')}`);
  const bs = built.find(v => v.tripId === 'badsched');
  check('ungültige Sollzeit -> Verspätung unbekannt (nicht NaN, nicht "On time")',
    bs && bs.delayMin === null && X.delayText(bs.delayMin) === 'Delay unknown' && X.delayClass(bs.delayMin) === 'unknown');
  check('Liniennummer als Zahl wird zu Text', bs && bs.lineName === '5');
  const at = X.vehiclesAt.call ? (X.setVehicles(built), X.vehiclesAt(Date.now())) : [];
  check('keine NaN-Positionen aus fehlerhaften Datensätzen', at.length > 0 && at.every(c => isFinite(c.pos[0]) && isFinite(c.pos[1])), `${at.length} Positionen`);
  const bc = built.find(v => v.tripId === 'badcolor');
  sandbox.DarmstadtLive.render(true);
  const headsLayer = cap.layers.find(l => l.id === 'live-heads');
  const fills = headsLayer.data.map(d => headsLayer.getFillColor(d));
  check('ungültige routeColor ergibt keine NaN-Farbe', !!bc && fills.every(c => c.every(Number.isFinite)));
  const ns = built.find(v => v.tripId === 'nostops');
  check('fehlende from/to-Halte: leere Namen statt "undefined"', ns && ns.fromName === '' && ns.dest === '');
  check('Statistik zählt unbekannte Verspätung nicht als pünktlich', !/NaN/.test(el('livestat').innerHTML));

  console.log('\n=== Statuswort für alle Fälle (synthetisch, unabhängig von der aktuellen Lage) ===');
  for (const [d, word, cls] of [[3, 'Delayed · +3 min', 'late'], [0, 'On time', 'ontime'], [-2, 'Early · −2 min', 'early'], [null, 'Delay unknown', 'unknown']]) {
    console.log(`  delay=${String(d).padStart(4)} -> "${X.delayText(d)}" / ${X.delayClass(d)}`);
    check(`Statuswort für ${d}`, X.delayText(d) === word && X.delayClass(d) === cls);
  }

  console.log('\n=== Veraltete Positionen ===');
  const old = X.buildVehicles([rec({ trips: [{ tripId: 'old' }] })])[0];
  old.dep = Date.now() - 300000; old.arr = Date.now() - 120000;    // Abschnitt seit 2 min vorbei, kein neuer Abruf
  X.setVehicles([old]);
  check('Fahrzeug mit längst beendetem Abschnitt wird nicht mehr gezeichnet', X.vehiclesAt(Date.now()).length === 0);

  console.log('\n=== HTML-Escaping (XSS aus API-Texten) ===');
  const evil = X.buildVehicles([rec({ to: { name: '<img src=x onerror=alert(1)>' }, from: { name: '"><script>alert(2)</script>' },
    trips: [{ tripId: '__xss__', routeShortName: '<b onmouseover=alert(3)>9</b>', headsign: '<iframe src=//x>' }] })])[0];
  check('esc() maskiert & < > " \'', X.esc(`&<>"'`) === '&amp;&lt;&gt;&quot;&#39;');
  await L.openPopup(evil);
  const ph = el('popup').innerHTML;
  const rawTags = ph.match(/<(img|script|iframe|svg|b onmouseover)[^>]*>/gi);
  check('Popup enthält keine API-HTML-Tags', !rawTags, rawTags && rawTags.join(' '));
  check('Popup zeigt die API-Texte maskiert an', ph.includes('&lt;img src=x onerror=alert(1)&gt;') && ph.includes('&lt;svg onload=1&gt;'));
  sandbox.matchMedia = () => ({ matches: true });   // Maus: Tooltip
  cap.layers = null; X.setVehicles([evil]); L.render(true);
  const tipEl = el('tip'); tipEl.innerHTML = '';
  const ov = { setProps(p) { cap.layers = p.layers; cap.hover = p.onHover; } };
  sandbox.DarmstadtLive.attach({ map, overlay: ov, deck: sandbox.deck, META, state, hex, fmt, shortStop, MODE_RGB, selectLine: () => {} });
  L.render(true);
  cap.hover({ object: { v: evil }, x: 1, y: 1 });
  check('Hover-Tooltip maskiert API-Texte', !/<(img|iframe|b onmouseover)/i.test(tipEl.innerHTML) && tipEl.innerHTML.includes('&lt;b onmouseover'));
  sandbox.matchMedia = () => ({ matches: false });
  check('Touch: kein Hover-Tooltip', (cap.hover({ object: { v: evil }, x: 1, y: 1 }), tipEl.style.display === 'none'));
  L.closePopup();

  console.log('\n=== Popup: Fahrt ohne Abschnitte / fehlgeschlagene Abfrage ===');
  const nolegs = Object.assign({}, evil, { tripId: '__nolegs__', lineName: '4' });
  await L.openPopup(nolegs);
  check('keine legs -> eigene Meldung statt leerer Haltliste', L.info().popupError === 'noLegs' && el('popup').innerHTML.includes('No stop list was returned'));
  const bogus = Object.assign({}, evil, { tripId: 'bogus-trip-id', lineName: '4' });
  await L.openPopup(bogus);
  const be = L.info().popupError;
  console.log(`  Abfrage mit ungültiger tripId -> Fehler: ${be}`);
  check('fehlgeschlagene Abfrage zeigt "Trip details unavailable" (HTTP-Fehler oder Netzfehler)',
    !!be && el('popup').innerHTML.includes('Trip details unavailable'));
  L.closePopup();

  console.log('\n=== Popup: Wettlauf und Timer ===');
  const realV = heads.map(d => d.v);
  let release; net.hold = new Promise(r => { release = r; });
  const p1 = L.openPopup(realV[0]);
  L.closePopup();                            // schließen, solange die Abfrage noch läuft
  release(); await p1; net.hold = null;
  check('nach Schließen während der Abfrage bleibt das Popup zu', L.info().popupOpen === false);
  check('… und es wird kein Auffrisch-Timer gesetzt', L.info().popupTimer === false);
  check('… und der Inhalt bleibt leer', el('popup').innerHTML === '');
  if (realV.length >= 2) {
    let r2; net.hold = new Promise(r => { r2 = r; });
    const pa = L.openPopup(realV[0]);
    const pb = L.openPopup(realV[1]);       // zweites Fahrzeug, bevor das erste antwortet
    r2(); await Promise.all([pa, pb]); net.hold = null;
    const html2 = el('popup').innerHTML;
    check('schneller Wechsel: Popup zeigt das zuletzt angetippte Fahrzeug',
      html2.includes('>' + X.esc(realV[1].lineName) + '<') && L.info().popupOpen, `Linie ${realV[1].lineName}`);
    check('… mit genau einem Auffrisch-Timer', L.info().popupTimer === true);
    const before = net.calls.length;
    sandbox.I18N.set('de'); L.setLang();
    check('Sprachwechsel übersetzt das Popup ohne neuen Abruf', net.calls.length === before && el('popup').innerHTML.includes('Nächste Halte'));
    sandbox.I18N.set('en'); L.setLang();
    L.closePopup();
  } else console.log('  (weniger als 2 Live-Fahrzeuge — Wechseltest übersprungen, ausdrücklich nicht bestanden gewertet)'), check('mind. 2 Live-Fahrzeuge für den Wechseltest', false);

  console.log('\n=== Abruf aus, wenn der Modus aus ist ===');
  L.setOn(false);
  const n0 = net.calls.length;
  await L.refresh();
  if (mapHandlers.moveend) mapHandlers.moveend();
  await wait(1000);
  check('setOn(false): kein Poll-Intervall mehr', L.info().polling === false && L.info().active === false);
  check('setOn(false): weder refresh() noch Kartenbewegung rufen die API ab', net.calls.length === n0, `${net.calls.length - n0} Abrufe`);
  L.setOn(true);
  await wait(50);
  check('setOn(true): Abruf läuft wieder', net.calls.length > n0 && L.info().polling === true);
  L.setOn(false);

  console.log('\n=== EN/DE-Abdeckung ===');
  require('./test_i18n').run(check);

  console.log('\n=== Statische Prüfungen: CSS, Kontrast, Icons ===');
  require('./test_static').run(check);

  console.log(`\nRESULT: ${fails === 0 ? 'PASS' : 'FAIL (' + fails + ')'}`);
  process.exit(fails === 0 ? 0 : 1);
})();
