/* Timetable (schedule) scope check — offline, runs against the shipped data files.
 *
 * Why: the schedule replay used to draw the regional rail lines (S6, RB61, RB68, RB75 …). Their
 * shapes are 32–104 km long with gaps of ~8 km between consecutive geometry points, so on a city
 * map they rendered as long purple streaks that follow no road. They are now excluded
 * (SCHEDULE_MODES in docs/index.html), and this test proves the shipped rule against the shipped
 * data instead of trusting the source text.
 *
 * Checks:
 *   1. SCHEDULE_MODES parsed from index.html contains no 'rail' and only real local modes.
 *   2. Applying that same rule to every day's trips leaves ZERO rail trips and a healthy number of
 *      tram/bus trips, each backed by a real shape.
 *   3. The rail station dots (hard-coded purple 199,125,255) are gone from the schedule layer and
 *      the station list is filtered to modes that are actually drawn.
 *   4. The rail UI (counter, toggle, legend groups) is hidden in schedule mode by CSS.
 *
 * Usage: node analysis/test_schedule.js
 */
const fs = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, '..', 'docs');
const html = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');
const META = JSON.parse(fs.readFileSync(path.join(DOCS, 'data', 'meta.json'), 'utf8'));
const SHAPES = JSON.parse(fs.readFileSync(path.join(DOCS, 'data', 'shapes.json'), 'utf8'));
const DAYS = ['werktag', 'samstag', 'sonntag'];

let fails = 0;
const check = (n, c, e) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${!c && e ? ' — ' + e : ''}`); if (!c) fails++; };
const list = (html.match(/const SCHEDULE_MODES = \[([^\]]+)\]/) || [])[1];
const modes = (list || '').split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);

console.log(`\n=== Rule shipped in index.html ===`);
console.log(`  SCHEDULE_MODES = [${modes.join(', ')}]`);
check('SCHEDULE_MODES is declared', !!list);
check('the timetable draws no rail (the purple streaks)', !modes.includes('rail'));
check('only real local modes are drawn (tram and bus)', modes.includes('tram') && modes.includes('bus') && modes.every(m => ['tram', 'bus'].includes(m)));

console.log(`\n=== Applied to the shipped trips ===`);
for (const day of DAYS) {
  const raw = JSON.parse(fs.readFileSync(path.join(DOCS, 'data', `trips_${day}.json`), 'utf8'));
  const kept = raw.filter(r => modes.includes(META.lines[r[0]].mode));
  const byMode = kept.reduce((a, t) => (a[META.lines[t[0]].mode] = (a[META.lines[t[0]].mode] || 0) + 1, a), {});
  const railLeft = kept.filter(t => META.lines[t[0]].mode === 'rail').length;
  const droppable = kept.filter(t => t[1] === null || !SHAPES[t[1]] || SHAPES[t[1]].length < 16).length;
  const dropped = raw.length - kept.length;
  console.log(`  ${day.padEnd(8)} kept ${String(kept.length).padStart(4)} of ${String(raw.length).padStart(4)} (dropped ${String(dropped).padStart(4)} rail)  ${JSON.stringify(byMode)}`);
  check(`${day}: nothing but tram/bus is drawn`, railLeft === 0 && kept.length > 0, `railLeft=${railLeft}`);
  check(`${day}: every drawn trip has real shape geometry`, droppable === 0, `${droppable} trips without a usable shape`);
}

console.log(`\n=== Stations and rail UI ===`);
const drawnModes = modes;
const stations = META.stations.filter(s => drawnModes.some(m => String(s[3]).includes(m)));
const railOnly = META.stations.length - stations.length;
console.log(`  stations: ${stations.length} of ${META.stations.length} (${railOnly} rail-only hidden)`);
check('rail-only stations are filtered out of the schedule layer',
  /SCHEDULE_STATIONS = META\.stations\.filter\(s => SCHEDULE_MODES\.some/.test(html));
check('the schedule station layer still exists and uses the filtered list',
  /new deck\.ScatterplotLayer\(\{ id: 'stations', data: SCHEDULE_STATIONS/.test(html));
const stationLayer = html.slice(html.indexOf("id: 'stations'"), html.indexOf("id: 'stations'") + 400);
check('the purple station colour (199,125,255) is gone from the schedule layer', !/199\s*,\s*125\s*,\s*255/.test(stationLayer), stationLayer.slice(0, 90).replace(/\s+/g, ' '));
check('rail counter/toggle/legend groups are hidden in schedule mode',
  /body:not\(\.live\) \[data-mode="rail"\]/.test(html) && /details\[data-modes~="rail"\]/.test(html));
check('legend groups are tagged with their modes', /det\.dataset\.modes = \(g\.modes \|\| \[\]\)\.join\(' '\)/.test(html));
check('the daily profile drops the rail band in schedule mode', /concat\(state\.liveOn \? \['rail'\] : \[\]\)/.test(html));

console.log(`\nRESULT: ${fails ? 'FAIL (' + fails + ')' : 'PASS'}`);
process.exit(fails ? 1 : 0);
