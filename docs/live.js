/* Echtzeit-Modul für "Darmstadt Live Map"
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
  const STALE_MS = 45000;          // ab wann Daten als veraltet gelten
  const NEXT_STOPS = 3;            // das Popup zeigt die nächsten drei Halte (Wunsch des Betreibers)
  const RELAX_MS = 10000;          // gewählte Linie: nach 10 s ohne Interaktion Haltestellen wieder zeigen
  // Muss mit dem APP_V in index.html übereinstimmen. GitHub Pages cached auch das HTML (max-age=600),
  // deshalb kann eine alte Seite mit neuem live.js laufen; index.html gleicht das über diese Kennung ab.
  const VERSION = '20261014-13';
  const LEG_GRACE_MS = 90000;      // so lange nach Abschnittsende bleibt ein Fahrzeug stehen (> REFRESH_MS),
                                   // danach verschwindet es, statt aus veralteten Daten "live" zu wirken
  const FRAME_MS = 33;             // ~30 Bilder/s: die Punkte sollen gleiten, nicht springen.
                                   // Die Karten-Platzierung läuft davon entkoppelt in jedem Frame (tick).

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
  let vehicles = [];
  let lastOk = 0, lastErr = null, failures = 0, lastPaint = 0;
  let pollTimer = null, refreshTimer = null, refreshInFlight = false;
  let lineIndex = null, viewBox = null;
  let stops = [];                        // Haltestellen aus dem Feed (echte Koordinaten, mit stopId)
  let popupVehicle = null, popupLeg = null, popupTimer = null, popupSeq = 0;
  let popupStation = null, popupAnchor = null, popupDepartures = null;   // Haltestellenkarte
  let popupStopList = [];                // Halte der gerade gezeigten Fahrzeugkarte (Klick-Ziele)
  let dragOff = null;                    // vom Nutzer verschobene Karte: Versatz zur Auto-Position
  let stopCache = null, stopCacheKey = '';   // zuletzt gezeichnete Haltestellen (nicht jeden Frame neu bauen)
  let lastSel = null;                    // nur für den Kamera-Schwenk bei neuer Linienwahl
  // Die Ruheuhr liegt in ctx.state.selAt: Fahrplan- und Echtzeitmodus brauchen dieselbe Regel
  // ("gewählte Linie -> nur sie; nach 10 s ohne Interaktion kommen die Haltestellen zurück").
  let active = false, lastFrame = 0;

  // API-Texte (Linien, Halte, Ziele, Betreiber, Fehlermeldungen) nie roh in innerHTML
  const esc = x => String(x == null ? '' : x).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ss = n => ctx.shortStop(String(n == null ? '' : n));
  const num = ts => { const v = Date.parse(ts); return Number.isFinite(v) ? v : NaN; };

  // ---------- Geometrie
  function decodePolyline(str) {
    if (!str) return [];
    let i = 0, lat = 0, lon = 0;
    const out = [];
    while (i < str.length) {
      for (let which = 0; which < 2; which++) {
        let r = 0, sh = 0, b;
        do { b = str.charCodeAt(i++) - 63; r |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20);
        const dv = (r & 1) ? ~(r >> 1) : (r >> 1);
        if (which === 0) lat += dv; else lon += dv;
      }
      out.push([lon * 1e-5, lat * 1e-5]);
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

  async function refresh() {
    if (refreshInFlight || !ctx || !active) return;   // nach dem Ausschalten kein Abruf mehr
    refreshInFlight = true;
    const now = Date.now();
    const t0 = new Date(now).toISOString().replace(/\.\d+Z$/, 'Z');
    const t1 = new Date(now + WINDOW_MIN * 60000).toISOString().replace(/\.\d+Z$/, 'Z');
    try {
      const bb = bboxParams();
      const [res, stopsRes] = await Promise.all([
        fetch(`${API}?${bb}&startTime=${t0}&endTime=${t1}`, { cache: 'no-store' }),
        fetch(`${API_STOPS}?${bb}`, { cache: 'no-store' }).catch(() => null),
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
        if (popupVehicle) {                      // offenes Popup am Fahrzeug halten
          const again = vehicles.find(x => x.tripId === popupVehicle.tripId);
          if (again) popupVehicle = again; else closePopup();   // Fahrt ist beendet
        }
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
      if (prev && !(running && !prev.running)) continue;      // pro Fahrt genau ein Abschnitt
      const path = decodePolyline(t.polyline);
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
      const sched = t.scheduledDeparture ? num(t.scheduledDeparture) : dep;
      const delayMin = Number.isFinite(sched) ? Math.round((dep - sched) / 60000) : null;  // null = unbekannt
      byTrip.set(tid, {
        tripId: tid, mode, running,
        lineName: String(tr.routeShortName || '?'),
        headsign: String(tr.headsign || ''),
        dest: String((t.to && t.to.name) || ''),
        fromName: String((t.from && t.from.name) || ''),
        dep, arr, delayMin, realTime: true, routeColor: t.routeColor || '',
        path, cd, total: cd[cd.length - 1],
        lineIdx: matchLine(tr.routeShortName, mode),
      });
    }
    return Array.from(byTrip.values()).filter(v => v.running);   // nur fahrende Fahrzeuge
  }

  // Der Feed liefert je Bahnsteig/Kante einen Eintrag — für die Karte genügt ein Punkt je Halt.
  function dedupeStops(raw) {
    const seen = new Map();
    for (const s of raw) {
      if (!s || typeof s.lat !== 'number' || typeof s.lon !== 'number' || !s.name) continue;
      const key = `${s.name}|${s.lat.toFixed(3)}|${s.lon.toFixed(3)}`;    // ~100 m Raster
      if (!seen.has(key)) seen.set(key, { name: s.name, stopId: s.stopId, lat: s.lat, lon: s.lon, modes: s.modes || [] });
    }
    return Array.from(seen.values());
  }

  function vehiclesAt(t) {
    const out = [];
    for (const v of vehicles) {
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
  function delayColor(d) {
    if (d === null) return [150, 155, 170];
    if (d >= 5) return [255, 90, 80];
    if (d >= 1) return [255, 209, 102];
    if (d <= -1) return [120, 220, 160];
    return [230, 235, 245];
  }

  // ---------- Betreiber-Positionen (HEAG) ----------
  // Die HEAG meldet echte Koordinaten; der offene Strom liefert nur Ableitungen aus Haltzeiten. Regel:
  // je Fahrzeug genau EIN Punkt. Findet sich ein Zwilling (gleiche Linie, nah dran), ersetzt der
  // Betreiberpunkt ihn und übernimmt dessen Verspätung — echte Position plus echte Verspätung.
  const OP_TWIN_MAX_M = 2500;      // MIT gleicher Richtung: derselbe Zug, auch ein paar Halte weiter
  const OP_TWIN_TIGHT_M = 250;     // ohne Richtungsangabe nur bei sehr großer Nähe raten
  let opLog = { merged: 0, added: 0, skipped: 0, available: 0 };   // für Tests und Diagnose
  const opPos = new Map();                               // tripId -> zuletzt gezeichnete Betreiberposition
  const metresBetween = (aLat, aLon, bLat, bLon) => {
    const dy = (aLat - bLat) * 111320, dx = (aLon - bLon) * 111320 * Math.cos(aLat * Math.PI / 180);
    return Math.sqrt(dx * dx + dy * dy);
  };
  const flat = s => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9ÄÖÜß]/g, '');
  // Zielangaben vergleichen: die HEAG nennt das Ziel, unser Abschnitt kennt Kopfschild und Endhalt.
  // Gleiche Richtung ist das, was zwei Fahrzeuge derselben Linie auseinanderhält (Gegenrichtung!).
  function sameDirection(op, v) {
    const d = flat(op.dest);
    if (!d || d.length < 3) return false;
    for (const cand of [v.headsign, v.dest]) {
      const c = flat(cand);
      if (c && c.length >= 3 && (c.includes(d) || d.includes(c))) return true;
    }
    return false;
  }

  function withOperator(cur) {
    const src = (ctx && ctx.heag && ctx.heag.list) ? ctx.heag.list() : null;
    opLog = { merged: 0, added: 0, skipped: 0, available: src ? src.length : 0 };
    opPos.clear();
    if (!src || !src.length) return cur;
    // Von der Betreiberflotte nur zeigen, was im geladenen Ausschnitt liegt. Außerhalb könnten wir nie
    // Fahrtdaten dazu haben — ein Punkt, dessen Karte nichts weiß, verwirrt mehr, als er nützt.
    const inBox = (lat, lon) => {
      if (!viewBox) return true;
      const padLat = (viewBox.n - viewBox.s) * 0.1, padLon = (viewBox.e - viewBox.w) * 0.1;
      return lat >= viewBox.s - padLat && lat <= viewBox.n + padLat &&
             lon >= viewBox.w - padLon && lon <= viewBox.e + padLon;
    };
    const out = cur.slice();
    for (const o of src) {
      const key = normLine(o.line);
      let twin = -1, best = Infinity;
      for (let i = 0; i < out.length; i++) {
        const c = out[i];
        if (c.op || !key || normLine(c.v.lineName) !== key) continue;
        const d = metresBetween(o.lat, o.lon, c.pos[1], c.pos[0]);
        if (d < best) { best = d; twin = i; }
      }
      const near = twin >= 0 ? out[twin] : null;
      let ok = false;
      if (near) {
        // Beide Seiten nennen ein Ziel -> es muss passen. Zwei Fahrzeuge derselben Linie in
        // Gegenrichtung stehen oft am selben Halt; ohne diese Prüfung hinge unsere Verspätung am
        // falschen Fahrzeug, nur weil es 50 m entfernt war.
        const ours = near.v.headsign || near.v.dest;
        if (String(o.dest || '').trim().length >= 3 && String(ours || '').trim().length >= 3) {
          ok = sameDirection(o, near.v) && best <= OP_TWIN_MAX_M;
        } else {
          ok = best <= OP_TWIN_TIGHT_M;                  // eine Seite ohne Ziel: nur bei großer Nähe
        }
      }
      if (!ok) twin = -1;                                  // nicht raten, wenn Richtung und Nähe fehlen
      const base = ok ? out[twin].v : null;
      if (!base && !inBox(o.lat, o.lon)) { opLog.skipped++; continue; }
      if (ok) out.splice(twin, 1);                         // Zwilling raus: eine Quelle je Fahrzeug
      const mode = (base && base.mode) || o.mode || 'bus';
      const trip = base ? base.tripId
                        : 'heag:' + (o.vehicleId == null ? o.line + ':' + o.lat : o.vehicleId);
      opPos.set(trip, [o.lon, o.lat]);
      out.push({
        op: true, bearing: o.bearing,
        pos: [o.lon, o.lat],
        rest: [],
        v: base ? Object.assign({}, base, { op: true, opId: o.vehicleId, opAt: o.at })
                : {
                    tripId: trip,
                    op: true, opId: o.vehicleId, opAt: o.at, opOnly: true,
                    mode, lineName: o.line || '?', headsign: o.dest || '', dest: o.dest || '',
                    fromName: '', delayMin: null, realTime: true, routeColor: '',
                    dep: 0, arr: 0, path: null, cd: null, total: 0,
                    lineIdx: matchLine(o.line, mode),
                  },
      });
      if (base) opLog.merged++; else opLog.added++;
    }
    return out;
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
    const sel = ctx.state.selLine;
    const cur = withOperator(vehiclesAt(t));
    // Angeklicktes Fahrzeug dauerhaft markieren, damit der Punkt auch nach dem Kamera-Follow zu finden ist
    const focusTrip = popupVehicle ? popupVehicle.tripId : null;
    const focus = focusTrip ? cur.find(c => c.v.tripId === focusTrip) : null;

    // Die Auswahl bestimmt, was zu sehen ist:
    //   Linie im Panel gewählt -> nur diese Linie, keine Haltestellen (nach 10 s Ruhe kommen sie zurück)
    //   Fahrzeug gewählt       -> dieses Fahrzeug samt seinen eigenen nächsten Halten
    //   nichts gewählt         -> alles
    const relaxed = sel !== null && Date.now() - (ctx.state.selAt || 0) > RELAX_MS;   // 10 s Ruhe
    if (sel !== lastSel) {                 // neue Linie gewählt -> Kamera gleich zu ihren Fahrzeugen
      lastSel = sel;
      if (sel !== null && !focusTrip) focusLine(sel, cur);
    }
    const inMode = c => ctx.state.modes[c.v.mode];
    const vis = sel !== null ? cur.filter(c => inMode(c) && c.v.lineIdx === sel) : cur.filter(inMode);
    const dim = v => (focusTrip ? v.tripId !== focusTrip : false);
    // Gedämpft statt fast unsichtbar: alpha 45 ließ alle anderen Punkte über der dunklen Karte wie
    // blasse weiße Geister wirken (auf dem Telefon als „da läuft ein weißer Punkt" gemeldet).
    const alpha = v => (dim(v) ? 130 : 255);
    // Bei gewähltem Fahrzeug nur dessen eigene Halte zeigen (nicht das ganze Netz)
    // Nur neu berechnen, wenn sich wirklich etwas geändert hat: sonst schiebt deck.gl die
    // Haltestellen-Ebene 30-mal pro Sekunde neu hoch, obwohl sie still steht (spürbare Last).
    const stopKey = `${focusTrip || ''}|${sel}|${relaxed ? 1 : 0}|${(popupStopList || []).length}|${stops.length}`;
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
      // Trefferfläche für Halte: unsichtbar, aber großzügig — die sichtbaren Punkte sind nur ~2 px,
      // und deck.gl prüft die Geometrie, nicht die Deckkraft. So trifft man den Halt auch mit dem Finger.
      new ctx.deck.ScatterplotLayer({
        id: 'live-stations-hit', data: shownStops, getPosition: d => [d.lon, d.lat],
        getRadius: 11, radiusUnits: 'pixels', radiusMinPixels: 11,
        getFillColor: [0, 0, 0, 1], pickable: true,
      }),
      new ctx.deck.ScatterplotLayer({          // Haltestellen: Positionen direkt aus dem Feed
        id: 'live-stations', data: shownStops, getPosition: d => [d.lon, d.lat],
        getRadius: d => (d.focus ? 4.5 : 2.6), radiusUnits: 'pixels', pickable: false, radiusMinPixels: 2.6,
        stroked: true, getLineColor: d => (d.focus ? [255, 255, 255, 240] : [236, 241, 252, 170]),
        getLineWidth: d => (d.focus ? 1.8 : 0.8), lineWidthUnits: 'pixels',
        getFillColor: d => (d.focus ? [255, 255, 255, 235] : [216, 223, 240, 215]),
        updateTriggers: { getRadius: focusTrip, getFillColor: focusTrip, getLineColor: focusTrip, getLineWidth: focusTrip },
      }),
      new ctx.deck.PathLayer({
        id: 'live-trails', data: vis, getPath: d => d.rest,
        getColor: d => { const c = colorFor(d.v); return [...c, dim(d.v) ? 25 : 90]; },
        widthUnits: 'pixels', getWidth: 2, capRounded: true, jointRounded: true,
        updateTriggers: { getPath: t, getColor: sel },
      }),
      new ctx.deck.ScatterplotLayer({
        id: 'live-heads', data: vis, getPosition: d => d.pos,
        // Größe: mit dem Finger trifft man sie so ohne Zoomen (die Trefferfläche von deck.gl folgt
        // dem Radius). Etwas kleiner als die erste Fassung — sie stand zu dick über der Karte.
        getRadius: d => (focusTrip && d.v.tripId === focusTrip ? 11 : (d.v.mode === 'bus' ? 6.5 : 7.5)), radiusUnits: 'pixels',
        getFillColor: d => { const c = colorFor(d.v); return [...c, alpha(d.v)]; },
        // Der Rand trägt die Verspätungsfarbe. Beim gewählten Fahrzeug stattdessen die Akzentfarbe:
        // der Rand war vorher fast weiß (delayColor liefert für „pünktlich/unbekannt" 230,235,245) und
        // ließ den angetippten Punkt auf dem Telefon wie einen weißen Klumpen aussehen.
        stroked: true,
        getLineColor: d => (focusTrip && d.v.tripId === focusTrip ? [255, 209, 102, 255]
                            : [...delayColor(d.v.delayMin), dim(d.v) ? 30 : 235]),
        getLineWidth: d => (focusTrip && d.v.tripId === focusTrip ? 2.2 : (Math.abs(d.v.delayMin) >= 1 ? 2.2 : 1.4)), lineWidthUnits: 'pixels',
        pickable: true, radiusMinPixels: 5,
        updateTriggers: { getPosition: t, getFillColor: sel, getLineColor: [sel, focusTrip], getRadius: focusTrip, getLineWidth: focusTrip },
      }),
      focus ? new ctx.deck.ScatterplotLayer({    // Ring um das angeklickte Fahrzeug
        id: 'live-focus', data: [focus], getPosition: d => d.pos,
        // Nur etwas größer als der Punkt selbst und in der Akzentfarbe statt Weiß: der Ring soll zeigen
        // „dieser Punkt ist gewählt", nicht wie ein zweiter weißer Punkt daneben aussehen.
        getRadius: 13 + 4 * Math.abs(Math.sin(t / 430)), radiusUnits: 'pixels', radiusMinPixels: 12,
        stroked: true, filled: false, getLineColor: [255, 209, 102, 240], getLineWidth: 2, lineWidthUnits: 'pixels',
        pickable: false,
        updateTriggers: { getPosition: t, getRadius: t },
      }) : null,
    ].filter(Boolean);
    ctx.overlay.setProps({ layers, onHover: hover, onClick: click, getCursor: cursor });
    if (force || Date.now() - lastPaint > 1000) {     // Statistik nur ~1x je Sekunde neu zeichnen
      lastPaint = Date.now();
      paintStats(cur);
      paintHistogram(cur);
      updateStat();
      const cl = document.getElementById('clock');    // im Live-Modus zeigt die Uhr die echte Uhrzeit
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
    tip.innerHTML = `<b>${esc(v.lineName)}</b> → ${esc(ss(v.headsign || v.dest))}<br>` +
      `<span style="color:var(--muted)">${esc(delayText(v.delayMin))} · ${esc(T('popup.realtime'))}</span>`;
    tip.style.display = 'block';
    tip.style.left = info.x + 14 + 'px'; tip.style.top = info.y + 14 + 'px';
  }

  function click(info) {
    if (ctx.state) ctx.state.selAt = Date.now();          // Interaktion -> Ruheuhr neu starten
    if (ctx.hidePanel) ctx.hidePanel();                   // Telefon: Panel aus dem Weg räumen
    const o = info.object;
    if (o && o.v) { startFollow(o.v); openPopup(o.v); return; }   // Fahrzeug: Kamera mitnehmen + Karte
    if (o && o.stopId) {                                          // Haltestelle: Kamera hin + Abfahrten
      openStation(o);
      announceStation(o);
      return;
    }
    stopFollow(); closePopup();                                   // Tipp auf die Karte schließt
    // Auswahl aufheben: erst dann erscheinen wieder alle Haltestellen
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

  const cursor = ({ isHovering }) => (isHovering ? 'pointer' : 'grab');

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

  function nextStops(leg) {
    const now = Date.now();
    const seq = [];
    if (leg.from) seq.push({ name: leg.from.name, time: leg.startTime, sched: leg.scheduledStartTime, stop: leg.from });
    (leg.intermediateStops || []).forEach(s => seq.push({
      name: s.name, time: s.departure || s.arrival,
      sched: s.scheduledDeparture || s.scheduledArrival, cancelled: s.cancelled, stop: s,
    }));
    if (leg.to) seq.push({ name: leg.to.name, time: leg.endTime, sched: leg.scheduledEndTime, stop: leg.to });
    return seq
      .filter(s => s.time && num(s.time) >= now - 45000)
      .slice(0, NEXT_STOPS)
      .map(s => {
        const tm = num(s.time), sc = s.sched ? num(s.sched) : tm;
        return {
          name: ss(s.name), time: tm, full: s.name,       // vollständiger Name für den Sprung zum Halt
          // Die Halte der Fahrt bringen Koordinaten und ihre Kennung mit -> direkt dorthin springen
          lat: s.stop && Number.isFinite(s.stop.lat) ? s.stop.lat : null,
          lon: s.stop && Number.isFinite(s.stop.lon) ? s.stop.lon : null,
          stopId: (s.stop && s.stop.stopId) || null,
          delay: Number.isFinite(sc) ? Math.round((tm - sc) / 60000) : null,
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
    };
  }

  function popupShell(v, leg, loading) {
    const stops = leg && !leg.error ? nextStops(leg) : null;
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
    const body = v.opOnly
      ? `<div class="pop-sub">${esc(T('popup.operatorOnly'))}</div>` +
        (v.opAt ? `<div class="pop-sub">${esc(T('updatedAgo', { s: Math.max(0, Math.round((Date.now() - v.opAt) / 1000)) }))}</div>` : '')
      : leg && leg.error
      ? `<div class="pop-sub pop-err">${esc(failMsg)}</div>`
      : loading
        ? `<div class="pop-sub">${esc(T('popup.loading'))}</div>`
        : `<ul class="pop-stops">${rows || `<li><span class="st-name">${esc(T('popup.noStops'))}</span></li>`}</ul>`;
    // Herkunft der Position: vom Betreiber gemeldet oder von uns aus Haltzeiten abgeleitet. Beides
    // gelb und fett, damit die Einordnung nicht im Kleingedruckten verschwindet.
    const note = v.op ? T('popup.positionOperator') : T('popup.positionNote');
    return `
      <div class="pop-head">
        <span class="pop-line" style="background:${cssColor(v)}">${esc(v.lineName)}</span>
        <span class="pop-title">${v.opOnly ? esc(ss(v.headsign || v.dest))
          : esc(T('popup.nextStops')) + ' → ' + esc(ss(v.headsign || v.dest))}</span>
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
    // Betreiberpunkte liegen nicht auf unserer abgeleiteten Linie: dann der zuletzt GEZEICHNETEN
    // Position folgen, sonst zieht die Kamera an einer Stelle, an der der Punkt nicht ist.
    const op = opPos.get(followTrip);
    if (op) {
      ctx.map.easeTo({ center: op, zoom: Math.max(ctx.map.getZoom(), FOLLOW_ZOOM),
                       duration: FRAME_MS, easing: t => t });
      return;
    }
    const v = vehicles.find(x => x.tripId === followTrip) || (popupVehicle && popupVehicle.tripId === followTrip ? popupVehicle : null);
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
    if (!v || !v.path || !v.cd || !(v.arr > v.dep)) return null;
    const u = Math.min(1, Math.max(0, (t - v.dep) / (v.arr - v.dep)));
    return posAt(v.path, v.cd)(u * v.total);
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
  function focusLine(idx, list) {
    if (!ctx.map.fitBounds || !window.maplibregl) return;
    const pts = (list || vehiclesAt(Date.now())).filter(d => d.v.lineIdx === idx).map(d => [d.v.lon, d.v.lat]);
    if (!pts.length) return;
    try {
      const b = new window.maplibregl.LngLatBounds(pts[0], pts[0]);
      for (const p of pts) b.extend(p);
      ctx.map.fitBounds(b, { padding: 72, maxZoom: 14.5, duration: 650 });
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
    const dep = Date.parse(e.place.departure);
    const sched = e.place.scheduledDeparture ? Date.parse(e.place.scheduledDeparture) : dep;
    const delay = Number.isFinite(sched) ? Math.round((dep - sched) / 60000) : null;
    const inMin = Math.round((dep - Date.now()) / 60000);
    const line = String(e.routeShortName || '?').replace(/\s*\(.*?\)/, '');
    const col = /^[0-9a-fA-F]{6}$/.test(String(e.routeColor || '')) ? '#' + e.routeColor : '#8a90a0';
    const rel = inMin >= 0 && inMin <= 90 ? (inMin <= 0 ? T('popup.stopNow') : T('popup.inMin', { n: inMin })) : '';
    return `<li><span class="st-line" style="background:${esc(col)}">${esc(line)}</span>` +
      `<span class="st-name">${esc(ss(e.headsign || ''))}</span>` +
      `${rel ? `<span class="st-rel">${esc(rel)}</span>` : ''}` +
      `<span class="st-clock">${clock(dep)}</span>` +
      `<span class="st-dly ${delay === null ? 'unknown' : delayClass(delay)}">${delay === null || delay === 0 ? '·' : delay > 0 ? '+' + delay : delay}</span></li>`;
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
      const res = await fetch(`${API_GEOCODE}?text=${encodeURIComponent(name)}&type=STOP`, { cache: 'no-store' });
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
      const res = await fetch(`${API_STOPTIMES}?stopId=${encodeURIComponent(stop.stopId)}&n=4`, { cache: 'no-store' });
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
      const fresh = vehicles.find(x => x.tripId === v.tripId);
      if (fresh) popupVehicle = fresh;
    }
    el.classList.add('on');
    paintPopup(!refreshing);
    let leg;
    if (v.opOnly) {
      leg = { operator: true };            // nur der Betreiberpunkt: der offene Strom kennt keine Fahrt
    } else try {
      const res = await fetch(`${API_TRIP}?tripId=${encodeURIComponent(v.tripId)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      leg = pickLeg(await res.json(), v) || { error: 'noLegs' };
    } catch (err) {
      leg = { error: (err && err.message) || 'error' };
    }
    if (v.opOnly) {                          // Betreiberpunkt: kein Fahrtabruf, kein Auffrisch-Timer
      if (seq !== popupSeq || !popupVehicle) return;
      popupLeg = leg;
      paintPopup(false);
      popupTimer = setTimeout(popupTick, POPUP_REFRESH_MS);
      return;
    }
    if (seq !== popupSeq || !popupVehicle) return;     // veraltet: Popup zu oder anderes Fahrzeug
    if (!(refreshing && leg.error && popupLeg && !popupLeg.error)) popupLeg = leg;  // Aussetzer: alte Liste behalten
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

  // Verspätungsverteilung auf der Zeitleisten-Canvas (Echtzeit-Modus)
  function paintHistogram(cur) {
    const cv = document.getElementById('tl');
    if (!cv || !ctx) return;
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const vis = cur.filter(x => ctx.state.modes[x.v.mode] && x.v.delayMin !== null);
    if (!vis.length) {
      c.fillStyle = '#8a90a0'; c.font = '11px system-ui';
      c.fillText(T('noData'), 4, 24);
      return;
    }
    const BIN = 2, bins = new Map();
    for (const x of vis) {
      const k = Math.max(-6, Math.min(20, Math.round(x.v.delayMin / BIN) * BIN));
      bins.set(k, (bins.get(k) || 0) + 1);
    }
    const keys = Array.from(bins.keys()).sort((a, b) => a - b);
    const max = Math.max(...bins.values());
    const bw = w / keys.length, top = 14, H = h - top;
    keys.forEach((k, i) => {
      const bh = bins.get(k) / max * H;
      c.fillStyle = k >= 5 ? 'rgba(255,90,80,.75)' : k >= 1 ? 'rgba(255,209,102,.75)' : k <= -1 ? 'rgba(120,220,160,.7)' : 'rgba(232,234,240,.55)';
      c.fillRect(i * bw + 1, h - bh, Math.max(1, bw - 2), bh);
      if (keys.length <= 14) {
        c.fillStyle = '#8a90a0'; c.font = '10px system-ui';
        c.fillText(k > 0 ? '+' + k : String(k), i * bw + 2, 10);
      }
    });
    c.fillStyle = '#8a90a0'; c.font = '10px system-ui';
    c.fillText(T('delayHistogram'), Math.max(4, w - 260), 10);
  }

  function updateStat() {
    const el = document.getElementById('livestat2');
    if (!el) return;
    const age = lastOk ? Math.round((Date.now() - lastOk) / 1000) : null;
    const stale = lastOk && Date.now() - lastOk > STALE_MS;
    el.textContent = age === null ? T('waiting')
      : T('updatedAgo', { s: age }) + (stale ? ' · ' + T('stale') : '') +
        (failures ? ' · ' + T('failedAttempts', { n: failures }) : '');
  }

  function setBanner(msg) {
    const b = document.getElementById('banner');
    if (!b) return;
    if (!msg) { b.hidden = true; b.textContent = ''; return; }
    b.hidden = false; b.textContent = msg;
  }

  // ---------- Steuerung
  function start() {
    stop();
    active = true;
    if (lastOk && Date.now() - lastOk > STALE_MS) vehicles = [];   // alte Positionen nicht wieder zeigen
    refresh();
    pollTimer = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  }

  function stop() {
    active = false;
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

  window.DarmstadtLive = {
    VERSION,
    attach(context) {
      ctx = context;
      lineIndex = null;
      ctx.map.on('moveend', () => scheduleRefresh(700));
      // Der Betreiber hat Vorrang: eigene Geste beendet das Begleiten sofort
      ctx.map.on('dragstart', stopFollow);
      ctx.map.on('dragstart', () => { if (ctx.state) ctx.state.selAt = Date.now(); });   // Ruheuhr neu
      const box = ctx.map.getContainer();
      ['wheel', 'mousedown', 'touchstart'].forEach(ev => box.addEventListener(ev, stopFollow, { passive: true }));
      document.addEventListener('visibilitychange', () => { if (!document.hidden && active) refresh(); });
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
    setOn(on) { on ? start() : stop(); },
    setLang() {                             // nach Sprachwechsel: Statistik, Histogramm, Popup neu beschriften
      if (ctx) render(true);
      if (popupVehicle) paintPopup(false);  // aus dem Zwischenspeicher, kein neuer Abruf
      else if (popupStation) paintStation(false);
    },
    closePopup,
    openPopup: v => openPopup(v, false),
    openStation: (s, instant) => openStation(s, false, instant),
    stops: () => stops,                  // für Suche/Favoriten: Halte des aktuellen Ausschnitts
    info() {
      return {
        active, count: vehicles.length, stops: stops.length, lastOk,
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
    _test: { esc, buildVehicles, delayText, delayClass, vehiclesAt, setVehicles(v) { vehicles = v; }, popupShell,
             goToStop, nextStops, stops: () => stops, popupStopList: () => popupStopList,
             setRelaxAt(t) { ctx.state.selAt = t; }, relaxAt: () => ctx.state.selAt, RELAX_MS,
             following: () => !!followTrip, resetFollow() { followTrip = null; followUntil = 0; },
             placePopup, dragOff: () => dragOff, setDrag(d) { dragOff = d; }, leaderD: leaderD, layoutPopup },
  };
})();
