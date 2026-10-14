/* Proves that the basemap tile cap in docs/index.html still matches reality.
 *
 * Why this exists: CARTO's dark-matter vector style declares NO maxzoom, while its tiles end at a
 * fixed zoom level. Past that level every request is HTTP 404, MapLibre keeps the last successfully
 * rendered tiles and the basemap appears frozen while zooming. index.html therefore replaces the
 * TileJSON source with an explicit tile template plus TILE_MAXZOOM, letting MapLibre overzoom.
 *
 * This script measures the real ceiling on the live service and fails if it no longer equals the
 * constant baked into the page — a drifting ceiling would silently reintroduce the freeze.
 *
 * Needs network access to tiles-*.basemaps.cartocdn.com.
 * Usage: node analysis/check_tile_ceiling.js
 */
const fs = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, '..', 'docs');
const UA = 'darmstadt-live-map/1.0 (+https://github.com/AlvOps/darmstadt-live-map)';
const LAT = 49.872, LON = 8.652;              // Darmstadt city centre
const ZMIN = 10, ZMAX = 18;

function tileX(lon, z) { return Math.floor((lon + 180) / 360 * 2 ** z); }
function tileY(lat, z) {
  const r = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z);
}
const url = (z, x, y) => `https://tiles-a.basemaps.cartocdn.com/vectortiles/carto.streets/v1/${z}/${x}/${y}.mvt`;

(async () => {
  const html = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');
  const declared = Number((html.match(/const TILE_MAXZOOM = (\d+)/) || [])[1]);
  const subs = (html.match(/const TILE_SUBS = \[([^\]]+)\]/) || [])[1] || '';
  let fails = 0;
  const check = (n, c, e) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${!c && e ? ' — ' + e : ''}`); if (!c) fails++; };

  console.log(`index.html declares TILE_MAXZOOM = ${declared}, subdomains [${subs.replace(/['\s]/g, '')}]`);
  check('TILE_MAXZOOM is declared and sane (8..18)', declared >= 8 && declared <= 18);
  check('tiles are requested from all four CARTO subdomains', /'a',\s*'b',\s*'c',\s*'d'/.test(subs));

  const measured = [];
  for (let z = ZMIN; z <= ZMAX; z++) {
    const x = tileX(LON, z), y = tileY(LAT, z);
    let code = 0;
    try {
      const res = await fetch(url(z, x, y), { headers: { 'User-Agent': UA } });
      code = res.status;
      if (code === 200) await res.arrayBuffer();          // drain
    } catch (err) { code = -1; }
    measured.push({ z, code });
    console.log(`  z${String(z).padEnd(2)} ${x}/${y}  HTTP ${code}`);
  }

  const ok = measured.filter(m => m.code === 200).map(m => m.z);
  const highest = ok.length ? Math.max(...ok) : null;
  console.log(`\n  highest zoom actually served: ${highest}`);
  check('the live service served tiles so a ceiling could be measured', highest !== null);
  check(`declared TILE_MAXZOOM (${declared}) equals the measured ceiling (${highest})`, declared === highest);
  check('zooming further really 404s (the cap is meaningful, not cosmetic)',
    measured.some(m => m.z === highest + 1 && m.code === 404));

  console.log(`\nRESULT: ${fails ? 'FAIL (' + fails + ')' : 'PASS'}`);
  process.exit(fails ? 1 : 0);
})();
