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

  const r = { url: URL_ };
  r.badge = await ev("document.getElementById('livebadge').dataset.state");
  r.livestat = await ev("document.getElementById('livestat').textContent");
  r.markersHostParent = await ev("(function(){var m=document.getElementById('markers');return m&&m.parentNode?(m.parentNode.className||m.parentNode.id||m.parentNode.tagName):'none'})()");
  r.vehicleMarkers = await ev("document.querySelectorAll('#markers .mk').length");
  r.clicked = await ev("(function(){var m=document.querySelector('#markers .mk');if(!m)return 'no .mk';m.dispatchEvent(new MouseEvent('click',{bubbles:true}));return m.textContent.slice(0,12)})()");
  await sleep(7000);
  r.popupVisible = await ev("(function(){var p=document.getElementById('popup');return !!(p&&p.classList.contains('on')&&p.textContent.trim())})()");
  r.popup = await ev("(function(){var p=document.getElementById('popup');return (p.textContent||'').replace(/\\s+/g,' ').slice(0,600)})()");
  r.stopRows = await ev("document.querySelectorAll('#popup .pop-stops li').length");
  r.stTag = await ev("document.querySelectorAll('#popup .st-tag').length");
  r.selName = await ev("(function(){var e=document.getElementById('selinfo');return e?e.style.display||'unset':'missing'})()");

  // Linienwahl muss die Fahrzeugauswahl wegräumen (M3) — Zustand davor festhalten
  r.followBefore = await ev("document.querySelectorAll('#markers .mk.focus').length");
  r.chipCount = await ev("document.querySelectorAll('.chip[data-line]').length");
  r.lineClick = await ev("(function(){var c=document.querySelector('.chip[data-line]');if(!c)return 'no chip';c.click();return c.dataset.line})()");
  await sleep(3000);
  r.lineSelActive = await ev("document.querySelectorAll('.chip.sel').length");
  r.selinfoAfterLine = await ev("(function(){var e=document.getElementById('selinfo');return e?(e.style.display||'unset'):'missing'})()");
  r.starAfterLine = await ev("document.getElementById('selfav').textContent");
  r.popupAfterLine = await ev("(function(){var p=document.getElementById('popup');return !!(p&&p.classList.contains('on'))})()");
  r.followAfterLine = await ev("document.querySelectorAll('#markers .mk.focus').length");

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
  ck('Marken hängen im Karten-Container (M7)', String(r.markersHostParent).includes('maplibregl-canvas-container'), String(r.markersHostParent));
  ck('Sprachwechsel setzt <html lang> auf de', r.lang === 'de', String(r.lang));
  console.log(`SMOKE: ${fails === 0 ? 'PASS' : 'FAIL (' + fails + ')'}`);

  ws.close(); chrome.kill('SIGKILL'); process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('SMOKE ERROR: ' + e.message); chrome.kill('SIGKILL'); process.exit(1); });
