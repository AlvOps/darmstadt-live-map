'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.RMV_PROXY_PORT || 8790);
const HOST = '127.0.0.1';
const ORIGINS = new Set(['http://127.0.0.1:8099', 'http://localhost:8099',
  'https://darmstadtmap.com', 'https://www.darmstadtmap.com']);   // oeffentlich ueber Funnel: nur diese Seiten
const BASE = 'https://www.rmv.de/hapi/';
const CACHE_MS = 60000;
const MAX_HOUR = 600;
const MAX_DAY = 5000;
const cache = new Map();
const calls = [];

function stripHtml(value) {
  return String(value == null ? '' : value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, ' ').trim();
}

function listAt(data, keys) {
  for (const key of keys) {
    const value = data && data[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') return [value];
  }
  return Array.isArray(data) ? data : [];
}

function dateTime(date, time) {
  if (!time) return null;
  let day = String(date || '').trim(), clock = String(time).trim();
  if (day.length === 8 && Number.isFinite(Number(day))) day = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
  if ((clock.length === 4 || clock.length === 6) && Number.isFinite(Number(clock))) {
    clock = `${clock.slice(0, 2)}:${clock.slice(2, 4)}:${clock.length === 6 ? clock.slice(4, 6) : '00'}`;
  }
  const value = day ? `${day}T${clock}` : clock;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

function textValue(value, depth = 0) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(item => textValue(item, depth + 1)).filter(Boolean).join(' ');
  if (typeof value === 'object' && depth < 4) {
    for (const key of ['text', 'Text', 'name', 'Name', 'value', 'Value', 'number', 'Number', 'content', 'Content', 'lead', 'head']) {
      if (value[key] != null) {
        const result = textValue(value[key], depth + 1);
        if (result) return result;
      }
    }
  }
  return '';
}

function messageTexts(row) {
  const raw = row.Messages || row.messages || row.Message || row.message;
  let messages = Array.isArray(raw) ? raw : [];
  if (!messages.length && raw && typeof raw === 'object') {
    const nested = listAt(raw, ['Message', 'message', 'HimMessage']);
    messages = nested.length ? nested : [raw];
  }
  return messages.map(message => stripHtml(textValue(message))).filter(Boolean);
}

function slimBoard(data) {
  const rows = listAt(data, ['Departure', 'departures', 'departure', 'items']);
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const product = row.ProductAtStop || row.productAtStop || {};
    const plannedTime = dateTime(row.date || row.Date, row.time || row.Time);
    const actualClock = row.rtTime || row.RtTime;
    const actualTime = actualClock ? dateTime(row.rtDate || row.RtDate || row.date || row.Date, actualClock) : null;
    const line = String(row.name || row.line || row.Line || '').trim();
    const direction = String(row.direction || row.Direction || '').trim();
    const plannedTrack = textValue(row.platform || row.Platform || '').trim();
    const track = textValue(row.track || row.Track || plannedTrack).trim();
    const cancelled = !!(row.cancelled || row.Cancelled || row.canceled || row.cancelledTrip);
    const lineId = String(product.lineId || product.lineID || row.lineId || '').trim();
    const messages = messageTexts(row);
    const key = [line, direction, plannedTime, actualTime, plannedTrack, track, cancelled].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ line, direction, plannedTime, actualTime, plannedTrack, track, cancelled, messages, lineId });
  }
  return { departures: out };
}

function walkMessages(root) {
  const out = [];
  const seen = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if ((value.head || value.headline || value.title) && (value.text || value.lead || value.description)) out.push(value);
    for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child);
  };
  visit(root);
  return out;
}

function slimNotices(data, lineIds) {
  const records = walkMessages(data);
  const notices = records.flatMap(record => {
    const products = Array.isArray(record.affectedProduct) ? record.affectedProduct : [];
    const targets = products.length ? products : [null];
    const headline = stripHtml(textValue(record.head || record.headline || record.title || record.lead || ''));
    const text = stripHtml(textValue(record.text || record.description || record.lead || ''));
    const validFrom = record.validFrom || record.validfrom || record.startDateTime || record.from || dateTime(record.sDate, record.sTime);
    const validUntil = record.validUntil || record.validuntil || record.endDateTime || record.to || dateTime(record.eDate, record.eTime);
    return targets.map(product => {
      const affected = product && (product.name || product.line) || record.line || record.lineName || record.name || record.lineId || record.lineID || '';
      const productLineId = product && product.lineId ? String(product.lineId) : '';
      const category = String(product && product.catOut || '').toLowerCase();
      const mode = category.includes('tram') ? 'tram' : category.includes('bus') ? 'bus'
        : category.includes('rail') || category.includes('train') ? 'rail' : '';
      return {
        id: String(record.id || record.ID || ''),
        line: stripHtml(textValue(affected)),
        mode,
        headline,
        text,
        validFrom,
        validUntil,
        lineIds: productLineId ? [productLineId] : lineIds,
      };
    });
  }).filter(item => item.headline || item.text);
  const unique = new Map();
  for (const item of notices) {
    const key = [item.id, item.line, item.headline, item.text, item.validFrom].join('|');
    if (!unique.has(key)) unique.set(key, item);
  }
  return { notices: Array.from(unique.values()).sort((a, b) => Date.parse(b.validFrom || 0) - Date.parse(a.validFrom || 0)) };
}

function readAccessId() {
  const file = path.join(os.homedir(), '.config', 'rmv', 'accessId');
  let key = '';
  try { key = fs.readFileSync(file, 'utf8').trim(); } catch (_) {}
  if (!key) throw new Error('RMV accessId is missing; configure ~/.config/rmv/accessId first.');
  return key;
}

