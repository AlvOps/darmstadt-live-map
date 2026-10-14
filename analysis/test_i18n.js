/* EN/DE coverage check (offline, no browser).
 *
 * Fails loudly when
 *   1. a key exists in only one language table, or the two tables differ in shape/type,
 *   2. a key used anywhere (I18N.t / T('…') / data-i18n* attributes / GROUPS keys) is missing,
 *   3. docs/index.html contains human-readable text or title/aria-label/alt/placeholder values
 *      that are not driven by i18n (text nodes are checked by walking the markup),
 *   4. docs/*.js or the inline script contain prose string literals (user-visible text that
 *      bypasses the string table),
 *   5. the initial <html lang> disagrees with the default language, or the default is not English.
 *
 * Usage:  node analysis/test_i18n.js         (standalone)
 *         require('./test_i18n').run(check)  (from test_ui.js / test_live.js)
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const DOCS = path.join(__dirname, '..', 'docs');
const read = f => fs.readFileSync(path.join(DOCS, f), 'utf8');

function loadI18n(navLang) {
  const store = {};
  const sb = {
    navigator: { language: navLang || 'de-DE' },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    document: { querySelectorAll: () => [], documentElement: { lang: '' }, title: '' },
    CustomEvent: class {}, dispatchEvent() {},
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(read('i18n.js'), sb);
  return sb;
}

function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object') flatten(v, key, out);
    else out.set(key, typeof v);
  }
  return out;
}

// --- minimal JS tokenizer: returns string/template literal bodies, skipping comments and regexes
function jsLiterals(src) {
  const out = [];
  let i = 0, prev = '';                                 // prev = last significant char (regex detection)
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i = src.indexOf('*/', i + 2) + 2; if (i < 2) break; continue; }
    if (c === '/' && (prev === '' || '(,=:[!&|?{};+-*%<>~^\n'.includes(prev))) {   // regex literal
      i++; let cls = false;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') cls = true; else if (src[i] === ']') cls = false;
        else if (src[i] === '/' && !cls) break;
        i++;
      }
      i++; prev = '/'; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, s = '';
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') { s += src[j + 1]; j += 2; continue; } s += src[j++]; }
      out.push(s); i = j + 1; prev = 'a'; continue;
    }
    if (c === '`') {                                    // template: keep text, drop ${…} (nested scan)
      let j = i + 1, s = '';
      while (j < src.length && src[j] !== '`') {
        if (src[j] === '\\') { s += src[j + 1]; j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '{') {
          let depth = 1; const st = j + 2; j += 2;
          while (j < src.length && depth) {
            if (src[j] === '{') depth++; else if (src[j] === '}') depth--;
            else if (src[j] === '`' || src[j] === "'" || src[j] === '"') {   // nested literal
              const q = src[j]; j++;
              while (j < src.length && src[j] !== q) { if (src[j] === '\\') j++; j++; }
            }
            j++;
          }
          out.push(...jsLiterals(src.slice(st, j - 1)));
          s += ' \u0000 ';
          continue;
        }
        s += src[j++];
      }
      out.push(s); i = j + 1; prev = 'a'; continue;
    }
    if (!/\s/.test(c)) prev = c; else if (c === '\n' && prev === '') prev = '\n';
    i++;
  }
  return out;
}

const KEY_NAMES = new Set(['Escape', 'Space', 'Enter', 'Tab']);
// Looks like a sentence for humans? (≥2 words, a word with ≥3 letters, not a selector/URL/CSS/id list)
/* CSS-ish selector list or single token, e.g. "#speed button", ".pop-stops li", "#legend summary".
 * Deliberately LINEAR: the previous pattern was /^[\w-]+(\s*[,>+~]?\s*[#.]?[\w-]+(\[[^\]]*\])?)*$/,
 * whose nested quantifiers over [\w-]+ backtrack exponentially (ReDoS) on a long string that nearly
 * matches. Long comment text scraped out of <style> hit exactly that and hung the whole test run. */
