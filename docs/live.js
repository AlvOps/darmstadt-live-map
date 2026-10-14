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
  const REFRESH_MS = 30000;        // Abrufintervall (Positionen dazwischen lokal interpoliert)
  const POPUP_REFRESH_MS = 30000;
  const WINDOW_MIN = 1;            // Zeitfenster je Anfrage (Nutzlast-Minimum)
  const MAX_SPAN = 0.28;           // max. bbox-Kantenlänge in Grad (verhindert 422)
  const STALE_MS = 45000;          // ab wann Daten als veraltet gelten
  const NEXT_STOPS = 3;            // das Popup zeigt die nächsten drei Halte (Wunsch des Betreibers)
  const RELAX_MS = 10000;          // gewählte Linie: nach 10 s ohne Interaktion Haltestellen wieder zeigen
  const LEG_GRACE_MS = 90000;      // so lange nach Abschnittsende bleibt ein Fahrzeug stehen (> REFRESH_MS),
                                   // danach verschwindet es, statt aus veralteten Daten "live" zu wirken
  const FRAME_MS = 200;            // Live-Animation ~5 Bilder/s: spart Akku/GC auf Telefonen

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
  let relaxAt = 0, lastSel = null;       // 10-s-Ruheuhr für die Linien-Auswahl
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
      const pos = posAt(v.path, v.cd)(u * v.total);
      const idx = v.cd.findIndex(d => d >= u * v.total);
      const rest = idx < 0 ? [] : [[pos[0], pos[1]]].concat(v.path.slice(idx));
      out.push({ v, pos, rest, u });
    }
    return out;
  }

  // ---------- Darstellung
  function delayColor(d) {
    if (d === null) return [150, 155, 170];
    if (d >= 5) return [255, 90, 80];
    if (d >= 1) return [255, 209, 102];
    if (d <= -1) return [120, 220, 160];
    return [230, 235, 245];
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
    const cur = vehiclesAt(t);
    // Angeklicktes Fahrzeug dauerhaft markieren, damit der Punkt auch nach dem Kamera-Follow zu finden ist
    const focusTrip = popupVehicle ? popupVehicle.tripId : null;
    const focus = focusTrip ? cur.find(c => c.v.tripId === focusTrip) : null;

    // Die Auswahl bestimmt, was zu sehen ist:
    //   Linie im Panel gewählt -> nur diese Linie, keine Haltestellen (nach 10 s Ruhe kommen sie zurück)
    //   Fahrzeug gewählt       -> dieses Fahrzeug samt seinen eigenen nächsten Halten
    //   nichts gewählt         -> alles
    if (sel !== lastSel) {                 // Auswahl hat gewechselt -> Ruheuhr neu starten
      lastSel = sel;
      relaxAt = sel === null ? 0 : Date.now() + RELAX_MS;
    }
    const relaxed = sel !== null && relaxAt > 0 && Date.now() > relaxAt;   // 10 s nichts passiert
    const inMode = c => ctx.state.modes[c.v.mode];
    const vis = sel !== null ? cur.filter(c => inMode(c) && c.v.lineIdx === sel) : cur.filter(inMode);
    const dim = v => (focusTrip ? v.tripId !== focusTrip : false);
    const alpha = v => (dim(v) ? 45 : 255);
    // Bei gewähltem Fahrzeug nur dessen eigene Halte zeigen (nicht das ganze Netz)
    const shownStops = focusTrip
      ? (popupStopList || [])
          .filter(s => s.lat !== null && s.lon !== null)
          .map(s => ({ name: s.name, lat: s.lat, lon: s.lon, stopId: s.stopId, focus: true }))
      : sel !== null ? (relaxed ? stops : []) : stops;

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
        autoHighlight: true, highlightColor: [255, 255, 255, 130],
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
        getRadius: d => (focusTrip && d.v.tripId === focusTrip ? 7.5 : (d.v.mode === 'bus' ? 4 : 5)), radiusUnits: 'pixels',
        getFillColor: d => { const c = colorFor(d.v); return [...c, alpha(d.v)]; },
        stroked: true, getLineColor: d => [...delayColor(d.v.delayMin), dim(d.v) ? 30 : 235],
        getLineWidth: d => (focusTrip && d.v.tripId === focusTrip ? 3 : (Math.abs(d.v.delayMin) >= 1 ? 2 : 1.2)), lineWidthUnits: 'pixels',
        pickable: true, radiusMinPixels: 3,
        updateTriggers: { getPosition: t, getFillColor: sel, getLineColor: [sel, focusTrip], getRadius: focusTrip, getLineWidth: focusTrip },
      }),
      focus ? new ctx.deck.ScatterplotLayer({    // pulsierender Ring um das angeklickte Fahrzeug
        id: 'live-focus', data: [focus], getPosition: d => d.pos,
        getRadius: 13 + 6 * Math.abs(Math.sin(t / 430)), radiusUnits: 'pixels', radiusMinPixels: 13,
        stroked: true, filled: false, getLineColor: [255, 255, 255, 240], getLineWidth: 3, lineWidthUnits: 'pixels',
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
    relaxAt = ctx.state && ctx.state.selLine !== null ? Date.now() + RELAX_MS : 0;   // Interaktion -> Uhr neu
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
    // Bevorzugt den Halt aus dem Kartenbestand (der kennt Abfahrten), sonst die Angaben der Fahrt
    const known = stops.find(x => s.stopId && x.stopId === s.stopId) ||
                  stops.find(x => normStopName(x.name) === normStopName(s.full));
    const target = known || { name: s.full || s.name, lat: s.lat, lon: s.lon, stopId: s.stopId, modes: [] };
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
    const body = leg && leg.error
      ? `<div class="pop-sub pop-err">${esc(failMsg)}</div>`
      : loading
        ? `<div class="pop-sub">${esc(T('popup.loading'))}</div>`
        : `<ul class="pop-stops">${rows || `<li><span class="st-name">${esc(T('popup.noStops'))}</span></li>`}</ul>`;
    return `
      <div class="pop-head">
        <span class="pop-line" style="background:${cssColor(v)}">${esc(v.lineName)}</span>
        <span class="pop-title">${esc(T('popup.nextStops'))} → ${esc(ss(v.headsign || v.dest))}</span>
        <button class="pop-close" aria-label="${esc(T('popup.close'))}">✕</button>
      </div>
      <div class="pop-delay ${delayClass(v.delayMin)}">${esc(delayText(v.delayMin))}</div>
      <div class="pop-sub">${esc(T('popup.realtime'))}${v.fromName ? ' · ' + esc(ss(v.fromName)) + ' → ' : ' · '}${esc(ss(v.dest))}` +
        `${leg && !leg.error && leg.agency ? ' · ' + esc(T('popup.agency')) + ': ' + esc(leg.agency) : ''}</div>
      ${body}
      <div class="pop-note">${esc(T('popup.positionNote'))}</div>`;
  }

  // ---------- Kamera begleitet das angeklickte Fahrzeug — kurz, dann gibt sie wieder frei
  const FOLLOW_MS = 2000;          // so lange folgt die Kamera dem Punkt
  const FOLLOW_ZOOM = 14.8;        // Zoomstufe, auf die beim Klick hineingegangen wird
  let followTrip = null, followUntil = 0;

  function startFollow(v) {
    if (!v) return;
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

  // Setzt das Popup neben den Punkt, hält es im Bild und zieht es weich nach (immediate = ohne Dämpfung).
  function placePopup(immediate) {
    const el = document.getElementById('popup');
    if (!el || (!popupVehicle && !popupStation) || !el.classList.contains('on')) return;
    if (!finePointer()) {                  // Telefon: Bottom-Sheet unten, keine Verfolgung
      if (el.style.left || el.style.top) { el.style.left = ''; el.style.top = ''; }
      popupPos = null;
      return;
    }
    // Fahrzeug: Punkt auf der Strecke · Haltestelle: fester Ort
    const p = popupAnchor || vehiclePosAt(popupVehicle, Date.now());
    if (!p) return;
    const pt = ctx.map.project(p);
    const w = el.offsetWidth || 240, h = el.offsetHeight || 132;
    const box = ctx.map.getContainer(), cw = box.clientWidth, ch = box.clientHeight, pad = 8;
    let x = pt.x + 18, y = pt.y - h - 12;  // bevorzugt rechts über dem Punkt
    if (x + w > cw - pad) x = Math.max(pad, pt.x - w - 18);   // sonst links daneben
    if (y < pad) y = pt.y + 18;                                // oben kein Platz -> darunter
    x = Math.max(pad, Math.min(x, cw - w - pad));
    y = Math.max(pad, Math.min(y, ch - h - pad));
    if (immediate || !popupPos) popupPos = { x, y };
    else popupPos = { x: popupPos.x + (x - popupPos.x) * 0.18,       // sanft nachziehen
                      y: popupPos.y + (y - popupPos.y) * 0.18 };
    el.style.left = Math.round(popupPos.x) + 'px';
    el.style.top = Math.round(popupPos.y) + 'px';
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

  function stationShell(stop, deps, loading) {
    const modes = (stop.modes || []).map(m => String(m).toLowerCase().replace(/_/g, ' ')).join(' · ');
    let body;
    if (deps && deps.error) body = `<div class="pop-sub">${esc(T('station.failed'))} (${esc(deps.error)})</div>`;
    else if (loading) body = `<div class="pop-sub">${esc(T('station.loading'))}</div>`;
    else if (!deps || !deps.length) body = `<div class="pop-sub">${esc(T('station.none'))}</div>`;
    else body = `<ul class="pop-stops">${deps.slice(0, 4).map(departureRow).join('')}</ul>`;
    return `
      <div class="pop-head">
        <span class="pop-title">${esc(ss(stop.name))}</span>
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
    placePopup(true);
  }

  // Öffnen (refreshing=false) oder Auffrischen (true: kein Kamerasprung, keine "lädt"-Anzeige)
  async function openStation(stop, refreshing, instant) {
    const el = document.getElementById('popup');
    if (!el || !stop) return;
    const seq = ++popupSeq;
    clearTimeout(popupTimer); popupTimer = null;
    if (!refreshing) {
      popupVehicle = null; popupLeg = null; popupDepartures = null;
      popupStation = stop; popupAnchor = [stop.lon, stop.lat];
      ctx.map.easeTo({ center: [stop.lon, stop.lat], zoom: Math.max(ctx.map.getZoom(), 15.6),
                       duration: instant ? 0 : 600 });     // aus der Fahrzeugkarte: sofort dorthin
      el.classList.add('on');
      paintStation(true);
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
    try {
      const res = await fetch(`${API_TRIP}?tripId=${encodeURIComponent(v.tripId)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      leg = pickLeg(await res.json(), v) || { error: 'noLegs' };
    } catch (err) {
      leg = { error: (err && err.message) || 'error' };
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
    attach(context) {
      ctx = context;
      lineIndex = null;
      ctx.map.on('moveend', () => scheduleRefresh(700));
      // Der Betreiber hat Vorrang: eigene Geste beendet das Begleiten sofort
      ctx.map.on('dragstart', stopFollow);
      ctx.map.on('dragstart', () => { if (ctx.state.selLine !== null) relaxAt = Date.now() + RELAX_MS; });
      const box = ctx.map.getContainer();
      ['wheel', 'mousedown', 'touchstart'].forEach(ev => box.addEventListener(ev, stopFollow, { passive: true }));
      document.addEventListener('visibilitychange', () => { if (!document.hidden && active) refresh(); });
      document.addEventListener('keydown', e => { if (e.key === 'Escape' && popupVehicle) { stopFollow(); closePopup(); } });
    },
    render,
    tick() {                                // aus requestAnimationFrame: gedrosselt
      const now = Date.now();
      if (now - lastFrame < FRAME_MS) return;
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
    openStation: s => openStation(s, false),
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
             setRelaxAt(t) { relaxAt = t; }, relaxAt: () => relaxAt },
  };
})();
