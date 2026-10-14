/* Echtzeit-Modul für "Darmstadt in Bewegung"
 *
 * Quelle: DELFI e.V. Echtzeitdaten (CC BY-SA 4.0) über den Transitous-/MOTIS-Dienst
 *         https://api.transitous.org/api/v1/map/trips   (offen, kein Schlüssel, CORS *)
 *
 * Datenmodell der API (empirisch verifiziert):
 *   Jeder Eintrag ist ein Halt-zu-Halt-Abschnitt ("hop") einer Fahrt, nicht ein Fahrzeugpunkt:
 *     from/to          Haltestellen mit lat/lon
 *     departure/arrival            Ist-Zeiten des Abschnitts (bei realTime=true)
 *     scheduledDeparture/Arrival   Soll-Zeiten
 *     polyline         Geometrie des Abschnitts; Anfang == from, Ende == to (Abweichung 0-3 m)
 *     realTime         true, wenn Ist-Zeiten vorliegen
 *     trips[0].tripId  Fahrt-Kennung; routeShortName = Linienname
 *   Es gibt KEIN Feld mit der GPS-Position. Die Position wird daher aus den Ist-Zeiten
 *   entlang der Abschnittsgeometrie interpoliert (wie es die Transitous-Karte selbst tut).
 *
 * API-Eigenheiten, die Zeit gekostet haben:
 *   - bbox-Reihenfolge ist min=lat,lon&max=lat,lon  (lon,lat liefert eine leere Liste)
 *   - zoom, startTime, endTime sind Pflicht, sonst 400
 *   - das Zeitfenster bestimmt die Nutzlast: 1 Min. ~280 KB, 30 Min. ~1.2 MB
 *     (längere Fenster liefern nur zusätzliche künftige Abschnitte)
 *   - ein zu großes bbox/zu kleiner zoom kann HTTP 422 liefern -> bbox wird geklemmt
 */
