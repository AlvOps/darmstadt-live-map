/* Compares the stop positions in docs/data/meta.json against the positions the feed publishes for
 * the same stops (GET /api/v1/map/stops). This is the "is our station plotted where the real stop
 * is" check: meta.json comes from the static timetable dump, the API answers with what the operator
 * data actually says, including the stop ids the live map uses.
 *
 * Matching is by normalised name (our names carry the town prefix, the API's do too). A station is
 * only compared when a same-named published stop lies in the same area, so a "Bahnhof" in another
 * town cannot be paired with ours by accident — the search is restricted to the station's vicinity.
 *
 * Fails when a matched pair deviates more than TOLERANCE_M, which is the symptom of a stale or
 * mis-geocoded timetable dump. Needs network access.
 *
 * Usage: node analysis/check_stations.js
 */
const fs = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, '..', 'docs');
const UA = 'darmstadt-live-map/1.0 (+https://github.com/AlvOps/darmstadt-live-map)';
const API_STOPS = 'https://api.transitous.org/api/v1/map/stops';
const TOLERANCE_M = 250;                       // a stop has to be this close to count as "the same stop"
const AREA = { minLat: 49.70, maxLat: 50.10, minLon: 8.30, maxLon: 9.00 };

const META = JSON.parse(fs.readFileSync(path.join(DOCS, 'data', 'meta.json'), 'utf8'));

const norm = s => String(s || '').toLowerCase()
  .replace(/\(.*?\)/g, '')
  .replace(/[^a-zäöüß0-9]/g, '');                 // "Darmstadt Hauptbahnhof" -> "darmstadthauptbahnhof"
const meters = (aLat, aLon, bLat, bLon) => {
  const kx = 111320 * Math.cos((aLat + bLat) / 2 * Math.PI / 180);
  return Math.hypot((bLon - aLon) * kx, (bLat - aLat) * 110540);
};

(async () => {
  let fails = 0;
  const check = (n, c, e) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${!c && e ? ' — ' + e : ''}`); if (!c) fails++; };

  const bb = `min=${AREA.minLat},${AREA.minLon}&max=${AREA.maxLat},${AREA.maxLon}&zoom=13`;
  const res = await fetch(`${API_STOPS}?${bb}`, { headers: { 'User-Agent': UA } });
  check('feed answered with stop positions (HTTP 200)', res.ok, 'HTTP ' + res.status);
  const published = await res.json();
  check('feed returned stops', Array.isArray(published) && published.length > 0, `${published.length} entries`);
  console.log(`  veröffentlichte Halte im Ausschnitt: ${published.length}`);

  // one entry per platform -> keep one point per name+vizinity for matching
  const byName = new Map();
  for (const s of published) {
    if (!s || typeof s.lat !== 'number' || typeof s.lon !== 'number' || !s.name) continue;
    const k = norm(s.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(s);
  }

  let matched = 0, missing = 0;
  const devs = [];
  for (const st of META.stations) {
    const [name, lon, lat] = st;                       // [name, lon, lat, modes]
    const cands = byName.get(norm(name)) || [];
    const near = cands.filter(c => meters(lat, lon, c.lat, c.lon) < 1500);
    if (!near.length) { missing++; continue; }
    const best = near.reduce((a, b) => meters(lat, lon, b.lat, b.lon) < meters(lat, lon, a.lat, a.lon) ? b : a);
    const d = meters(lat, lon, best.lat, best.lon);
    devs.push({ name, d, ours: [lon, lat], theirs: [best.lon, best.lat] });
    matched++;
  }
  devs.sort((a, b) => b.d - a.d);
  const med = devs.length ? devs[Math.floor(devs.length / 2)].d : 0;
  const over = devs.filter(x => x.d > TOLERANCE_M);
  console.log(`\n  verglichen: ${matched} von ${META.stations.length} Halten (${missing} ohne gleichnamigen Halt im Feed)`);
  console.log(`  Abweichung: median ${med.toFixed(0)} m | größte ${devs.length ? devs[0].d.toFixed(0) : '-'} m`);
  for (const w of devs.slice(0, 5)) {
    console.log(`    ${w.d.toFixed(0).padStart(5)} m  ${w.name}  ours=${w.ours.map(n => n.toFixed(5))} feed=${w.theirs.map(n => n.toFixed(5))}`);
  }
  check('at least half of our stations were matched to published stops', matched >= META.stations.length / 2,
    `${matched}/${META.stations.length}`);
  check(`median deviation is small (< 60 m, got ${med.toFixed(0)} m)`, med < 60);
  check(`no station is off by more than ${TOLERANCE_M} m (${over.length} offenders)`, over.length === 0,
    over.slice(0, 5).map(w => `${w.name} ${w.d.toFixed(0)}m`).join(', '));

  console.log(`\nRESULT: ${fails ? 'FAIL (' + fails + ')' : 'PASS'}`);
  process.exit(fails ? 1 : 0);
})();
