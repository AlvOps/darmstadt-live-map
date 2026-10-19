/* Echtzeit-Modul für "Darmstadt Public Transport Map"
 *
 * Quellen (beide offen, kein Schlüssel, CORS *):
 *   https://api.transitous.org/api/v1/map/trips      Fahrzeuge/Abschnitte im Kartenausschnitt
 *   https://api.transitous.org/api/v1/trip?tripId=…  Fahrtdetails (Haltestellenfolge) für das Popup
 *
 * Datenmodell der API (empirisch verifiziert, siehe analysis/):
 *   Jeder Eintrag von map/trips ist ein Halt-zu-Halt-Abschnitt einer Fahrt, kein Fahrzeugpunkt:
 *     from/to                      Haltestellen mit lat/lon
 *     departure/arrival            Ist-Zeiten des Abschnitts (bei realTime=true)
 *     scheduledDeparture/Arrival   Soll-Zeiten
 *     polyline                     Geometrie des Abschnitts (Anfang == from, Ende == to)
 *     realTime                     true, wenn Ist-Zeiten vorliegen
 *     trips[0].tripId              Fahrt-Kennung für /trip
 *   Im gesamten offenen DELFI-Echtzeitstrom kommen KEINE GPS-Koordinaten vor — nachgewiesen per
 *   Brute-Force-Scan über 50 MB (0 Treffer; das Scan-Skript liegt nicht im Repository, siehe
 *   README) und der SIRI-ET-Struktur (Haltestellen-Prognosen). Es gibt für Darmstadt auch kein offenes SIRI-VM-Fahrzeugpositionsangebot.
 *
 *   Daraus folgt für die Punkte auf der Karte:
 *     - Gezeichnet werden ausschließlich Fahrzeuge mit realTime=true. Fahrzeuge ohne Echtzeit
 *       werden verworfen — deren Position wäre reine Fahrplandaten (Halluzination).
 *     - Die Position ergibt sich aus dem Fortschritt des laufenden Abschnitts nach Ist-Zeiten
 *       entlang dessen echter Geometrie (dieselbe Methode nutzt die Transitous-Karte).
 *     - Das Popup weist diese Ableitung ausdrücklich aus, damit nichts als GPS missverstanden wird.
 *
 * Zweite Quelle: die Live-Positionen des Betreibers (operator.js, IVANTO SRS) — echtes GPS, aber
 *   nur für die Linien, die dort gemeldet werden. Regel: EINE QUELLE JE LINIE (selectSources):
 *     - Linienschlüssel = Verkehrsart + normalisierte Liniennummer; Betreiber-Bus 4/8 heißt im offenen
 *       Strom 4E/8E (SEV) -> Aliastabelle OP_ALIAS, sonst stünden je Linie 4–6 Punkte doppelt da.
 *     - Eine Linie gilt als abgedeckt, wenn in den letzten 10 Min. ein frisches (<= 90 s altes)
 *       Betreiberfahrzeug dafür gemeldet wurde. Die Haltezeit fängt Linien ab, die für einen Abruf
 *       verschwinden (gemessen: GU3, OR1 — Linien mit nur einem Fahrzeug).
 *     - Abgeleitete Punkte einer abgedeckten Linie entfallen NUR im Betriebsgebiet, d. h. im Umkreis
 *       von 2 km um ein Betreiberfahrzeug derselben Linie. Die Offenbacher Busse 1/3/4/6/8 (~35 km
 *       entfernt, gleiche Namen) bleiben so sichtbar.
 *     - Keine Antwort des Betreibers seit 90 s -> Betreiberdaten komplett ignorieren, alles aus dem
 *       offenen Strom zeichnen und ein Banner zeigen (Rückfall global, nicht je Linie).
 *     - Kein Abgleich einzelner Fahrzeuge, nirgends: das ist ein früherer, gescheiterter Versuch
 *       (Zwillinge im Median 250–290 m, im p90 bis 1,4 km auseinander; Commit 6d649d8 hat ihn entfernt).
 *   Jedes Fahrzeug trägt `source` ('operator' | 'open'); Karte, Tooltip und Quellenangabe nennen die
 *   Herkunft. Betreiberfahrzeuge haben keine Verspätung (das Feld ist dort immer null) — sie wird als
 *   „nicht gemeldet" gezeigt, nie als 0.
 *
 * API-Eigenheiten:
 *   - bbox-Reihenfolge ist min=lat,lon&max=lat,lon (umgekehrt -> leere Liste)
 *   - zoom, startTime, endTime sind Pflicht; zu große bbox kann HTTP 422 liefern (bbox wird geklemmt)
 *   - Zeitfenster bestimmt die Nutzlast: 1 Min ≈ 280 kB, 30 Min ≈ 1,2 MB
 *   - generische/fehlende User-Agents -> HTTP 403 (Browser senden ihren eigenen)
 */
