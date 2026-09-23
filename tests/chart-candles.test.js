const test = require('node:test');
const assert = require('node:assert/strict');
const { createTracker, normalizeInterval } = require('../chart-candles.js');

const SESSION_START = Date.parse('2026-09-22T09:15:00+05:30');

function sample(seconds, values = {}) {
  return {
    symbol: 'NSE:NIFTY', interval: '1m',
    open: 100, high: 102, low: 99, close: 101,
    seenAt: SESSION_START + seconds * 1000,
    ...values
  };
}

function finishFirstBar(tracker) {
  tracker.observe(sample(0));
  tracker.observe(sample(30, { high: 103, close: 102 }));
  return tracker.observe(sample(60, { open: 102, high: 103, low: 101, close: 103 }));
}

test('only complete observed candles are returned, with exact 1m boundary timestamps', () => {
  const tracker = createTracker();
  assert.deepEqual(tracker.observe(sample(0)).candles, []);
  assert.deepEqual(tracker.observe(sample(30, { high: 103, close: 102 })).candles, []);
  const closed = tracker.observe(sample(60, { open: 102, high: 103, low: 101, close: 103 }));
  assert.equal(closed.updated, true);
  assert.deepEqual(closed.candles, [{
    timestamp: SESSION_START,
    open: 100, high: 103, low: 99, close: 102,
    symbol: 'NSE:NIFTY', interval: '1m', closed: true, source: 'observed-chart'
  }]);
  assert.equal(tracker.count(), 1);
  closed.candles[0].close = 999;
  assert.equal(tracker.observe(sample(75, { open: 102, high: 104, low: 101, close: 104 })).candles[0].close, 102);
});

test('30m and hourly intervals anchor to 09:15 IST, not to wall-clock half hours', () => {
  for (const interval of ['30m', '1h']) {
    const tracker = createTracker();
    const secondsPerBar = interval === '30m' ? 1800 : 3600;
    for (let second = 0; second < secondsPerBar; second += 30) {
      assert.equal(tracker.observe(sample(second, { interval })).candles.length, 0);
    }
    const result = tracker.observe(sample(secondsPerBar, { interval, open: 101, high: 103, close: 102 }));
    assert.equal(result.updated, true);
    assert.equal(result.candles[0].timestamp, SESSION_START);
    assert.equal(result.candles[0].interval, interval === '30m' ? '30m' : '60m');
  }
});

test('identical frozen OHLC across several rollovers never creates candles', () => {
  const tracker = createTracker();
  for (let second = 0; second <= 300; second += 15) {
    const result = tracker.observe(sample(second));
    assert.equal(result.candles.length, 0);
    assert.equal(result.updated, false);
  }
});

test('a rollover may wait briefly for changed values without counting the open candle', () => {
  const tracker = createTracker();
  tracker.observe(sample(0));
  tracker.observe(sample(30));
  assert.equal(tracker.observe(sample(60)).candles.length, 0);
  const result = tracker.observe(sample(70, { open: 101, high: 103, close: 102 }));
  assert.equal(result.updated, true);
  assert.equal(result.candles.length, 1);
  assert.equal(result.candles[0].timestamp, SESSION_START);
});

test('unchanged OHLC is allowed inside a bar but identical real bars are not fabricated', () => {
  const tracker = createTracker();
  tracker.observe(sample(0));
  tracker.observe(sample(30));
  tracker.observe(sample(60));
  tracker.observe(sample(90));
  const result = tracker.observe(sample(120, { open: 101, high: 103, close: 102 }));
  assert.equal(result.updated, false);
  assert.equal(result.candles.length, 0);
});

test('starting mid-candle skips that partial bar and can later collect a complete one', () => {
  const tracker = createTracker();
  tracker.observe(sample(40));
  tracker.observe(sample(55));
  const first = tracker.observe(sample(60, { open: 101, high: 103, close: 102 }));
  assert.equal(first.candles.length, 0);
  tracker.observe(sample(90, { open: 101, high: 103, close: 102 }));
  const second = tracker.observe(sample(120, { open: 102, high: 104, close: 103 }));
  assert.equal(second.candles.length, 1);
  assert.equal(second.candles[0].timestamp, SESSION_START + 60000);
});