function looksLikeSelectorOrToken(s) {
  if (!s || !/^[\w\s,>+~#.[\]*:/=-]*$/.test(s)) return false;
  const parts = s.split(/[\s,>+~]+/).filter(Boolean);
  return parts.length > 0 && parts.every(p => /^[#.]?[\w-]+(\[[^\]]*\])?(:[\w-]+)?$/.test(p));
}

function isProse(lit) {
  const s = lit.replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\u0000/g, ' ').trim();
  if (!s) return false;
  if (/^(https?:|data\/|[#.\[]|\(|rgba?\(|var\(|calc\(|min\(|max\(|clamp\()/.test(s)) return false;   // CSS-Werte sind keine Prosa
  if (/(^|[?&\s])[a-zA-Z]+=/.test(s)) return false;                 // URL query strings
  if (KEY_NAMES.has(s)) return false;                                // KeyboardEvent.key/code values
  if (looksLikeSelectorOrToken(s) && !/[A-ZÄÖÜ][a-zäöüß]+ [a-zäöüß]/.test(s) && !/[äöüß]/.test(s)) {
    // single tokens or css-ish selector lists like "#speed button": technical unless clearly sentence-cased
    if (!/\s/.test(s)) return /[äöüßÄÖÜ]/.test(s) || /^[A-ZÄÖÜ][a-zäöüß]{2,}$/.test(s);
    return /\b(the|and|der|die|das|und|nicht|not|no|in|of|ist|is)\b/i.test(s);
  }
  const words = s.match(/[A-Za-zÄÖÜäöüß]{2,}/g) || [];
  return words.length >= 2 && words.some(w => w.length >= 3) && /\s/.test(s);
}

// --- markup walk: text nodes + attributes in <body>
function markupFindings(html) {
  const findings = [];
  const body = html.slice(html.indexOf('<body'));
  const clean = body.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '<script></script>')
    .replace(/<style[\s\S]*?<\/style>/gi, '<style></style>');
  const VOID = new Set(['br', 'img', 'input', 'meta', 'link', 'hr', 'source']);
  const stack = [];
  const re = /<\/?([a-zA-Z0-9-]+)([^>]*)>|([^<]+)/g;
  let m;
  while ((m = re.exec(clean))) {
    if (m[3] !== undefined) {
      const text = m[3].replace(/&[a-z]+;/g, ' ').trim();
      if (!text) continue;
      const i18nOwned = stack.some(e => e.i18n);
      if (!/[A-Za-zÄÖÜäöüß]/.test(text)) continue;        // numbers, glyphs (✕ ❚❚ --:--)
      const top = stack[stack.length - 1] || {};
      if (/^(EN|DE)$/.test(text) && top.attrs && /data-lang=/.test(top.attrs)) continue;   // language codes
      if (!i18nOwned) findings.push(`text "${text}" in <${top.tag || '?'}${top.id ? '#' + top.id : ''}>`);
      continue;
    }
    const tag = m[1].toLowerCase(), attrs = m[2] || '';
    if (m[0].startsWith('</')) {
      const at = stack.map(e => e.tag).lastIndexOf(tag);
      if (at >= 0) stack.length = at;
      continue;
    }
    const id = (attrs.match(/\sid="([^"]*)"/) || [])[1];
    for (const [attr, drv] of [['title', 'data-i18n-title'], ['aria-label', 'data-i18n-aria'], ['alt', null], ['placeholder', 'data-i18n-placeholder']]) {
      const v = (attrs.match(new RegExp('\\s' + attr + '="([^"]*)"')) || [])[1];
      if (v && /[A-Za-zÄÖÜäöüß]{2,}/.test(v) && !(drv && new RegExp('\\s' + drv + '="').test(attrs)))
        findings.push(`${attr}="${v}" on <${tag}${id ? '#' + id : ''}> has no ${drv || 'i18n binding'}`);
    }
    if (!VOID.has(tag) && !/\/\s*$/.test(attrs)) stack.push({ tag, id, attrs, i18n: /\sdata-i18n="/.test(attrs) });
  }
  return findings;
}

function run(check, log = console.log) {
  const html = read('index.html');
  const sources = { 'live.js': read('live.js'), 'i18n.js': read('i18n.js') };
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x => x[1]).join('\n');
  sources['index.html<script>'] = inline;

  const sb = loadI18n('de-DE');
  const S = sb.I18N.strings;
  check('i18n.js exposes both tables', !!(S && S.en && S.de));
  const en = flatten(S.en, '', new Map()), de = flatten(S.de, '', new Map());
  const onlyEn = [...en.keys()].filter(k => !de.has(k)), onlyDe = [...de.keys()].filter(k => !en.has(k));
  const typeDiff = [...en.keys()].filter(k => de.has(k) && de.get(k) !== en.get(k));
  log(`  tables: en=${en.size} keys, de=${de.size} keys`);
  check('no key only in EN', onlyEn.length === 0, onlyEn.join(', '));
  check('no key only in DE', onlyDe.length === 0, onlyDe.join(', '));
  check('EN/DE tables have identical shape and value types', typeDiff.length === 0, typeDiff.join(', '));
  const emptyVals = [...en.keys()].filter(k => !sb.I18N.t(k)).concat();
  check('no empty strings', emptyVals.length === 0, emptyVals.join(', '));

  // A template placeholder must never reach the UI: rendering a key without values has to come back
  // clean (this is what produced a visible "{n} lines" in the legend).
  const leaked = [];
  for (const [k] of en) {
    const out = sb.I18N.t(k);
    if (typeof out === 'string' && /\{[a-z]+\}/i.test(out)) leaked.push(`${k} -> ${out}`);
  }
  check('no key renders a literal placeholder when called without values', leaked.length === 0, leaked.slice(0, 5).join('; '));

  // used keys
  const used = new Map();
  const add = (k, where) => { if (!used.has(k)) used.set(k, new Set()); used.get(k).add(where); };
  const noComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const [name, raw] of Object.entries(sources)) {
    const src = noComments(raw);
    for (const mm of src.matchAll(/(?:\bI18N\.t|\bT|(?<![\w.])t)\(\s*'([A-Za-z0-9_.]+)'/g)) add(mm[1], name);
    for (const mm of src.matchAll(/\bkey:\s*'([A-Za-z0-9_.]+)'/g)) add(mm[1], name + ' (GROUPS)');
  }
  for (const mm of html.matchAll(/data-i18n(?:-title|-aria|-placeholder)?="([^"]+)"/g)) add(mm[1], 'index.html attr');
  const missing = [];
  for (const [k, w] of used) {
    if (!en.has(k)) missing.push(`${k} missing in en (${[...w].join(', ')})`);
    if (!de.has(k)) missing.push(`${k} missing in de (${[...w].join(', ')})`);
  }
  log(`  keys referenced by code/markup: ${used.size}`);
  check('every referenced key exists in EN and DE', missing.length === 0, missing.join('; '));
  for (const lang of ['en', 'de']) {          // rendered value must never be the raw key
    sb.I18N.set(lang);
    const lookup = k => k.split('.').reduce((o, p) => o && o[p], S[lang]);
    const raw = [...used.keys()].filter(k => {
      const val = lookup(k);
      if (typeof val !== 'string') return true;                        // fehlt oder kein String
      // Schlüssel mit Platzhalter werden hier ohne Werte aufgerufen: dann darf nur kein offener
      // Platzhalter übrig bleiben (das Sicherheitsnetz entfernt ihn), sonst muss alles passen.
      if (/\{[a-z]+\}/i.test(val)) return sb.I18N.t(k).includes('{');
      return sb.I18N.t(k) !== val;
    });
    check(`[${lang}] every referenced key resolves to its own ${lang} string (no raw key, no fallback)`, raw.length === 0, raw.join(', '));
  }
  sb.I18N.set('en');
  const sameText = [...used.keys()].filter(k => S.en && k.split('.').reduce((o, p) => o && o[p], S.en) ===
    k.split('.').reduce((o, p) => o && o[p], S.de));
  log(`  keys identical in EN and DE (allowed, e.g. names/units): ${sameText.join(', ') || 'none'}`);

  // markup
  const mf = markupFindings(html);
  log(`  markup walk: ${mf.length} hardcoded string(s)`);
  mf.forEach(f => log('    - ' + f));
  check('no hardcoded human-readable text/attributes in index.html markup', mf.length === 0);

  // prose literals in JS
  const prose = [];
  for (const [name, src] of Object.entries(sources)) {
    if (name === 'i18n.js') continue;          // the string table itself
    for (const lit of jsLiterals(src)) if (isProse(lit)) prose.push(`${name}: ${JSON.stringify(lit.slice(0, 80))}`);
  }
  log(`  JS literal scan: ${prose.length} prose literal(s) outside the string table`);
  prose.forEach(f => log('    - ' + f));
  check('no user-visible prose literals in JS outside i18n.js', prose.length === 0);
  // the scanner must actually work: it has to flag a known prose literal
  check('scanner self-test flags a prose literal', jsLiterals("x = 'Fahrplan: DELFI via gtfs.de'; // c").some(isProse) &&
    !jsLiterals("q('#speed button'); r = /it's/g;").some(isProse));

  // Regression guard: a long comment scraped out of <style> used to make the selector pattern
  // backtrack exponentially and hang the whole run (ReDoS). The scan must stay linear and fast.
  const tricky = ' war ein Splitter, den man kaum treffen konnte. */ @supports (scrollbar-width: auto) { #legend { sc';
  const tProse = Date.now();
  const trickyVerdict = isProse(tricky);
  const msProse = Date.now() - tProse;
  log(`  tricky selector-ish input evaluated in ${msProse} ms -> prose=${trickyVerdict}`);
  check(`prose scanner stays fast on tricky input (${msProse} ms < 200)`, msProse < 200);

  // default language
  const htmlLang = (html.match(/<html[^>]*\slang="([^"]*)"/) || [])[1];
  const fresh = loadI18n('de-DE');                      // German browser, nothing stored
  check('default language is English even for a German browser', fresh.I18N.detect() === 'en');
  check('<html lang> in the static markup matches the default (en)', htmlLang === 'en', `lang="${htmlLang}"`);
  check('index.html syncs <html lang> from I18N.detect() before first paint',
    /<head>[\s\S]*documentElement\.lang\s*=\s*window\.I18N\.detect\(\)[\s\S]*<\/head>/.test(html));
  fresh.I18N.set('de');
  check('I18N.set() updates documentElement.lang', fresh.document.documentElement.lang === 'de');
}

module.exports = { run, jsLiterals, isProse, markupFindings };

if (require.main === module) {
  let fails = 0;
  const check = (name, cond, extra) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && extra ? ' — ' + extra : ''}`); if (!cond) fails++; };
  console.log('=== EN/DE coverage ===');
  run(check);
  console.log(`\nRESULT: ${fails === 0 ? 'PASS' : 'FAIL (' + fails + ')'}`);
  process.exit(fails ? 1 : 0);
}
