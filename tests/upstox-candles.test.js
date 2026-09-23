const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { fetchClosedCandles, normalizeCandles } = require('../upstox-candles.js');

const instrumentKey = 'NSE_INDEX|Nifty 50';
const now = Date.parse('2026-09-22T10:01:03+05:30');
const options = { instrumentKey, interval: '1m', now };
const row = (time, prices = [100, 103, 99, 102], volume = 0) => [`2026-09-22T${time}+05:30`, ...prices, volume, 0];
const response = (candles) => ({ ok: true, status: 200, json: async () => ({ status: 'success', data: { candles } }) });

test('browser script exposes its API without CommonJS', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../upstox-candles.js'), 'utf8'), context);
  assert.equal(typeof context.UpstoxCandles.fetchClosedCandles, 'function');
});

test('requests encoded instrument with token only in headers and returns ordered closed bars', async () => {
  let request;
  const candles = await fetchClosedCandles({
    ...options, accessToken: 'test-private-token',
    fetchImpl: async (url, init) => {
      request = { url, init };
      return response([row('10:01:00'), row('10:00:00'), row('09:59:00'), row('09:59:00')]);
    }
  });
  assert.equal(request.url, 'https://api.upstox.com/v3/historical-candle/intraday/NSE_INDEX%7CNifty%2050/minutes/1');
  assert.equal(request.url.includes('test-private-token'), false);
  assert.equal(request.init.headers.Authorization, 'Bearer test-private-token');
  assert.equal(request.init.redirect, 'error');
  assert.equal(request.init.credentials, 'omit');
  assert.equal(request.init.signal instanceof AbortSignal, true);
  assert.deepEqual(candles.map((item) => item.timestamp), [Date.parse('2026-09-22T09:59:00+05:30'), Date.parse('2026-09-22T10:00:00+05:30')]);
  assert.deepEqual(candles[1], {
    timestamp: Date.parse('2026-09-22T10:00:00+05:30'),
    open: 100, high: 103, low: 99, close: 102, volume: 0,
    symbol: instrumentKey, interval: '1m', closed: true, source: 'upstox-api'
  });
});

test('waits the full three-second close grace and ignores an unfinished malformed bar', () => {
  const rows = [row('10:00:00'), row('10:01:00', [NaN, null, -1, 'invalid'])];
  assert.equal(normalizeCandles(rows, { ...options, now: now - 1 }).length, 0);
  assert.equal(normalizeCandles(rows, options).length, 1);
});

test('all supported intervals use their real duration, not the scan frequency', () => {
  for (const interval of ['1m', '3m', '5m', '15m', '30m']) {
    const minutes = Number.parseInt(interval, 10);
    const start = Date.parse('2026-09-22T09:15:00+05:30');
    const sample = [row('09:15:00')];
    assert.equal(normalizeCandles(sample, { ...options, interval, now: start + minutes * 60000 + 2999 }).length, 0);
    assert.equal(normalizeCandles(sample, { ...options, interval, now: start + minutes * 60000 + 3000 }).length, 1);
  }
});

test('rejects unknown intervals, invalid keys and missing credentials before network access', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return response([]); };
  await assert.rejects(fetchClosedCandles({ ...options, interval: 'visible', accessToken: 'token', fetchImpl }), { code: 'INVALID_INTERVAL' });
  await assert.rejects(fetchClosedCandles({ ...options, instrumentKey: 'Nifty 50', accessToken: 'token', fetchImpl }), { code: 'INVALID_INSTRUMENT' });
  await assert.rejects(fetchClosedCandles({ ...options, accessToken: '', fetchImpl }), { code: 'AUTH_REQUIRED' });
  await assert.rejects(fetchClosedCandles({ ...options, accessToken: 'token\r\nInjected: value', fetchImpl }), { code: 'AUTH_REQUIRED' });
  assert.equal(called, false);
});

test('rejects malformed completed prices, impossible OHLC ranges and invalid volume', () => {
  for (const malformed of [
    row('10:00:00', [100, 99, 98, 102]),
    row('10:00:00', [100, 103, 101, 102]),
    row('10:00:00', ['100', 103, 99, 102]),
    row('10:00:00', [100, Infinity, 99, 102]),
    row('10:00:00', [100, 103, 99, 0]),
    row('10:00:00', undefined, -1),
    row('10:00:00', undefined, '100')
  ]) {
    assert.throws(() => normalizeCandles([malformed], options), { code: 'INVALID_CANDLES' });
  }
});