test('missing samples or skipped buckets clear the history and do not bridge gaps', () => {
  const tracker = createTracker();
  assert.equal(finishFirstBar(tracker).candles.length, 1);
  const afterGap = tracker.observe(sample(150, { open: 104, high: 105, close: 104 }));
  assert.equal(afterGap.candles.length, 0);
  assert.match(afterGap.reason, /gap/);
  assert.equal(tracker.count(), 0);
});

test('a long same-bucket pause also invalidates an apparent complete candle', () => {
  const tracker = createTracker();
  tracker.observe(sample(0, { interval: '5m' }));
  tracker.observe(sample(270, { interval: '5m' }));
  const result = tracker.observe(sample(300, { interval: '5m', open: 101, high: 103, close: 102 }));
  assert.equal(result.candles.length, 0);
});

test('switching symbol, timeframe or session cannot mix candles', () => {
  for (const change of [
    { symbol: 'BSE:SENSEX' },
    { interval: '3m' },
    { seenAt: Date.parse('2026-09-23T09:15:00+05:30') }
  ]) {
    const tracker = createTracker();
    finishFirstBar(tracker);
    const result = tracker.observe(sample(75, change));
    assert.equal(result.candles.length, 0);
    assert.equal(result.updated, false);
    assert.match(result.reason, /changed/);
  }
});

test('missing or ambiguous symbols, intervals and malformed prices clear existing history', () => {
  for (const change of [
    { symbol: '' }, { symbol: 'unknown' }, { symbol: null }, { symbol: 'MCX:GOLD' },
    { interval: '1D' }, { interval: '2m' }, { interval: undefined },
    { open: '100' }, { low: 0 }, { high: NaN }, { close: Infinity },
    { high: 98 }, { low: 103 }, { close: 200 }, { seenAt: 'today' },
    { seenAt: Number.MAX_SAFE_INTEGER }
  ]) {
    const tracker = createTracker();
    finishFirstBar(tracker);
    assert.equal(tracker.observe(sample(75, change)).candles.length, 0, JSON.stringify(change));
  }
});

test('changing an open or shrinking the range inside a bucket invalidates it', () => {
  for (const change of [{ open: 101 }, { high: 101 }, { low: 100 }]) {
    const tracker = createTracker();
    tracker.observe(sample(0));
    const result = tracker.observe(sample(30, change));
    assert.equal(result.candles.length, 0);
    assert.match(result.reason, /inconsistently/);
    assert.equal(tracker.observe(sample(60, { open: 102, high: 103, close: 102 })).candles.length, 0);
  }
});

test('duplicate or very close observations do not constitute coverage of a bar', () => {
  for (const times of [[30, 30], [29, 30]]) {
    const tracker = createTracker();
    for (const time of times) tracker.observe(sample(time));
    const result = tracker.observe(sample(60, { open: 101, high: 103, close: 102 }));
    assert.equal(result.candles.length, 0);
  }
});

test('backwards time, weekends and times outside the equity session reset observation history', () => {
  for (const seenAt of [
    SESSION_START + 59000,
    Date.parse('2026-09-22T09:14:59+05:30'),
    Date.parse('2026-09-22T15:30:00+05:30'),
    Date.parse('2026-09-26T10:00:00+05:30')
  ]) {
    const tracker = createTracker();
    finishFirstBar(tracker);
    const result = tracker.observe(sample(75, { seenAt }));
    assert.equal(result.candles.length, 0);
    assert.equal(result.updated, false);
  }
});

test('history is bounded to 100 closed bars and reset empties it', () => {
  const tracker = createTracker();
  let result;
  for (let bar = 0; bar <= 105; bar += 1) {
    const open = 100 + bar;
    const values = { open, high: open + 2, low: open - 1, close: open + 1 };
    result = tracker.observe(sample(bar * 60, values));
    tracker.observe(sample(bar * 60 + 30, values));
  }
  assert.equal(result.candles.length, 100);
  assert.equal(result.candles[0].timestamp, SESSION_START + 5 * 60000);
  assert.equal(tracker.count(), 100);
  tracker.reset();
  assert.equal(tracker.count(), 0);
});

test('only explicitly supported intraday intervals are normalized', () => {
  assert.equal(normalizeInterval(' 5 MIN '), '5m');
  assert.equal(normalizeInterval('1h'), '60m');
  assert.equal(normalizeInterval('30'), '30m');
  for (const value of [null, 5, '1D', '0m', '2m', '2h', '1w', '5m junk']) {
    assert.equal(normalizeInterval(value), null);
  }
});