function usage(now = Date.now(), log = calls) {
  while (log.length && log[0] < now - 86400000) log.shift();
  const hour = log.filter(t => t > now - 3600000).length;
  const todayStart = new Date(now); todayStart.setUTCHours(0, 0, 0, 0);
  const day = log.filter(t => t >= todayStart.getTime()).length;
  return { hour, day };
}

function requestUpstream(key, endpoint, params) {
  const url = new URL(endpoint, BASE);
  url.searchParams.set('accessId', key);
  url.searchParams.set('format', 'json');
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'darmstadt-live-map/1.0' } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`RMV HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (_) { reject(new Error(`RMV returned invalid JSON (${res.headers['content-type'] || 'unknown content type'})`)); }
      });
    });
    req.setTimeout(12000, () => req.destroy(new Error('RMV request timed out')));
    req.on('error', () => reject(new Error('RMV request failed')));
  });
}

function createServer(key, options = {}) {
  const upstream = options.upstream || requestUpstream;
  const serverCache = options.cache || cache;
  const callLog = options.calls || calls;
  const send = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(text);
  };
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    let url;
    try { url = new URL(req.url, `http://${HOST}:${PORT}`); } catch (_) { send(res, 400, { error: 'bad request' }); return; }
    if (req.method !== 'GET') { send(res, 405, { error: 'method not allowed' }); return; }
    if (url.pathname === '/health') {
      const u = usage(Date.now(), callLog);
      send(res, 200, { ok: true, upstreamCallsHour: u.hour, upstreamCallsDay: u.day, cacheEntries: serverCache.size });
      return;
    }

    let endpoint, params, makeResult;
    if (url.pathname === '/board') {
      const stop = (url.searchParams.get('stop') || '').trim();
      if (!/^\d+$/.test(stop)) { send(res, 400, { error: 'stop must be an RMV external id' }); return; }
      const duration = Math.max(1, Math.min(120, Number(url.searchParams.get('duration') || 60) || 60));
      endpoint = 'departureBoard'; params = { id: stop, duration };
      makeResult = slimBoard;
    } else if (url.pathname === '/notices') {
      const lineIds = Array.from(new Set((url.searchParams.get('lineIds') || '').split('|').map(x => x.trim()).filter(Boolean)));
      if (!lineIds.length || lineIds.length > 50 || lineIds.some(id => !/^de:rmv:[\w:-]+$/i.test(id))) {
        send(res, 400, { error: 'lineIds must contain one to fifty RMV line ids' }); return;
      }
      endpoint = 'himsearch'; params = { lineids: lineIds.join(',') };
      makeResult = data => slimNotices(data, lineIds);
    } else if (url.pathname === '/resolve') {
      const name = (url.searchParams.get('name') || '').trim();
      if (!name || name.length > 120) { send(res, 400, { error: 'name is required' }); return; }
      endpoint = 'location.name'; params = { input: name, maxNo: 20 };
      const lat = Number(url.searchParams.get('lat')), lon = Number(url.searchParams.get('lon'));
      makeResult = data => {
        const entries = listAt(data, ['stopLocationOrCoordLocation', 'StopLocationOrCoordLocation', 'locations', 'Location']);
        const places = entries.map(entry => entry && (entry.StopLocation || entry.stopLocation || entry)).filter(Boolean);
        const results = places.map(place => ({
          name: stripHtml(textValue(place && (place.name || place.Name || ''))),
          extId: String(place && (place.extId || place.ExtId || '')).trim(),
          lat: Number(place && (place.lat || place.Lat)), lon: Number(place && (place.lon || place.Lon)),
        })).filter(place => /^\d+$/.test(place.extId));
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          results.sort((a, b) => Math.hypot(a.lat - lat, a.lon - lon) - Math.hypot(b.lat - lat, b.lon - lon));
        } else {
          results.sort((a, b) => Number(a.name.toLowerCase().includes('darmstadt')) - Number(b.name.toLowerCase().includes('darmstadt')));
        }
        return { locations: results.map(({ name: placeName, extId }) => ({ name: placeName, extId })) };
      };
    } else { send(res, 404, { error: 'not found' }); return; }

    const cacheKey = `${endpoint}?${Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&')}` +
      (endpoint === 'location.name' ? `&lat=${url.searchParams.get('lat') || ''}&lon=${url.searchParams.get('lon') || ''}` : '');
    const cached = serverCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_MS) { send(res, 200, cached.value); return; }
    const u = usage(Date.now(), callLog);
    if (u.hour >= MAX_HOUR || u.day >= MAX_DAY) { send(res, 429, { error: 'RMV request limit reached' }); return; }
    callLog.push(Date.now());
    try {
      const data = await upstream(key, endpoint, params);
      const result = makeResult(data);
      serverCache.set(cacheKey, { at: Date.now(), value: result });
      send(res, 200, result);
    } catch (error) {
      const message = String(error && error.message || '');
      const reason = message.startsWith('RMV HTTP ') || message.startsWith('RMV returned invalid JSON (') || message === 'RMV request timed out'
        ? message : 'upstream request failed';
      console.error(`RMV ${endpoint}: ${reason}`);
      send(res, 502, { error: 'RMV service unavailable' });
    }
  });
  return server;
}

function start() {
  const key = readAccessId();
  const server = createServer(key);
  server.listen(PORT, HOST, () => console.log(`RMV development proxy listening on http://${HOST}:${PORT}`));
  return server;
}

module.exports = { stripHtml, slimBoard, slimNotices, createServer, readAccessId, usage, start };
if (require.main === module) start();
