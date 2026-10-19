'use strict';

const assert = require('assert');
const http = require('http');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { createServer, slimBoard, slimNotices, stripHtml } = require('./rmv-proxy');
const DOCS = path.join(__dirname, '..', 'docs');

async function request(port, requestPath, origin) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: requestPath,
      headers: origin ? { Origin: origin } : {} }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }));
    });
    req.on('error', reject);
  });
}

async function run() {
  assert.strictEqual(stripHtml('<p>Track &amp; platform</p><script>x</script>'), 'Track & platform');
  const board = slimBoard({ Departure: [
    { name: '4', direction: 'Luisenplatz', date: '2026-10-19', time: '12:00:00', rtTime: '12:02:00', platform: '2', track: '4',
      ProductAtStop: { lineId: 'de:rmv:0000001' }, Messages: [{ text: '<b>Track change</b>' }] },
    { name: '4', direction: 'Luisenplatz', date: '2026-10-19', time: '12:00:00', rtTime: '12:02:00', platform: '2', track: '4',
      ProductAtStop: { lineId: 'de:rmv:0000001' }, Messages: [{ text: 'Track change' }] },
    { name: '9', direction: 'Main station', date: '2026-10-19', time: '12:05:00', platform: { type: 'ST', text: '1' }, track: '3' },
  ] });
  assert.strictEqual(board.departures.length, 2);
  assert.strictEqual(board.departures[0].plannedTrack, '2');
  assert.strictEqual(board.departures[0].track, '4');
  assert.deepStrictEqual(board.departures[0].messages, ['Track change']);
  assert.strictEqual(board.departures[1].plannedTrack, '1');
  assert.strictEqual(board.departures[1].actualTime, null);
  const notices = slimNotices({ HIM: { Messages: [
    { id: 'old', head: 'Older', text: '<p>Older text</p>', sDate: '20261019', sTime: '100000', eDate: '20261019', eTime: '230000' },
    { id: 'new', head: 'Newer', text: 'Newer text', validFrom: '2026-10-19T11:00:00Z' },
  ] } }, ['de:rmv:0000001']);
  assert.strictEqual(notices.notices[0].id, 'new');
  assert.strictEqual(notices.notices[1].text, 'Older text');
  assert.ok(notices.notices[1].validFrom);
  assert.ok(notices.notices[1].validUntil);
  const perLine = slimNotices({ Message: [{ id: 'multi', head: 'Service update', text: 'Update', affectedProduct: [
    { name: 'Bus H', lineId: 'de:rmv:00000111:', catOut: 'Bus' },
    { name: 'Tram 3', lineId: 'de:rmv:00000099:', catOut: 'Tram' },
  ] }] }, ['de:rmv:0000001']);
  assert.deepStrictEqual(perLine.notices.map(item => [item.line, item.mode]), [['Bus H', 'bus'], ['Tram 3', 'tram']]);

  let upstreamCalls = 0;
  let upstreamLineids = '';
  const calls = [];
  const cache = new Map();
  const server = createServer('test-access-token-never-returned', { calls, cache, upstream: async (_key, endpoint, params) => {
    upstreamCalls++;
    if (endpoint === 'himsearch') upstreamLineids = params.lineids;
    if (endpoint === 'departureBoard') return { Departure: [
      { name: '4', direction: 'Luisenplatz', date: '2026-10-19', time: '12:00:00', platform: '2', track: '4' },
    ] };
    if (endpoint === 'himsearch') return { HIM: { Messages: [
      { id: 'n1', head: 'Notice', text: 'Issue', validFrom: '2026-10-19T11:00:00Z' },
    ] } };
    if (endpoint === 'location.name') return [{ name: 'Luisenplatz', extId: '3004734' }];
    throw new Error('unexpected endpoint');
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const health = await request(port, '/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(upstreamCalls, 0);
    const first = await request(port, '/board?stop=3004734&duration=60', 'http://127.0.0.1:8099');
    const second = await request(port, '/board?stop=3004734&duration=60');
    assert.strictEqual(first.status, 200);
    assert.strictEqual(second.status, 200);
    assert.strictEqual(upstreamCalls, 1);
    assert.strictEqual(first.headers['access-control-allow-origin'], 'http://127.0.0.1:8099');
    const forbidden = await request(port, '/health', 'http://example.com');
    assert.strictEqual(forbidden.headers['access-control-allow-origin'], undefined);
    const notice = await request(port, '/notices?lineIds=' + encodeURIComponent('de:rmv:0000001|de:rmv:0000002'));
    assert.strictEqual(notice.body.notices.length, 1);
    assert.strictEqual(upstreamLineids, 'de:rmv:0000001,de:rmv:0000002');
    const resolve = await request(port, '/resolve?name=Luisenplatz');
    assert.strictEqual(resolve.body.locations[0].extId, '3004734');
    assert.strictEqual(upstreamCalls, 3);

    const limitedCalls = Array.from({ length: 600 }, () => Date.now());
    const limited = createServer('test', { calls: limitedCalls, cache: new Map(), upstream: async () => {
      throw new Error('must not call upstream');
    } });
    await new Promise(resolve => limited.listen(0, '127.0.0.1', resolve));
    try {
      const blocked = await request(limited.address().port, '/board?stop=1');
      assert.strictEqual(blocked.status, 429);
    } finally { await new Promise(resolve => limited.close(resolve)); }
    const dailyCalls = Array.from({ length: 5000 }, () => Date.now() - 2 * 3600000);
    const dailyLimited = createServer('test', { calls: dailyCalls, cache: new Map(), upstream: async () => {
      throw new Error('must not call upstream');
    } });
    await new Promise(resolve => dailyLimited.listen(0, '127.0.0.1', resolve));
    try {
      const blocked = await request(dailyLimited.address().port, '/board?stop=2');
      assert.strictEqual(blocked.status, 429);
    } finally { await new Promise(resolve => dailyLimited.close(resolve)); }
  } finally { await new Promise(resolve => server.close(resolve)); }

  async function runClient(fetchImpl) {
    const sandbox = { URLSearchParams, Promise, String, Array, Set, window: { fetch: fetchImpl, location: { search: '' } } };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(DOCS, 'rmv.js'), 'utf8'), sandbox);
    await sandbox.window.DarmstadtRMV.ready;
    return sandbox.window.DarmstadtRMV;
  }
  let fetchCalls = 0;
  const disabled = await runClient(async () => { fetchCalls++; throw new Error('offline'); });
  assert.strictEqual(disabled.enabled(), false);
  assert.strictEqual(await disabled.board('3004734'), null);
  assert.strictEqual(fetchCalls, 1);
  console.log('RESULT: PASS');
}

module.exports = { run };
if (require.main === module) run().catch(err => { console.error(err); process.exitCode = 1; });
