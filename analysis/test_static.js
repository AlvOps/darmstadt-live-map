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
  // Wunsch des Betreibers: die Telefonkarte zeigt — wie die Karte am Rechner — genau DREI Halte,
  // alles Weitere scrollt, und der Balken bleibt unsichtbar. Die Zeilen sind hier 44 px hoch.
  const mobList = rule('.pop-stops', mob) || '';
  check('mobile: the card shows exactly three stops, the rest scrolls with no visible bar',
    prop(mobList, 'max-height') === 'calc(3 * var(--stop-row))' &&
    prop(mobList, 'overflow-y') === 'auto' && prop(mobList, 'scrollbar-width') === 'none' &&
    /--stop-row:\s*44px/.test(mobList));
  check('mobile: close button is a >=40px touch target', /min-height:\s*4\dpx/.test(rule('.pop-close', mob) || '') && /min-width:\s*4\dpx/.test(rule('.pop-close', mob) || ''));
  check('mobile: segmented buttons >=40px', /min-height:\s*4\dpx/.test(rule('.seg button', mob) || ''));
  check('mobile: mode toggles >=40px', /min-height:\s*4\dpx/.test(rule('.tog', mob) || ''));
  check('mobile: hover tooltip suppressed', /display:\s*none/.test(rule('#tip', mob) || ''));
  check('viewport-fit=cover for safe areas', /viewport-fit=cover/.test(html));
  check('index.html measures the bar into --bar-h', /setProperty\('--bar-h'/.test(html));

  // scrollbars
  check('Firefox: thin scrollbars with themed colour', /scrollbar-width:\s*thin/.test(css) && /scrollbar-color:\s*var\(--scroll-thumb\)\s+transparent/.test(css));
  for (const sel of ['.panel']) {                        // Karte/Liste: nur das Panel hat noch einen Balken
    check(`WebKit scrollbar styled for ${sel}`, css.includes(sel + '::-webkit-scrollbar-thumb') && css.includes(sel + '::-webkit-scrollbar-track') &&
      css.includes(sel + '::-webkit-scrollbar-corner') && css.includes(sel + '::-webkit-scrollbar-thumb:hover'));
  }
  // Rechner: genau DREI Halte sichtbar (wie die Schublade auf dem Telefon), der Rest scrollbar.
  const cardList = rule('.pop-stops', css), cardRow = rule('.pop-stops li', css);
  check('desktop: the vehicle card shows exactly three stops, the rest scrolls',
    prop(cardList, 'max-height') === 'calc(3 * var(--stop-row))' &&
    prop(cardList, 'overflow-y') === 'auto' &&
    prop(cardRow, 'min-height') === 'var(--stop-row)' &&
    prop(cardRow, 'box-sizing') === 'border-box' &&
    prop(cardRow, 'line-height') === '16px' &&            // 16 + 12 + 1 = 29 -> Zeile genau 30px
    !/max-height: 34vh/.test(css));

  check('stop list scrolls but shows no scrollbar (owner wish)',
    /\.pop-stops \{ scrollbar-width: none; -ms-overflow-style: none; \}/.test(css) &&
    /\.pop-stops::-webkit-scrollbar \{ width: 0; height: 0; \}/.test(css) &&
    !/\.pop-stops[^{]*\{[^}]*scrollbar-width:\s*thin/.test(css));
  // Die Pillen hängen als Sprechblase ÜBER der genauen Position; ein Punkt darunter markiert sie.
  // Vorher lag die Pille mittig auf dem Punkt und verdeckte bei z13 rund 600 m Straße.
  const liveNow = fs.readFileSync(path.join(DOCS, 'live.js'), 'utf8');
  // Ausdrücklicher Wunsch des Betreibers (2026-10-15): die Liniennummer steht in JEDEM Zoom in der
  // Marke. Ein reiner Punkt-Modus beim Herauszoomen und eine hochgezogene Sprechblase gab es
  // zwischenzeitlich — beides ist wieder entfernt; die Pille sitzt wieder mittig auf dem Punkt.
  check('every marker keeps its line tag at every zoom, centred on the point',
    /classList\.toggle\('scaled', ctx\.map\.getZoom\(\) < 14\)/.test(liveNow) &&
    !/toggle\('dots'/.test(liveNow) && !/toggle\('callout'/.test(liveNow) &&
    /translate\(x, y\)|'translate\(' \+ Math\.round/.test(liveNow) &&
    /translate\(-50%,-50%\)/.test(liveNow) && !/'-100%'/.test(liveNow) &&
    !/#markers\.dots/.test(css) && !/#markers\.callout/.test(css) && !/\.mk::before \{/.test(css));
  check('the markers keep symbol and label in the compact variant too',
    /#markers\.scaled \.mk \{ font-size: 11px; padding: 2px 7px 2px 6px; \}/.test(css) &&
    !/#markers\.scaled \.mk (svg|span)[^{]*\{[^}]*display: none/.test(css));
  // Der Betreiber-GPS-Punkt oben rechts bleibt die einzige Zusatzmarke am Fahrzeug.
  check('the operator provenance mark is the only extra pseudo-element on a marker',
    /\.mk\[data-src="operator"\]::after/.test(css) && !/\.mk::before/.test(css));
  // Eigene Tramgleise unter den Pillen: die dunkle Grundkarte zeichnet sie nicht, Nebenstraßen erst
  // ab z13 — deshalb wirkten korrekt gesetzte Bahnpillen wie schwebend. Aus meta.json, kein Abruf.
  check('tram corridors are drawn under the pills from the repository data',
    /META\.tram_tracks/.test(liveNow) && /id: 'corridors'/.test(liveNow) &&
    /type: 'geojson'/.test(liveNow) && /addSource\('tracks'/.test(liveNow) &&
    /try \{ addCorridors\(\); \}/.test(liveNow));
  check('the map zooms one step closer (17) so point and road can be told apart', /maxZoom: 17/.test(html));

  check('scrollbar thumb colour derives from --muted/--accent', /--scroll-thumb:\s*var\(--muted\)/.test(css) && /--scroll-thumb-hover:\s*var\(--accent\)/.test(css));
  check('overscroll-behavior: contain on panels and lists', /\.panel, #legend, \.pop-stops \{ overscroll-behavior: contain; \}/.test(css));
  check('scrollbar-gutter: stable where a list can scroll (popup)', /scrollbar-gutter:\s*stable/.test(rule('#popup') || ''));
  check('legend no longer carries a scrollbar of its own',
    !/#legend[^{]*::-webkit-scrollbar/.test(css) && !/#legend \{[^}]*overflow-y:\s*auto/.test(css));
  check('map canvas has no scrollbar styling', !/#map[^{]*::-webkit-scrollbar/.test(css));

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
  check('phone panel is height-limited so the map stays visible', /#head \{[^}]*max-height:\s*6\dvh/.test(mob));
  const popupW = parseFloat((rule('#popup').match(/width:\s*([\d.]+)px/) || [])[1] || '0');
  check(`vehicle card is wide enough for line + destination + time (${popupW}px >= 280px)`, popupW >= 280);
  check('departure/stop clock time has its own prominent style', /\.pop-stops \.st-clock \{/.test(css));

  // Verbindungslinie Karte->Punkt, ziehbare Karte, Panel-Schublade auf dem Telefon
  const liveSrc = fs.readFileSync(path.join(DOCS, 'live.js'), 'utf8');
  check('connector element sits between card and point (svg with path + dot)',
    /<svg id="leader" aria-hidden="true"><path><\/path><circle r="3\.5"><\/circle><\/svg>/.test(html));
  check('connector is styled (dashed line, dot)',
    /#leader path \{[^}]*stroke-dasharray/.test(css) && /#leader circle \{[^}]*fill:/.test(css));
  check('card is draggable (pointerdown wiring + grab cursor)',
    /el\.addEventListener\('pointerdown'/.test(liveSrc) && /\.pop-head \{[^}]*cursor: grab/.test(css));
  check('card drag keeps buttons and stop rows clickable', /closest\('button, a, li, \.pop-stops'\)/.test(liveSrc));
  check('card drag is mouse-only and clamped to the viewport',
    /function initDrag\(el\)[\s\S]*?if \(!finePointer\(\)\) return;/.test(liveSrc) &&
    /function clampPopup\(/.test(liveSrc) &&
    /const placed = clampPopup\(popupPos\.x \+ dx/.test(liveSrc));
  check('phone: no drag affordance on the card header',
    /\.pop-head \{ cursor: default; touch-action: auto; \}/.test(mob));
  check('touch is detected by pointer, not only by width (landscape phones)',
    /const DRAWER_QUERY = '\(max-width: 700px\), \(hover: none\) and \(pointer: coarse\)'/.test(html) &&
    /matchMedia\(DRAWER_QUERY\)/.test(html) &&
    /@media \(max-width: 700px\), \(hover: none\) and \(pointer: coarse\)/.test(css));
  check('phone: picking a line slides the panel away too',
    /if \(touchLayout\(\) && hidePanelNow\) hidePanelNow\(\)/.test(html));
  check('phone: panel is a drawer (hidden state + toggle + close)',
    /body\.panel-closed #head \{ display: none; \}/.test(mob) &&
    /#paneltoggle \{ display: inline-flex/.test(mob) && /#panelclose \{ display: inline-flex/.test(mob));
  check('phone: drawer controls are thumb-sized (>= 40px)',
    /#paneltoggle \{[^}]*min-height: 44px/.test(mob) && /#panelclose \{[^}]*min-height: 40px/.test(mob));
  check('desktop keeps no drawer chrome (toggle/close hidden)',
    /#paneltoggle, #panelclose \{ display: none; \}/.test(css));
  check('phone drawer stays open when a group is expanded (only a line/favourite choice closes it)',
    /closest\('\.chip, \.fav-go'\)/.test(html) && !/closest\('\.chip, \.fav-go, details summary'\)/.test(html));
  check('3D tilt button exists and really changes the pitch',
    /class TiltButton/.test(html) && /pitch: on \? 45 : 0/.test(html) &&
    /\.maplibregl-ctrl-group\.tilt3d \{/.test(css) && /on\('pitchend'/.test(html));
  const i18nAll = fs.readFileSync(path.join(DOCS, 'i18n.js'), 'utf8');    // lokal: i18nSrc wird erst weiter unten gesetzt
  check('tilt button is labelled in both languages (symbol, nothing hardcoded)',
    /tilt3d: 'Tilt the map/.test(i18nAll) && /tilt3d: 'Karte kippen/.test(i18nAll) &&
    /data-i18n-aria', 'tilt3d'/.test(html));
  check('vehicle card lists up to 25 stops (short form stays at 3)',
    /const CARD_STOPS = 25;/.test(liveSrc) && /nextStops\(leg, CARD_STOPS\)/.test(liveSrc));
  check('line choice asks for the wide city box, then frames the line',
    /focusLineWide\(sel\)/.test(liveSrc) && /const CITY_BOX = \{ w: 8\.560, s: 49\.790/.test(liveSrc) &&
    /focusLine\(idx, wide\)/.test(liveSrc));

  // „Wo bin ich?" (Wunsch 2026-10-15): auf Telefon UND Rechner, und die Koordinaten bleiben am Gerät
  // Ortung: auf dem Telefon immer, auf dem Rechner nur im Hybridbetrieb — die veröffentlichte
  // Seite soll sich nicht ändern.
  check('location button is on every phone layout and on the desktop only in the hybrid build',
    /if \(\(touchLayout\(\) \|\| HYBRID\) && navigator\.geolocation\) map\.addControl\(new LocateButton\(\), 'bottom-right'\)/.test(html) &&
    !/if \(navigator\.geolocation\) map\.addControl\(new LocateButton/.test(html) &&
    /getCurrentPosition\(/.test(html) && /watchPosition\(/.test(html) && /clearWatch\(/.test(html));
  check('location is drawn on the map and never sent anywhere',
    !/const GEO = [\s\S]{0,1500}?fetch\(/.test(html) && /addSource\('me'/.test(html) &&
    /id: 'me-acc'/.test(html) && /id: 'me-dot'/.test(html));
  check('a drag stops the follow (the marker stays)',
    /map\.on\('dragstart', \(\) => \{ if \(GEO\.on\) geoStop/.test(html));
  check('location messages exist in both languages',
    /geoTitle: 'Where am I\?'/.test(i18nAll) && /geoTitle: 'Wo bin ich\?'/.test(i18nAll) &&
    /geoDenied: 'Location is not available/.test(i18nAll) && /geoDenied: 'Standort nicht verfügbar/.test(i18nAll));
  check('location control matches the other map buttons',
    /\.maplibregl-ctrl-group\.locate \{/.test(css) && /\.maplibregl-ctrl-group\.locate\[aria-pressed="true"\]/.test(css));

  // Aufklärung + Einführung beim Start (Wunsch 2026-10-15: Hinweis immer, Einführung nur einmal)
  check('start overlay exists and cannot block the page if JS fails (no .on in the markup)',
    /<div id="welcome" role="dialog" aria-modal="true"/.test(html) && !/id="welcome" class="on"/.test(html));
  check('overlay fades in and out (CSS transition, `.on` set by the script)',
    /#welcome\.on \{ opacity: 1; pointer-events: auto; \}/.test(css) && /#welcome \{[^}]*transition: opacity/.test(css));
  check('disclaimer appears on every visit, tutorial only the first time',
    /localStorage\.getItem\('darmstadt-live-tour'\)/.test(html) &&
    /localStorage\.setItem\('darmstadt-live-tour', '1'\)/.test(html) &&
    /if \(i === 0 && seenTour\) \{ close\(\); return; \}/.test(html));
  check('tutorial has four steps and a skip that only shows from step 1',
    /skip\.hidden = i === 0/.test(html) && /skip\.onclick = close/.test(html) &&
    (html.match(/'tut[1-4]Title'/g) || []).length === 4);
  check('intro text exists in both languages',
    /welcomeTitle: 'Work in progress'/.test(i18nAll) && /welcomeTitle: 'Baustelle'/.test(i18nAll) &&
    /tut4Title: '4 · Language, 3D and the drawer'/.test(i18nAll) &&
    /tut4Title: '4 · Sprache, 3D und die Schublade'/.test(i18nAll));
  check('intro buttons are thumb-sized and the overlay sits above every panel',
    /\.wnav \{[^}]*min-height: 44px/.test(css) && /\.wskip \{[^}]*min-height: 44px/.test(css) &&
    /#welcome \{ position: absolute; inset: 0; z-index: 20;/.test(css));
  check('tapping the map closes the phone drawer',
    /hidePanel: \(\) => \{ if \(touchLayout\(\)\) setPanel\(false\); \}/.test(html));
  check('phone: the drawer toggle stays in one place (top-left, panel starts below it)',
    /#paneltoggle \{[^}]*top: calc\(6px \+ env\(safe-area-inset-top\)\)/.test(mob) &&
    /#head \{ top: calc\(56px \+ env\(safe-area-inset-top\)\)/.test(mob) &&
    !/body:not\(\.panel-closed\) #paneltoggle \{ display: none; \}/.test(mob));
  check('phone: the toggle says what it does (icon + label switch with the state)',
    /ico\.textContent = open \? '✕' : '☰'/.test(html) &&
    /lbl\.dataset\.i18n = open \? 'closePanel' : 'openPanel'/.test(html));
  check('phone: no camera follow of a vehicle (that is desktop-only)',
    /if \(!finePointer\(\)\) \{[\s\S]*?return;[\s\S]*?\}\s*followTrip = v\.tripId;/.test(liveSrc) &&
    /following: \(\) => !!followTrip/.test(liveSrc));
  check('stale HTML heals itself (version compared against the freshly loaded live.js)',
    /const APP_V = '\d{8}-\d+'/.test(html) && /DarmstadtLive\.VERSION/.test(html) &&
    /new URLSearchParams\(location\.search\)/.test(html) &&
    /location\.replace\(location\.pathname \+ '\?' \+ qs\.toString\(\)\)/.test(html) &&
    /sessionStorage/.test(html));
  // Die Selbstheilung darf den Hybridschalter nicht verlieren, sonst landet man beim Neuladen der
  // versionierten Seite plötzlich auf der Fassung ohne Betreiberpositionen.
  check('self-healing keeps the hybrid switch in the URL', /qs\.set\('v', fresh\)/.test(html));
  // Ruckeln: die Animation lief mit 5 Bildern/s, weil pro Fahrzeug und Frame linear gesucht und ein
  // neues Pfad-Array geschnitten wurde. Jetzt ~30/s, Karte entkoppelt, Suche logarithmisch.
  check('animation runs near display rate (not the old 5 fps)', /const FRAME_MS = 3[0-9];/.test(liveSrc));
  check('card placement is decoupled from the throttled layer rebuild',
    /if \(popupVehicle \|\| popupStation\) placePopup\(false\);/.test(liveSrc));
  check('per-frame vehicle maths is O(log n) and does not re-slice the path every frame',
    /function lowerBound\(/.test(liveSrc) && !/cd\.findIndex\(/.test(liveSrc) && /v\._restIdx !== idx/.test(liveSrc));
  // Quellenangabe: nicht mehr das MapLibre-Bedienelement (stand aufgeklappt), sondern ein ⓘ im Balken
  const i18nSrc = fs.readFileSync(path.join(DOCS, 'i18n.js'), 'utf8');
  check('attribution is collapsed by default and opens on tap',
    /<div id="attribbox" hidden>/.test(html) &&
    /attribBtn\.onclick = e => \{ e\.stopPropagation\(\); setAttribOpen\(attribBox\.hidden\); \}/.test(html) &&
    /#attribbox\[hidden\] \{ display: none; \}/.test(css));
  check('no MapLibre attribution control left (it was open by default)',
    !/new maplibregl\.AttributionControl/.test(html) && !/maplibregl-ctrl-attrib/.test(liveSrc) &&
    /attributionControl: false/.test(html));
  check('attribution credits only sources we actually use (no stale pfaedle shapes)',
    !/pfaedle/.test(i18nSrc) && /attributionLive/.test(i18nSrc) && /CARTO/.test(i18nSrc));
  check('attribution toggle is thumb-sized on phones', /#attribbtn \{[^}]*width: 34px/.test(mob));
  // Suche und Favoriten: Suchfeld neben dem Umschalter, dritter Bereich für Gemerktes, Stern zum Merken.
  const searchSrc = fs.readFileSync(path.join(DOCS, 'search.js'), 'utf8');
  check('panel has a third pane for favourites (still only one pane at a time)',
    /id="panes"[\s\S]*data-pane="favs"[\s\S]*data-pane="status"/.test(html) &&
    /body\[data-pane="favs"\] #legend-sec \{ display: none; \}/.test(css) &&
    /body:not\(\[data-pane="favs"\]\) #favs \{ display: none; \}/.test(css));
  check('stop search keeps its ids and the shared strings (search.js unchanged)',
    /<input id="search"[^>]*data-i18n-placeholder="searchPlaceholder"/.test(html) &&
    /<ul id="results" hidden><\/ul>/.test(html) && /search\.js\?v=\d{8}-\d+/.test(html));
  check('search results and saved stops are thumb-sized on phones',
    /#search \{ min-height: 40px/.test(mob) && /#results button\.res \{ min-height: 44px/.test(mob) &&
    /#favstations \.fav-go \{ min-height: 44px/.test(mob));
  check('favourites live in localStorage (a static page has no server to receive a cookie)',
    /localStorage/.test(searchSrc) && !/document\.cookie/.test(searchSrc) && /darmstadt-live-favs/.test(searchSrc));
  // Der Hinweis „Position abgeleitet, kein GPS" soll auffallen: gelb und fett, in der Karte UND in
  // der Quellenangabe (dort liest man die Herkunft nach) — in beiden Sprachen über denselben Schlüssel.
  check('the "no GPS" note is highlighted (bold, yellow) in the card and in the credits',
    /\.note-warn \{ color: var\(--accent\); font-weight: 700; \}/.test(css) &&
    /class="pop-note note-warn"/.test(liveSrc) &&
    /<p class="note-warn" data-i18n="attributionPosition">/.test(html));
  // Marken sind DOM-Elemente: wirklich rund, weiß, mit SVG-Sinnbild für Bus/Bahn/Zug — und sie
  // bekommen den Tipp vor der Karte (sonst öffnete sich der Halt dahinter).
  check('vehicle markers are round white pills with a mode pictogram (DOM, not a text layer)',
    /id="markers"/.test(html) && /#markers \{ position: absolute/.test(css) &&
    /\.mk \{[\s\S]*border-radius: 999px; background: #fff; color: #10131a;/.test(css) &&
    /\.mk svg \{ width: 14px; height: 14px; flex: none; fill: currentColor; \}/.test(css) &&
    /const MODE_SVG = \{/.test(liveSrc) &&
    /tram: '<svg viewBox="0 0 24 24"/.test(liveSrc) && /bus: '<svg viewBox="0 0 24 24"/.test(liveSrc) &&
    /rail: '<svg viewBox="0 0 24 24"/.test(liveSrc) &&
    /function renderMarkers\(vis, shownStops, focusTrip\)/.test(liveSrc) &&
    /el\.className = 'mk'/.test(liveSrc) && !/live-labels/.test(liveSrc));
  // Ein Tipp auf ein Fahrzeug gehört dem Fahrzeug: Panel weg, Linienauswahl aufheben, Fahrzeug zeigen.
  check('a tap on a vehicle shows the vehicle, not the stop behind it and not the line',
    /function tapVehicle\(v\)/.test(liveSrc) &&
    /if \(ctx\.state\.selLine !== null && ctx\.selectLine\) ctx\.selectLine\(null\)/.test(liveSrc) &&
    /ev\.stopPropagation\(\); tapVehicle\(v\)/.test(liveSrc) &&
    /renderMarkers\(vis, shownStops, focusTrip\)/.test(liveSrc) &&
    /function click\(info\) \{[\s\S]*stopFollow\(\); closePopup\(\);/.test(liveSrc));
  check('stops are circles with a letter, localised and switching without a reload',
    /\.stopmk \{[\s\S]*border-radius: 50%/.test(css) &&
    /el\.className = 'stopmk'/.test(liveSrc) &&
    /if \(el\.textContent !== letter\) el\.textContent = letter/.test(liveSrc) &&
    /const letter = T\('stopMark'\)/.test(liveSrc));
  check('focus sits on the marker itself and the others step back',
    /\.mk\.focus \{ border-color: #fff; box-shadow: 0 0 0 2\.5px var\(--accent\)/.test(css) &&
    /\.mk\.dim \{ opacity: \.55; \}/.test(css) &&
    /el\.classList\.toggle\('focus', id === focusTrip\)/.test(liveSrc) &&
    /el\.classList\.toggle\('dim', !!focusTrip && id !== focusTrip\)/.test(liveSrc));
  // Farbe nach Verkehrsart wie die Schalter im Panel, und die Marken folgen der Karte (kein Schweben).
  check('pills take the mode colour of the panel switches (tram red, bus turquoise, rail purple)',
    /\.mk\[data-mode="tram"\] \{ background: var\(--tram\); \}/.test(css) &&
    /\.mk\[data-mode="bus"\] \{ background: var\(--bus\); \}/.test(css) &&
    /\.mk\[data-mode="rail"\] \{ background: var\(--rail\); \}/.test(css) &&
    /el\.dataset\.mode = v\.mode \|\| 'bus'/.test(liveSrc));
  check('markers are repositioned while the map moves (they do not float)',
    /function syncMarkerPositions\(\)/.test(liveSrc) &&
    /syncMarkers: \(\) => syncMarkerPositions\(\)/.test(liveSrc) &&
    /\['move', 'zoom', 'rotate', 'pitch'\]\.forEach\(ev => map\.on\(ev, \(\) => window\.DarmstadtLive\.syncMarkers\(\)\)\)/.test(html) &&
    /window\.DarmstadtLive\.syncMarkers\(\);\n    requestAnimationFrame\(loop\);/.test(html));
  check('stop marker is a small, properly centred circle (yellow, green letter, 13px)',
    /\.stopmk \{[\s\S]*box-sizing: border-box; padding: 0; margin: 0;[\s\S]*width: 13px; height: 13px; border-radius: 50%;[\s\S]*align-items: center; justify-content: center;[\s\S]*background: var\(--accent\); color: #1d7a3d;/.test(css));
  // Die Linie einer Fahrt folgt den Straßen: echte Geometrie (legGeometry) vor Luftlinie.
  check('route line uses the trip street geometry, stops only as fallback',
    /leg\.legGeometry && leg\.legGeometry\.points/.test(liveSrc) &&
    /const pts = decodePolyline\(g, 1e7\)/.test(liveSrc) &&
    /function decodePolyline\(str, factor\)/.test(liveSrc));
  // Betreiberpositionen sind zurück — aber EINE QUELLE JE LINIE statt Fahrzeugpaarung, und nur im
  // Hybridbetrieb. Das alte Modul, das je Fahrzeug zusammenführte, bleibt entfernt.
  // Der Abruf bestimmt nur, wie spät eine neue Meldung ankommt: 10 s statt 30 s. Je Meldung gehen der
  // rohe encodedPath und die Empfangszeit an live.js, das den Pfad wie die Betreiber-App abspielt.
  // Das Verhalten (Pfad, Ecke, Rückfall) prüft test_ui an operator.js selbst; hier nur die Verdrahtung.
  const opSrc = fs.readFileSync(path.join(DOCS, 'operator.js'), 'utf8');
  check('operator feed polls every 10 s and hands the travelled path + reception time to live.js',
    /const REFRESH_MS = 10000;/.test(opSrc) && /function parse\(data, prev, nowMs\)/.test(opSrc) &&
    /parse\(await res\.json\(\), list, Date\.now\(\)\)/.test(opSrc) &&
    /encodedPath: path, seenAt: same \? was\.seenAt : t,/.test(opSrc) && !/prevLat|prevAt/.test(opSrc + liveSrc) &&
    /function opPosAt\(v, t\)/.test(liveSrc) && /if \(isOp\(v\)\) return opPosAt\(v, t\);/.test(liveSrc) &&
    /const op = opPosAt\(v, t\);/.test(liveSrc) && /decodePolyline\(enc, 1e5\)/.test(liveSrc) &&
    /const OP_TICK_MS = 1000;/.test(liveSrc) && /const OP_REPLAY_MS = 20000;/.test(liveSrc));

  // Die veröffentlichte Seite verspricht nirgends GPS: auch der Ersatztext im Markup (vor I18N.init,
  // ohne JS) der Schlüssel, die nur der Hybridbetrieb umstellt, nennt nur die abgeleitete Quelle.
  check('published markup fallback text never claims GPS for the hybrid-swapped keys',
    ['subtitle', 'modeLive', 'attributionPosition', 'welcomeBody'].every(k => {
      const m = html.match(new RegExp('data-i18n="' + k + '"[^>]*>([^<]*)<'));
      return !!m && !/(?<!no )GPS|operator['’]s own/i.test(m[1]);
    }));

  check('operator positions are a gated, per-line feature (no vehicle pairing again)',
    fs.existsSync(path.join(DOCS, 'operator.js')) && /DarmstadtOperator/.test(liveSrc) &&
    /const HYBRID_ON =/.test(liveSrc) && /!HYBRID_ON \? null/.test(liveSrc) &&
    /function selectSources\(/.test(liveSrc) && /OP_ALIAS/.test(liveSrc) &&
    !/matchTwin|pairTwin|mergeTwin/.test(liveSrc) &&
    !/heag\.js/.test(html) && !fs.existsSync(path.join(DOCS, 'heag.js')) &&
    /DarmstadtLive\.activateHybridCopy\(\)/.test(html));
  // Zwei Wortlaute: die veröffentlichte Seite nennt weiter nur die abgeleitete Quelle, der
  // Hybridbetrieb nennt zusätzlich die Betreiberpositionen. Getauscht wird im Skript, nicht im Markup.
  check('credits know both sources while the published page states the derived one',
    /attributionPosition: '/.test(i18nSrc) && /attributionPositionOperator: '/.test(i18nSrc) &&
    /<p class="note-warn" data-i18n="attributionPosition">/.test(html) &&
    /<p class="attrib-op" data-i18n="attributionOperator">/.test(html) &&
    /#attribbox \.attrib-op \{ display: none; \}/.test(html) &&
    /html\[data-hybrid="1"\] #attribbox \.attrib-op \{ display: block; \}/.test(html) &&
    !/data-i18n="attributionPositionOperator"/.test(html));
  // Eine Suche von außerhalb des Ausschnitts muss trotzdem Abfahrten zeigen: der Halt wird über den
  // Namen nachgeschlagen, statt auf die Halte des aktuellen Ausschnitts zu hoffen ("mal ja, mal nein").
  check('a stop outside the current view is looked up by name (departures are no longer hit-and-miss)',
    /API_GEOCODE = 'https:\/\/api\.transitous\.org\/api\/v1\/geocode'/.test(liveSrc) &&
    /async function lookupStop\(name\)/.test(liveSrc) && /lookupStop\(stop\.name\)\.then/.test(liveSrc));
  // Am Knotenpunkt (Hauptbahnhof: 16 Steig-Einträge) standen viele fast weiße Punkte übereinander.
  check('stops are deduped per stop, not per platform',
    /normStopName\(s\.name\)\}\|\$\{s\.lat\.toFixed\(2\)\}/.test(liveSrc) &&
    /const better = \(!prev\.stopId && cand\.stopId\)/.test(liveSrc));
  // Haltestelle als Kreis mit Buchstabe: „H" in beiden Sprachen (ein englisches „S" würde als S-Bahn gelesen).
  check('stop letter is "H" in both languages (never "S")',
    /stopMark: 'H'/.test(i18nSrc) && !/stopMark: 'S'/.test(i18nSrc));
  // Volle Länge der Linie beim Klick auf eine Marke, in der Farbe des Betreibers.
  check('clicking a vehicle draws the whole run of its line in the line colour',
    /function tripChain\(leg\)/.test(liveSrc) && /id: 'live-line-chain'/.test(liveSrc) &&
    /const c = popupVehicle \? colorFor\(popupVehicle\)/.test(liveSrc) &&
    /chainCache = popupChain \? \[popupChain\] : \[\]/.test(liveSrc));
  check('the drawer check mirrors the CSS media query exactly (panel closes where the drawer exists)',
    /const DRAWER_QUERY = '\(max-width: 700px\), \(hover: none\) and \(pointer: coarse\)'/.test(html) &&
    /\(max-width: 700px\), \(hover: none\) and \(pointer: coarse\)/.test(css) &&
    /hidePanel: \(\) => \{ if \(touchLayout\(\)\) setPanel\(false\); \}/.test(html) &&
    /headEl\.addEventListener\('click'/.test(html));
  // Der Kartenraum ist begrenzt: vorher ließ sich die Karte endlos (auch nach oben) schieben.
  {
    const mb = (html.match(/maxBounds: \[\[([-\d.]+), ([-\d.]+)\], \[([-\d.]+), ([-\d.]+)\]\]/) || []).slice(1).map(Number);
    const [w, s, e, n] = mb;
    console.log(`  maxBounds: west ${w} süd ${s} ost ${e} nord ${n}`);
    check('map bounds are set (no endless panning)',
      mb.length === 4 && s < n && w < e && (n - s) > 0.5 && (n - s) < 3 && (e - w) > 0.5 && (e - w) < 3);
    check('map bounds cover Darmstadt', s < 49.872 && n > 49.872 && w < 8.652 && e > 8.652);
    check('zoom-out is limited and the world is not repeated', /minZoom: [1-9]\d*/.test(html) && /renderWorldCopies: false/.test(html));
  }
  check('chosen line swings the camera to its vehicles (with room for panel/sheet)',
    /function focusLine\(/.test(liveSrc) && /const padding = finePointer\(\)/.test(liveSrc) &&
    /padding, maxZoom: 15, duration: 700/.test(liveSrc));

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

  // Die drei Neuerungen (Grundkarten-Umschalter, Suche oben rechts, Ortung auf dem Rechner) gehören
  // NUR in den Hybridbetrieb — die veröffentlichte Seite bleibt wie vorher.
  check('the new UI is hybrid-only (basemap, top-right search, desktop location)',
    /const HYBRID = !!\(window\.DarmstadtLive && window\.DarmstadtLive\.HYBRID_ON\)/.test(html) &&
    /if \(HYBRID\) map\.addControl\(new BasemapButton\(\)/.test(html) &&
    /if \(\(touchLayout\(\) \|\| HYBRID\) && navigator\.geolocation\)/.test(html) &&
    /if \(HYBRID\) \{ addRasters\(\); applyBasemap\(\); \}/.test(html) &&
    /html:not\(\[data-hybrid\]\) #searchbar \{ position: static/.test(css) &&
    /pb\.appendChild\(sb\)/.test(html));

  // Drei Grundkarten (Wunsch 2026-10-15): dunkler Vektorstil, Luftbild, helle Straßenkarte.
  check('satellite raster source is configured but starts hidden',
    /SAT_TILES = 'https:\/\/server\.arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery\/MapServer\/tile\/\{z\}\/\{y\}\/\{x\}'/.test(html) &&
    /id: 'sat', type: 'raster'/.test(html) && /layout: \{ visibility: 'none' \}/.test(html) &&
    /const SAT_MAXZOOM = 1[89];/.test(html) && /maxzoom: SAT_MAXZOOM/.test(html));
  // Beide Raster werden OBEN angehängt: der Stil beginnt mit einer background-Ebene, die die ganze
  // Fläche malt — darunter eingehängt wäre ein Raster unsichtbar.
  check('three basemaps exist, both rasters start hidden and sit above the style layers',
    /CARTO_TILES = 'https:\/\/tile\.openstreetmap\.de\/\{z\}\/\{x\}\/\{y\}\.png'/.test(html) &&
    /const CARTO_MAXZOOM = 19;/.test(html) && /id: 'cartoimg', type: 'raster'/.test(html) &&
    /const BASEMAPS = \['normal', 'satellite', 'carto'\]/.test(html) &&
    /map\.addLayer\(\{ id: 'sat'[^\n]*\}\);/.test(html) && /map\.addLayer\(\{ id: 'cartoimg'[^\n]*\}\);/.test(html) &&
    !/firstStyleLayerId/.test(html));
  check('the three basemap titles exist in EN and DE',
    ['basemapToSatellite: ', 'basemapToMap: ', 'basemapToNormal: '].every(k =>
      (i18nSrc.match(new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length === 2));
  check('the basemap switch never swaps the style (layer visibility only)',
    /function applyBasemap\(\)[\s\S]*?setLayoutProperty\(l\.id, 'visibility'/.test(html) &&
    !/function (setBasemap|applyBasemap)\([^)]*\) \{[^}]*setStyle\(/.test(html) &&
    (html.match(/\.setStyle\(/g) || []).length === 1);           // nur der Kachel-Patch
  check('basemap toggle stacks directly above the tilt button, one rule for every layout',
    /map\.addControl\(new BasemapButton\(\), 'bottom-right'\);[^\n]*\nmap\.addControl\(new TiltButton\(\), 'bottom-right'\);/.test(html) &&
    !/touchLayout\(\)[^\n]*BasemapButton/.test(html));
  check('basemap toggle looks like the other map buttons and shows its state',
    /\.maplibregl-ctrl-group\.basemap \{ display: grid;[^}]*width: 29px; height: 29px/.test(css) &&
    /\.maplibregl-ctrl-group\.basemap\[aria-pressed="true"\]/.test(css));
  check('satellite credit is in the source box and shown only while satellite is on',
    /<p class="attrib-sat" data-i18n="attributionSatellite">/.test(html) &&
    /#attribbox \.attrib-sat \{ display: none; \}/.test(css) &&
    /html\[data-basemap="satellite"\] #attribbox \.attrib-sat \{ display: block; \}/.test(css) &&
    /attributionSatellite: 'Satellite imagery: Esri, Maxar, Earthstar Geographics'/.test(fs.readFileSync(path.join(DOCS, 'i18n.js'), 'utf8')));
  check('marker pills get a dark outline on the two light basemaps (focus ring kept)',
    /html:not\(\[data-basemap="normal"\]\) \.mk \{ box-shadow: 0 0 0 1\.5px rgba\(0,0,0,\.55\)/.test(css) &&
    /html:not\(\[data-basemap="normal"\]\) \.mk\.focus \{ box-shadow:[^}]*var\(--accent\)/.test(css) &&
    !/(^|\n)\s*\.mk \{[^}]*rgba\(0,0,0,\.55\)/.test(css));

  // Suche oben rechts neben EN/DE (Wunsch 2026-10-15), Telefon: hinter der Lupe
  check('the search input lives next to the language toggle, not in the panel',
    /<div id="searchbar" role="search">[\s\S]*id="search"[\s\S]*<\/div>\s*<div id="lang"/.test(html) &&
    !/<div id="head"[\s\S]*id="search"[\s\S]*<div id="bar"/.test(html));
  check('the search box is transparent and sits beside the language switch',
    prop(rule('#searchbar'), 'background') === 'transparent' && /right: 118px/.test(rule('#searchbar') || '') &&
    /rgba\(16,19,26,\.28\)/.test(prop(rule('#search'), 'background') || '') && /blur/.test(prop(rule('#search'), 'backdrop-filter') || ''));
  check('desktop hides the magnifier, phones collapse the search behind it',
    prop(rule('#searchopen'), 'display') === 'none' &&
    prop(rule('#searchopen', mob), 'display') === 'inline-flex' && /min-height: 44px/.test(rule('#searchopen', mob) || '') &&
    /min-width: 44px/.test(rule('#searchopen', mob) || '') &&
    prop(rule('#searchwrap', mob), 'display') === 'none' &&
    prop(rule('#searchbar.open #searchwrap', mob), 'display') === 'block' &&
    /left: auto; right: 8px/.test(rule('#searchbar.open', mob) || ''));
  // Aufgeklappt muss das Feld klein bleiben (der Betreiber fand es zu wuchtig): schmal, flach, aber
  // die Trefferliste darf breiter sein als das Feld und die Trefferzeilen bleiben Fingergröße.
  check('the opened search box stays small on phones',
    /width: min\(58vw, 208px\)/.test(rule('#searchbar.open #searchwrap', mob) || '') &&
    /min-height: 32px/.test(rule('#searchbar.open #search', mob) || '') &&
    /font-size: 13px/.test(rule('#searchbar.open #search', mob) || '') &&
    /width: min\(76vw, 288px\)/.test(rule('#searchbar.open #results', mob) || '') &&
    /min-height: 44px/.test(rule('#results button.res', mob) || ''));
  check('the magnifier is labelled in both languages and wired to the box',
    /<button id="searchopen" type="button" aria-expanded="false" aria-controls="searchwrap"\s+data-i18n-aria="searchOpen"/.test(html) &&
    /searchOpen: 'Open the stop search'/.test(fs.readFileSync(path.join(DOCS, 'i18n.js'), 'utf8')) &&
    /searchOpen: 'Haltestellensuche öffnen'/.test(fs.readFileSync(path.join(DOCS, 'i18n.js'), 'utf8')));
  check('the old panel search rules are gone', !/flex: 1 1 180px/.test(css) && !/#searchwrap \{ flex: 1 1 100%/.test(css));

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

  // assets: every relative src/href must exist (query strings like ?v=... are cache busters, not paths)
  const refs = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map(m => m[1])
    .filter(u => !/^(https?:)?\/\//.test(u) && !u.startsWith('#'))
    .map(u => u.split('?')[0]);
  const dataRefs = [...html.matchAll(/fetch\(`?'?(data\/[\w.]+)/g)].map(m => m[1]).filter(u => /\.json$/.test(u));
  const missing = refs.concat(dataRefs).filter(u => !fs.existsSync(path.join(DOCS, u)));
  log(`  relative assets referenced: ${refs.concat(dataRefs).join(', ')}`);
  check('all relative assets exist (no leading slash -> works under the Pages subpath)', missing.length === 0 && !refs.some(u => u.startsWith('/')), missing.join(', '));
  check('scripts carry a cache-busting version so a push reaches phones immediately',
    /<script src="live\.js\?v=[^"]+"/.test(html) && /<script src="i18n\.js\?v=[^"]+"/.test(html));

  // live-only: die Fahrplan-Daten und -Tests müssen weg sein
  const gone = ['data/shapes.json', 'data/trips_werktag.json', 'data/trips_samstag.json', 'data/trips_sonntag.json'];
  const stillThere = gone.filter(u => fs.existsSync(path.join(DOCS, u)));
  check('timetable data files are gone (live-only map)', stillThere.length === 0, stillThere.join(', '));
  check('no timetable code left in index.html/live.js',
    !/loadDay|drawTimeline|SCHEDULE_MODES|trips_werktag|modeSchedule/.test(html + live));
  check('timetable test file removed', !fs.existsSync(path.join(__dirname, 'test_schedule.js')));

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
  // Dekoder gegen echte Proben prüfen: die beiden Quellen kodieren unterschiedlich (1e5 vs 1e7).
  {
    const vm = require('vm');
    const liveSrcU = fs.readFileSync(path.join(DOCS, 'live.js'), 'utf8');   // liveSrc gilt nur im Block oben
    const fn = liveSrcU.match(/function decodePolyline\([\s\S]*?\n  \}/);
    const box = {};
    if (!fn) {
      check('encoded polyline decodes back to the known coordinates', false, 'Funktion nicht gefunden');
    } else {
      vm.createContext(box);
      vm.runInContext(fn[0] + '\nthis.decodePolyline = decodePolyline;', box);
      // Beispielkette (Präzision 5) aus der Google-Dokumentation
      const got = box.decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 1e5);
      const want = [[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]];
      check('encoded polyline decodes back to the known coordinates',
        got.length === want.length && got.every((p, i) =>
          Math.abs(p[0] - want[i][0]) < 1e-3 && Math.abs(p[1] - want[i][1]) < 1e-3), JSON.stringify(got));
      // Zwei echte Proben: /map/trips-Abschnitt (1e5) und legGeometry aus /trip (1e7).
      const SEC = 'akgoHwcys@ADAHAJCFCFEHEDKFYHGBE?q@NWFa@L[J{@XIB_Bj@eBn@ULs@V';
      const TRIP = 'oiufv\\mliscDaCPeVtBkPvAmIh@m[tBsg@fAsCCgMKsM_CsLuBaPuJcCyAiY}YaPaYuKwYyFaVcFe_@uCif@';
      const a5 = box.decodePolyline(SEC, 1e5)[0], a7 = box.decodePolyline(SEC, 1e7)[0];
      check('a /map/trips section decodes with 1e5 into Darmstadt (and not with 1e7)',
        Math.abs(a5[0] - 8.6536) < 0.002 && Math.abs(a5[1] - 49.8503) < 0.002 && a7[1] < 1,
        `1e5 ${a5.map(v => v.toFixed(4))} | 1e7 ${a7.map(v => v.toFixed(4))}`);
      const t7 = box.decodePolyline(TRIP, 1e7)[0];
      check('the trip legGeometry decodes with 1e7 into Darmstadt',
        Math.abs(t7[0] - 8.6316) < 0.002 && Math.abs(t7[1] - 49.8724) < 0.002, t7.map(v => v.toFixed(4)).join(', '));
      check('both call sites use the factor their source encodes with',
        /decodePolyline\(t\.polyline, 1e5\)/.test(liveSrcU) && /decodePolyline\(g, 1e7\)/.test(liveSrcU));
    }
  }

  console.log(`\nRESULT: ${fails ? 'FAIL (' + fails + ')' : 'PASS'}`);
  process.exit(fails ? 1 : 0);
}
