/* Echter Browser-Smoke (opt-in, braucht Netz für den Live-Feed und ein laufendes Server-Verzeichnis).
 *
 * Warum diese Datei: die Suiten test_behaviour/test_ui/test_static fahren eine DOM-Attrappe. Ein echter
 * Chromium über CDP ist die einzige Prüfung, die die Verdrahtung der Seite so sieht wie der Betreiber —
 * u. a. den unbeachteten ReferenceError "paintLineStar is not defined" bei jeder Linienwahl und jedem
 * Sprachwechsel (selectLine stand eine Ebene über der Favoritenlogik). Der Smoke sammelt alle
 * uncaught exceptions (Runtime.exceptionThrown) und schlägt fehl, sobald eine auftritt.
 *
 * Benutzung (nicht Teil der Standardprüfungen):
 *   python3 -m http.server 8099 --directory docs &      # statisch, Pages-artig
 *   node analysis/smoke_browser.js http://127.0.0.1:8099/ [cdp-port]
 *
 * Umgebung: CHROME=/pfad/zu/chrome (Standard: Playwright-Chromium im Benutzer-Cache).
 */
const { spawn } = require('child_process');
const CHR = process.env.CHROME || '/home/talos/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome';
const URL_ = process.argv[2];
const PORT = Number(process.argv[3] || 9335);
if (!URL_) { console.error('usage: node analysis/smoke_browser.js <url> [cdp-port]'); process.exit(2); }