(function () {
  'use strict';

  const API = 'https://api.transitous.org/api/v1/map/trips';
  const API_TRIP = 'https://api.transitous.org/api/v1/trip';
  const API_STOPS = 'https://api.transitous.org/api/v1/map/stops';      // echte Haltestellenpositionen
  const API_STOPTIMES = 'https://api.transitous.org/api/v1/stoptimes';  // Abfahrten je Halt
  const API_GEOCODE = 'https://api.transitous.org/api/v1/geocode';      // Halt per Namen (auch außerhalb des Ausschnitts)
  const REFRESH_MS = 30000;        // Abrufintervall (Positionen dazwischen lokal interpoliert)
  const POPUP_REFRESH_MS = 30000;
  const WINDOW_MIN = 1;            // Zeitfenster je Anfrage (Nutzlast-Minimum)
  const MAX_SPAN = 0.28;           // max. bbox-Kantenlänge in Grad (verhindert 422)
  const STALE_MS = 45000;          // ab wann Daten als veraltet gelten (Badge, Statuszeile)
  const EXPIRED_MS = 120000;       // ab wann sie als überholt gelten (Badge, Banner)
  const HOLD_MS = 150000;          // so lange bleibt ein Fahrzeug an seinem Halt stehen, wenn die
                                   // Abfahrt des nächsten Abschnitts noch aussteht (Abschnittslücke)
  const REQUEST_TIMEOUT_MS = 12000; // Frist je Abruf: ein hängender Abruf darf nicht alles blockieren
  const NEXT_STOPS = 3;            // Fahrzeugkarte in Kurzform (z. B. für Zählwerte/Tooltips)
  const CARD_STOPS = 25;           // die Karte listet alle kommenden Halte (scrollbar, ohne Balken)
  const RELAX_MS = 10000;          // gewählte Linie: nach 10 s ohne Interaktion Haltestellen wieder zeigen
  // Muss mit dem APP_V in index.html übereinstimmen. GitHub Pages cached auch das HTML (max-age=600),
  // deshalb kann eine alte Seite mit neuem live.js laufen; index.html gleicht das über diese Kennung ab.
  const VERSION = '20261019-61';
  const LEG_GRACE_MS = 90000;      // so lange nach Abschnittsende bleibt ein Fahrzeug stehen (> REFRESH_MS),
                                   // danach verschwindet es, statt aus veralteten Daten "live" zu wirken
  const FRAME_MS = 33;             // ~30 Bilder/s: die Punkte sollen gleiten, nicht springen.
                                   // Die Karten-Platzierung läuft davon entkoppelt in jedem Frame (tick).
  // Eine Quelle je Linie (siehe Kopf): Schwellen der Auswahl zwischen Betreiber-GPS und offenem Strom.
  const OP_FRESH_MS = 90000;       // Meldung höchstens so alt -> zählt als „Linie wird gemeldet"
  const OP_HOLD_MS = 600000;       // so lange bleibt eine Linie abgedeckt, auch wenn sie kurz fehlt
  const OP_SCOPE_M = 2000;         // Betriebsgebiet: so nah an einem Betreiberfahrzeug derselben Linie
  const OP_STALE_MS = 90000;       // so lange ohne erfolgreiche Betreiberantwort -> globaler Rückfall
  const OP_MAX_AGE_MS = 120000;    // ältere Betreibermeldung wird nicht mehr gezeichnet
  const OP_CARD_MS = 5000;         // Karte eines Betreiberfahrzeugs: Alter der Meldung nachführen
  // Abspielen des Betreiberpfads (encodedPath) wie in der Betreiber-App — Herleitung bei opPosAt.
  const OP_TICK_MS = 1000;         // Schritt: die App setzt die Marken einmal je Sekunde (setInterval 1e3)
  const OP_REPLAY_MS = 20000;      // Abspieldauer: die App teilt die Zeit seit der Meldung durch 20 s
  const OP_PATH_END_M = 10;        // Pfadende so nah an der gemeldeten Position, sonst nicht abspielen
  const OP_PATH_MAX_M = 1500;      // längerer Pfad (GPS-Sprung, Depot) wird nicht abgespielt
  const OP_REPLAY_LAG_MS = 45000;  // Meldung beim Empfang schon älter -> nicht abspielen (veraltet)
  const OP_SKEW_MS = 30000;        // Meldung beim Empfang so weit „in der Zukunft" -> Uhren uneins
  const SELECT_MS = 5000;          // Auswahl spätestens so oft neu (Haltezeit/Rückfall laufen ab)
  // Betreiber-Name -> Name im offenen Strom (gemessen: die SEV-Busse heißen dort 4E/8E, Zwillinge
  // 60–540 m auseinander). Nur in diese Richtung: ein Bus „4" des offenen Stroms (Offenbach) bleibt 4.
  const OP_ALIAS = { 'bus|4': 'bus|4e', 'bus|8': 'bus|8e' };

  // Nur Nahverkehr (kein ICE/IC, keine Fernbusse, keine Flugzeuge) — sonst hängen Abschnitte
  // mit mehreren tausend Geometriepunkten bis Stuttgart/Nürnberg in der Karte.
  const MODE_MAP = {
    TRAM: 'tram', BUS: 'bus',
    SUBURBAN: 'rail', SUBWAY: 'rail', METRO: 'rail', REGIONAL_RAIL: 'rail',
    COACH: null, HIGHSPEED_RAIL: null, LONG_DISTANCE: null, NIGHT_RAIL: null,
    AIRPLANE: null, FERRY: null, ODM: null,
  };

  const T = (key, vars) => (window.I18N ? window.I18N.t(key, vars) : key);

  let ctx = null;
  let vehicles = [];                     // Fahrzeuge aus dem offenen Strom (abgeleitete Positionen)
  let drawn = [];                        // Auswahl je Linie: das wird gezeichnet, gezählt, angetippt
  let opSeen = new Map();                // Linienschlüssel -> { at, pts } (Abdeckung + Haltezeit)
  let opFallback = false, opPresent = false, lastSelect = 0, feedBanner = null, shownBanner = null;
  let selCounts = { operator: 0, open: 0, suppressed: 0, covered: 0 };
  // Für die Punkte in der Linienliste: 'aus dem Bildausschnitt' taugt nicht als Aussage darüber, ob eine
  // Linie gerade überhaupt fährt. Deshalb eine langsame, stadtweite Abfrage für die offenen Linien und
  // die Linien mit Betreiberfahrzeug aus der letzten Auswahl (der Betreiberstrom ist ohnehin netzweit).
  let coverageLines = {};                // aus dem stadtweiten Abruf: Linie -> 'feed'
  let selectedOpLines = new Set();       // Linien, für die gerade ein Betreiberfahrzeug vorliegt
  let lastOk = 0, lastErr = null, failures = 0, lastPaint = 0;
  let pollTimer = null, refreshTimer = null, refreshInFlight = false, pendingRefresh = false;
  let lineIndex = null, viewBox = null;
  let stops = [];                        // Haltestellen aus dem Feed (echte Koordinaten, mit stopId)
  let popupVehicle = null, popupLeg = null, popupTimer = null, popupSeq = 0;
  let popupStation = null, popupAnchor = null, popupDepartures = null;   // Haltestellenkarte
  let popupStopList = [];                // Halte der gerade gezeigten Fahrzeugkarte (Klick-Ziele)
  let popupChain = null, chainCache = [];  // volle Länge der Linie der geöffneten Fahrt
  let dragOff = null;                    // vom Nutzer verschobene Karte: Versatz zur Auto-Position
  let stopCache = null, stopCacheKey = '';   // zuletzt gezeichnete Haltestellen (nicht jeden Frame neu bauen)
  let lastSel = null;                    // nur für den Kamera-Schwenk bei neuer Linienwahl
  // Die Ruheuhr liegt in ctx.state.selAt: Linienwahl und Kartenbewegung brauchen dieselbe Regel
  // ("gewählte Linie -> nur sie; nach 10 s ohne Interaktion kommen die Haltestellen zurück").
  let active = false, lastFrame = 0;

  // API-Texte (Linien, Halte, Ziele, Betreiber, Fehlermeldungen) nie roh in innerHTML
  const esc = x => String(x == null ? '' : x).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ss = n => ctx.shortStop(String(n == null ? '' : n));
  const num = ts => { const v = Date.parse(ts); return Number.isFinite(v) ? v : NaN; };

  // ---------- Geometrie
  // Kodierte Polylinie (Google-Format) zu [lon, lat]. Der Faktor gehört zum Aufruf, weil die Quellen
  // unterschiedlich kodieren: Abschnitte aus /map/trips mit 1e5, legGeometry aus /trip mit 1e7.
  function decodePolyline(str, factor) {
    if (!str) return [];
    const f = factor || 1e5;          // 1e5 ist die Kodierung der Abschnittspolylinien
    let i = 0, lat = 0, lon = 0;
    const out = [];
    while (i < str.length) {
      for (let which = 0; which < 2; which++) {
        let r = 0, sh = 0, b;
        do { b = str.charCodeAt(i++) - 63; r |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20);
        const dv = (r & 1) ? ~(r >> 1) : (r >> 1);
        if (which === 0) lat += dv; else lon += dv;
      }
      out.push([lon / f, lat / f]);
    }
    return out;
  }

  function cumDist(path) {
    const n = path.length, out = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      const kx = 111320 * Math.cos((path[i - 1][1] + path[i][1]) / 2 * Math.PI / 180);
      out[i] = out[i - 1] + Math.hypot((path[i][0] - path[i - 1][0]) * kx, (path[i][1] - path[i - 1][1]) * 110540);
    }
    return out;
  }

  // Eigene Tramgleise als dünne Linien unter den Fahrzeugpillen. Sie zeigen genau die Korridore,
  // die die dunkle Grundkarte verschweigt — ohne einen einzigen zusätzlichen Abruf.
  function addCorridors() {
    const META = ctx && ctx.META;
    const tracks = (META && META.tram_tracks) || [];
    if (!tracks.length || ctx.map.getSource('tracks')) return 0;
    const features = [];
    for (const flat of tracks) {
      const coords = [];
      for (let i = 0; i + 1 < flat.length; i += 2) coords.push([flat[i], flat[i + 1]]);
      if (coords.length > 1) features.push({ type: 'Feature', properties: {},
        geometry: { type: 'LineString', coordinates: coords } });
    }
    if (!features.length) return 0;
    ctx.map.addSource('tracks', { type: 'geojson', data: { type: 'FeatureCollection', features } });
    ctx.map.addLayer({
      id: 'corridors', type: 'line', source: 'tracks',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#9aa4b8',
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.9, 14, 1.8, 17, 3.2],
        'line-opacity': 0.5,
      },
    });
    return features.length;
  }

  function posAt(path, cd) {
    let j = 0;
    return function (dist) {
      while (j < cd.length - 2 && cd[j + 1] < dist) j++;
      const seg = cd[j + 1] - cd[j];
      const u = seg > 0 ? Math.min(1, Math.max(0, (dist - cd[j]) / seg)) : 0;
      const a = path[j], b = path[j + 1];
      return [a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1])];
    };
  }

  // ---------- Linienzuordnung (Farbe aus meta.json)
  // Namen sind zwischen API und meta.json nicht identisch ("RB68 (15316)"), daher beide Seiten
  // normalisieren: Kleinschreibung, Klammern/Wagennummern und Leerzeichen weg, führende Kürzel weg.
  function normLine(name) {
    const s = String(name || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]/g, '');
    return s.replace(/^(ice|ic|ec|en|rj|re|rb|ire|n|s|u|tram|bus|str)(?=[0-9])/, '');
  }

  function buildLineIndex(META) {
    const idx = new Map();
    META.lines.forEach((l, i) => {
      const k = l.mode + '|' + normLine(l.name);
      if (!idx.has(k)) idx.set(k, i);
    });
    return idx;
  }

  function matchLine(name, mode) {
    const key = normLine(name);
    if (!ctx || !key) return -1;
    if (!lineIndex) lineIndex = buildLineIndex(ctx.META);
    const hit = lineIndex.get(mode + '|' + key);
    return hit === undefined ? -1 : hit;
  }

  function colorFor(v) {
    if (v.lineIdx >= 0) return ctx.hex(ctx.META.lines[v.lineIdx].color);
    if (v.routeColor) {                       // API liefert z. B. "ffbe3c"
      const c = String(v.routeColor).replace('#', '');
      if (/^[0-9a-f]{6}$/i.test(c)) return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
    }
    return ctx.MODE_RGB[v.mode] || [200, 200, 200];
  }

  function cssColor(v) {
    const c = colorFor(v);
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  // ---------- Abruf
  function bboxParams() {
    const b = ctx.map.getBounds();
    let w = b.getWest(), s = b.getSouth(), e = b.getEast(), n = b.getNorth();
    const cx = (w + e) / 2, cy = (s + n) / 2;
    const spanLon = Math.min(e - w, MAX_SPAN), spanLat = Math.min(n - s, MAX_SPAN);
    w = cx - spanLon / 2; e = cx + spanLon / 2; s = cy - spanLat / 2; n = cy + spanLat / 2;
    const zoom = Math.max(11, Math.min(15, Math.round(ctx.map.getZoom())));
    viewBox = { w, s, e, n };
    // Achtung: lat,lon — nicht lon,lat
    return `min=${s.toFixed(4)},${w.toFixed(4)}&max=${n.toFixed(4)},${e.toFixed(4)}&zoom=${zoom}`;
  }

  // Jede Anfrage bekommt eine Frist. Ohne sie blockierte ein einziger hängender Abruf mit
  // refreshInFlight=true jeden weiteren Abruf (und damit die ganze Karte) bis zum Neuladen.
  async function timedFetch(url, opts) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS) : null;
    try {
      return await fetch(url, ctrl ? Object.assign({}, opts, { signal: ctrl.signal }) : opts);
    } finally { clearTimeout(timer); }
  }

  async function refresh() {
    if (!ctx) return;
    if (refreshInFlight) { pendingRefresh = true; return; }   // Bewegung während des Abrufs nicht verwerfen
    if (!active) return;                                       // nach dem Ausschalten kein Abruf mehr
    refreshInFlight = true;
    const now = Date.now();
    const t0 = new Date(now).toISOString().replace(/\.\d+Z$/, 'Z');
    const t1 = new Date(now + WINDOW_MIN * 60000).toISOString().replace(/\.\d+Z$/, 'Z');
    try {
      const bb = bboxParams();
      const [res, stopsRes] = await Promise.all([
        timedFetch(`${API}?${bb}&startTime=${t0}&endTime=${t1}`, { cache: 'no-store' }),
        timedFetch(`${API_STOPS}?${bb}`, { cache: 'no-store' }).catch(() => null),
      ]);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (stopsRes && stopsRes.ok) {                 // Halte mit echten Koordinaten aus dem Feed
        const rawStops = await stopsRes.json().catch(() => null);
        if (Array.isArray(rawStops)) stops = dedupeStops(rawStops);
      }
      if (!active) return;                       // während des Abrufs ausgeschaltet
      if (!Array.isArray(json)) throw new Error('bad payload');
      const built = buildVehicles(json);
      if (built.length || failures === 0) {      // leere Antwort nicht als Erfolg überbügeln
        vehicles = built;
        lastOk = Date.now();
        reselect(true);                          // Quelle je Linie neu wählen, offenes Popup nachziehen
      }
      lastErr = null; failures = 0;
      setBanner(null);
    } catch (err) {
      failures++;
      lastErr = err;
      setBanner(failures >= 2
        ? T('bannerUnreachable', { err: err.message || 'network' })
        : T('bannerBlip'));
    } finally {
      refreshInFlight = false;
      updateStat();
      if (pendingRefresh) { pendingRefresh = false; scheduleRefresh(0); }   // nachgeholter Abruf
    }
  }

  function buildVehicles(data) {
    const nowMs = Date.now();
    const byTrip = new Map();
    for (const t of data) {
      if (!t || typeof t !== 'object') continue;
      const mode = MODE_MAP[t.mode];
      if (!mode) continue;
      // Nur echte Echtzeitfahrzeuge: ohne realTime wäre die Position reine Fahrplanableitung.
      if (t.realTime !== true) continue;
      if (typeof t.polyline !== 'string' || !t.departure || !t.arrival) continue;
      const dep = num(t.departure), arr = num(t.arrival);
      if (!(arr > dep)) continue;
      if (nowMs > arr) continue;                              // Abschnitt ist durch
      const tr = (Array.isArray(t.trips) && t.trips[0]) || {};
      const tid = tr.tripId || (t.from && t.from.stopId) + '|' + t.departure;
      const prev = byTrip.get(tid);
      const running = dep <= nowMs;
      // Zwischen zwei Abschnitten (Fahrzeug steht am Halt, Abfahrt des nächsten Abschnitts noch
      // offen) lieferte der Feed keinen laufenden Abschnitt — der Punkt verschwand bei jedem Abruf
      // und eine offene Karte schloss sich. Der nächste Abschnitt steht schon in der Nutzlast:
      // solange er bald beginnt, bleibt das Fahrzeug an seinem Halt stehen (u=0).
      const holding = !running && dep - nowMs <= HOLD_MS;
      if (!running && !holding) continue;
      if (prev) {
        if (prev.running && !running) continue;              // der laufende Abschnitt hat Vorrang
        if (prev.running === running) continue;              // sonst gewinnt der erste Eintrag dieser Art
      }
      // Faktor 1e5: so kodiert /map/trips seine Abschnitte. Falscher Faktor -> alle Positionen liegen
      // weit außerhalb des Ausschnitts und die Karte bleibt leer.
      const path = decodePolyline(t.polyline, 1e5);
      if (path.length < 2) continue;
      const cd = cumDist(path);
      if (!(cd[cd.length - 1] > 0)) continue;
      if (viewBox) {                                          // nur Fahrzeuge im Kartenausschnitt
        const u = Math.min(1, Math.max(0, (nowMs - dep) / (arr - dep)));
        const p = posAt(path, cd)(u * cd[cd.length - 1]);
        const padLat = (viewBox.n - viewBox.s) * 0.25, padLon = (viewBox.e - viewBox.w) * 0.25;
        if (p[1] < viewBox.s - padLat || p[1] > viewBox.n + padLat ||
            p[0] < viewBox.w - padLon || p[0] > viewBox.e + padLon) continue;
      }
      // Ohne Soll-Zeit gibt es keine Verspätung — sie darf nie als "Pünktlich" (0) erscheinen.
      const sched = t.scheduledDeparture ? num(t.scheduledDeparture) : NaN;
      const delayMin = Number.isFinite(sched) ? Math.round((dep - sched) / 60000) : null;  // null = unbekannt
      byTrip.set(tid, {
        tripId: tid, mode, running, holding, source: 'open',
        lineName: String(tr.routeShortName || '?'),
        headsign: String(tr.headsign || ''),
        dest: String((t.to && t.to.name) || ''),
        fromName: String((t.from && t.from.name) || ''),
        dep, arr, delayMin, realTime: true, routeColor: t.routeColor || '',
        path, cd, total: cd[cd.length - 1],
        lineIdx: matchLine(tr.routeShortName, mode),
      });
    }
    return Array.from(byTrip.values()).filter(v => v.running || v.holding);   // fahrend oder am Halt wartend
  }

  // ---------- Eine Quelle je Linie: Betreiber-GPS oder offener Strom
  const isOp = v => !!v && v.source === 'operator';
  const lineKey = (mode, name) => mode + '|' + normLine(name);
  // Schlüssel eines Betreiberfahrzeugs im Namensraum des offenen Stroms (Alias 4 -> 4E, 8 -> 8E)
  function opKey(mode, name) { const k = lineKey(mode, name); return OP_ALIAS[k] || k; }

  function metres(a, b) {                       // [lon, lat] -> Meter (äquirektangulär, reicht für 2 km)
    const kx = 111320 * Math.cos((a[1] + b[1]) / 2 * Math.PI / 180);
    return Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 110540);
  }

  // Eintrag aus operator.js -> dasselbe Fahrzeugmodell, das Karte, Tipp, Linienfokus und Zähler
  // benutzen. Keine Verspätung (null = nicht gemeldet), keine Fahrt-Kennung, keine Halteliste.
  function opModel(e) {
    const key = opKey(e.mode, e.line);
    return {
      tripId: 'op:' + (e.vehicleId || (e.line + '@' + e.lat.toFixed(5) + ',' + e.lon.toFixed(5))),
      source: 'operator', key, mode: e.mode,
      lineName: e.line, headsign: e.dest, dest: e.dest, fromName: '',
      lon: e.lon, lat: e.lat, at: e.at, bearing: e.bearing, vehicleId: e.vehicleId,
      // Gefahrener Weg (roh, kodiert) und Empfang der Meldung: daraus spielt opPosAt die Bewegung ab.
      encodedPath: typeof e.encodedPath === 'string' ? e.encodedPath : '',
      seenAt: Number.isFinite(e.seenAt) ? e.seenAt : null,
      delayMin: null, realTime: true, routeColor: '',
      // Farbe/Linienfokus über den Namen im offenen Strom: so gehört der SEV-Bus 4 zur selben Linie wie 4E
      lineIdx: matchLine(key.slice(key.indexOf('|') + 1), e.mode),
    };
  }

  // Die Auswahl als reine Rechnung (ohne DOM, ohne Netz — die Tests geben synthetische Daten hinein).
  //   open    Fahrzeuge des offenen Stroms (abgeleitet)
  //   op      Fahrzeuge des Betreibers (opModel)
  //   o.now, o.seen (bisherige Abdeckung), o.health (operator.health() oder null = Modul fehlt),
  //   o.posOf (Position eines offenen Fahrzeugs; Vorgabe: dieselbe Interpolation wie die Karte)
  // Ergebnis: { list, seen, fallback, covered, counts } — `seen` ist neu, die Eingabe bleibt unberührt.
  function selectSources(open, op, o) {
    const opt = o || {};
    const now = typeof opt.now === 'number' ? opt.now : Date.now();
    const posOf = opt.posOf || (v => vehiclePosAt(v, now));
    const openList = (open || []).filter(Boolean);
    const h = opt.health || null;
    // Modul fehlt: genau das Verhalten von vorher, ohne Banner.
    if (!h) return { list: openList, seen: new Map(), fallback: false, covered: new Set(),
                     counts: { operator: 0, open: openList.length, suppressed: 0, covered: 0 } };
    // Globaler Rückfall: seit OP_STALE_MS keine erfolgreiche Antwort (oder der erste Abruf ist
    // gescheitert / nach OP_STALE_MS noch keiner gelungen) -> Betreiberdaten komplett ignorieren.
    const fallback = h.lastOk ? now - h.lastOk > OP_STALE_MS
      : (!!h.lastErr || (h.startedAt > 0 && now - h.startedAt > OP_STALE_MS));
    if (fallback) return { list: openList, seen: new Map(), fallback: true, covered: new Set(),
                           counts: { operator: 0, open: openList.length, suppressed: 0, covered: 0 } };
    // Abdeckung: frische Meldung (<= 90 s) frischt die Linie auf; sie bleibt OP_HOLD_MS abgedeckt.
    // Neben dem Zeitpunkt merkt sich jede Linie die letzten Orte ihrer Fahrzeuge — das ist das
    // Betriebsgebiet für die Gebietsprüfung, auch während die Linie für einen Abruf fehlt.
    const seen = new Map();
    for (const [k, e] of (opt.seen || new Map())) {
      if (now - e.at > OP_HOLD_MS) continue;
      seen.set(k, { at: e.at, pts: e.pts.filter(p => now - p.at <= OP_HOLD_MS) });
    }
    const ops = (op || []).filter(v => v && Number.isFinite(v.lon) && Number.isFinite(v.lat) &&
      Number.isFinite(v.at) && now - v.at <= OP_MAX_AGE_MS);
    for (const v of ops) {
      if (now - v.at > OP_FRESH_MS) continue;
      const k = v.key || opKey(v.mode, v.lineName);
      const e = seen.get(k) || { at: 0, pts: [] };
      e.at = now;
      e.pts = e.pts.filter(p => p.id !== v.tripId).concat([{ id: v.tripId, lon: v.lon, lat: v.lat, at: now }]);
      seen.set(k, e);
    }
    const covered = new Set(seen.keys());
    // Offener Strom: nur unterdrücken, wenn die Linie abgedeckt ist UND das Fahrzeug im Gebiet liegt.
    let suppressed = 0;
    const keep = [];
    for (const v of openList) {
      const k = lineKey(v.mode, v.lineName);
      const e = covered.has(k) ? seen.get(k) : null;
      if (e) {
        const p = posOf(v);
        if (p && e.pts.some(q => metres(p, [q.lon, q.lat]) <= OP_SCOPE_M)) { suppressed++; continue; }
      }
      keep.push(v);
    }
    // Betreiberfahrzeuge: nur abgedeckte Linien (frisch oder in der Haltezeit) — praktisch alle.
    const opKeep = ops.filter(v => covered.has(v.key || opKey(v.mode, v.lineName)));
    return { list: keep.concat(opKeep), seen, fallback: false, covered,
             counts: { operator: opKeep.length, open: keep.length, suppressed, covered: covered.size } };
  }

  // ---------- Linie und Halte für ein Betreiberfahrzeug (nur Namen, keine Zeiten) ----------
  // Der Betreiberstrom hat keine Halteliste. Für die Karte holen wir eine Fahrt DERSELBEN Linie aus dem
  // offenen Strom — über die Alias-Schlüssel, damit die SEV-Läufe zusammenfinden (Betreiber BUS 4 = offen
  // 4E). Zeiten werden bewusst NICHT übernommen: der Betreiber meldet keine, und fremde Zeiten als seine
  // auszugeben wäre genau die Vermischung, die dieses Projekt vermeidet.
  const OP_TRIP_BOX = 0.035;               // rund ±3,5 km um das Fahrzeug
  const OP_TRIP_TTL = 60000;               // so lange gilt ein Treffer weiter (Karte wird oft neu gebaut)
  let opTripCache = new Map();             // Fahrzeugkennung -> { at, leg }

  function legStopsAhead(leg, v, limit) {
    if (!leg || leg.error) return [];
    const seq = [];
    if (leg.from) seq.push(leg.from);
    (leg.intermediateStops || []).forEach(s => seq.push(s));
    if (leg.to) seq.push(leg.to);
    const pts = seq.filter(s => s && Number.isFinite(s.lat) && Number.isFinite(s.lon));
    if (!pts.length || !Number.isFinite(v.lat) || !Number.isFinite(v.lon)) return [];
    let idx = 0, best = Infinity;
    for (let i = 0; i < pts.length; i++) {                 // ab dem nächstgelegenen Halt in Fahrtrichtung
      const d = metres([v.lon, v.lat], [pts[i].lon, pts[i].lat]);
      if (d < best) { best = d; idx = i; }
    }
    return pts.slice(idx, idx + (limit || CARD_STOPS))
      .map(s => ({ name: ss(s.name), full: s.name, lat: s.lat, lon: s.lon }));
  }

  async function opTripFor(v) {
    const key = v.tripId || 'op';
    const hit = opTripCache.get(key);
    if (hit && Date.now() - hit.at < OP_TRIP_TTL) return hit.leg;
    if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon)) return null;
    const want = opKey(v.mode, v.lineName);
    const s = v.lat - OP_TRIP_BOX, w = v.lon - OP_TRIP_BOX;
    const now = new Date(), end = new Date(Date.now() + 30 * 60000);
    let arr = [];
    try {
      const res = await timedFetch(`${API}?min=${s},${w}&max=${v.lat + OP_TRIP_BOX},${v.lon + OP_TRIP_BOX}&zoom=14` +
        `&startTime=${encodeURIComponent(now.toISOString())}&endTime=${encodeURIComponent(end.toISOString())}`,
        { cache: 'no-store' });
      if (!res.ok) return null;
      const json = await res.json();
      arr = Array.isArray(json) ? json : (json && Array.isArray(json.trips) ? json.trips : []);
    } catch (_) { return null; }
    let best = null;
    for (const t of arr) {
      if (!t || t.realTime !== true) continue;
      const tr = (t.trips && t.trips[0]) || {};
      if (!tr.tripId) continue;
      if (lineKey(MODE_MAP[t.mode] || t.mode, tr.routeShortName) !== want) continue;   // genau dieselbe Linie
      const fr = t.from || {};
      const d = Number.isFinite(fr.lat) && Number.isFinite(fr.lon) ? metres([v.lon, v.lat], [fr.lon, fr.lat]) : 1e9;
      const same = v.headsign && tr.headsign && normLine(v.headsign) === normLine(tr.headsign);
      const score = d + (same ? 0 : 1500);               // gleiche Richtung deutlich bevorzugt
      if (!best || score < best.score) best = { tripId: tr.tripId, score };
    }
    if (!best) { opTripCache.set(key, { at: Date.now(), leg: null }); return null; }
    let leg = null;
    try {
      const r2 = await timedFetch(`${API_TRIP}?tripId=${encodeURIComponent(best.tripId)}`, { cache: 'no-store' });
      if (r2.ok) leg = pickLeg(await r2.json(), { tripId: best.tripId, lineName: '' });
    } catch (_) { leg = null; }
    opTripCache.set(key, { at: Date.now(), leg });
    return leg;
  }

  function inBox(box, pos, pad) {
    if (!box || !pos) return true;
    const pl = (box.n - box.s) * pad, pw = (box.e - box.w) * pad;
    return pos[1] >= box.s - pl && pos[1] <= box.n + pl && pos[0] >= box.w - pw && pos[0] <= box.e + pw;
  }

  // Hybridbetrieb: Betreiberpositionen sind eine Testfunktion. Standardmäßig AUS, damit die
  // Hauptseite ist inzwischen die Betreiberfassung; nur ?hybrid=0 schaltet auf den reinen offenen
  // Strom zurück (keine Betreiberabrufe).
  // Betreiberfassung = Standard (Wunsch des Betreibers 2026-10-15). Die reine Prognosefassung gibt es
  // nur noch ausdrücklich: ?hybrid=0 in der Adresse oder window.DLM_OPERATOR = false eingebettet.
  const HYBRID_ON = typeof window !== 'undefined' && !!window &&
    !(window.DLM_OPERATOR === false ||
      /[?&]hybrid=0(?:&|$)/.test(String((window.location && window.location.search) || '')));

  // EINZIGER Einstieg zum Betreibermodul: ohne Hybridbetrieb null, damit Start, Stopp, Rückfall und
  // Fahrzeugabruf gar nicht erst stattfinden.
  const operatorModule = () => (!HYBRID_ON ? null
    : (window.DarmstadtOperator && typeof window.DarmstadtOperator.vehicles === 'function'
      ? window.DarmstadtOperator : null));

  function operatorInput() {
    const O = operatorModule();
    if (!O) return { health: null, op: [] };
    let health = null, op = [];
    try {
      health = O.health();
      op = (O.vehicles() || []).filter(e => e && e.mode && e.line).map(opModel);
    } catch (_) { health = null; op = []; }   // kaputtes Modul -> wie ohne Modul
    return { health, op };
  }

  // Auswahl anwenden: was gezeichnet wird, Zähler, Banner und das offene Popup. closeMissing: nur nach
  // neuen Daten schließt sich eine Karte, deren Fahrzeug weg ist (wie bisher beim Abruf) — die
  // regelmäßige Neuauswahl im Bildtakt zieht sie nur nach.
  function reselect(closeMissing) {
    const now = Date.now();
    const inp = operatorInput();
    opPresent = !!inp.health;
    const r = selectSources(vehicles, inp.op, { now, seen: opSeen, health: inp.health });
    opSeen = r.seen;
    opFallback = r.fallback;
    // Betreiberfahrzeuge kommen netzweit: wie der offene Strom nur im (erweiterten) Ausschnitt zeigen.
    drawn = r.list.filter(v => !isOp(v) || inBox(viewBox, [v.lon, v.lat], 0.25));
    selectedOpLines = new Set(r.list.filter(isOp).map(v => v.lineIdx).filter(i => i >= 0));
    const nOp = drawn.filter(isOp).length;
    selCounts = { operator: nOp, open: drawn.length - nOp, suppressed: r.counts.suppressed, covered: r.counts.covered };
    lastSelect = now;
    if (popupVehicle) {                        // offenes Popup am Fahrzeug halten
      const again = drawn.find(x => x.tripId === popupVehicle.tripId);
      if (again) popupVehicle = again;
      else if (closeMissing) closePopup();     // Fahrt beendet oder Linie wechselt die Quelle
    }
    paintBanner(false);
  }

  function onOperatorChange() {
    if (!ctx || !active) return;
    reselect(true);
    updateStat();
  }

  // Der Feed liefert je Bahnsteig/Kante einen Eintrag. Am Hauptbahnhof waren das 16 Einträge für
  // "Darmstadt Hauptbahnhof" — auf der Karte standen entsprechend viele Punkte übereinander.
  // Für die Karte zählt der HALT, nicht der Steig: ein Punkt je Name (plus grobem Raster, damit
  // gleichnamige Halte in verschiedenen Orten getrennt bleiben), bevorzugt der Stationshalt.
  function dedupeStops(raw) {
    const seen = new Map();
    for (const s of raw) {
      if (!s || typeof s.lat !== 'number' || typeof s.lon !== 'number' || !s.name) continue;
      const key = `${normStopName(s.name)}|${s.lat.toFixed(2)}|${s.lon.toFixed(2)}`;   // ~1 km Raster
      if (!key || key.indexOf('|') === 0) continue;
      const cand = { name: s.name, stopId: s.stopId, lat: s.lat, lon: s.lon, modes: s.modes || [] };
      const prev = seen.get(key);
      if (!prev) { seen.set(key, cand); continue; }
      // Der Halt der Station schlägt den Steig: er kennt das ganze Abfahrtsbrett.
      const better = (!prev.stopId && cand.stopId) ||
        (!!prev.stopId && !!cand.stopId && stationLevel(cand.stopId) && !stationLevel(prev.stopId));
      if (better) seen.set(key, cand);
    }
    return Array.from(seen.values());
  }

  function vehiclesAt(t) {
    const out = [];
    for (const v of drawn) {
      if (isOp(v)) {
        // Betreiberfahrzeug: nie vorausgerechnet. Der Punkt läuft im Sekundentakt den gemeldeten,
        // tatsächlich gefahrenen Weg (encodedPath) ab und steht danach auf der neuesten Meldung (opPosAt).
        if (t - v.at > OP_MAX_AGE_MS) continue;
        const op = opPosAt(v, t);            // Punkt auf dem gefahrenen Weg, nie daneben, nie davor
        if (!op) continue;
        out.push({ v, pos: op, rest: [], u: 0 });
        continue;
      }
      if (t > v.arr + LEG_GRACE_MS) continue;   // Daten zu alt: nicht als Live-Position zeigen
      const u = Math.min(1, Math.max(0, (t - v.dep) / (v.arr - v.dep)));
      const d = u * v.total;
      const pos = posAt(v.path, v.cd)(d);
      const idx = lowerBound(v.cd, d);
      // Schweif-Geometrie nur neu schneiden, wenn das Fahrzeug einen Stützpunkt überschritten hat.
      // Vorher wurde pro Fahrzeug und Frame über alle Punkte gesucht UND ein neues Array geschnitten —
      // genau deshalb lief die Animation gedrosselt. Jetzt nur noch einmal pro Stützpunkt.
      if (v._restIdx !== idx || !v._rest) {
        v._restIdx = idx;
        v._rest = idx < 0 ? [] : [[pos[0], pos[1]]].concat(v.path.slice(idx));
      } else if (v._rest.length) {
        v._rest[0] = [pos[0], pos[1]];          // erster Punkt ist immer die aktuelle Position
      }
      out.push({ v, pos, rest: v._rest, u });
    }
    return out;
  }

  // Erster Index mit cd[i] >= d (wie findIndex, nur logarithmisch statt linear)
  function lowerBound(cd, d) {
    let hi = cd.length - 1;
    if (hi < 0) return -1;
    if (d <= cd[0]) return 0;
    let lo = 0;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cd[mid] < d) lo = mid + 1; else hi = mid; }
    return cd[lo] >= d ? lo : -1;
  }

  // ---------- Darstellung
  // ---------- Fahrzeugmarken und Haltestellen als Kartenebenen (GPU, keine DOM-Elemente) ----------
  // Vorher war jede Marke ein <button> über der Karte, dessen Position in JEDEM Frame aus
  // map.project() neu geschrieben wurde (~100 Schreibzugriffe pro Frame, gemessen 30 statt 60 fps beim
  // Ziehen). Jetzt zeichnet MapLibre die Pillen selbst: eine GeoJSON-Quelle, eine Symbolebene mit
  // einem selbst gerasterten Bild je Linie und eine unsichtbare Kreisebene als großzügiges Tippziel.
  // Getippt wird über queryRenderedFeatures im Klick der Karte. Die Schrift kommt NICHT aus den
  // Glyphen des Stils (über der Rasterkarte fiel die Beschriftung sonst stumm weg) — die Pille ist ein
  // Bild, das hier mit Canvas 2D gezeichnet und als ImageData übergeben wird (ein <canvas> direkt an
  // addImage wirft in dieser MapLibre-Fassung „mismatched image size").
  const VEHICLE_SOURCE = 'live-vehicles';
  const STOP_SOURCE = 'live-stops';
  const VEHICLE_HIT = 'live-vehicle-hit';          // unsichtbar (circle-opacity 0), nur Tippziel
  const VEHICLE_PILLS = 'live-vehicle-pills';      // die sichtbaren Pillen (icon-image = pillimg)
  const STOP_CIRCLES = 'live-stop-circles';
  const STOP_LABELS = 'live-stop-labels';
  const STOP_HIT = 'live-stop-hit';                // unsichtbar: 26px Tippziel um den 13px-Punkt (WCAG 24px)
  const CANVAS_LAYERS = [STOP_HIT, STOP_CIRCLES, STOP_LABELS, VEHICLE_HIT, VEHICLE_PILLS];
  const TAP_LAYERS = [VEHICLE_PILLS, VEHICLE_HIT, STOP_LABELS, STOP_CIRCLES, STOP_HIT];   // Fahrzeug vor Halt
  // Bildnamen je Linie: normal ab z14, kompakt darunter (wie früher #markers.scaled), Fokus.
  const PILL_PREFIX = { normal: 'pill-', scaled: 'pills-', focus: 'pillf-' };
  const SCALED_BELOW_ZOOM = 14;
  let canvasEventsReady = false;
  let canvasVehicleById = new Map();
  let canvasStopByKey = new Map();
  let canvasHover = false;               // Zeiger über einer Marke -> Cursor „pointer"
  let canvasLog = { vehicles: [], stops: [] };   // zuletzt übergebene Features (Tests/Diagnose)
  const canvasPillSignatures = new Map();
  let markerLog = [];                    // zuletzt gezeichnete Fahrzeuge (Tests/Diagnose)

  function emptyFeatureCollection() { return { type: 'FeatureCollection', features: [] }; }

  // Pixelgenaue Nachbildung der Pillen aus docs/index.html (.mk): SVG-Sinnbild der Verkehrsart +
  // Liniennummer, padding 3/9/3/7, gap 5, Schrift 12.5px/800, Rand 1.5px rgba(10,14,22,.35),
  // Schatten 0 1px 5px rgba(0,0,0,.5), Kapselradius, Betreiber-Punkt 7px aussen oben rechts.
  // Die Farben werden zur Laufzeit aus den CSS-Variablen der Seite gelesen, damit Karte und Panel
  // nie auseinanderlaufen.
  const PILL_ICONS = {
    tram: [{ d: 'M12 1l4 2.5V5H8V3.5L12 1zM5 7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7zm3 1v4h8V8H8z' },
           { cx: 9, cy: 19.5, r: 1.8 }, { cx: 15, cy: 19.5, r: 1.8 }],
    bus: [{ d: 'M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm2 3v5h12V6H6z' },
          { cx: 7, cy: 19.5, r: 1.8 }, { cx: 17, cy: 19.5, r: 1.8 }],
    rail: [{ d: 'M6 2h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-1l2 3v1h-2.4l-1.8-2.5h-5.6L7.4 21H5v-1l2-3H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm1 3v5h10V5H7z' },
           { cx: 9, cy: 18.6, r: 1.7 }, { cx: 15, cy: 18.6, r: 1.7 }],
  };
  const PILL_FALLBACK = { tram: '#ff6b6b', bus: '#2ec4b6', rail: '#c77dff', accent: '#ffd166' };

  function pillColor(mode) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--' + mode).trim();
      if (v) return v;
    } catch (err) { /* Fallback unten */ }
    return PILL_FALLBACK[mode] || PILL_FALLBACK.bus;
  }

  // Schrift der Seite übernehmen (wie die .mk-Pille sie erbte) statt einer eigenen Schriftliste.
  function pageFont() {
    try {
      const f = getComputedStyle(document.body).fontFamily;
      if (f) return f;
    } catch (err) { /* Fallback unten */ }
    return 'sans-serif';
  }

  function capsule(c, x, y, w, h) {
    const r = h / 2;
    c.beginPath();
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y);
    c.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
    c.lineTo(x + r, y + h);
    c.arc(x + r, y + r, r, Math.PI / 2, Math.PI * 1.5);
    c.closePath();
  }

  // Die Pille einmal je Linie rastern. scaled = kompakte Fassung unter z14 (#markers.scaled: Schrift
  // 11px, padding 2/7/2/6, Sinnbild 12px); focus = .mk.focus (weißer Rand + 2,5px Akzentring).
  function makeVehiclePill(label, mode, hasOperator, scaled, focus) {
    const S = 2;                       // Gerätepixel je CSS-Pixel (addImage mit pixelRatio 2)
    const PAD_T = scaled ? 2 : 3, PAD_R = scaled ? 7 : 9, PAD_B = scaled ? 2 : 3, PAD_L = scaled ? 6 : 7;
    const GAP = 5, ICON = scaled ? 12 : 14;
    const FONT_SIZE = scaled ? 11 : 12.5, WEIGHT = 800, LINE_H = FONT_SIZE * 1.15, BORDER = 1.5;
    const RING = focus ? 2.5 : 0;      // .mk.focus: box-shadow 0 0 0 2.5px var(--accent)
    const MARGIN = 5 + RING;           // Platz für den überstehenden Betreiber-Punkt, Schatten und Ring
    const font = WEIGHT + ' ' + FONT_SIZE + 'px ' + pageFont();   // dieselbe Schrift wie die Seite

    const meas = document.createElement('canvas').getContext('2d');
    meas.font = font;
    const textW = meas.measureText(label).width;
    const w = PAD_L + ICON + GAP + textW + PAD_R + BORDER * 2;
    const h = LINE_H + PAD_T + PAD_B + BORDER * 2;

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil((w + MARGIN * 2) * S);
    canvas.height = Math.ceil((h + MARGIN * 2) * S);
    const c = canvas.getContext('2d');
    c.scale(S, S);
    const x = MARGIN, y = MARGIN;

    // Kapsel + Schatten (+ Fokusring) + feiner Rand, genau wie .mk
    c.save();
    c.shadowColor = 'rgba(0,0,0,.5)';
    c.shadowBlur = 5; c.shadowOffsetY = 1;
    if (focus) {
      capsule(c, x - RING, y - RING, w + RING * 2, h + RING * 2);
      c.fillStyle = pillColor('accent') || PILL_FALLBACK.accent;
      c.fill();
      c.restore();
      c.save();
    }
    capsule(c, x, y, w, h);
    c.fillStyle = pillColor(mode);
    c.fill();
    c.restore();
    capsule(c, x, y, w, h);
    c.lineWidth = BORDER;
    c.strokeStyle = focus ? '#fff' : 'rgba(10,14,22,.35)';   // .mk.focus { border-color: #fff }
    c.stroke();

    // Sinnbild der Verkehrsart im 14px-Feld, aus dem 24px-viewBox skaliert
    const icons = PILL_ICONS[mode] || PILL_ICONS.bus;
    c.save();
    c.translate(x + BORDER + PAD_L, y + BORDER + PAD_T + (LINE_H - ICON) / 2);
    c.scale(ICON / 24, ICON / 24);
    c.fillStyle = '#10131a';
    c.fill(new Path2D(icons[0].d));
    for (let i = 1; i < icons.length; i++) {
      c.beginPath();
      c.arc(icons[i].cx, icons[i].cy, icons[i].r, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();

    // Liniennummer
    c.font = font;
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    c.fillStyle = '#10131a';
    c.fillText(label, x + BORDER + PAD_L + ICON + GAP, y + h / 2 + 0.5);

    // Betreiber-GPS: 7px, aussen oben rechts, 1,5px dunkler Ring (== .mk[data-src="operator"]::after)
    if (hasOperator) {
      const cx = x + w - 3, cy = y + 3, dr = 3.5;
      c.beginPath();
      c.arc(cx, cy, dr + 1.5, 0, Math.PI * 2);
      c.fillStyle = '#10131a';
      c.fill();
      c.beginPath();
      c.arc(cx, cy, dr, 0, Math.PI * 2);
      c.fillStyle = '#78dca0';
      c.fill();
    }

    return c.getImageData(0, 0, canvas.width, canvas.height);
  }

  function pillImageId(label, focus, scaled) {
    return (focus ? PILL_PREFIX.focus : scaled ? PILL_PREFIX.scaled : PILL_PREFIX.normal) + label;
  }

  // Drei Bilder je Linie: normal, kompakt, Fokus. Nur neu rastern, wenn sich Verkehrsart oder
  // Betreiber-Kennzeichen der Linie ändert (oder ein setStyle die Bilder weggeworfen hat).
  function ensureCanvasPillImages(vis) {
    const m = ctx.map, lines = new Map();
    for (const item of vis || []) {
      const v = item.v;
      const label = String(v.lineName || '?');
      let line = lines.get(label);
      if (!line) { line = { mode: v.mode || 'bus', operator: false }; lines.set(label, line); }
      if (isOp(v)) line.operator = true;
    }
    for (const [label, line] of lines) {
      const ids = [pillImageId(label, false, false), pillImageId(label, false, true), pillImageId(label, true, false)];
      const signature = line.mode + '|' + (line.operator ? 'operator' : 'open');
      if (canvasPillSignatures.get(label) === signature && ids.every(id => m.hasImage(id))) continue;
      try {
        const images = [
          makeVehiclePill(label, line.mode, line.operator, false, false),
          makeVehiclePill(label, line.mode, line.operator, true, false),
          makeVehiclePill(label, line.mode, line.operator, false, true),
        ];
        ids.forEach((id, i) => {
          // updateImage verlangt dieselbe Größe; bei geändertem Betreiber-Kennzeichen bleibt sie gleich.
          if (m.hasImage(id)) {
            const old = m.getImage && m.getImage(id);
            const od = old && (old.data || old);
            if (od && od.width === images[i].width && od.height === images[i].height) { m.updateImage(id, images[i]); return; }
            m.removeImage(id);
          }
          m.addImage(id, images[i], { pixelRatio: 2 });
        });
        canvasPillSignatures.set(label, signature);
      } catch (err) {
        // Ein misslungenes Bild darf die Karte und die übrigen Marken nicht mitreißen.
        console.warn('vehicle-pill-image-failed', label, err);
      }
    }
  }

  function ensureCanvasLayers(vis) {
    if (!ctx || !ctx.map || typeof ctx.map.addSource !== 'function') return false;
    const m = ctx.map;
    if (typeof m.isStyleLoaded === 'function' && !m.isStyleLoaded()) return false;
    // Bilder vor den Features, die sie über pillimg verlangen.
    ensureCanvasPillImages(vis);
    if (!m.getSource(STOP_SOURCE)) m.addSource(STOP_SOURCE, { type: 'geojson', data: emptyFeatureCollection() });
    if (!m.getLayer(STOP_HIT)) m.addLayer({
      id: STOP_HIT, type: 'circle', source: STOP_SOURCE,
      paint: { 'circle-radius': 13, 'circle-color': '#000', 'circle-opacity': 0, 'circle-stroke-width': 0 },
    });
    if (!m.getLayer(STOP_CIRCLES)) m.addLayer({
      id: STOP_CIRCLES, type: 'circle', source: STOP_SOURCE,
      paint: {
        'circle-radius': ['case', ['get', 'focus'], 7, 6],
        'circle-color': '#ffd166', 'circle-stroke-color': '#1d7a3d', 'circle-stroke-width': 1.5,
      },
    });
    if (!m.getLayer(STOP_LABELS)) m.addLayer({
      id: STOP_LABELS, type: 'symbol', source: STOP_SOURCE,
      layout: {
        'text-field': ['get', 'mark'], 'text-size': 8, 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-allow-overlap': true, 'text-ignore-placement': true, 'text-anchor': 'center',
      },
      paint: { 'text-color': '#1d7a3d', 'text-halo-color': '#ffd166', 'text-halo-width': 0.4 },
    });
    if (!m.getSource(VEHICLE_SOURCE)) m.addSource(VEHICLE_SOURCE, { type: 'geojson', data: emptyFeatureCollection() });
    if (!m.getLayer(VEHICLE_HIT)) m.addLayer({
      id: VEHICLE_HIT, type: 'circle', source: VEHICLE_SOURCE,
      paint: {
        'circle-radius': ['case', ['get', 'focus'], 11, 9],
        'circle-color': '#000',
        // Die Pille ist die sichtbare Marke; der Kreis bleibt unsichtbar, ist aber ein großzügiges
        // Tippziel (die Trefferprüfung ignoriert die Deckkraft).
        'circle-opacity': 0, 'circle-stroke-width': 0,
      },
    });
    if (!m.getLayer(VEHICLE_PILLS)) m.addLayer({
      id: VEHICLE_PILLS, type: 'symbol', source: VEHICLE_SOURCE,
      layout: {
        'icon-image': ['get', 'pillimg'],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 1, 17, 1.15],
        'icon-anchor': 'center',                      // immer mittig auf dem Punkt
        'icon-allow-overlap': true, 'icon-ignore-placement': true,   // nichts wird weggelassen
      },
      paint: { 'icon-opacity': ['case', ['get', 'dim'], 0.55, 1] },  // == .mk.dim { opacity: .55 }
    });
    // Die Grundkarten-Umschaltung in index.html blendet jede Stil-Ebene aus, die sie nicht als eigene
    // kennt — die Marken müssen aber in jeder Grundkarte sichtbar bleiben.
    if (typeof m.getLayoutProperty === 'function') {
      for (const id of CANVAS_LAYERS) {
        try { if (m.getLayoutProperty(id, 'visibility') === 'none') m.setLayoutProperty(id, 'visibility', 'visible'); }
        catch (_) { /* Ebene gerade nicht da */ }
      }
    }
    registerCanvasEvents();
    return true;
  }

  // Ein Tipp auf die Karte: Fahrzeug vor Haltestelle, sonst ins Leere (Karte schließen).
  function canvasTap(point) {
    const m = ctx.map;
    let hits = [];
    try { hits = m.queryRenderedFeatures([point.x, point.y], { layers: TAP_LAYERS }) || []; }
    catch (_) { /* Stil wechselt gerade */ }
    const veh = hits.find(f => f && f.properties && f.properties.kind === 'vehicle');
    const feature = veh || hits.find(f => f && f.properties && f.properties.kind === 'stop');
    if (feature) {
      const props = feature.properties;
      if (props.kind === 'vehicle') {
        const v = canvasVehicleById.get(String(props.key)) || drawn.find(x => String(x.tripId) === String(props.key));
        if (v) { tapVehicle(v); return 'vehicle'; }
      } else {
        const stop = canvasStopByKey.get(String(props.key));
        if (stop) { tapStop(stop); return 'stop'; }
      }
    }
    click({ x: point.x, y: point.y, object: null });
    return 'map';
  }

  function registerCanvasEvents() {
    if (canvasEventsReady || !ctx || !ctx.map) return;
    const m = ctx.map;
    m.on('click', e => canvasTap((e && e.point) || { x: NaN, y: NaN }));
    const canvas = m.getCanvas && m.getCanvas();
    TAP_LAYERS.forEach(id => {
      m.on('mouseenter', id, () => { canvasHover = true; if (canvas && canvas.style) canvas.style.cursor = 'pointer'; });
      m.on('mouseleave', id, () => { canvasHover = false; if (canvas && canvas.style) canvas.style.cursor = ''; });
    });
    canvasEventsReady = true;
  }

  function updateCanvasLayers(vis, shownStops, focusTrip) {
    markerLog = vis.map(c => ({ v: c.v, pos: c.pos, rest: c.rest, u: c.u }));
    if (!ensureCanvasLayers(vis)) return;
    const scaled = ctx.map.getZoom() < SCALED_BELOW_ZOOM;   // kompakte Pille beim Herauszoomen
    const focusId = focusTrip == null ? null : String(focusTrip);
    const vehiclesFC = emptyFeatureCollection();
    canvasVehicleById = new Map();
    for (const c of vis) {
      const v = c.v, id = String(v.tripId);
      if (!c.pos || !Number.isFinite(c.pos[0]) || !Number.isFinite(c.pos[1])) continue;
      canvasVehicleById.set(id, v);
      const label = String(v.lineName || '?');
      const focus = id === focusId;
      vehiclesFC.features.push({
        type: 'Feature', geometry: { type: 'Point', coordinates: c.pos },
        properties: {
          kind: 'vehicle', key: id, label,
          // Der Fokus behält die volle Größe auch unter z14: er soll herausstechen.
          pillimg: pillImageId(label, focus, scaled),
          mode: v.mode || 'bus',
          source: isOp(v) ? 'operator' : 'open', focus,
          dim: !!focusId && !focus,
        },
      });
    }
    const letter = T('stopMark');                       // "H" in beiden Sprachen (Haltestelle)
    const stopsFC = emptyFeatureCollection();
    canvasStopByKey = new Map();
    for (const stop of shownStops || []) {
      if (!stop || !Number.isFinite(stop.lon) || !Number.isFinite(stop.lat)) continue;
      const key = String(stop.name || stop.stopId || '');
      if (!key) continue;
      canvasStopByKey.set(key, stop);
      stopsFC.features.push({
        type: 'Feature', geometry: { type: 'Point', coordinates: [stop.lon, stop.lat] },
        properties: { kind: 'stop', key, name: String(stop.name || ''), mark: letter, focus: !!stop.focus },
      });
    }
    canvasLog = { vehicles: vehiclesFC.features, stops: stopsFC.features };
    const vehicleSource = ctx.map.getSource(VEHICLE_SOURCE);
    const stopSource = ctx.map.getSource(STOP_SOURCE);
    if (vehicleSource) vehicleSource.setData(vehiclesFC);
    if (stopSource) stopSource.setData(stopsFC);
  }

  // Ein Tipp auf ein Fahrzeug gehört dem Fahrzeug: Linienauswahl aufheben (sonst sieht man die Linie
  // statt des Fahrzeugs), Panel aus dem Weg, Fahrzeug fokussieren und Karte öffnen.
  function tapVehicle(v) {
    if (!v) return;
    if (ctx.state) {
      ctx.state.selAt = Date.now();
      if (ctx.state.selLine !== null && ctx.selectLine) ctx.selectLine(null);
    }
    if (ctx.hidePanel) ctx.hidePanel();
    startFollow(v);
    openPopup(v);
  }

  function tapStop(stop) {
    if (!stop) return;
    if (ctx.state) ctx.state.selAt = Date.now();
    if (ctx.hidePanel) ctx.hidePanel();
    openStation(stop, false, true);
    announceStation(stop);
  }

  function render(force) {
    if (!ctx) return;
    followTick();                      // Kamera am angeklickten Fahrzeug halten (kurzzeitig)
    placePopup(false);                 // Popup bleibt am Fahrzeug — auch während die Karte sich bewegt
    // Während Zoom/Pan nichts neu bauen: Layer-Aufbau und Fahrzeugberechnung konkurrieren sonst mit
    // der Geste um den Hauptthread, was die Karte beim Zoomen hakelig wirken lässt. Der nächste
    // Tick zeichnet direkt nach dem Ende der Geste. Beim Verfolgen eines Fahrzeugs muss aber
    // weitergezeichnet werden, sonst steht der Punkt still.
    if (!followTrip && ctx.map.isMoving && ctx.map.isMoving()) return;
    const t = Date.now();
    // Haltezeit und globaler Rückfall laufen auch ohne neue Daten ab: Auswahl regelmäßig neu rechnen.
    if (t - lastSelect > SELECT_MS) reselect(false);
    const sel = ctx.state.selLine;
    const cur = vehiclesAt(t);
    // Angeklicktes Fahrzeug dauerhaft markieren, damit der Punkt auch nach dem Kamera-Follow zu finden ist
    const focusTrip = popupVehicle ? popupVehicle.tripId : null;

    // Die Auswahl bestimmt, was zu sehen ist:
    //   Linie im Panel gewählt -> nur diese Linie, keine Haltestellen (nach 10 s Ruhe kommen sie zurück)
    //   Fahrzeug gewählt       -> NUR dieses Fahrzeug, seine Linie und seine nächsten Halte
    //   nichts gewählt         -> alles
    const relaxed = sel !== null && Date.now() - (ctx.state.selAt || 0) > RELAX_MS;   // 10 s Ruhe
    if (sel !== lastSel) {                 // neue Linie gewählt -> Kamera gleich zu ihren Fahrzeugen
      lastSel = sel;
      if (sel !== null && !focusTrip) focusLineWide(sel);
    }
    const inMode = c => ctx.state.modes[c.v.mode];
    // Ein gewähltes Fahrzeug ist ein Fokus: nur dieses Fahrzeug und seine Linie, sonst nichts. Das
    // gilt dauerhaft — auch wenn weit herausgezoomt wird und der Abruf dann das halbe Netz liefert.
    // Bewusst KEIN Ruhetimer wie bei der Linienwahl, sonst käme der Rest nach ein paar Sekunden
    // zurück und die Ansicht würde beim Zoomen wieder voll.
    const vis = focusTrip
      ? cur.filter(c => c.v.tripId === focusTrip && inMode(c))
      : sel !== null ? cur.filter(c => inMode(c) && c.v.lineIdx === sel) : cur.filter(inMode);
    // Bei gewähltem Fahrzeug nur dessen eigene Halte zeigen (nicht das ganze Netz)
    // Nur neu berechnen, wenn sich wirklich etwas geändert hat: sonst schiebt deck.gl die
    // Haltestellen-Ebene 30-mal pro Sekunde neu hoch, obwohl sie still steht (spürbare Last).
    // Der Schlüssel muss die Haltestellen selbst abbilden: mit der Anzahl allein (vorher
    // popupStopList.length) blieb eine Karte mit gleich vielen, aber anderen Halten stehen.
    const stopKey = `${focusTrip || ''}|${sel}|${relaxed ? 1 : 0}|${
      (popupStopList || []).map(s => s.stopId || s.full || s.name || '').join(',')}|${stops.length}`;
    if (stopKey !== stopCacheKey) {
      stopCacheKey = stopKey;
      stopCache = focusTrip
        ? (popupStopList || [])
            .filter(s => s.lat !== null && s.lon !== null)
            .map(s => ({ name: s.name, lat: s.lat, lon: s.lon, stopId: s.stopId, focus: true }))
        : sel !== null ? (relaxed ? stops : []) : stops;
    }
    const shownStops = stopCache;

    const layers = [
      // Verlauf: der Rest der Fahrt, dünn in der Linienfarbe (deck.gl zeichnet nur Linien, die
      // Fahrzeugmarken und Halte sind MapLibre-Ebenen).
      new ctx.deck.PathLayer({
        id: 'live-trails', data: vis, getPath: d => d.rest,
        getColor: d => { const c = colorFor(d.v); return [...c, 70]; },
        widthUnits: 'pixels', getWidth: 2, capRounded: true, jointRounded: true,
        updateTriggers: { getPath: t },
      }),
      // Volle Länge der gewählten Linie: alle Halte der Fahrt, verbunden, in der Linienfarbe.
      chainCache.length ? new ctx.deck.PathLayer({
        id: 'live-line-chain', data: chainCache, getPath: d => d,
        getColor: () => { const c = popupVehicle ? colorFor(popupVehicle) : [255, 209, 102]; return [...c, 170]; },
        widthUnits: 'pixels', getWidth: 4, capRounded: true, jointRounded: true,
      }) : null,
    ].filter(Boolean);
    // Marken und Halte als Kartenebenen: MapLibre zeichnet sie mit der Karte, keine DOM-Arbeit pro
    // Frame. Getippt wird über den Klick der Karte (canvasTap: Fahrzeug vor Halt, sonst ins Leere) —
    // deck.gl bekommt deshalb KEIN onClick, sonst schlösse sein Leer-Tipp die eben geöffnete Karte.
    updateCanvasLayers(vis, shownStops, focusTrip);
    ctx.overlay.setProps({ layers, onHover: hover, onClick: null, getCursor: cursor });
    if (force || Date.now() - lastPaint > 1000) {     // Statistik nur ~1x je Sekunde neu zeichnen
      lastPaint = Date.now();
      paintStats(cur);
      updateStat();
      const cl = document.getElementById('clock');    // Ecke unten links: echte Uhrzeit im Live-Betrieb
      if (cl) cl.textContent = new Date().toTimeString().slice(0, 5);
    }
  }

  // Hover-Tooltip nur auf Zeigegeräten; auf Touch öffnet der Tipp das Popup.
  const finePointer = () => !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);

  function hover(info) {
    const tip = document.getElementById('tip');
    if (!tip) return;
    if (!info.object || !finePointer()) { tip.style.display = 'none'; return; }
    if (info.object.stopId) {                       // Haltestelle
      tip.innerHTML = `<b>${esc(info.object.name)}</b><br>` +
        `<span style="color:var(--muted)">${esc(T('station.departures'))}</span>`;
      tip.style.display = 'block';
      tip.style.left = info.x + 14 + 'px'; tip.style.top = info.y + 14 + 'px';
      return;
    }
    if (!info.object.v) { tip.style.display = 'none'; return; }
    const v = info.object.v;
    const status = isOp(v) ? T('popup.delayNotReported') + ' · ' + T('popup.sourceOperator')
      : delayText(v.delayMin) + ' · ' + T('popup.realtime');
    tip.innerHTML = `<b>${esc(v.lineName)}</b> → ${esc(ss(v.headsign || v.dest))}<br>` +
      `<span style="color:var(--muted)">${esc(status)}</span>`;
    tip.style.display = 'block';
    tip.style.left = info.x + 14 + 'px'; tip.style.top = info.y + 14 + 'px';
  }

  // Die Fahrzeug- und Haltemarken sind Kartenebenen; canvasTap() prüft sie zuerst (tapVehicle/
  // tapStop). Hier bleibt nur der Tipp ins Leere: Karte schließen, Auswahl aufheben.
  function click(info) {
    if (ctx.state) ctx.state.selAt = Date.now();
    if (ctx.hidePanel) ctx.hidePanel();
    void info;
    stopFollow(); closePopup();
    if (ctx.state && ctx.state.selLine !== null && ctx.selectLine) ctx.selectLine(null);
  }

  // Kurze Rückmeldung im Panel: sonst weiß man nicht, ob der Tipp auf einen Halt gewirkt hat
  function announceStation(stop) {
    const el = document.getElementById('selname');
    const box = document.getElementById('selinfo');
    if (!el || !box) return;
    el.innerHTML = `<b>${esc(ss(stop.name))}</b> <span style="color:var(--muted)">${esc(T('station.departures'))}</span>`;
    box.style.display = 'flex';
  }

  function normStopName(x) {
    return String(x || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-zäöüß0-9]/g, '');
  }

  // Klick auf einen Halt in der Fahrzeugkarte: Kamera dorthin und die Haltestellenkarte öffnen
  function goToStop(i) {
    const s = popupStopList && popupStopList[i];
    if (!s || s.lat === null || s.lon === null) return;
    // Kartenbestand liefert Name/Kennung, die Koordinaten kommen aus dem Feed: der Feed kennt den
    // echten Standort des Halts (unser Bestand weicht teils um bis zu 149 m ab, s. check_stations.js).
    const known = stops.find(x => s.stopId && x.stopId === s.stopId) ||
                  stops.find(x => normStopName(x.name) === normStopName(s.full));
    const target = {
      name: (known && known.name) || s.full || s.name,
      lat: s.lat, lon: s.lon,                       // exakt der angetippte Punkt
      stopId: (known && known.stopId) || s.stopId || null,
      modes: (known && known.modes) || [],
    };
    openStation(target, false, true);      // sofort springen (ohne Kamera-Animation)
    announceStation(target);
  }

  const cursor = ({ isHovering }) => (isHovering || canvasHover ? 'pointer' : 'grab');

  // ---------- Popup: Linie, Verspätungsstatus, nächste Halte
  // "Verspätet · +3 Min." / "Pünktlich" / "Zu früh · −2 Min." — der Status steht als Wort vorn,
  // damit auch ohne Farbwahrnehmung eindeutig ist, ob das Fahrzeug verspätet ist.
  function delayText(d) {
    if (d === null || !Number.isFinite(d)) return T('popup.statusUnknown');
    if (d >= 1) return T('popup.statusLate') + ' · ' + T('popup.delayPlus', { n: d });
    if (d <= -1) return T('popup.statusEarly') + ' · ' + T('popup.delayMinus', { n: Math.abs(d) });
    return T('popup.statusOntime');
  }

  function delayClass(d) {
    if (d === null || !Number.isFinite(d)) return 'unknown';
    if (d >= 1) return 'late';
    if (d <= -1) return 'early';
    return 'ontime';
  }

  const clock = ts => {
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  };

  // Die Fahrt liefert ihre echte Geometrie mit (legGeometry.points, kodierte Polylinie, Faktor 1e7).
  // Damit liegt die Linie auf den Straßen statt als Luftlinie von Halt zu Halt.
  // Alle Halte der Fahrt der Reihe nach (auch die bereits durchfahrenen) — das ist die volle Länge der
  // Linie, nicht nur der Rest vor dem Fahrzeug. Die Halte bringen Koordinaten mit.
  function tripChain(leg) {
    if (!leg || leg.error || leg.operator || leg.noLegs) return null;
    // Vorrang: die mitgelieferte Straßengeometrie. Nur wenn sie fehlt, gerade Linien zwischen den Halten.
    const g = leg.legGeometry && leg.legGeometry.points;
    if (typeof g === 'string' && g.length > 8) {
      const pts = decodePolyline(g, 1e7).filter(q => q.every(Number.isFinite));
      if (pts.length >= 2) return pts;
    }
    const seq = [];
    if (leg.from) seq.push(leg.from);
    (leg.intermediateStops || []).forEach(s => seq.push(s));
    if (leg.to) seq.push(leg.to);
    const pts = seq.filter(s => s && Number.isFinite(s.lat) && Number.isFinite(s.lon)).map(s => [s.lon, s.lat]);
    return pts.length >= 2 ? pts : null;
  }

  function nextStops(leg, limit) {
    const now = Date.now();
    const max = limit || NEXT_STOPS;
    const seq = [];
    if (leg.from) seq.push({ name: leg.from.name, time: leg.startTime, sched: leg.scheduledStartTime, stop: leg.from });
    (leg.intermediateStops || []).forEach(s => seq.push({
      name: s.name, time: s.departure || s.arrival,
      sched: s.scheduledDeparture || s.scheduledArrival, cancelled: s.cancelled, stop: s,
    }));
    if (leg.to) seq.push({ name: leg.to.name, time: leg.endTime, sched: leg.scheduledEndTime, stop: leg.to });
    return seq
      .filter(s => s.time && num(s.time) >= now - 45000)
      .slice(0, max)
      .map(s => {
        const tm = num(s.time), sc = s.sched ? num(s.sched) : NaN;
        return {
          name: ss(s.name), time: tm, full: s.name,       // vollständiger Name für den Sprung zum Halt
          // Die Halte der Fahrt bringen Koordinaten und ihre Kennung mit -> direkt dorthin springen
          lat: s.stop && Number.isFinite(s.stop.lat) ? s.stop.lat : null,
          lon: s.stop && Number.isFinite(s.stop.lon) ? s.stop.lon : null,
          stopId: (s.stop && s.stop.stopId) || null,
          // Keine Soll-Zeit -> Verspätung unbekannt; sie darf nicht als 0 ("pünktlich") erscheinen.
          delay: Number.isFinite(sc) && Number.isFinite(tm) ? Math.round((tm - sc) / 60000) : null,
          inMin: Math.round((tm - now) / 60000),
          cancelled: !!s.cancelled,
        };
      });
  }

  function pickLeg(data, v) {
    const legs = (data && Array.isArray(data.legs) ? data.legs : []).filter(l => l && typeof l === 'object');
    if (!legs.length) return null;
    const leg = legs.find(l => l.tripId === v.tripId)
      || legs.find(l => normLine(l.routeShortName) === normLine(v.lineName))
      || legs[0];
    return {
      agency: leg.agencyName || '', from: leg.from, to: leg.to,
      startTime: leg.startTime, endTime: leg.endTime,
      scheduledStartTime: leg.scheduledStartTime, scheduledEndTime: leg.scheduledEndTime,
      intermediateStops: Array.isArray(leg.intermediateStops) ? leg.intermediateStops : [],
      // Die Straßengeometrie MUSS mit: ohne sie fällt tripChain auf gerade Linien zwischen den
      // Halten zurück und die "straßenfolgende" Linie war nie zu sehen (das war der Fehler).
      legGeometry: leg.legGeometry || null,
    };
  }

  // Karte eines Betreiberfahrzeugs: was der Betreiber meldet (Linie, Ziel, Alter der Meldung) — und
  // ausdrücklich, was er NICHT meldet (Verspätung, Halte). Kein Wort davon ist abgeleitet.
  function opShell(v, leg) {
    const age = Number.isFinite(v.at) ? Math.max(0, Math.round((Date.now() - v.at) / 1000)) : null;
    const sub = [T('popup.sourceOperator')];
    if (age !== null) sub.push(T('popup.reportAge', { s: age }));
    if (v.vehicleId) sub.push(T('popup.vehicleNo', { id: v.vehicleId }));
    return `
      <div class="pop-head">
        <span class="pop-line" style="background:${cssColor(v)}">${esc(v.lineName)}</span>
        <span class="pop-title">${esc(ss(v.headsign || v.dest))}</span>
        <button class="pop-close" aria-label="${esc(T('popup.close'))}">✕</button>
      </div>
      <div class="pop-delay unknown">${esc(T('popup.delayNotReported'))}</div>
      <div class="pop-sub pop-src-op">${esc(sub.join(' · '))}</div>
      ${(() => {
        const list = (leg && leg.stops) || [];
        if (list.length) {
          const rows = list.map((s, i) => {
            const go = Number.isFinite(s.lat) && Number.isFinite(s.lon);
            return `<li${go ? ` class="st-go" data-i="${i}"` : ''}><span class="st-name">${esc(s.name)}</span></li>`;
          }).join('');
          return `<ul class="pop-stops">${rows}</ul>` +
            `<div class="pop-sub pop-src-feed">${esc(T('popup.stopsFromFeed'))}</div>`;
        }
        return leg && leg.loading
          ? `<div class="pop-sub">${esc(T('popup.stopsLoading'))}</div>`
          : `<div class="pop-sub">${esc(T('popup.noStopsOperator'))}</div>`;
      })()}
      <div class="pop-note note-gps">${esc(T('popup.positionNoteOperator'))}</div>`;
  }

  function popupShell(v, leg, loading) {
    if (isOp(v)) { popupStopList = (leg && leg.stops) || []; return opShell(v, leg); }
    const stops = leg && !leg.error ? nextStops(leg, CARD_STOPS) : null;
    popupStopList = stops || [];                 // Klick-Ziele im Popup (Index -> Halt)
    const rows = stops ? stops.map((s, i) => {
      const rel = s.inMin >= 0 && s.inMin <= 60
        ? `<span class="st-rel">${esc(s.inMin <= 0 ? T('popup.stopNow') : T('popup.inMin', { n: s.inMin }))}</span>` : '';
      const d = s.delay;
      const dl = d === null ? '–' : d > 0 ? '+' + d : d < 0 ? '−' + Math.abs(d) : '·';
      // Jeder Halt ist anklickbar und führt zur Haltestelle (wenn der Feed Koordinaten mitliefert)
      const go = s.lat !== null && s.lon !== null;
      return `<li${go ? ` class="st-go" data-i="${i}"` : ''}><span class="st-name">${esc(s.name)}${s.cancelled ? ' ⚠' : ''}</span>${rel}` +
        `<span class="st-clock">${clock(s.time)}</span>` +
        `<span class="st-dly ${delayClass(d)}">${dl}</span></li>`;
    }).join('') : '';
    const failMsg = leg && leg.error
      ? (leg.error === 'noLegs' ? T('popup.noTrip') : T('popup.failed') + ' (' + leg.error + ')') : '';
    const body = leg && leg.error
      ? `<div class="pop-sub pop-err">${esc(failMsg)}</div>`
      : loading
        ? `<div class="pop-sub">${esc(T('popup.loading'))}</div>`
        : `<ul class="pop-stops">${rows || `<li><span class="st-name">${esc(T('popup.noStops'))}</span></li>`}</ul>`;
    // Herkunft der Position: aus Haltzeiten abgeleitet, der offene Strom hat kein GPS.
    const note = T('popup.positionNote');
    return `
      <div class="pop-head">
        <span class="pop-line" style="background:${cssColor(v)}">${esc(v.lineName)}</span>
        <span class="pop-title">${esc(T('popup.nextStops')) + ' → ' + esc(ss(v.headsign || v.dest))}</span>
        <button class="pop-close" aria-label="${esc(T('popup.close'))}">✕</button>
      </div>
      <div class="pop-delay ${delayClass(v.delayMin)}">${esc(delayText(v.delayMin))}</div>
      <div class="pop-sub">${esc(T('popup.realtime'))}${v.fromName ? ' · ' + esc(ss(v.fromName)) + ' → ' : ' · '}${esc(ss(v.dest))}` +
        `${leg && !leg.error && leg.agency ? ' · ' + esc(T('popup.agency')) + ': ' + esc(leg.agency) : ''}</div>
      ${body}
      <div class="pop-note note-warn">${esc(note)}</div>`;
  }

  // ---------- Kamera begleitet das angeklickte Fahrzeug — kurz, dann gibt sie wieder frei
  const FOLLOW_MS = 2000;          // so lange folgt die Kamera dem Punkt
  const FOLLOW_ZOOM = 14.8;        // Zoomstufe, auf die beim Klick hineingegangen wird
  let followTrip = null, followUntil = 0;

  function startFollow(v) {
    if (!v) return;
    // Auf dem Telefon wird NICHT mitgefahren (Wunsch des Betreibers): dort schiebt sich die Karte
    // sonst unter dem Finger weg. Ein Klick zentriert einmal, danach gehört die Karte dem Nutzer.
    if (!finePointer()) {
      const q = vehiclePosAt(v, Date.now());
      if (q) {
        // Der Balken/das Sheet liegt unten: den Punkt etwas über die Mitte legen, sonst verschwindet
        // genau der Bus, den er sehen will, hinter dem Sheet.
        const box = ctx.map.getContainer ? ctx.map.getContainer() : null;
        const ch = box && box.clientHeight ? box.clientHeight : 0;
        ctx.map.easeTo({ center: q, zoom: Math.max(ctx.map.getZoom(), FOLLOW_ZOOM), duration: 650,
                         offset: [0, ch ? -Math.round(ch * 0.22) : 0] });
      }
      return;
    }
    followTrip = v.tripId;
    followUntil = Date.now() + FOLLOW_MS;
    const p = vehiclePosAt(v, Date.now());
    if (p) ctx.map.easeTo({ center: p, zoom: Math.max(ctx.map.getZoom(), FOLLOW_ZOOM), duration: 650 });
  }

  // Freigabe: nach FOLLOW_MS oder sobald der Betreiber selbst eingreift
  function stopFollow() { followTrip = null; followUntil = 0; }

  function followTick() {
    if (!followTrip) return;
    if (Date.now() > followUntil) { stopFollow(); return; }
    const v = drawn.find(x => x.tripId === followTrip) || (popupVehicle && popupVehicle.tripId === followTrip ? popupVehicle : null);
    if (!v) { stopFollow(); return; }
    const p = vehiclePosAt(v, Date.now());
    if (!p) { stopFollow(); return; }
    ctx.map.easeTo({ center: p, zoom: Math.max(ctx.map.getZoom(), FOLLOW_ZOOM),
                     duration: FRAME_MS, easing: t => t });   // gleitend, nicht springend
  }

  // ---------- Popup-Position: am Fahrzeug ausgerichtet und dem Punkt gedämpft nachgeführt
  let popupPos = null;                     // zuletzt gezeichnete Popup-Position (Container-Pixel)

  // Position des Fahrzeugs zu einem Zeitpunkt — dieselbe Interpolation wie die Kartenpunkte
  function vehiclePosAt(v, t) {
    if (isOp(v)) return opPosAt(v, t);
    if (!v || !v.path || !v.cd || !(v.arr > v.dep)) return null;
    const u = Math.min(1, Math.max(0, (t - v.dep) / (v.arr - v.dep)));
    return posAt(v.path, v.cd)(u * v.total);
  }

  // Betreiberposition zum Zeitpunkt t — eine Kopie der Betreiber-App (heagmobilo-live.geomobile.de,
  // bundle.261d6da9.js), nur für GPS-Punkte. Dort steht (gekürzt, minifiziert):
  //   setInterval(function(){ … t.updateMarkers() }, 1e3)                  // Marken einmal je Sekunde
  //   i = b.duration(n.diff(e)).asSeconds()/20*100; i>100&&(i=100)        // e = Antwort-`timestamp`
  //   n = M.default.getLocationAtPercentage(e.encodedPath, i)             // Punkt bei i % der Pfadlänge
  // getLocationAtPercentage dekodiert den Pfad, misst ihn (Haversine), sucht das Teilstück, in dem
  // i % der Länge liegen, und halbiert es bis zu 100-mal am Großkreis-Mittelpunkt — also der Punkt
  // auf diesem Teilstück nach Bogenlänge. Bei 100 % das letzte Pfadstück = die gemeldete Position.
  // Die App springt also im Sekundentakt den zuletzt gefahrenen Weg entlang (~20 s lang) und kommt
  // 20 s nach der Meldung genau an der gemeldeten Position an; danach steht sie still. Weder Gerade
  // zwischen zwei Meldungen noch Vorausrechnung — nur Punkte auf dem gemeldeten Weg.
  //
  // Unsere Umsetzung, dieselbe Rechnung: Anteil = (Sekundenschritt seit Empfang) / OP_REPLAY_MS,
  // gedeckelt bei 1; der Punkt liegt bei diesem Anteil der Bogenlänge auf dem dekodierten Pfad
  // (Haversine wie dort, innerhalb eines Teilstücks linear — bei Teilstücken von Metern bis wenigen
  // hundert Metern ist der Unterschied zum Großkreis unter einem Millimeter). Bei 1 die gemeldete
  // Position selbst.
  // Eine bewusste Abweichung: die App rechnet ab dem `timestamp` der Antwort (Serveruhr, wechselt
  // alle ~20 s) und fragt jede Sekunde — eine neue Meldung ist bei ihr also nach <= 1 s sichtbar und
  // läuft fast von Anfang an. Wir fragen nur alle 10 s (Datenmenge, siehe operator.js); ab dem
  // Server-`timestamp` gerechnet sprängen unsere Punkte beim Empfang bis zu 10 s = halben Weg nach
  // vorn, und eine falsch gehende Geräteuhr verschöbe alles. Darum zählen wir ab dem EMPFANG der
  // Meldung (seenAt, Geräteuhr gegen Geräteuhr): derselbe Ablauf wie dort (Pfadanfang -> gemeldete
  // Position in 20 s, Sekundenschritte), nur höchstens eine Abrufperiode später. Da die Meldungen
  // alle ~20 s = 2 Abrufperioden kommen, ist das Abspielen fertig, wenn die nächste ankommt, und deren
  // Pfad beginnt dort, wo der alte endet — durchgehend, ohne Sprung.
  // Alles Unsichere zeigt genau die gemeldete Position (still) statt einer Schätzung: kein oder
  // kaputter Pfad, weniger als 2 Punkte, Länge 0 oder über OP_PATH_MAX_M, Pfadende weiter als
  // OP_PATH_END_M von der Meldung, beim Empfang schon veraltete Meldung, Uhren uneins, NaN.
  function havM(a, b) {                         // [lon, lat] -> Meter, Formel wie in der App
    const r = 0.017453292519943295, c = Math.cos;
    const x = 0.5 - c((b[1] - a[1]) * r) / 2 + c(a[1] * r) * c(b[1] * r) * (1 - c((b[0] - a[0]) * r)) / 2;
    return 12742000 * Math.asin(Math.sqrt(x));
  }

  // Dekodierter, geprüfter Pfad eines Betreiberfahrzeugs ({ pts, cd, total }) oder null. Am Modell
  // zwischengespeichert, weil opPosAt in jedem Bild läuft.
  function opTrack(v) {
    if (!v) return null;
    const enc = v.encodedPath;
    if (v._trackSrc === enc && v._trackLat === v.lat && v._trackLon === v.lon) return v._track;
    let tr = null;
    if (typeof enc === 'string' && /^[\x3f-\x7e]+$/.test(enc)) {
      const pts = decodePolyline(enc, 1e5);
      const ok = pts.length >= 2 && pts.every(q => Number.isFinite(q[0]) && Number.isFinite(q[1]) &&
        Math.abs(q[0]) <= 180 && Math.abs(q[1]) <= 90);
      if (ok && Number.isFinite(v.lon) && Number.isFinite(v.lat) &&
          havM(pts[pts.length - 1], [v.lon, v.lat]) <= OP_PATH_END_M) {
        const cd = new Float64Array(pts.length);
        for (let i = 1; i < pts.length; i++) cd[i] = cd[i - 1] + havM(pts[i - 1], pts[i]);
        const total = cd[pts.length - 1];
        if (total > 0 && total <= OP_PATH_MAX_M) tr = { pts, cd, total };
      }
    }
    v._trackSrc = enc; v._trackLat = v.lat; v._trackLon = v.lon; v._track = tr;
    return tr;
  }

  function opPosAt(v, t) {
    if (!v || !Number.isFinite(v.lon) || !Number.isFinite(v.lat)) return null;
    const here = [v.lon, v.lat];             // gemeldet, nicht gerechnet
    const s = v.seenAt, lag = s - v.at;
    if (!Number.isFinite(t) || !Number.isFinite(s) || !Number.isFinite(lag) ||
        lag > OP_REPLAY_LAG_MS || lag < -OP_SKEW_MS || t < s) return here;
    const tr = opTrack(v);
    if (!tr) return here;
    const step = Math.floor((t - s) / OP_TICK_MS) * OP_TICK_MS;   // Sekundenschritte wie die App
    if (!(step < OP_REPLAY_MS)) return here;                        // 100 %: genau die Meldung
    const d = tr.total * step / OP_REPLAY_MS;
    const j = Math.max(1, lowerBound(tr.cd, d));                    // erstes Teilstück, das d erreicht
    const a = tr.pts[j - 1], b = tr.pts[j], seg = tr.cd[j] - tr.cd[j - 1];
    const f = seg > 0 ? Math.min(1, Math.max(0, (d - tr.cd[j - 1]) / seg)) : 0;
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  }

  // Reine Rechnung, wohin die Karte kommt (ohne DOM, damit testbar): bevorzugt rechts über dem Punkt,
  // sonst links daneben, notfalls darunter, immer mit Abstand zum Rand.
  function layoutPopup(pt, w, h, cw, ch, pad) {
    let x = pt.x + 18, y = pt.y - h - 12;
    if (x + w > cw - pad) x = Math.max(pad, pt.x - w - 18);
    if (y < pad) y = pt.y + 18;
    x = Math.max(pad, Math.min(x, cw - w - pad));
    y = Math.max(pad, Math.min(y, ch - h - pad));
    return { x, y };
  }

  // Der Linienzug der Verbindungslinie (untere linke Ecke der Karte -> Punkt)
  function leaderD(from, pt) {
    return `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} L ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`;
  }

  // Verbindungslinie zeichnen: sie sagt eindeutig, zu welchem Punkt die Karte gehört
  function drawLeader(el, pt) {
    const svg = document.getElementById('leader');
    if (!svg || !el.getBoundingClientRect || !ctx.map.getContainer) return;
    const box = ctx.map.getContainer();
    if (!box.getBoundingClientRect) return;
    const host = box.getBoundingClientRect(), r = el.getBoundingClientRect();
    if (!Number.isFinite(r.left) || !Number.isFinite(r.bottom)) { hideLeader(); return; }
    const from = { x: r.left - host.left + 3, y: r.bottom - host.top - 3 };
    if (svg.setAttribute) svg.setAttribute('viewBox', `0 0 ${Math.round(host.width)} ${Math.round(host.height)}`);
    svg.style.width = Math.round(host.width) + 'px';
    svg.style.height = Math.round(host.height) + 'px';
    const path = svg.querySelector ? svg.querySelector('path') : null;
    const dot = svg.querySelector ? svg.querySelector('circle') : null;
    if (path && path.setAttribute) path.setAttribute('d', leaderD(from, pt));
    if (dot && dot.setAttribute) { dot.setAttribute('cx', pt.x.toFixed(1)); dot.setAttribute('cy', pt.y.toFixed(1)); }
    if (svg.classList) svg.classList.add('on');
  }
  function hideLeader() {
    const svg = document.getElementById('leader');
    if (svg && svg.classList) svg.classList.remove('on');
  }

  // Karte immer im Bild halten: gezogene Karten wurden über den Rand geschoben (meist nach oben),
  // waren dort nicht mehr zu greifen und „zickten" herum.
  function clampPopup(x, y, w, h, cw, ch, pad) {
    return { x: Math.max(pad, Math.min(x, cw - w - pad)), y: Math.max(pad, Math.min(y, ch - h - pad)) };
  }

  // Karte verschiebbar: ziehen am Kartenkörper. Auf dem Telefon ist das Ziehen ABGESCHALTET
  // (dort wird die Karte als Bottom-Sheet gehalten, Verschieben brach die Ausrichtung), und Knöpfe
  // sowie Halte-Zeilen bleiben ohnehin klickbar.
  function initDrag(el) {
    if (!el || !el.addEventListener || el.dataset.dragReady) return;
    el.dataset.dragReady = '1';
    el.addEventListener('pointerdown', e => {
      if (!finePointer()) return;                       // nur Maus: auf dem Telefon bleibt das Sheet
      const t = e.target;
      if (t && t.closest && t.closest('button, a, li, .pop-stops')) return;
      if (!el.getBoundingClientRect) return;
      const r = el.getBoundingClientRect();
      const base = dragOff || { dx: 0, dy: 0 };
      const start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
      el.classList.add('dragging');
      if (el.setPointerCapture) { try { el.setPointerCapture(e.pointerId); } catch (_) {} }
      const move = ev => {
        const w = el.offsetWidth || 240, h = el.offsetHeight || 132;
        const box = ctx.map.getContainer ? ctx.map.getContainer() : null;
        const cw = box && box.clientWidth ? box.clientWidth : 0, ch = box && box.clientHeight ? box.clientHeight : 0;
        let nx = base.dx + (ev.clientX - start.x), ny = base.dy + (ev.clientY - start.y);
        if (cw && ch) {                                  // Versatz so begrenzen, dass die Karte im Bild bleibt
          const c = clampPopup(start.left + nx, start.top + ny, w, h, cw, ch, 8);
          nx = c.x - start.left; ny = c.y - start.top;
        }
        dragOff = { dx: Math.round(nx), dy: Math.round(ny) };
        el.style.left = Math.round(start.left + dragOff.dx) + 'px';
        el.style.top = Math.round(start.top + dragOff.dy) + 'px';
        const p = popupAnchor || (popupVehicle && vehiclePosAt(popupVehicle, Date.now()));
        if (p && ctx.map.project) drawLeader(el, ctx.map.project(p));
      };
      const up = () => {
        el.classList.remove('dragging');
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  }

  // Zur gewählten Linie schwenken: sonst muss man den Bus zwischen allen Punkten suchen
  // Linienwahl: die Kamera soll ALLE Fahrzeuge der Linie zeigen — auch die außerhalb des aktuellen
  // Ausschnitts. Der normale Abruf kennt nur die sichtbaren Fahrzeuge, deshalb passierte beim Schwenk
  // oft gar nichts (Wunsch 2026-10-15: „zoom out und zeig mir alle"). Dafür einmal weit abfragen.
  const CITY_BOX = { w: 8.560, s: 49.790, e: 8.780, n: 49.950 };   // Darmstadt + Umland
  let wideFetchAt = 0;
  async function focusLineWide(idx) {
    if (!ctx || !ctx.map.fitBounds || typeof fetch !== 'function') { focusLine(idx, null); return; }
    const now = Date.now();
    if (now - wideFetchAt < 4000) { focusLine(idx, null); return; }   // nicht bei jedem Tipp neu abfragen
    wideFetchAt = now;
    const t0 = new Date(now).toISOString().replace(/\.\d+Z$/, 'Z');
    const t1 = new Date(now + 60000).toISOString().replace(/\.\d+Z$/, 'Z');
    try {
      const res = await timedFetch(`${API}?min=${CITY_BOX.s},${CITY_BOX.w}&max=${CITY_BOX.n},${CITY_BOX.e}` +
        `&zoom=12&startTime=${t0}&endTime=${t1}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const keep = viewBox;
      viewBox = CITY_BOX;                     // die Ausschnittsprüfung im Aufbau nutzt diese Box
      const wideOpen = buildVehicles(Array.isArray(json) ? json : []);
      viewBox = keep;
      // Dieselbe Regel wie auf der Karte: eine Quelle je Linie, Betreiberfahrzeuge im weiten Ausschnitt.
      // (Vorher ging hier die Fahrzeugliste ohne `pos` an focusLine — der Schwenk brach still ab.)
      const inp = operatorInput(), at = Date.now();
      const sel = selectSources(wideOpen, inp.op, { now: at, seen: opSeen, health: inp.health });
      const wide = sel.list.filter(v => !isOp(v) || inBox(CITY_BOX, [v.lon, v.lat], 0))
        .map(v => ({ v, pos: vehiclePosAt(v, at) }));
      if (!wide.some(d => d.v.lineIdx === idx)) { focusLine(idx, null); return; }   // weit nichts: wie bisher
      focusLine(idx, wide);
    } catch (_) {
      focusLine(idx, null);                    // im Zweifel mit dem schwenken, was wir schon haben
    }
  }

  // Stadtweiter, langsamer Abruf NUR für die Linienliste: Betriebszeiten ändern sich träge, eine Minute
  // Takt reicht und kostet einen Abruf. Ohne ihn wäre „rot" eine Aussage über den Bildausschnitt.
  let coverageAt = 0;
  const COVERAGE_MS = 60000;
  async function coveragePoll() {
    if (!active || typeof fetch !== 'function') return;
    const now = Date.now();
    if (now - coverageAt < COVERAGE_MS) return;
    coverageAt = now;
    const t0 = new Date(now).toISOString().replace(/\.\d+Z$/, 'Z');
    const t1 = new Date(now + 60000).toISOString().replace(/\.\d+Z$/, 'Z');
    try {
      const res = await timedFetch(`${API}?min=${CITY_BOX.s},${CITY_BOX.w}&max=${CITY_BOX.n},${CITY_BOX.e}` +
        `&zoom=12&startTime=${t0}&endTime=${t1}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const keep = viewBox;
      viewBox = CITY_BOX;                   // die Ausschnittsprüfung im Aufbau nutzt diese Box
      const wide = buildVehicles(Array.isArray(json) ? json : []);
      viewBox = keep;
      const lines = {};
      for (const v of wide) if (v && v.lineIdx >= 0) lines[v.lineIdx] = 'feed';
      coverageLines = lines;
    } catch (_) { /* still: der vorige Stand bleibt stehen, beim nächsten Takt wieder */ }
  }
  setInterval(coveragePoll, 15000);        // fragt nur ab, wenn die Minute um ist

  // Kamera auf die Fahrzeuge einer Linie setzen — mit Platz für Panel (Rechner) bzw. Karte (Telefon).
  function focusLine(idx, list) {
    if (!ctx || !ctx.map.fitBounds || !window.maplibregl) return;
    // Die berechneten Punkte tragen ihre Position als [lon, lat] in `pos` — vorher stand hier
    // d.v.lon/d.v.lat, Felder, die es nie gab: der Schwenk brach mit NaN ab und wurde verschluckt.
    const pts = (list || vehiclesAt(Date.now()))
      .filter(d => d.v.lineIdx === idx && d.pos && Number.isFinite(d.pos[0]) && Number.isFinite(d.pos[1]))
      .map(d => d.pos);
    if (!pts.length) return;
    try {
      const b = new window.maplibregl.LngLatBounds(pts[0], pts[0]);
      for (const p of pts) b.extend(p);
      const box = ctx.map.getContainer ? ctx.map.getContainer() : null;
      const ch = box && box.clientHeight ? box.clientHeight : 800;
      // Genug Rand, damit die Punkte nicht hinter Panel oder Bottom-Sheet liegen; maxZoom deckelt nur
      // den Hineinzoom, ein Herauszoomen bleibt erlaubt (genau das fehlte vorher).
      const padding = finePointer()
        ? { top: 90, bottom: 150, left: 340, right: 90 }
        : { top: 90, bottom: Math.round(ch * 0.45), left: 40, right: 40 };
      ctx.map.fitBounds(b, { padding, maxZoom: 15, duration: 700 });
    } catch (_) { /* Schwenk ist Komfort, kein Muss */ }
  }

  // Setzt das Popup neben den Punkt, hält es im Bild und zieht es weich nach (immediate = ohne Dämpfung).
  function placePopup(immediate) {
    const el = document.getElementById('popup');
    if (!el || (!popupVehicle && !popupStation) || !el.classList.contains('on')) { hideLeader(); return; }
    const p = popupAnchor || vehiclePosAt(popupVehicle, Date.now());
    const pt = p && ctx.map.project ? ctx.map.project(p) : null;
    if (!finePointer() && !dragOff) {      // Telefon: Bottom-Sheet unten, keine Verfolgung
      if (el.style.left || el.style.top) { el.style.left = ''; el.style.top = ''; }
      popupPos = null;
      if (pt) drawLeader(el, pt);          // Linie zeigt auch hier auf den Punkt
      return;
    }
    if (!pt) { hideLeader(); return; }
    const w = el.offsetWidth || 240, h = el.offsetHeight || 132;
    const box = ctx.map.getContainer(), cw = box.clientWidth, ch = box.clientHeight, pad = 8;
    const auto = layoutPopup(pt, w, h, cw, ch, pad);
    if (immediate || !popupPos) popupPos = auto;
    else popupPos = { x: popupPos.x + (auto.x - popupPos.x) * 0.18,       // sanft nachziehen
                      y: popupPos.y + (auto.y - popupPos.y) * 0.18 };
    // Vom Nutzer gezogene Karte behält ihren Versatz und bleibt trotzdem am Punkt hängen — aber
    // begrenzt: erst addieren, dann ins Bild zwingen und den Versatz entsprechend zurückrechnen.
    const dx = dragOff ? dragOff.dx : 0, dy = dragOff ? dragOff.dy : 0;
    const placed = clampPopup(popupPos.x + dx, popupPos.y + dy, w, h, cw, ch, pad);
    if (dragOff) dragOff = { dx: Math.round(placed.x - popupPos.x), dy: Math.round(placed.y - popupPos.y) };
    el.style.left = Math.round(placed.x) + 'px';
    el.style.top = Math.round(placed.y) + 'px';
    drawLeader(el, pt);
  }

  // ---------- Haltestellenkarte: Kamera zum Halt, nächste Abfahrten aus demselben Feed
  function departureRow(e) {
    const place = e.place || {};
    const dep = Date.parse(place.departure);
    const sched = place.scheduledDeparture ? Date.parse(place.scheduledDeparture) : NaN;
    // Ohne Soll-Zeit ist die Verspätung unbekannt — sie darf nicht als 0 ("pünktlich") erscheinen.
    const delay = Number.isFinite(sched) && Number.isFinite(dep) ? Math.round((dep - sched) / 60000) : null;
    const inMin = Math.round((dep - Date.now()) / 60000);
    const line = String(e.routeShortName || '?').replace(/\s*\(.*?\)/, '');
    const col = /^[0-9a-fA-F]{6}$/.test(String(e.routeColor || '')) ? '#' + e.routeColor : '#8a90a0';
    // Ausfall: der Halt oder die ganze Fahrt ist abgesagt. Vorher stand so eine Abfahrt wie jede
    // andere da — die Liste behauptete eine Fahrt, die nicht stattfindet.
    const cancelled = !!(place.cancelled || place.tripCancelled || e.tripCancelled);
    // realTime=false heißt: es gibt nur die Fahrplanzeit, keine Echtzeitprognose. Kennzeichnen.
    const scheduledOnly = place.realTime === false || e.realTime === false;
    const rel = cancelled ? T('station.cancelled')
      : inMin >= 0 && inMin <= 90 ? (inMin <= 0 ? T('popup.stopNow') : T('popup.inMin', { n: inMin })) : '';
    const tag = scheduledOnly ? `<span class="st-tag">${esc(T('popup.scheduled'))}</span>` : '';
    const dly = cancelled ? '⚠' : delay === null ? '–' : delay === 0 ? '·' : delay > 0 ? '+' + delay : String(delay);
    return `<li${cancelled ? ' class="st-cancel"' : ''}>` +
      `<span class="st-line" style="background:${esc(col)}">${esc(line)}</span>` +
      `<span class="st-name">${esc(ss(e.headsign || ''))}${tag}</span>` +
      `${rel ? `<span class="st-rel">${esc(rel)}</span>` : ''}` +
      `<span class="st-clock">${clock(dep)}</span>` +
      `<span class="st-dly ${cancelled ? 'cancelled' : delay === null ? 'unknown' : delayClass(delay)}">${dly}</span></li>`;
  }

  // Stationsebene ("…:16017") oder Steig ("…:16017:2:3")? Der Stationshalt liefert das ganze
  // Abfahrtsbrett, ein Steig nur seine eigene Richtung — für Suche/Favoriten ist die Station besser.
  const stationLevel = id => String(id || '').replace(/^de-DELFI_/, '').split(':').length <= 3;

  // Halt aus unserem Bestand dem Feed-Halt zuordnen: der Feed kennt die Kennung (für die Abfahrten)
  // und die echte Position. Suche und Favoriten liefern nur Name + Koordinaten.
  function resolveStop(stop) {
    if (!stop || stop.stopId) return stop;
    const same = stops.filter(x => normStopName(x.name) === normStopName(stop.name));
    const hit = same.find(x => stationLevel(x.stopId)) || same[0];
    if (!hit) return stop;
    return { name: hit.name || stop.name, lat: hit.lat, lon: hit.lon, stopId: hit.stopId,
             modes: (hit.modes && hit.modes.length) ? hit.modes : (stop.modes || []) };
  }

  function stationShell(stop, deps, loading) {
    const modes = (stop.modes || []).map(m => String(m).toLowerCase().replace(/_/g, ' ')).join(' · ');
    let body;
    if (deps && deps.error) body = `<div class="pop-sub">${esc(T('station.failed'))} (${esc(deps.error)})</div>`;
    else if (loading) body = `<div class="pop-sub">${esc(T('station.loading'))}</div>`;
    else if (!deps || !deps.length) body = `<div class="pop-sub">${esc(T('station.none'))}</div>`;
    else body = `<ul class="pop-stops">${deps.slice(0, 4).map(departureRow).join('')}</ul>`;
    const fav = !!(ctx && ctx.fav && ctx.fav.has && ctx.fav.has(stop));
    return `
      <div class="pop-head">
        <span class="pop-title">${esc(ss(stop.name))}</span>
        <button class="pop-star${fav ? ' on' : ''}" aria-label="${esc(T(fav ? 'favRemove' : 'favAdd'))}"
          title="${esc(T(fav ? 'favRemove' : 'favAdd'))}">${fav ? '★' : '☆'}</button>
        <button class="pop-close" aria-label="${esc(T('popup.close'))}">✕</button>
      </div>
      <div class="pop-sub">${esc(T('station.departures'))}${modes ? ' · ' + esc(modes) : ''}</div>
      ${body}
      <div class="pop-note">${esc(T('station.note'))} ${esc(T('station.mapNote'))}</div>`;
  }

  function paintStation(loading) {
    const el = document.getElementById('popup');
    if (!el || !popupStation) return;
    el.innerHTML = stationShell(popupStation, popupDepartures, loading);
    const btn = el.querySelector('.pop-close');
    if (btn) btn.onclick = closePopup;
    const star = el.querySelector('.pop-star');                 // Halt als Favorit merken
    if (star) star.onclick = () => {
      if (!ctx || !ctx.fav) return;
      ctx.fav.toggle(popupStation);
      paintStation(false);
    };
    placePopup(true);
  }

  // Öffnen (refreshing=false) oder Auffrischen (true: kein Kamerasprung, keine "lädt"-Anzeige)
  const geoCache = new Map();             // Name -> Halt (auch negative Treffer), damit nur einmal gefragt wird

  // Halt per Namen nachschlagen. Nötig, weil `stops` nur die Halte des AKTUELLEN Ausschnitts enthält:
  // eine Suche oder ein Favorit von woanders fand dort nichts und die Karte blieb ohne Abfahrten —
  // mal mit, mal ohne, je nachdem wo die Karte gerade stand.
  async function lookupStop(name) {
    const key = normStopName(name);
    if (!key) return null;
    if (geoCache.has(key)) return geoCache.get(key);
    let hit = null;
    try {
      const res = await timedFetch(`${API_GEOCODE}?text=${encodeURIComponent(name)}&type=STOP`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        const arr = Array.isArray(data) ? data : (data.results || []);
        const stops = arr.filter(x => x && x.type === 'STOP' && x.id && x.lat != null);
        const same = stops.filter(x => normStopName(x.name) === key);   // erst gleicher Name
        const pool = same.length ? same : stops;                        // sonst irgendetwas Nahes am Namen
        hit = pool.find(x => stationLevel(x.id)) || pool[0] || null;    // Stationshalt schlägt Steig
      }
    } catch (_) { /* dann bleibt die Karte eben ohne Abfahrten */ }
    geoCache.set(key, hit);
    return hit;
  }

  async function openStation(stop, refreshing, instant) {
    const el = document.getElementById('popup');
    if (!el || !stop) return;
    const seq = ++popupSeq;
    clearTimeout(popupTimer); popupTimer = null;
    if (!refreshing) {
      stop = resolveStop(stop);             // Kennung/Position aus dem Feed nachziehen, falls vorhanden
      popupVehicle = null; popupLeg = null; popupDepartures = null;
      popupChain = null; chainCache = [];   // Haltestellenkarte: keine Linienlänge anzeigen
      popupStation = stop; popupAnchor = [stop.lon, stop.lat];
      ctx.map.easeTo({ center: [stop.lon, stop.lat], zoom: Math.max(ctx.map.getZoom(), 15.6),
                       duration: instant ? 0 : 600 });     // aus der Fahrzeugkarte: sofort dorthin
      el.classList.add('on');
      paintStation(true);
      if (!stop.stopId) {                   // Ausschnitt kennt den Halt nicht -> Namen nachschlagen
        lookupStop(stop.name).then(found => {
          if (!found || popupStation !== stop) return;             // inzwischen etwas anderes angeklickt
          openStation({ name: found.name || stop.name, lat: found.lat, lon: found.lon,
                        stopId: found.id, modes: stop.modes || [] }, true);
        });
      }
    } else {
      popupStation = stop; popupAnchor = [stop.lon, stop.lat];
    }
    if (!stop.stopId) {                 // Halt ohne Kennung (z. B. aus Fahrtdaten) -> Karte ohne Abfahrten
      popupDepartures = [];
      paintStation(false);
      popupTimer = setTimeout(popupTick, POPUP_REFRESH_MS);
      return;
    }
    try {
      const res = await timedFetch(`${API_STOPTIMES}?stopId=${encodeURIComponent(stop.stopId)}&n=4`, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (seq !== popupSeq || !popupStation) return;
      popupDepartures = (json && Array.isArray(json.stopTimes) ? json.stopTimes : [])
        .filter(e => e && e.place && e.place.departure);
    } catch (err) {
      if (seq !== popupSeq || !popupStation) return;
      if (!refreshing) popupDepartures = { error: (err && err.message) || 'error' };   // alte Liste behalten
    }
    if (seq !== popupSeq || !popupStation) return;
    paintStation(false);
    popupTimer = setTimeout(popupTick, POPUP_REFRESH_MS);
  }

  function paintPopup(loading) {
    const el = document.getElementById('popup');
    if (!el || !popupVehicle) return;
    const list = el.querySelector('.pop-stops');
    const scroll = (list && list.scrollTop) || 0, outer = el.scrollTop || 0;
    el.innerHTML = popupShell(popupVehicle, popupLeg, loading);
    const btn = el.querySelector('.pop-close');
    if (btn) btn.onclick = closePopup;
    const nl = el.querySelector('.pop-stops');           // Scrollposition beim Auffrischen behalten
    if (nl) nl.scrollTop = scroll;
    el.scrollTop = outer;
    el.querySelectorAll('li.st-go[data-i]').forEach(li => {   // Halte in der Fahrzeugkarte sind anklickbar
      li.onclick = e => { e.stopPropagation(); goToStop(+li.dataset.i); };
    });
    initDrag(el);                                        // Karte ist ziehbar
    placePopup(true);                                    // neue Höhe -> sofort neu ausrichten
  }

  // Popup öffnen (refresh=false) oder auffrischen (refresh=true: keine "lädt"-Anzeige, Scroll bleibt).
  // Jede Anfrage bekommt eine laufende Nummer; Antworten für ein inzwischen geschlossenes oder
  // gewechseltes Popup werden verworfen und setzen keinen neuen Timer.
  async function openPopup(v, refreshing) {
    const el = document.getElementById('popup');
    if (!el || !v) return;
    const seq = ++popupSeq;
    clearTimeout(popupTimer); popupTimer = null;
    if (!refreshing) {                       // Fahrzeugkarte ersetzt eine eventuell offene Haltestellenkarte
      popupVehicle = v; popupLeg = null;
      popupStation = null; popupAnchor = null; popupDepartures = null;
    }
    else {                                   // aktuellen Datensatz der Fahrt übernehmen (Verspätung ändert sich)
      const fresh = drawn.find(x => x.tripId === v.tripId);
      if (fresh) popupVehicle = fresh;
    }
    el.classList.add('on');
    paintPopup(!refreshing && !isOp(v));
    // Betreiberfahrzeug: es gibt keine Fahrt im offenen Strom, also keinen Fahrtabruf, keine Halte und
    // keine Linienlänge. Die Karte wird nur häufiger neu beschriftet, damit das Alter der Meldung stimmt.
    if (isOp(v)) {
      // Betreiberfahrzeug: keine Fahrt im offenen Strom. Karte sofort zeigen und die Linie samt Halten
      // nachreichen (nur Namen) — dieselbe Linienlänge, die die Prognosepillen zeichnen.
      popupLeg = { operator: true, loading: true };
      popupChain = null; chainCache = [];
      const mine = v.tripId;
      opTripFor(v).then(leg => {
        if (seq !== popupSeq || !popupVehicle || !isOp(popupVehicle) || popupVehicle.tripId !== mine) return;
        popupLeg = { operator: true, loading: false };
        if (leg) {
          popupLeg.stops = legStopsAhead(leg, v, CARD_STOPS);
          popupLeg.chain = tripChain(leg);
          popupChain = popupLeg.chain;
          chainCache = popupChain ? [popupChain] : [];
        }
        paintPopup(false);
      }).catch(() => { /* ohne Linie weiter, die Karte bleibt */ });
      paintPopup(false);
      popupTimer = setTimeout(popupTick, OP_CARD_MS);
      return;
    }
    let leg;
    try {
      const res = await timedFetch(`${API_TRIP}?tripId=${encodeURIComponent(v.tripId)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      leg = pickLeg(await res.json(), v) || { error: 'noLegs' };
    } catch (err) {
      leg = { error: (err && err.message) || 'error' };
    }
    // Achtung: eine verspätete Antwort darf die Linie NICHT zeichnen. Vorher wurden popupChain und
    // chainCache vor der Prüfung auf popupSeq gesetzt — eine Antwort für eine schon geschlossene
    // oder ersetzte Karte hinterließ einen Geisterzug auf der Karte.
    if (seq !== popupSeq || !popupVehicle) return;     // veraltet: Popup zu oder anderes Fahrzeug
    // Volle Länge der Linie: alle Halte dieser Fahrt in Reihenfolge, auch die schon durchfahrenen.
    // Nur bei brauchbarer Antwort neu setzen — ein Aussetzer behält Liste und Linie.
    if (!(refreshing && leg.error && popupLeg && !popupLeg.error)) {
      popupLeg = leg;
      popupChain = tripChain(leg);
      chainCache = popupChain ? [popupChain] : [];
    }
    paintPopup(false);
    popupTimer = setTimeout(popupTick, POPUP_REFRESH_MS);
  }

  function popupTick() {
    popupTimer = null;
    if (document.hidden) { popupTimer = setTimeout(popupTick, POPUP_REFRESH_MS); return; }
    if (popupStation && active) { openStation(popupStation, true); return; }   // Abfahrten auffrischen
    if (!popupVehicle || !active) return;
    openPopup(popupVehicle, true);
  }

  function closePopup() {
    popupSeq++;                              // laufende Antworten verwerfen
    popupVehicle = null; popupLeg = null; popupPos = null;
    popupChain = null; chainCache = [];
    popupStation = null; popupAnchor = null; popupDepartures = null;
    clearTimeout(popupTimer); popupTimer = null;
    const el = document.getElementById('popup');
    if (el) { el.classList.remove('on'); el.innerHTML = ''; el.style.left = ''; el.style.top = ''; }
  }

  // ---------- Statistik
  function paintStats(cur) {
    if (!ctx) return;
    const counts = { tram: 0, bus: 0, rail: 0 };
    let onTime = 0, late = 0, early = 0;
    for (const c of cur) {
      if (ctx.state.modes[c.v.mode]) counts[c.v.mode]++;
      if (!ctx.state.modes[c.v.mode] || c.v.delayMin === null) continue;   // gleiche Basis wie die Gesamtzahl
      if (c.v.delayMin >= 1) late++;
      else if (c.v.delayMin <= -1) early++;
      else onTime++;
    }
    for (const m in counts) {
      const el = document.getElementById('n-' + m);
      if (el) el.textContent = counts[m];
    }
    const total = cur.filter(c => ctx.state.modes[c.v.mode]).length;
    const meta = document.getElementById('livestat');
    if (meta) {
      meta.innerHTML = `<b>${total}</b> ${esc(T('vehicles'))} · ` +
        `<span style="color:#78dca0">${onTime} ${esc(T('onTime'))}</span> · ` +
        `<span style="color:var(--accent)">${late} ${esc(T('delayed'))}</span> · ` +
        `<span style="color:#8ecbff">${early} ${esc(T('early'))}</span>`;
    }
  }


  // Frischezustand der Daten: frisch / veraltet / überholt. Er steuert das Badge und die Statuszeile
  // und ist die einzige Stelle, an der "Echtzeit" ehrlich werden kann. Reine Rechnung (testbar).
  function freshness(age) {
    if (age === null) return 'waiting';
    if (age > EXPIRED_MS) return 'expired';
    if (age > STALE_MS) return 'stale';
    return 'fresh';
  }

  function updateStat() {
    const el = document.getElementById('livestat2');
    const age = lastOk ? Math.round((Date.now() - lastOk) / 1000) : null;
    // Ein Fehlversuch zählt sofort als "nicht frisch" — sonst leuchtete das Badge während eines
    // Ausfalls weiter, als käme gerade etwas an.
    const state = failures ? (age !== null && age * 1000 > STALE_MS ? 'expired' : 'stale') : freshness(age !== null ? age * 1000 : null);
    const badge = document.getElementById('livebadge');
    if (badge && badge.dataset) badge.dataset.state = state;
    if (!el) return;
    // Herkunft auch in der Statuszeile: wie viele Punkte Betreiber-GPS sind, oder dass gerade alles
    // abgeleitet ist, weil der Betreiber nicht antwortet.
    const src = !opPresent ? '' : opFallback ? ' · ' + T('statOperatorDown')
      : selCounts.operator ? ' · ' + T('statOperator', { n: selCounts.operator }) : '';
    el.textContent = age === null ? T('waiting')
      : T('fetchedAgo', { s: age }) + (state === 'expired' ? ' · ' + T('expired') : state === 'stale' ? ' · ' + T('stale') : '') +
        (failures ? ' · ' + T('failedAttempts', { n: failures }) : '') + src;
  }

  // Ein Banner, zwei Anlässe: Störung des offenen Stroms (Vorrang) oder globaler Rückfall, weil der
  // Betreiber nicht antwortet. force=true schreibt immer (wie bisher bei jedem Abruf); sonst nur bei
  // Änderung, damit kurze Hinweise aus index.html (Ortung) nicht im Bildtakt überschrieben werden.
  function paintBanner(force) {
    const msg = feedBanner || (opFallback ? T('bannerOperatorDown') : null);
    if (!force && msg === shownBanner) return;
    shownBanner = msg;
    const b = document.getElementById('banner');
    if (!b) return;
    if (!msg) { b.hidden = true; b.textContent = ''; return; }
    b.hidden = false; b.textContent = msg;
  }

  function setBanner(msg) {
    feedBanner = msg || null;
    paintBanner(true);
  }

  // ---------- Steuerung
  function start() {
    stop();
    active = true;
    if (lastOk && Date.now() - lastOk > STALE_MS) { vehicles = []; drawn = []; }   // alte Positionen nicht wieder zeigen
    const O = operatorModule();
    if (O && typeof O.start === 'function') { try { O.start(onOperatorChange); } catch (_) { /* dann ohne */ } }
    refresh();
    pollTimer = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  }

  function stop() {
    active = false;
    const O = operatorModule();
    if (O && typeof O.stop === 'function') { try { O.stop(); } catch (_) { /* egal */ } }
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    clearTimeout(popupTimer); popupTimer = null;
  }

  function scheduleRefresh(delay) {         // bei Kartenbewegung
    if (!active) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, delay);
  }

  // Wortlaut für den Hybridbetrieb: dort stehen zwei Quellen, auf der veröffentlichten Seite eine.
  // Die Schlüsselpaare liegen hier (nicht im HTML), damit die Prüfung auf i18n-Attribute im HTML
  // keine erfundenen Schlüssel sieht.
  const HYBRID_COPY = [['subtitle', 'subtitleOperator'], ['modeLive', 'modeLiveOperator'],
    ['attributionPosition', 'attributionPositionOperator'], ['welcomeBody', 'welcomeBodyOperator']];

  function activateHybridCopy() {
    if (!HYBRID_ON || typeof document === 'undefined') return false;
    document.documentElement.dataset.hybrid = '1';
    for (const pair of HYBRID_COPY) {
      document.querySelectorAll('[data-i18n="' + pair[0] + '"]')
        .forEach(el => { el.dataset.i18n = pair[1]; });
    }
    return true;
  }

  // Status je Linie für die Punkte in der Linienliste: 'gps' = mindestens ein Fahrzeug dieser Linie
  // meldet sich über den Betreiberstrom (echte GPS-Position), 'feed' = die Linie fährt, aber nur aus
  // den Echtzeit-Prognosen abgeleitet. Linien ohne Eintrag fahren gerade nicht.
  // Wichtig: über die VOLLE Liste, nicht über die Auswahl im Bildausschnitt. Rot heißt „fährt gerade
  // nicht", nicht „gerade nicht im Ausschnitt" (Korrektur des Betreibers 2026-10-15).
  function lineStatus() {
    const out = {};
    for (const k of Object.keys(coverageLines)) out[k] = 'feed';   // fährt im Stadtgebiet
    for (const i of selectedOpLines) out[i] = 'gps';               // fährt und meldet sich per GPS
    return out;
  }

  window.DarmstadtLive = {
    VERSION,
    HYBRID_ON,
    activateHybridCopy,
    lineStatus,                                 // Zustand je Linie für die Punkte in der Linienliste
    attach(context) {
      ctx = context;
      lineIndex = null;
      // Tramgleise aus dem eigenen Bestand unter die Pillen legen (data/meta.json, 399 Polylinien).
      // Die dunkle Kachel zeichnet Gleise überhaupt nicht und Nebenstraßen erst ab z13 — deshalb
      // wirkten korrekt gesetzte Bahnpillen wie über Häusern schwebend. Reine Bestandsdaten, kein
      // zusätzlicher Abruf; applyBasemap blendet die Ebene bei Satellit/Karte wieder aus.
      try { addCorridors(); } catch (_) { /* Stil noch nicht da: dann eben ohne */ }
      ctx.map.on('moveend', () => scheduleRefresh(700));
      // Der Betreiber hat Vorrang: eigene Geste beendet das Begleiten sofort
      ctx.map.on('dragstart', stopFollow);
      ctx.map.on('dragstart', () => { if (ctx.state) ctx.state.selAt = Date.now(); });   // Ruheuhr neu
      const box = ctx.map.getContainer();
      ['wheel', 'mousedown', 'touchstart'].forEach(ev => box.addEventListener(ev, stopFollow, { passive: true }));
      document.addEventListener('visibilitychange', () => {
        if (document.hidden || !active) return;
        refresh();
        const O = operatorModule();                 // auch der Betreiber pausiert im Hintergrund
        if (O && typeof O.tick === 'function') { try { O.tick(); } catch (_) { /* egal */ } }
      });
      document.addEventListener('keydown', e => { if (e.key === 'Escape' && popupVehicle) { stopFollow(); closePopup(); } });
    },
    render,
    tick() {                                // aus requestAnimationFrame
      // Die Karte/Popup folgt dem Punkt in JEDEM Frame — vorher hing sie am gedrosselten
      // Ebenen-Takt und ruckelte sichtbar in Sprüngen.
      if (popupVehicle || popupStation) placePopup(false);
      const now = Date.now();
      if (now - lastFrame < FRAME_MS) return;   // nur der Ebenen-Neuaufbau ist gedrosselt
      lastFrame = now;
      render();
    },
    refresh,
    // Beim Einschalten sofort den stadtweiten Stand holen: sonst stünden die Punkte der offenen Linien
    // bis zum ersten Takt (~15 s) fälschlich auf rot.
    setOn(on) { if (on) { start(); coveragePoll(); } else stop(); },
    // Eine Linienwahl ersetzt die Fahrzeugauswahl: sonst blieben Karte, Verbindungslinie und
    // Zug der vorher angeklickten Fahrt stehen, während die Linie hervorgehoben wird.
    clearVehicle() { stopFollow(); closePopup(); },
    setLang() {                             // nach Sprachwechsel: Statistik, Histogramm, Popup neu beschriften
      paintBanner(true);                    // Rückfall-Banner in der neuen Sprache
      if (ctx) render(true);
      if (popupVehicle) paintPopup(false);  // aus dem Zwischenspeicher, kein neuer Abruf
      else if (popupStation) paintStation(false);
    },
    closePopup,
    openPopup: v => openPopup(v, false),
    openStation: (s, instant) => openStation(s, false, instant),
    stops: () => stops,                  // für Suche/Favoriten: Halte des aktuellen Ausschnitts
    // Früher: DOM-Marken je Frame nachziehen. Die Marken sind jetzt Kartenebenen und bewegen sich mit
    // der Karte; index.html ruft das im Bildtakt weiter auf, deshalb bleibt es als leere Funktion.
    syncMarkers: () => {},
    info() {
      return {
        active, count: drawn.length, stops: stops.length, lastOk,
        // Herkunft der gezeichneten Fahrzeuge: operator = Betreiber-GPS, open = abgeleitet,
        // suppressed = abgeleitete Punkte, deren Linie im Betriebsgebiet vom Betreiber kommt.
        sources: { operator: selCounts.operator, open: selCounts.open, suppressed: selCounts.suppressed },
        coveredLines: selCounts.covered, operatorPresent: opPresent, operatorFallback: opFallback,
        banner: shownBanner,
        lastErr: lastErr ? String(lastErr.message || lastErr) : null, failures,
        polling: !!pollTimer, popupTimer: !!popupTimer,
        popupOpen: !!popupVehicle || !!popupStation,
        popupKind: popupStation ? 'station' : popupVehicle ? 'vehicle' : null,
        popupStops: popupLeg && !popupLeg.error ? nextStops(popupLeg).length : null,
        popupDepartures: Array.isArray(popupDepartures) ? popupDepartures.length
          : (popupDepartures && popupDepartures.error ? 'error' : null),
        popupError: popupLeg && popupLeg.error ? popupLeg.error : null,
      };
    },
    _test: { esc, buildVehicles, delayText, delayClass, vehiclesAt, setVehicles(v) { vehicles = v; reselect(false); }, popupShell,
             HYBRID_ON, activateHybridCopy, selectSources, opPosAt, opTripFor, legStopsAhead, opShell, opModel, opKey, lineKey, OP_ALIAS, reselect: () => reselect(true), drawn: () => drawn,
             OP_FRESH_MS, OP_HOLD_MS, OP_SCOPE_M, OP_STALE_MS, OP_MAX_AGE_MS, OP_TICK_MS, OP_REPLAY_MS, OP_PATH_END_M, OP_PATH_MAX_M, opTrack, havM, resetOperator() { opSeen = new Map(); },
             setCoverage(o) { coverageLines = o; }, coverage: () => coverageLines,
             departureRow, stationShell, freshness, focusLine, focusLineWide, CITY_BOX,
             dedupeStops, markers: () => markerLog, canvasFeatures: () => canvasLog, canvasTap,
             makeVehiclePill, pillImageId, PILL_PREFIX, SCALED_BELOW_ZOOM,
             CANVAS: { VEHICLE_SOURCE, STOP_SOURCE, VEHICLE_HIT, VEHICLE_PILLS, STOP_CIRCLES, STOP_LABELS, STOP_HIT },
             map: () => (ctx ? ctx.map : null),   // Prüfzugriff (Browser-Smoke): die Marken leben in der Karte
             syncMarkers: () => {}, decodePolyline,
             tapVehicle, tapStop,
             tripChain, chain: () => chainCache,
             goToStop, nextStops, stops: () => stops, popupStopList: () => popupStopList,
             setRelaxAt(t) { ctx.state.selAt = t; }, relaxAt: () => ctx.state.selAt, RELAX_MS,
             CARD_STOPS,
             following: () => !!followTrip, resetFollow() { followTrip = null; followUntil = 0; },
             placePopup, dragOff: () => dragOff, setDrag(d) { dragOff = d; }, leaderD: leaderD, layoutPopup },
  };
})();