(function () {
  'use strict';

  const API = 'https://api.transitous.org/api/v1/map/trips';
  // Hinweis: Die API weist generische/default User-Agents mit HTTP 403 ab
  // ("Generic user-agent headers are not allowed, please set your own").
  // Im Browser ist der eigene UA automatisch gesetzt; eigene Skripte müssen einen setzen.
  const REFRESH_MS = 30000;       // Abrufintervall (Positionen werden dazwischen lokal interpoliert)
  const WINDOW_MIN = 1;           // Zeitfenster je Anfrage (Nutzlast-Minimum)
  const MAX_SPAN = 0.28;          // max. bbox-Kantenlänge in Grad (verhindert 422)
  const STALE_MS = 45000;         // ab wann Daten als veraltet gelten

  // API-Modus -> Modus der Karte (null = ausblenden).
  // Bewusst auf den Umfang der Fahrplan-Simulation begrenzt: kein Fernverkehr (ICE/IC),
  // keine Fernbusse (FlixBus = COACH), keine Flugzeuge/Fähren – sonst hängen Abschnitte
  // mit mehreren tausend Geometriepunkten bis Stuttgart/Nürnberg in der Karte.
  const MODE_MAP = {
    TRAM: 'tram', BUS: 'bus',
    SUBURBAN: 'rail', SUBWAY: 'rail', METRO: 'rail', REGIONAL_RAIL: 'rail',
    COACH: null, HIGHSPEED_RAIL: null, LONG_DISTANCE: null, NIGHT_RAIL: null,
    AIRPLANE: null, FERRY: null, ODM: null,
  };

  let ctx = null;            // von index.html übergeben
  let vehicles = [];
  let lastOk = 0, lastErr = null, failures = 0, lastPaint = 0;
  let pollTimer = null, refreshTimer = null, refreshInFlight = false;
  let lineIndex = null;

  // ---------- Geometrie-Helfer
  function decodePolyline(str) {
    // Google-Encoded-Polyline -> [[lon, lat], ...] (deck.gl-Reihenfolge)
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
    // kumulative Länge in Metern (gleiche Näherung wie im Rest der Seite)
    const n = path.length, out = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      const kx = 111320 * Math.cos((path[i - 1][1] + path[i][1]) / 2 * Math.PI / 180);
      out[i] = out[i - 1] + Math.hypot((path[i][0] - path[i - 1][0]) * kx, (path[i][1] - path[i - 1][1]) * 110540);
    }
    return out;
  }

  function posAt(path, cd, d) {
    // Punkt bei Streckenlänge d (Fortschritt j wird über die Aufrufe gehalten)
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
  // Liniennamen sind zwischen API und meta.json nicht identisch ("RB68 (15316)", "ICE 211"),
  // daher beide Seiten normalisieren: Kleinschreibung, Klammern/Wagen-Nummern und Leerzeichen weg,
  // führende Verkehrsmittelkürzel (S, RB, RE, ICE, N ...) entfernen.
  function normLine(name) {
    let s = String(name || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]/g, '');
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
    if (v.routeColor) {           // API liefert z. B. "ffbe3c"
      const c = String(v.routeColor).replace('#', '');
      if (c.length === 6) return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
    }
    return ctx.MODE_RGB[v.mode] || [200, 200, 200];
  }

  // ---------- Abruf
  let viewBox = null;        // zuletzt angefragter (geklemmter) Kartenausschnitt

  function bboxParams() {
    const b = ctx.map.getBounds();               // [[west,south],[east,north]]
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
    if (refreshInFlight || !ctx) return;
    refreshInFlight = true;
    const now = Date.now();
    const t0 = new Date(now).toISOString().replace(/\.\d+Z$/, 'Z');
    const t1 = new Date(now + WINDOW_MIN * 60000).toISOString().replace(/\.\d+Z$/, 'Z');
    try {
      const url = `${API}?${bboxParams()}&startTime=${t0}&endTime=${t1}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const built = buildVehicles(data);
      if (built.length || failures === 0) {     // leere Antwort nicht als Erfolg überbügeln
        vehicles = built;
        lastOk = Date.now();
      }
      lastErr = null; failures = 0;
      setBanner(null);
    } catch (err) {
      failures++;
      lastErr = err;
      setBanner(failures >= 2
        ? 'Echtzeitdaten nicht erreichbar (' + (err.message || 'Netzwerkfehler') + ') – letzte bekannte Positionen, neuer Versuch läuft.'
        : 'Echtzeitdaten: kurzer Aussetzer, neuer Versuch läuft …');
    } finally {
      refreshInFlight = false;
      updateStat();
    }
  }

  function buildVehicles(data) {
    const nowMs = Date.now();
    const byTrip = new Map();
    for (const t of data) {
      const mode = MODE_MAP[t.mode];
      if (!mode) continue;                                  // Flugzeuge, Fähren, ODM: raus
      if (!t.polyline || !t.departure || !t.arrival) continue;
      const dep = Date.parse(t.departure), arr = Date.parse(t.arrival);
      if (!(arr > dep)) continue;
      if (nowMs > arr) continue;                            // Abschnitt ist durch
      const tr = (t.trips && t.trips[0]) || {};
      const tid = tr.tripId || (t.from && t.from.stopId) + '|' + t.departure;
      const prev = byTrip.get(tid);
      // pro Fahrt nur einen Abschnitt: den gerade laufenden, sonst den nächsten
      const running = dep <= nowMs;
      if (prev && !(running && !prev.running)) continue;
      const path = decodePolyline(t.polyline);
      if (path.length < 2) continue;
      const cd = cumDist(path);
      if (!(cd[cd.length - 1] > 0)) continue;
      // Fahrzeug nur aufnehmen, wenn es im (leicht erweiterten) Kartenausschnitt steht
      if (viewBox) {
        const u = Math.min(1, Math.max(0, (nowMs - dep) / (arr - dep)));
        const p = posAt(path, cd, 0)(u * cd[cd.length - 1]);
        const padLat = (viewBox.n - viewBox.s) * 0.25, padLon = (viewBox.e - viewBox.w) * 0.25;
        if (p[1] < viewBox.s - padLat || p[1] > viewBox.n + padLat ||
            p[0] < viewBox.w - padLon || p[0] > viewBox.e + padLon) continue;
      }
      const delayMin = Math.round((dep - Date.parse(t.scheduledDeparture || t.departure)) / 60000);
      byTrip.set(tid, {
        tripId: tid, mode, running,
        lineName: tr.routeShortName || '?',
        dest: (t.to && t.to.name) || '',
        fromName: (t.from && t.from.name) || '',
        dep, arr, delayMin, realTime: !!t.realTime, routeColor: t.routeColor || '',
        path, cd, total: cd[cd.length - 1],
        lineIdx: matchLine(tr.routeShortName, mode),
      });
    }
    return Array.from(byTrip.values()).filter(v => v.running);   // nur fahrende Fahrzeuge
  }

  function vehiclesAt(t) {
    const out = [];
    for (const v of vehicles) {
      const u = Math.min(1, Math.max(0, (t - v.dep) / (v.arr - v.dep)));
      const posFn = posAt(v.path, v.cd, 0);
      const pos = posFn(u * v.total);
      const idx = v.cd.findIndex(d => d >= u * v.total);
      const rest = idx < 0 ? [] : [[pos[0], pos[1]]].concat(v.path.slice(idx));
      out.push({ v, pos, rest, u });
    }
    return out;
  }

  // ---------- Darstellung
  function delayColor(d) {
    if (d >= 5) return [255, 90, 80];      // deutlich verspätet
    if (d >= 1) return [255, 209, 102];    // leicht verspätet
    if (d <= -1) return [120, 220, 160];   // verfrüht
    return [230, 235, 245];                // pünktlich
  }

  function render(force) {
    if (!ctx) return;
    const t = Date.now();
    const sel = ctx.state.selLine;
    const cur = vehiclesAt(t);
    const alpha = v => (sel === null || v.lineIdx === sel) ? 255 : 45;
    const dim = v => (sel !== null && v.lineIdx !== sel);
    const vis = cur.filter(c => ctx.state.modes[c.v.mode]);

    const layers = [
      new ctx.deck.PathLayer({
        id: 'live-trails', data: vis, getPath: d => d.rest,
        getColor: d => { const c = colorFor(d.v); return [...c, dim(d.v) ? 25 : 90]; },
        widthUnits: 'pixels', getWidth: 2, capRounded: true, jointRounded: true,
        updateTriggers: { getPath: t, getColor: sel },
      }),
      new ctx.deck.ScatterplotLayer({
        id: 'live-heads', data: vis, getPosition: d => d.pos,
        getRadius: d => (d.v.mode === 'bus' ? 3.6 : 4.6), radiusUnits: 'pixels',
        getFillColor: d => { const c = colorFor(d.v); return [...c, alpha(d.v)]; },
        stroked: true, getLineColor: d => [...delayColor(d.v.delayMin), dim(d.v) ? 30 : 235],
        getLineWidth: d => (Math.abs(d.v.delayMin) >= 1 ? 2 : 1.2), lineWidthUnits: 'pixels',
        pickable: true,
        updateTriggers: { getPosition: t, getFillColor: sel, getLineColor: sel },
      }),
    ];
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

  function hover(info) {
    const tip = document.getElementById('tip');
    if (!info.object || !info.object.v) { tip.style.display = 'none'; return; }
    const v = info.object.v;
    const age = Math.round((Date.now() - v.dep) / 1000);
    const d = v.delayMin;
    const dtxt = d > 0 ? `+${d} min` : d < 0 ? `${d} min` : 'pünktlich';
    tip.innerHTML =
      `<b>${v.lineName}</b> → ${ctx.shortStop(v.dest)}<br>` +
      `<span style="color:var(--muted)">${v.fromName ? ctx.shortStop(v.fromName) + ' → ' : ''}` +
      `${ctx.shortStop(v.dest)} · ${dtxt} ${v.realTime ? '(Echtzeit)' : '(Soll)'}</span>` +
      `<br><span style="color:var(--muted)">Abschnitt seit ${Math.floor(age / 60)}:${String(age % 60).padStart(2, '0')} unterwegs</span>`;
    tip.style.display = 'block';
    tip.style.left = info.x + 14 + 'px'; tip.style.top = info.y + 14 + 'px';
  }

  function click(info) {
    const v = info.object && info.object.v;
    document.getElementById('tip').style.display = 'none';
    if (v) ctx.selectLine(v.lineIdx >= 0 ? v.lineIdx : null);
  }

  const cursor = ({ isHovering }) => (isHovering ? 'pointer' : 'grab');

  function paintStats(cur) {
    const counts = { tram: 0, bus: 0, rail: 0 };
    let onTime = 0, late = 0, early = 0;
    for (const c of cur) {
      if (ctx.state.modes[c.v.mode]) counts[c.v.mode]++;
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
      meta.innerHTML = `<b>${total}</b> Fahrzeuge unterwegs · ` +
        `<span style="color:#78dca0">${onTime} pünktlich</span> · ` +
        `<span style="color:var(--accent)">${late} verspätet</span> · ` +
        `<span style="color:#8a90a0">${early} verfrüht</span>`;
    }
  }

  // Verspätungsverteilung auf der Zeitleisten-Canvas (Echtzeit-Modus)
  function paintHistogram(cur) {
    const cv = document.getElementById('tl');
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const vis = cur.filter(x => ctx.state.modes[x.v.mode]);
    if (!vis.length) { c.fillStyle = '#8a90a0'; c.font = '11px system-ui'; c.fillText('keine Echtzeitdaten im Kartenausschnitt', 4, 24); return; }
    const BIN = 2;                                          // 2-Minuten-Klassen
    const bins = new Map();
    for (const x of vis) { const k = Math.max(-6, Math.min(20, Math.round(x.v.delayMin / BIN) * BIN)); bins.set(k, (bins.get(k) || 0) + 1); }
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
    c.fillText('Verspätung in Minuten (Anteil der Fahrzeuge)', w - 240, 10);
  }

  function updateStat() {
    const el = document.getElementById('livestat2');
    if (!el) return;
    const age = lastOk ? Math.round((Date.now() - lastOk) / 1000) : null;
    const stale = lastOk && Date.now() - lastOk > STALE_MS;
    el.innerHTML = age === null ? 'warte auf erste Daten …'
      : `aktualisiert vor ${age} s${stale ? ' · <span style="color:#ff5a50">veraltet</span>' : ''}` +
        (failures ? ` · ${failures} Fehlversuche` : '');
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
    refresh();
    pollTimer = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  }

  function stop() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function scheduleRefresh(delay) {         // bei Kartenbewegung
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, delay);
  }

  window.DarmstadtLive = {
    attach(context) {
      ctx = context;
      lineIndex = null;
      ctx.map.on('moveend', () => scheduleRefresh(700));
      document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    },
    render,
    tick() { render(); },
    refresh,
    setOn(on) { on ? start() : stop(); },
    info() { return { count: vehicles.length, lastOk, lastErr: lastErr ? String(lastErr.message || lastErr) : null, failures }; },
  };
})();