const chrome = spawn(CHR, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader',
  '--remote-debugging-port=' + PORT, '--user-data-dir=/tmp/chr-profile-' + PORT, 'about:blank'
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250);
    try { const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); target = l.find(t => t.type === 'page'); } catch {}
  }
  if (!target) throw new Error('no CDP target');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map(); const ex = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') ex.push((m.params.exceptionDetails.text || '') + ' :: ' + ((m.params.exceptionDetails.exception || {}).description || ''));
  };
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) return 'ERR: ' + (r.result.exceptionDetails.exception || {}).description;
    return r.result.result.value;
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: URL_ });
  await sleep(14000);

  // Start-Overlay wie ein Besucher bestätigen (Sprache, dann Hinweis) — es liegt sonst über den Pillen.
  for (let i = 0; i < 3; i++) {
    const shown = await ev("(function(){var w=document.getElementById('welcome');if(!w)return false;var cs=getComputedStyle(w);" +
      "if(cs.display==='none'||cs.visibility==='hidden'||w.hidden)return false;" +
      "var l=document.getElementById('wlang');if(l&&!l.hidden){var b=l.querySelector('button[data-lang=de]');if(b)b.click();}" +
      "document.getElementById('wnav').click();return true;})()");
    if (!shown) break;
    await sleep(800);
  }
  const r = { url: URL_ };
  r.badge = await ev("document.getElementById('livebadge').dataset.state");
  r.livestat = await ev("document.getElementById('livestat').textContent");
  // Die Marken sind MapLibre-Ebenen (GPU), nicht DOM: gezählt wird in der Karte, getippt wird mit einem
  // ECHTEN Mausklick (CDP Input) auf die Bildschirmposition einer gezeichneten Pille.
  const MAP = "window.DarmstadtLive._test.map()", C = "window.DarmstadtLive._test.CANVAS";
  r.domMarkers = await ev("document.querySelectorAll('.mk, .stopmk').length + document.getElementById('markers').children.length");
  r.canvas = await ev(`(function(){var m=${MAP},C=${C};var src=m.getSource(C.VEHICLE_SOURCE);
    var f=(src&&src._data&&src._data.features)||(src&&src.serialize&&src.serialize().data&&src.serialize().data.features)||[];
    var labels=[...new Set(f.map(x=>x.properties.label))];
    var missing=labels.filter(l=>!['pill-','pills-','pillf-'].every(p=>m.hasImage(p+l)));
    var r=m.queryRenderedFeatures({layers:[C.VEHICLE_PILLS]});
    return {features:f.length,labels:labels.length,missing:missing,rendered:r.length,
      props:f.length?Object.keys(f[0].properties).sort().join(','):'',zoom:m.getZoom(),
      vis:m.getLayoutProperty(C.VEHICLE_PILLS,'visibility')||'visible'};})()`);
  const pill = await ev(`(function(){var m=${MAP},C=${C};var r=m.queryRenderedFeatures({layers:[C.VEHICLE_PILLS]});
    var b=m.getCanvas().getBoundingClientRect();
    for(var i=0;i<r.length;i++){var p=m.project(r[i].geometry.coordinates);
      if(p.x>40&&p.y>40&&p.x<b.width-40&&p.y<b.height-40){
        var top=document.elementFromPoint(b.left+p.x,b.top+p.y);
        if(top&&top.tagName==='CANVAS')return {x:b.left+p.x,y:b.top+p.y,label:r[i].properties.label,key:r[i].properties.key};}}
    return null;})()`);
  if (pill && pill.x) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: pill.x, y: pill.y, button: 'left', clickCount: 1 });
    }
    r.clicked = pill.label;
  } else r.clicked = 'no rendered pill';
  await sleep(7000);
  r.popupVisible = await ev("(function(){var p=document.getElementById('popup');return !!(p&&p.classList.contains('on')&&p.textContent.trim())})()");
  r.popup = await ev("(function(){var p=document.getElementById('popup');return (p.textContent||'').replace(/\\s+/g,' ').slice(0,600)})()");
  r.stopRows = await ev("document.querySelectorAll('#popup .pop-stops li').length");
  r.stTag = await ev("document.querySelectorAll('#popup .st-tag').length");
  r.selName = await ev("(function(){var e=document.getElementById('selinfo');return e?e.style.display||'unset':'missing'})()");

  // Linienwahl muss die Fahrzeugauswahl wegräumen (M3) — Zustand davor festhalten
  const focusCount = `(function(){var m=${MAP},C=${C};return m.queryRenderedFeatures({layers:[C.VEHICLE_PILLS]}).filter(f=>f.properties.focus).length;})()`;
  r.followBefore = await ev(focusCount);
  r.chipCount = await ev("document.querySelectorAll('.chip[data-line]').length");
  r.lineClick = await ev("(function(){var c=document.querySelector('.chip[data-line]');if(!c)return 'no chip';c.click();return c.dataset.line})()");
  await sleep(3000);
  r.lineSelActive = await ev("document.querySelectorAll('.chip.sel').length");
  r.selinfoAfterLine = await ev("(function(){var e=document.getElementById('selinfo');return e?(e.style.display||'unset'):'missing'})()");
  r.starAfterLine = await ev("document.getElementById('selfav').textContent");
  r.popupAfterLine = await ev("(function(){var p=document.getElementById('popup');return !!(p&&p.classList.contains('on'))})()");
  r.followAfterLine = await ev(focusCount);

  // DE-Umschaltung, Wortlaut im Popup
  await ev("(function(){var b=document.querySelectorAll('#lang .seg button');if(b[1])b[1].click();return b.length})()");
  await sleep(1500);
  r.lang = await ev("document.documentElement.lang");
  r.attribDe = await ev("(function(){var e=document.querySelector('[data-i18n=attributionPosition]');return (e?e.textContent:'').slice(0,140)})()");
  r.badgeDe = await ev("document.getElementById('livebadgetxt').textContent");
  r.exceptions = ex;

  console.log(JSON.stringify(r, null, 2));

  let fails = 0;
  const ck = (n, c, extra) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${extra ? ' — ' + extra : ''}`); if (!c) fails++; };
  console.log('\n=== Smoke-Urteil ===');
  ck('keine uncaught exception auf der Seite (Linienwahl + Sprachwechsel)', ex.length === 0, ex.join(' | '));
  ck('Linienwahl zeigt das Auswahlfeld', r.selinfoAfterLine === 'flex', String(r.selinfoAfterLine));
  ck('die gewählte Linie ist markiert', Number(r.lineSelActive) >= 1, String(r.lineSelActive));
  ck('Linienwahl räumt die Fahrzeugauswahl weg (M3)', r.popupAfterLine === false && Number(r.followAfterLine) === 0,
    `popup=${r.popupAfterLine} follow=${r.followAfterLine}`);
  const cv = r.canvas || {};
  ck('keine Marke im DOM (Pillen sind Kartenebenen)', Number(r.domMarkers) === 0, String(r.domMarkers));
  ck('die Fahrzeugquelle hat Features mit label/mode/source/pillimg', cv.features > 0 &&
    ['label', 'mode', 'pillimg', 'source'].every(k => String(cv.props).split(',').includes(k)), `${cv.features} / ${cv.props}`);
  ck('für jede Linie liegen alle drei Pillenbilder vor', cv.labels > 0 && Array.isArray(cv.missing) && cv.missing.length === 0,
    `${cv.labels} Linien, fehlend ${JSON.stringify(cv.missing)}`);
  ck('die Pillenebene zeichnet (queryRenderedFeatures > 0)', cv.rendered > 0 && cv.vis !== 'none', `${cv.rendered}`);
  ck('ein echter Klick auf eine Pille öffnet die Karte dieser Linie', r.popupVisible === true && !!pill &&
    String(r.popup).includes(String(pill.label)), `${r.clicked} -> ${String(r.popup).slice(0, 60)}`);
  ck('die angetippte Pille ist hervorgehoben (Fokusbild)', Number(r.followBefore) === 1, String(r.followBefore));
  ck('Sprachwechsel setzt <html lang> auf de', r.lang === 'de', String(r.lang));
  console.log(`SMOKE: ${fails === 0 ? 'PASS' : 'FAIL (' + fails + ')'}`);

  ws.close(); chrome.kill('SIGKILL'); process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('SMOKE ERROR: ' + e.message); chrome.kill('SIGKILL'); process.exit(1); });
