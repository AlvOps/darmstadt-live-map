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
 *   Brute-Force-Scan über 50 MB (analysis/brute_coords.py: 0 Treffer) und der SIRI-ET-Struktur
 *   (Haltestellen-Prognosen). Es gibt für Darmstadt auch kein offenes SIRI-VM-Fahrzeugpositionsangebot.
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
  const REFRESH_MS = 30000;        // Abrufintervall (Positionen dazwischen lokal interpoliert)
  const POPUP_REFRESH_MS = 30000;
  const WINDOW_MIN = 1;            // Zeitfenster je Anfrage (Nutzlast-Minimum)
  const MAX_SPAN = 0.28;           // max. bbox-Kantenlänge in Grad (verhindert 422)
  const STALE_MS = 45000;          // ab wann Daten als veraltet gelten
  const NEXT_STOPS = 8;            // wie viele kommende Halte das Popup zeigt

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
  let popupVehicle = null, popupLeg = null, popupTimer = null;

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
      if (c.length === 6) return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
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
    if (refreshInFlight || !ctx) return;
    refreshInFlight = true;
    const now = Date.now();
    const t0 = new Date(now).toISOString().replace(/\.\d+Z$/, 'Z');
    const t1 = new Date(now + WINDOW_MIN * 60000).toISOString().replace(/\.\d+Z$/, 'Z');
    try {
      const res = await fetch(`${API}?${bboxParams()}&startTime=${t0}&endTime=${t1}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const built = buildVehicles(await res.json());
      if (built.length || failures === 0) {      // leere Antwort nicht als Erfolg überbügeln
        vehicles = built;
        lastOk = Date.now();
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
      const mode = MODE_MAP[t.mode];
      if (!mode) continue;
      // Nur echte Echtzeitfahrzeuge: ohne realTime wäre die Position reine Fahrplanableitung.
      if (t.realTime !== true) continue;
      if (!t.polyline || !t.departure || !t.arrival) continue;
      const dep = Date.parse(t.departure), arr = Date.parse(t.arrival);
      if (!(arr > dep)) continue;
      if (nowMs > arr) continue;                              // Abschnitt ist durch
      const tr = (t.trips && t.trips[0]) || {};
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
      const delayMin = Math.round((dep - Date.parse(t.scheduledDeparture || t.departure)) / 60000);
      byTrip.set(tid, {
        tripId: tid, mode, running,
        lineName: tr.routeShortName || '?',
        headsign: tr.headsign || '',
        dest: (t.to && t.to.name) || '',
        fromName: (t.from && t.from.name) || '',
        dep, arr, delayMin, realTime: true, routeColor: t.routeColor || '',
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
      const pos = posAt(v.path, v.cd)(u * v.total);
      const idx = v.cd.findIndex(d => d >= u * v.total);
      const rest = idx < 0 ? [] : [[pos[0], pos[1]]].concat(v.path.slice(idx));
      out.push({ v, pos, rest, u });
    }
    return out;
  }

  // ---------- Darstellung
  function delayColor(d) {
    if (d >= 5) return [255, 90, 80];
    if (d >= 1) return [255, 209, 102];
    if (d <= -1) return [120, 220, 160];
    return [230, 235, 245];
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
        getRadius: d => (d.v.mode === 'bus' ? 4 : 5), radiusUnits: 'pixels',
        getFillColor: d => { const c = colorFor(d.v); return [...c, alpha(d.v)]; },
        stroked: true, getLineColor: d => [...delayColor(d.v.delayMin), dim(d.v) ? 30 : 235],
        getLineWidth: d => (Math.abs(d.v.delayMin) >= 1 ? 2 : 1.2), lineWidthUnits: 'pixels',
        pickable: true, radiusMinPixels: 3,
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

  // Hover-Tooltip nur auf Zeigegeräten; auf Touch öffnet der Tipp das Popup.
  const finePointer = () => !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);

  function hover(info) {
    const tip = document.getElementById('tip');
    if (!tip) return;
    if (!info.object || !info.object.v || !finePointer()) { tip.style.display = 'none'; return; }
    const v = info.object.v;
    tip.innerHTML = `<b>${v.lineName}</b> → ${ctx.shortStop(v.headsign || v.dest)}<br>` +
      `<span style="color:var(--muted)">${delayText(v.delayMin)} · ${T('popup.realtime')}</span>`;
    tip.style.display = 'block';
    tip.style.left = info.x + 14 + 'px'; tip.style.top = info.y + 14 + 'px';
  }

  function click(info) {
    const v = info.object && info.object.v;
    if (v) openPopup(v);
    else closePopup();                     // Tipp auf die Karte schließt das Popup
  }

  const cursor = ({ isHovering }) => (isHovering ? 'pointer' : 'grab');

  // ---------- Popup: Linie, Verspätungsstatus, nächste Halte
  // "Verspätet · +3 Min." / "Pünktlich" / "Zu früh · −2 Min." — der Status steht als Wort vorn,
  // damit auch ohne Farbwahrnehmung eindeutig ist, ob das Fahrzeug verspätet ist.
  function delayText(d) {
    if (d >= 1) return T('popup.statusLate') + ' · ' + T('popup.delayPlus', { n: d });
    if (d <= -1) return T('popup.statusEarly') + ' · ' + T('popup.delayMinus', { n: Math.abs(d) });
    return T('popup.statusOntime');
  }

  function delayClass(d) {
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
    if (leg.from) seq.push({ name: leg.from.name, time: leg.startTime, sched: leg.scheduledStartTime });
    (leg.intermediateStops || []).forEach(s => seq.push({
      name: s.name, time: s.departure || s.arrival,
      sched: s.scheduledDeparture || s.scheduledArrival, cancelled: s.cancelled,
    }));
    if (leg.to) seq.push({ name: leg.to.name, time: leg.endTime, sched: leg.scheduledEndTime });
    return seq
      .filter(s => s.time && Date.parse(s.time) >= now - 45000)
      .slice(0, NEXT_STOPS)
      .map(s => {
        const tm = Date.parse(s.time), sc = s.sched ? Date.parse(s.sched) : tm;
        return {
          name: ctx.shortStop(s.name), time: tm,
          delay: Math.round((tm - sc) / 60000),
          inMin: Math.round((tm - now) / 60000),
          cancelled: !!s.cancelled,
        };
      });
  }

  function pickLeg(data, v) {
    const legs = (data && data.legs) || [];
    if (!legs.length) return null;
    const leg = legs.find(l => l.tripId === v.tripId)
      || legs.find(l => normLine(l.routeShortName) === normLine(v.lineName))
      || legs[0];
    return {
      agency: leg.agencyName || '', from: leg.from, to: leg.to,
      startTime: leg.startTime, endTime: leg.endTime,
      scheduledStartTime: leg.scheduledStartTime, scheduledEndTime: leg.scheduledEndTime,
      intermediateStops: leg.intermediateStops || [],
    };
  }

  function popupShell(v, leg, loading) {
    const stops = leg && !leg.error ? nextStops(leg) : null;
    const rows = stops ? stops.map(s => {
      const rel = s.inMin >= 0 && s.inMin <= 60
        ? `<span class="st-time">${s.inMin <= 0 ? T('popup.stopNow') : T('popup.inMin', { n: s.inMin })}</span>` : '';
      const d = s.delay;
      return `<li><span class="st-name">${s.name}${s.cancelled ? ' ⚠' : ''}</span>${rel}` +
        `<span class="st-time">${clock(s.time)}</span>` +
        `<span class="st-dly ${delayClass(d)}">${d > 0 ? '+' + d : d < 0 ? d : '·'}</span></li>`;
    }).join('') : '';
    const body = leg && leg.error
      ? `<div class="pop-sub">${T('popup.failed')} (${leg.error})</div>`
      : loading
        ? `<div class="pop-sub">${T('popup.loading')}</div>`
        : `<ul class="pop-stops">${rows || `<li><span class="st-name">${T('popup.noStops')}</span></li>`}</ul>`;
    return `
      <div class="pop-head">
        <span class="pop-line" style="background:${cssColor(v)}">${v.lineName}</span>
        <span class="pop-title">${T('popup.nextStops')} → ${ctx.shortStop(v.headsign || v.dest)}</span>
        <button class="pop-close" aria-label="${T('popup.close')}">✕</button>
      </div>
      <div class="pop-delay ${delayClass(v.delayMin)}">${delayText(v.delayMin)}</div>
      <div class="pop-sub">${T('popup.realtime')}${v.fromName ? ' · ' + ctx.shortStop(v.fromName) + ' → ' : ' · '}${ctx.shortStop(v.dest)}` +
        `${leg && !leg.error && leg.agency ? ' · ' + T('popup.agency') + ': ' + leg.agency : ''}</div>
      ${body}
      <div class="pop-note">${T('popup.positionNote')}</div>`;
  }

  function wirePopup(el) {
    const btn = el.querySelector('.pop-close');
    if (btn) btn.onclick = closePopup;
  }

  async function openPopup(v) {
    const el = document.getElementById('popup');
    if (!el) return;
    popupVehicle = v; popupLeg = null;
    el.classList.add('on');
    el.innerHTML = popupShell(v, null, true);
    wirePopup(el);
    try {
      const res = await fetch(`${API_TRIP}?tripId=${encodeURIComponent(v.tripId)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      popupLeg = pickLeg(await res.json(), v);
    } catch (err) {
      popupLeg = { error: err.message || 'error' };
    }
    if (popupVehicle && popupVehicle.tripId === v.tripId) {
      el.innerHTML = popupShell(v, popupLeg, false);
      wirePopup(el);
    }
    clearTimeout(popupTimer);
    popupTimer = setTimeout(() => { if (popupVehicle) openPopup(popupVehicle); }, POPUP_REFRESH_MS);
  }

  function closePopup() {
    popupVehicle = null; popupLeg = null;
    clearTimeout(popupTimer); popupTimer = null;
    const el = document.getElementById('popup');
    if (el) { el.classList.remove('on'); el.innerHTML = ''; }
  }

  // ---------- Statistik
  function paintStats(cur) {
    if (!ctx) return;
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
      meta.innerHTML = `<b>${total}</b> ${T('vehicles')} · ` +
        `<span style="color:#78dca0">${onTime} ${T('onTime')}</span> · ` +
        `<span style="color:var(--accent)">${late} ${T('delayed')}</span> · ` +
        `<span style="color:#8a90a0">${early} ${T('early')}</span>`;
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
    const vis = cur.filter(x => ctx.state.modes[x.v.mode]);
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
    setLang() {                             // nach Sprachwechsel: Statistik, Histogramm, Popup neu beschriften
      if (ctx) render(true);
      if (popupVehicle) openPopup(popupVehicle);
    },
    closePopup,
    openPopup,
    info() {
      return {
        count: vehicles.length, lastOk,
        lastErr: lastErr ? String(lastErr.message || lastErr) : null, failures,
        popupOpen: !!popupVehicle, popupStops: popupLeg && !popupLeg.error ? nextStops(popupLeg).length : null,
      };
    },
  };
})();
