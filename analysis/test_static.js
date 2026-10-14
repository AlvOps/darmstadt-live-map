/* Static checks on docs/ (offline): CSS rules for phones and scrollbars, WCAG contrast of the
 * delay status pill, relative asset paths, favicon / touch icon / manifest.
 * Usage: node analysis/test_static.js   or   require('./test_static').run(check)
 *
 * What this can NOT prove: actual rendering in a browser (no WebGL/headless browser here).
 * The checks read the CSS text and compute contrast from the declared colours. */
const fs = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, '..', 'docs');
const html = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');
const css = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';

// --- colours
const VARS = Object.fromEntries([...css.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
function parseColor(c) {
  c = c.trim();
  const v = c.match(/^var\(--([\w-]+)\)$/); if (v) return parseColor(VARS[v[1]]);
  let m = c.match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = c.match(/^rgba?\(([^)]+)\)$/);
  if (m) { const p = m[1].split(',').map(Number); return [p[0], p[1], p[2], p[3] === undefined ? 1 : p[3]]; }
  throw new Error('colour? ' + c);
}
const over = (fg, bg) => [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
const lum = c => { const f = x => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

function rule(sel, src) {
  const re = new RegExp('(?:^|[\\n}])\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
  const m = (src || css).match(re); return m ? m[1] : null;
}
function prop(body, name) { const m = body && body.match(new RegExp('(?:^|;|\\s)' + name + ':\\s*([^;]+)')); return m ? m[1].trim() : null; }
function media(q) {             // body of an @media block (balanced braces)
  const i = css.indexOf('@media (' + q + ')'); if (i < 0) return '';
  let j = css.indexOf('{', i) + 1, d = 1; const st = j;
  while (d && j < css.length) { if (css[j] === '{') d++; else if (css[j] === '}') d--; j++; }
  return css.slice(st, j - 1);
}

function pngSize(file) {
  const b = fs.readFileSync(file);
  if (b.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), colorType: b[25] };   // 2 = RGB (no alpha)
}

function run(check, log = console.log) {
  // contrast of the status pill on the panel over the map background
  const page = parseColor(VARS.bg), panel = over(parseColor(VARS.panel), page);
  for (const cls of ['late', 'ontime', 'early', 'unknown']) {
    const body = rule('.pop-delay.' + cls);
    if (!body) { check(`status pill .${cls} is styled`, false); continue; }
    const bg = over(parseColor(prop(body, 'background')), panel), fg = parseColor(prop(body, 'color'));
    const r = ratio(fg, bg);
    log(`  .pop-delay.${cls.padEnd(7)} contrast ${r.toFixed(2)}:1`);
    check(`status pill .${cls} meets WCAG AA (4.5:1)`, r >= 4.5);
  }
  check('early and on-time pills are visually distinct', prop(rule('.pop-delay.early'), 'color') !== prop(rule('.pop-delay.ontime'), 'color'));
  check('per-stop delay has early/unknown styles', !!rule('.pop-stops .st-dly.early') && !!rule('.pop-stops .st-dly.unknown'));

  // phones
  const mob = media('max-width: 700px');
  check('mobile: popup is a bottom sheet above the measured bar (--bar-h)', /bottom:\s*calc\(var\(--bar-h/.test(rule('#popup', mob) || ''));
  check('mobile: popup uses safe-area inset', /safe-area-inset-bottom/.test(rule('#popup', mob) || ''));
  check('mobile: stop list does not scroll on its own (max-height: none -> no nested scroll)', prop(rule('.pop-stops', mob), 'max-height') === 'none');
  check('mobile: close button is a >=40px touch target', /min-height:\s*4\dpx/.test(rule('.pop-close', mob) || '') && /min-width:\s*4\dpx/.test(rule('.pop-close', mob) || ''));
  check('mobile: segmented buttons >=40px', /min-height:\s*4\dpx/.test(rule('.seg button', mob) || ''));
  check('mobile: mode toggles >=40px', /min-height:\s*4\dpx/.test(rule('.tog', mob) || ''));
  check('mobile: hover tooltip suppressed', /display:\s*none/.test(rule('#tip', mob) || ''));
  check('viewport-fit=cover for safe areas', /viewport-fit=cover/.test(html));
  check('index.html measures the bar into --bar-h', /setProperty\('--bar-h'/.test(html));

  // scrollbars
  check('Firefox: thin scrollbars with themed colour', /scrollbar-width:\s*thin/.test(css) && /scrollbar-color:\s*var\(--scroll-thumb\)\s+transparent/.test(css));
  for (const sel of ['.panel', '.pop-stops']) {          // #legend scrollt nicht mehr -> kein eigener Balken
    check(`WebKit scrollbar styled for ${sel}`, css.includes(sel + '::-webkit-scrollbar-thumb') && css.includes(sel + '::-webkit-scrollbar-track') &&
      css.includes(sel + '::-webkit-scrollbar-corner') && css.includes(sel + '::-webkit-scrollbar-thumb:hover'));
  }
  check('scrollbar thumb colour derives from --muted/--accent', /--scroll-thumb:\s*var\(--muted\)/.test(css) && /--scroll-thumb-hover:\s*var\(--accent\)/.test(css));
  check('overscroll-behavior: contain on panels and lists', /\.panel, #legend, \.pop-stops \{ overscroll-behavior: contain; \}/.test(css));
  check('scrollbar-gutter: stable where a list can scroll (popup)', /scrollbar-gutter:\s*stable/.test(rule('#popup') || ''));
  check('legend no longer carries a scrollbar of its own',
    !/#legend[^{]*::-webkit-scrollbar/.test(css) && !/#legend \{[^}]*overflow-y:\s*auto/.test(css));
  check('map canvas has no scrollbar styling', !/#map[^{]*::-webkit-scrollbar/.test(css));
  check('schedule mode hides the frozen realtime stats', /body:not\(\.live\) #livestat, body:not\(\.live\) #livestat2 \{ display: none; \}/.test(css));

  // The line browser is the primary control: it must sit above the presentation layer, be visible on
  // phones too (it used to be display:none there) and be reachable with a thumb.
  const legendIdx = html.indexOf('id="legend-sec"'), presIdx = html.indexOf('id="presentation"');
  log(`  markup order: legend-sec@${legendIdx} presentation@${presIdx}`);
  check('line browser comes before the presentation block in the markup', legendIdx > 0 && legendIdx < presIdx);
  check('panel has a Lines/Status switcher (one pane at a time, so it fits)',
    /id="panes"[\s\S]*data-pane="lines"[\s\S]*data-pane="status"/.test(html));
  check('only one pane is visible at a time',
    /body\[data-pane="status"\] #legend-sec \{ display: none; \}/.test(css) &&
    /body\[data-pane="lines"\] #presentation \{ display: none; \}/.test(css));
  check('panel shows no scrollbar (hidden by design)',
    /#head::-webkit-scrollbar \{ width: 0; height: 0; \}/.test(css) && /#head \{[^}]*scrollbar-width: none/.test(css));
  check('line list does not scroll on its own',
    /#legend \{ flex: 0 0 auto; min-height: 0; max-height: none; overflow: visible; \}/.test(css));
  check('map starts north-up and flat (no rotation/tilt by default)',
    /pitch: 0, bearing: 0/.test(html));
  const paneMob = prop(rule('#panes button', mob), 'min-height') || '0';
  check(`phone pane switcher is thumb-sized (${paneMob})`, parseFloat(paneMob) >= 40);
  const selMob = prop(rule('#selinfo button', mob), 'min-height') || '0';
  check(`phone 'clear line' button is thumb-sized (${selMob})`, parseFloat(selMob) >= 40);
  check('phone vehicle-card rows are tall enough to tap',
    parseFloat((prop(rule('.pop-stops li', mob), 'padding') || '0')) >= 10);
  check('panel sits at the very top', /#head \{ top:\s*[0-8]px;/.test(css));
  check('phones keep the line browser visible (no display:none)', !/#legend-sec\s*\{\s*display:\s*none/.test(mob));
  check('phones get one scroll area, not a nested mini-scrollbar', /#legend \{[^}]*overflow:\s*visible/.test(mob));
  const chipMob = parseFloat((prop(rule('.chip', mob), 'min-height') || '0').replace('px', ''));
  check(`phone line chips are thumb-sized (${chipMob}px >= 40px)`, chipMob >= 40);
  const sumMob = parseFloat((prop(rule('#legend summary', mob), 'min-height') || '0').replace('px', ''));
  check(`phone group headers are thumb-sized (${sumMob}px >= 40px)`, sumMob >= 40);
  check('phones collapse the timetable-only bar controls in realtime mode',
    /body\.live #daywrap, body\.live #speedwrap, body\.live #play \{ display: none; \}/.test(mob));
  check('phone panel is height-limited so the map stays visible', /#head \{[^}]*max-height:\s*6\dvh/.test(mob));
  const popupW = parseFloat((rule('#popup').match(/width:\s*([\d.]+)px/) || [])[1] || '0');
  check(`vehicle card is wide enough for line + destination + time (${popupW}px >= 280px)`, popupW >= 280);
  check('departure/stop clock time has its own prominent style', /\.pop-stops \.st-clock \{/.test(css));

  // Overlap fix: with 'Status & filters' AND the line list open, the blocks used to collide because
  // the panel could not scroll and the legend still had a grow factor. Now the panel scrolls and the
  // legend keeps a fixed band.
  const head = rule('#head') || '';
  check('panel scrolls instead of letting open blocks overlap', /#head \{[\s\S]*?overflow-y:\s*auto/.test(css));
  check('legend and its section no longer grow into the panel',
    /#legend \{ flex: 0 0 auto;/.test(css) && /#legend-sec \{ flex: 0 0 auto;/.test(css));
  check('panel height leaves only a small gap above the bar (and caps at 92vh)',
    /--head-max'[^\n]*bh \+ 30[^\n]*92vh/.test(html));
  check('stops in the vehicle card are marked as clickable targets',
    /\.pop-stops li\.st-go \{ cursor: pointer; \}/.test(css) && /\.pop-stops li\.st-go::after/.test(css));

  // The line list must be usable: hittable chips, no nested scroll areas.
  const legend = rule('#legend') || '', legendSec = rule('#legend-sec') || '';
  check('legend keeps a fixed band instead of growing (that caused the overlap)',
    /#legend \{ flex: 0 0 auto;/.test(css) && /#legend-sec \{ flex: 0 0 auto;/.test(css));
  const chipMin = parseFloat(((rule('.chip') || '').match(/min-height:\s*([\d.]+)px/) || [])[1] || '0');
  check(`line chips are big enough to hit (${chipMin}px >= 26px)`, chipMin >= 26);

  // Basemap zooming: CARTO's vector tiles stop at a fixed zoom with no maxzoom in the style, so the
  // source must be inlined and capped, otherwise MapLibre requests 404 tiles and the map freezes.
  check('basemap tile source is capped at a declared maxzoom',
    /const TILE_MAXZOOM = \d+/.test(html) && /src\.maxzoom = TILE_MAXZOOM/.test(html));
  check('capped source inlines tiles for all four CARTO subdomains',
    /const TILE_SUBS = \['a', 'b', 'c', 'd'\]/.test(html) && /tiles-\$\{s\}\.basemaps\.cartocdn\.com/.test(html));
  check('TileJSON url removed so the cap takes effect', /delete src\.url/.test(html));
  check('style.load cap runs exactly once', /map\.on\('style\.load'/.test(html) && /if \(basemapCapped\) return/.test(html));
  check('map zoom is capped too (no pointless overzoom)', /maxZoom:\s*1[0-9]\b/.test(html));

  const live = fs.readFileSync(path.join(DOCS, 'live.js'), 'utf8');
  check('live rendering pauses during map gestures (no layer rebuild while zooming)',
    /isMoving && ctx\.map\.isMoving\(\)\) return/.test(live));

  // assets: every relative src/href must exist
  const refs = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map(m => m[1]).filter(u => !/^(https?:)?\/\//.test(u) && !u.startsWith('#'));
  const dataRefs = [...html.matchAll(/fetch\(`?'?(data\/[\w.]+)/g)].map(m => m[1]).filter(u => /\.json$/.test(u));
  const days = ['werktag', 'samstag', 'sonntag'].map(d => `data/trips_${d}.json`);
  const missing = refs.concat(dataRefs, days).filter(u => !fs.existsSync(path.join(DOCS, u)));
  log(`  relative assets referenced: ${refs.concat(dataRefs, days).join(', ')}`);
  check('all relative assets exist (no leading slash -> works under the Pages subpath)', missing.length === 0 && !refs.some(u => u.startsWith('/')), missing.join(', '));

  // icons
  check('<link rel="icon" type="image/svg+xml" href="favicon.svg">', html.includes('<link rel="icon" type="image/svg+xml" href="favicon.svg">'));
  check('apple-touch-icon link', /<link rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon.png">/.test(html));
  check('manifest link', html.includes('<link rel="manifest" href="manifest.webmanifest">'));
  const svg = fs.readFileSync(path.join(DOCS, 'favicon.svg'), 'utf8');
  check('favicon.svg is self-contained (no external refs, no <text>)', /^<svg[^>]+xmlns="http:\/\/www.w3.org\/2000\/svg"/.test(svg) &&
    !/href=|<image|<text|url\(/.test(svg));
  const ati = pngSize(path.join(DOCS, 'apple-touch-icon.png'));
  log(`  apple-touch-icon.png: ${ati ? ati.w + 'x' + ati.h + ' colorType=' + ati.colorType : 'not a PNG'}`);
  check('apple-touch-icon.png is a 180x180 opaque PNG', ati && ati.w === 180 && ati.h === 180 && ati.colorType === 2);
  const man = JSON.parse(fs.readFileSync(path.join(DOCS, 'manifest.webmanifest'), 'utf8'));
  const theme = (html.match(/<meta name="theme-color" content="([^"]+)"/) || [])[1];
  check('manifest: name/short_name/start_url/scope/display', !!man.name && !!man.short_name && man.start_url === './' && man.scope === './' && man.display === 'standalone');
  check('manifest colours match the app background and <meta theme-color>', man.background_color === VARS.bg && man.theme_color === VARS.bg && theme === VARS.bg, `${man.background_color} ${man.theme_color} ${theme} ${VARS.bg}`);
  for (const ic of man.icons) {
    const f = path.join(DOCS, ic.src);
    let ok = fs.existsSync(f) && !ic.src.startsWith('/');
    if (ok && ic.type === 'image/png') { const s = pngSize(f); ok = s && `${s.w}x${s.h}` === ic.sizes; }
    check(`manifest icon ${ic.src} (${ic.sizes}) exists and matches its size`, ok);
  }
}

module.exports = { run };
if (require.main === module) {
  let fails = 0;
  const check = (n, c, e) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${!c && e ? ' — ' + e : ''}`); if (!c) fails++; };
  run(check);
  console.log(`\nRESULT: ${fails ? 'FAIL (' + fails + ')' : 'PASS'}`);
  process.exit(fails ? 1 : 0);
}