test('accepts missing index volume and zero volume without manufacturing volume', () => {
  const absent = row('09:59:00').slice(0, 5);
  const candles = normalizeCandles([absent, row('10:00:00')], options);
  assert.equal(candles[0].volume, undefined);
  assert.equal(candles[1].volume, 0);
});

test('deduplicates identical timestamps but rejects conflicting prices or volume', () => {
  assert.equal(normalizeCandles([row('10:00:00'), row('10:00:00')], options).length, 1);
  assert.throws(() => normalizeCandles([row('10:00:00'), row('10:00:00', [100, 104, 99, 102])], options), { code: 'CONFLICTING_CANDLES' });
  assert.throws(() => normalizeCandles([row('10:00:00'), row('10:00:00', undefined, 10)], options), { code: 'CONFLICTING_CANDLES' });
});

test('never fills missing bars or relabels previous-day candles as current data', () => {
  const stale = ['2026-09-21T10:00:00+05:30', 100, 103, 99, 102, 0];
  assert.deepEqual(normalizeCandles([stale], options), []);
  const candles = normalizeCandles([row('09:55:00'), row('10:00:00'), stale], options);
  assert.equal(candles.length, 2);
  assert.equal(candles[1].timestamp - candles[0].timestamp, 5 * 60000);
  assert.deepEqual(normalizeCandles([], options), []);
});

test('current-day filtering uses IST even when its calendar day differs from UTC', () => {
  const midnightOptions = { ...options, now: Date.parse('2026-09-22T00:03:03+05:30') };
  const candles = normalizeCandles([
    ['2026-09-21T23:59:00+05:30', 100, 103, 99, 102, 0],
    row('00:01:00')
  ], midnightOptions);
  assert.equal(candles.length, 1);
  assert.equal(candles[0].timestamp, Date.parse('2026-09-22T00:01:00+05:30'));
});

test('retains the newest 100 closed bars in ascending order', () => {
  const start = Date.parse('2026-09-22T09:15:00+05:30');
  const rows = Array.from({ length: 130 }, (_, index) => [new Date(start + index * 60000).toISOString(), 100, 103, 99, 102, 0]);
  const candles = normalizeCandles(rows.reverse(), { ...options, now: start + 130 * 60000 + 3000 });
  assert.equal(candles.length, 100);
  assert.equal(candles[0].timestamp, start + 30 * 60000);
  assert.equal(candles.at(-1).timestamp, start + 129 * 60000);
});

test('rejects malformed response rows and ambiguous timestamps', () => {
  for (const rows of [[{}], [[]],
    [['2026-09-22 10:00:00', 100, 103, 99, 102]],
    [['not-a-date', 100, 103, 99, 102]],
    [['2026-02-30T10:00:00+05:30', 100, 103, 99, 102]],
    [['2026-09-22T24:00:00+05:30', 100, 103, 99, 102]]
  ]) {
    assert.throws(() => normalizeCandles(rows, options), { code: 'INVALID_CANDLES' });
  }
  assert.throws(() => normalizeCandles({}, options), { code: 'INVALID_RESPONSE' });
});

test('authentication and rate-limit errors are helpful without response-body disclosure', async () => {
  for (const [status, code] of [[401, 'AUTH_REQUIRED'], [403, 'AUTH_REQUIRED'], [429, 'RATE_LIMITED'], [500, 'API_ERROR']]) {
    let bodyRead = false;
    await assert.rejects(fetchClosedCandles({
      ...options, accessToken: 'secret-token',
      fetchImpl: async () => ({ status, ok: false, json: async () => { bodyRead = true; return 'secret-token'; } })
    }), (error) => error.code === code && !error.message.includes('secret-token'));
    assert.equal(bodyRead, false);
  }
});

test('sanitizes network, JSON and unexpected response errors', async () => {
  for (const [fetchImpl, code] of [
    [async () => { throw new Error('Failed Authorization Bearer secret-token'); }, 'NETWORK_ERROR'],
    [async () => ({ ok: true, status: 200, json: async () => { throw new Error('secret-token'); } }), 'INVALID_RESPONSE'],
    [async () => ({ ok: true, status: 200, json: async () => ({ status: 'error', message: 'secret-token' }) }), 'INVALID_RESPONSE'],
    [async () => { throw new DOMException('secret-token', 'AbortError'); }, 'TIMEOUT']
  ]) {
    await assert.rejects(fetchClosedCandles({ ...options, accessToken: 'secret-token', fetchImpl }),
      (error) => error.code === code && !String(error).includes('secret-token'));
  }
});
