/* Suche und Favoriten für die Karte — reine Funktionen, damit sie testbar bleiben.
 *
 * Warum localStorage und nicht Cookies: die Seite ist statisch, es gibt keinen Server, der ein
 * Cookie je Anfrage bekommen würde. localStorage ist größer, strukturiert (JSON) und wandert nicht
 * bei jedem Asset-Request mit. Gespeichert wird nur lokal im Browser des Nutzers.
 */
(function () {
  'use strict';

  const KEY = 'darmstadt-live-favs';

  // Umlaute/ß/Accents weg, Kleinschreibung, Mehrfach-Leerzeichen zusammen — "Hauptbahnhof" == "hauptbahnhof"
  function norm(s) {
    let out = String(s == null ? '' : s).toLowerCase()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
    if (typeof out.normalize === 'function') out = out.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return out.replace(/\s+/g, ' ').trim();
  }

  const idOf = s => String((s && (s.stopId || s.globalId)) || norm(s && s.name) || '');

  // Rang eines Treffers: 0 = am Namensanfang, 1 = am Wortanfang, 2 = irgendwo mitten im Namen.
  // "haupt" soll "Hauptbahnhof Nord" vor "Darmstadt Hauptbahnhof" stellen, beide vor "…-Hauptdurchgang".
  function rank(n, q) {
    const at = n.indexOf(q);
    if (at <= 0) return at === 0 ? 0 : 3;
    return /[\s\-/(.]/.test(n.charAt(at - 1)) ? 1 : 2;
  }

  // Stationssuche: Rang zuerst, dann alphabetisch; Duplikate raus, Trefferzahl begrenzt.
  function matchStations(query, list, limit) {
    const q = norm(query);
    const out = [];
    if (!q || !Array.isArray(list)) return out;
    const seen = new Set();
    for (const s of list) {
      if (!s) continue;
      const n = norm(s.name);
      if (!n || n.indexOf(q) < 0) continue;
      const id = idOf(s);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ s, r: rank(n, q), n });
    }
    out.sort((a, b) => (a.r === b.r ? a.n.localeCompare(b.n) : a.r - b.r));
    return out.slice(0, limit || 7).map(x => x.s);
  }

  // ---------- Favoriten
  const empty = () => ({ stations: [], lines: [] });

  function load(storage) {
    const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!store) return empty();
    try {
      const raw = store.getItem(KEY);
      if (!raw) return empty();
      const d = JSON.parse(raw);
      return {
        stations: Array.isArray(d && d.stations) ? d.stations.filter(s => s && s.name) : [],
        lines: Array.isArray(d && d.lines) ? d.lines.filter(i => Number.isInteger(i) && i >= 0) : [],
      };
    } catch (_) { return empty(); }        // kaputter Eintrag darf die Seite nicht lahmlegen
  }

  function save(favs, storage) {
    const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!store) return false;
    try { store.setItem(KEY, JSON.stringify({ stations: favs.stations, lines: favs.lines })); return true; }
    catch (_) { return false; }            // z. B. Privatmodus mit vollem Speicher
  }

  const hasStation = (favs, s) => favs.stations.findIndex(x => idOf(x) === idOf(s));
  const hasLine = (favs, i) => favs.lines.indexOf(i);

  function toggleStation(favs, s) {
    const i = hasStation(favs, s);
    const stations = favs.stations.slice();
    if (i >= 0) stations.splice(i, 1);
    else stations.push({ name: s.name, lat: s.lat, lon: s.lon, stopId: s.stopId || null });
    return { stations, lines: favs.lines.slice() };
  }

  function toggleLine(favs, idx) {
    const i = hasLine(favs, idx);
    const lines = favs.lines.slice();
    if (i >= 0) lines.splice(i, 1); else lines.push(idx);
    return { stations: favs.stations.slice(), lines };
  }

  window.DarmstadtSearch = { KEY, norm, matchStations, load, save, hasStation, hasLine, toggleStation, toggleLine, empty };
})();
