/* Wo endet unser Datenraum wirklich?
 *
 * Die Karte soll nicht die ganze Welt zeigen. Statt eine Zahl zu raten, wird hier gemessen, wie
 * weit die Linien reichen, die wir tatsächlich zeichnen: gleiche Filter wie in docs/live.js
 * (MODE_MAP ohne COACH/HIGHSPEED_RAIL/LONG_DISTANCE/NIGHT_RAIL/AIRPLANE/FERRY/ODM, nur
 * realTime === true). Abgefragt wird ein Raster über Rhein-Main/Neckar, das deutlich größer ist
 * als der erwartete Datenraum, damit die Ränder wirklich sichtbar werden.
 *
 * Aufruf:  node analysis/measure_extent.js
 */
const fs = require('fs');
const path = require('path');

const API = 'https://api.transitous.org/api/v1/map/trips';
const UA = 'darmstadt-live-map-extent/1.0 (+https://github.com/AlvOps/darmstadt-live-map)';
const MODE_MAP = {
  TRAM: 'tram', BUS: 'bus',
  SUBURBAN: 'rail', SUBWAY: 'rail', METRO: 'rail', REGIONAL_RAIL: 'rail',
  COACH: null, HIGHSPEED_RAIL: null, LONG_DISTANCE: null, NIGHT_RAIL: null,
  AIRPLANE: null, FERRY: null, ODM: null,
};

const META = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'data', 'meta.json'), 'utf8'));

// Raster: Rhein-Main + Bergstraße/Odenwald + Neckar, absichtlich großzügig
const LAT0 = 49.20, LAT1 = 50.90, LON0 = 7.60, LON1 = 9.50, SPAN = 0.28, WINDOW_MIN = 5;
const boxes = [];
for (let lat = LAT0; lat < LAT1; lat += SPAN) {
  for (let lon = LON0; lon < LON1; lon += SPAN) {
    boxes.push({ s: lat, n: Math.min(lat + SPAN, LAT1), w: lon, e: Math.min(lon + SPAN, LON1) });
  }
}

const get = async url => {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
};

(async () => {
  const now = Date.now();
  const t0 = new Date(now).toISOString().replace(/\.\d+Z$/, 'Z');
  const t1 = new Date(now + WINDOW_MIN * 60000).toISOString().replace(/\.\d+Z$/, 'Z');

  const all = { s: Infinity, n: -Infinity, w: Infinity, e: -Infinity };
  const perLine = new Map();                  // Linienname -> {s,n,w,e,count,mode}
  let records = 0, kept = 0, failed = 0;

  for (const b of boxes) {
    const url = `${API}?min=${b.s.toFixed(3)},${b.w.toFixed(3)}&max=${b.n.toFixed(3)},${b.e.toFixed(3)}` +
                `&zoom=11&startTime=${t0}&endTime=${t1}`;
    let data;
    try { data = await get(url); } catch (err) { failed++; continue; }
    if (!Array.isArray(data)) continue;
    for (const t of data) {
      records++;
      const mode = MODE_MAP[t.mode];
      if (!mode || t.realTime !== true) continue;
      const pts = [t.from, t.to].filter(p => p && Number.isFinite(p.lat) && Number.isFinite(p.lon));
      if (!pts.length) continue;
      kept++;
      const name = String((t.trips && t.trips[0] && t.trips[0].routeShortName) || '?');
      const key = mode + ' ' + name;
      const box = perLine.get(key) || { s: Infinity, n: -Infinity, w: Infinity, e: -Infinity, count: 0, mode };
      for (const p of pts) {
        box.s = Math.min(box.s, p.lat); box.n = Math.max(box.n, p.lat);
        box.w = Math.min(box.w, p.lon); box.e = Math.max(box.e, p.lon);
        all.s = Math.min(all.s, p.lat); all.n = Math.max(all.n, p.lat);
        all.w = Math.min(all.w, p.lon); all.e = Math.max(all.e, p.lon);
      }
      box.count++;
      perLine.set(key, box);
    }
    await new Promise(r => setTimeout(r, 120));   // höflich bleiben
  }

  const metaStations = (META.stations || []).filter(s => Number.isFinite(s[1]) && Number.isFinite(s[2]));
  const metaBox = metaStations.reduce((a, s) => ({
    s: Math.min(a.s, s[1]), n: Math.max(a.n, s[1]), w: Math.min(a.w, s[2]), e: Math.max(a.e, s[2]),
  }), { s: Infinity, n: -Infinity, w: Infinity, e: -Infinity });

  const fmt = x => Number.isFinite(x) ? x.toFixed(3) : '-';
  console.log(`Raster: ${boxes.length} Felder à ${SPAN}°, Fenster ${WINDOW_MIN} min (Fehler: ${failed})`);
  console.log(`Datensätze: ${records}, davon mit unseren Modi + realTime: ${kept}`);
  console.log(`\nGemessener Datenraum (Fahrzeuge):    lat ${fmt(all.s)} … ${fmt(all.n)}   lon ${fmt(all.w)} … ${fmt(all.e)}`);
  console.log(`Ausdehnung:                          ${fmt(all.n - all.s)}° × ${fmt(all.e - all.w)}°`);
  console.log(`Darmstädter Bestand in meta.json:    lat ${fmt(metaBox.s)} … ${fmt(metaBox.n)}   lon ${fmt(metaBox.w)} … ${fmt(metaBox.e)}`);

  const rows = [...perLine.entries()].sort((a, b) =>
    Math.max(b[1].n - b[1].s, b[1].e - b[1].w) - Math.max(a[1].n - a[1].s, a[1].e - a[1].w));
  console.log(`\nLinien im Raster: ${rows.length} (mit den weitesten zuerst)`);
  for (const [key, b] of rows.slice(0, 18)) {
    console.log(`  ${key.padEnd(10)} ${String(b.count).padStart(4)} Abschnitte   lat ${fmt(b.s)}…${fmt(b.n)}  lon ${fmt(b.w)}…${fmt(b.e)}`);
  }

  const names = new Set(rows.map(([k]) => k.split(' ')[1]));
  const metaNames = new Set(META.lines.map(l => l.name));
  const extra = [...names].filter(n => !metaNames.has(n)).sort();
  console.log(`\nLinien im Raster, die NICHT in meta.json stehen: ${extra.length ? extra.join(', ') : 'keine'}`);

  // Vorschlag: gemessener Raum + Rand, auf 0,05° gerundet
  const pad = 0.05, round = x => Math.round(x * 20) / 20;
  console.log(`\nVorschlag maxBounds: south=${fmt(round(all.s - pad))} west=${fmt(round(all.w - pad))} ` +
              `north=${fmt(round(all.n + pad))} east=${fmt(round(all.e + pad))}`);
})();
