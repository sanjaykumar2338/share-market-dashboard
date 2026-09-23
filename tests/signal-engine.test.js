'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../signal-engine.js');

const START = Date.parse('2026-09-22T04:00:00Z');
const INTERVAL = 5 * 60_000;

function buyCandles() {
  const prices = Array.from({ length: 37 }, (_, index) => ({
    open: 100 + (index % 2 ? -0.3 : 0.3) + index * 0.006,
    high: 100.75 + index * 0.006,
    low: 99.25 + index * 0.006,
    close: 100 + (index % 2 ? 0.4 : -0.4) + index * 0.006
  }));
  prices.push(
    { open: 100.5, high: 100.8, low: 99.8, close: 100 },
    { open: 100.1, high: 103, low: 100, close: 102.8 },
    { open: 103.1, high: 104, low: 103, close: 103.9 }
  );
  return prices.map((candle, index) => ({
    ...candle, timestamp: START + index * INTERVAL, symbol: 'NIFTY', interval: '5m',
    closed: true, source: 'upstox-api', volume: index === prices.length - 1 ? 1500 : 1000
  }));
}

function evaluate(candles = buyCandles(), options = {}) {
  return engine.evaluate(candles, { now: START + 40 * INTERVAL, ...options });
}

function near(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} should equal ${expected}`);
}

test('EMA is seeded from the first complete SMA window', () => {
  assert.deepEqual(engine.indicators.ema([1, 2, 3, 4, 5, 6], 3), [null, null, 2, 3, 4, 5]);
  assert.deepEqual(engine.indicators.ema([1, 2], 3), [null, null]);
});

test('Wilder ATR uses true range across gaps and recursive smoothing', () => {
  const candles = [
    { high: 10, low: 8, close: 9 },
    { high: 12, low: 9, close: 11 },
    { high: 13, low: 10, close: 12 },
    { high: 14, low: 11, close: 13 },
    { high: 12, low: 10, close: 11 },
    { high: 17, low: 16, close: 16.5 }
  ];
  const actual = engine.indicators.wilderAtr(candles, 3);
  assert.deepEqual(actual.slice(0, 2), [null, null]);
  [8 / 3, 25 / 9, 77 / 27, 316 / 81].forEach((expected, index) => near(actual[index + 2], expected));
});

test('Wilder RSI agrees with a independently calculated 14-period example', () => {
  const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42,
    45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03];
  const actual = engine.indicators.wilderRsi(closes);
  near(actual[14], 70.46413502109705);
  near(actual[15], 66.24961855355505);
  near(actual[16], 66.48094183471265);
  assert.equal(engine.indicators.wilderRsi(Array(16).fill(20))[15], 50);
  assert.equal(engine.indicators.wilderRsi(Array.from({ length: 16 }, (_, index) => index + 1))[15], 100);
});

test('confirmed BUY consolidates overlapping FVG and order block into one signal', () => {
  const response = evaluate();
  assert.equal(response.status, 'signal');
  assert.equal(response.signals.length, 1);
  const signal = response.signals[0];
  assert.equal(signal.action, 'BUY');
  assert.equal(signal.pattern, 'Bullish FVG + Bullish Order Block');
  assert.equal(signal.confirmation, 'closed-feed');
  assert.equal(signal.barTime, START + 39 * INTERVAL);
  assert.equal(signal.candleClosedAt, START + 40 * INTERVAL);
  assert.equal(signal.metrics.volumeConfirmed, true);
  assert.equal(signal.metrics.volumeRatio, 1.5);
  assert.ok(signal.reasons.some((reason) => reason.includes('RSI')));
  assert.ok(!Object.hasOwn(signal, 'confidence'));
});

test('mirroring prices produces a symmetric confirmed SELL', () => {
  const candles = buyCandles().map((candle) => ({ ...candle,
    open: 220 - candle.open, high: 220 - candle.low,
    low: 220 - candle.high, close: 220 - candle.close }));
  const response = evaluate(candles);
  assert.equal(response.status, 'signal');
  assert.equal(response.signals.length, 1);
  assert.equal(response.signals[0].action, 'SELL');
  assert.equal(response.signals[0].pattern, 'Bearish FVG + Bearish Order Block');
  near(response.metrics.rsi, 100 - evaluate().metrics.rsi);
  near(response.metrics.atr, evaluate().metrics.atr);
});

test('an immediate order block can confirm without an FVG', () => {
  const candles = buyCandles().slice(0, -1);
  candles.at(-1).volume = 1500;
  const response = evaluate(candles, { now: START + 39 * INTERVAL });
  assert.equal(response.signals.length, 1);
  assert.equal(response.signals[0].pattern, 'Bullish Order Block');
});

test('closed candles observed from the chart retain their weaker provenance', () => {
  const candles = buyCandles().map((candle) => ({ ...candle, source: 'observed-chart', volume: null }));
  const response = evaluate(candles);
  assert.equal(response.signals[0].confirmation, 'observed-close');
  assert.equal(response.signals[0].metrics.volumeConfirmed, false);
  assert.equal(response.signals[0].metrics.volumeRatio, null);
  assert.ok(response.signals[0].reasons.some((reason) => reason.includes('volume confirmation was not used')));
  assert.equal(response.signals[0].reasons[0], 'Observed 5m interval close from chart snapshots.');
  assert.match(response.reason, /detected at an observed interval close/);
  assert.doesNotMatch(response.reason, /confirmed/);
});

test('volume is required to exceed its baseline only when reliably available', () => {
  const candles = buyCandles();
  candles.at(-1).volume = 1199;
  assert.match(evaluate(candles).reason, /Volume is below/);
  candles.at(-1).volume = 1200;
  assert.equal(evaluate(candles).signals.length, 1);
  candles[25].volume = null;
  candles.at(-1).volume = 1;
  assert.equal(evaluate(candles).signals.length, 1);
  assert.equal(evaluate(candles).metrics.volumeAvailable, false);
});

test('zero current volume fails the gate when the preceding volume baseline is available', () => {
  const candles = buyCandles();
  candles.at(-1).volume = 0;
  const response = evaluate(candles);
  assert.equal(response.status, 'no-signal');
  assert.match(response.reason, /Volume is below/);
  assert.equal(response.metrics.volumeAvailable, true);
  assert.equal(response.metrics.volumeConfirmed, false);
  assert.equal(response.metrics.volumeRatio, 0);
});

test('an all-zero volume series remains explicitly unavailable', () => {
  const candles = buyCandles().map((candle) => ({ ...candle, volume: 0 }));
  const response = evaluate(candles);
  assert.equal(response.signals.length, 1);
  assert.equal(response.metrics.volumeAvailable, false);
  assert.equal(response.metrics.volumeConfirmed, false);
  assert.equal(response.metrics.volumeRatio, null);
});

test('pattern switches disable only their own candidates', () => {
  assert.equal(evaluate(buyCandles(), { orderBlockEnabled: false }).signals[0].pattern, 'Bullish FVG');
  assert.equal(evaluate(buyCandles(), { fvgEnabled: false }).signals[0].pattern, 'Bullish Order Block');
  const disabled = evaluate([], { fvgEnabled: false, orderBlockEnabled: false });
  assert.equal(disabled.status, 'disabled');
  assert.deepEqual(disabled.signals, []);
});

test('a short history warms up without producing a signal', () => {
  const candles = buyCandles().slice(-29);
  const response = evaluate(candles);
  assert.equal(response.status, 'warming-up');
  assert.match(response.reason, /29\/30/);
  assert.deepEqual(response.signals, []);
  assert.equal(evaluate([]).status, 'warming-up');
});

const invalidCases = [
  ['an unclosed candle', (candles) => { candles.at(-1).closed = false; }],
  ['missing closed provenance', (candles) => { delete candles.at(-1).closed; }],
  ['a missing high', (candles) => { delete candles[5].high; }],
  ['a missing candle', (candles) => { candles[5] = null; }],
  ['a close outside the high', (candles) => { candles[5].close = candles[5].high + 1; }],
  ['a non-positive low', (candles) => { candles[5].low = 0; }],
  ['a non-finite price', (candles) => { candles[5].open = Infinity; }],
  ['a missing timestamp', (candles) => { delete candles[5].timestamp; }],
  ['a text timestamp', (candles) => { candles[5].timestamp = String(candles[5].timestamp); }],
  ['a duplicate timestamp', (candles) => { candles[5].timestamp = candles[4].timestamp; }],
  ['a gap', (candles) => { candles.splice(5, 1); }],
  ['out-of-order timestamps', (candles) => { [candles[4], candles[5]] = [candles[5], candles[4]]; }],
  ['mixed symbols', (candles) => { candles[5].symbol = 'BANKNIFTY'; }],
  ['mixed intervals', (candles) => { candles[5].interval = '15m'; }],
  ['an unsupported interval', (candles) => { candles.forEach((candle) => { candle.interval = '1d'; }); }],
  ['a missing symbol', (candles) => { candles[0].symbol = ''; }],
  ['a missing source', (candles) => { delete candles[5].source; }],
  ['mixed data sources', (candles) => { candles[5].source = 'observed-chart'; }],
  ['negative volume', (candles) => { candles[5].volume = -1; }]
];
for (const [description, mutate] of invalidCases) {
  test(`rejects ${description}`, () => {
    const candles = buyCandles();
    mutate(candles);
    const response = evaluate(candles);
    assert.equal(response.status, 'invalid-data');
    assert.deepEqual(response.signals, []);
  });
}

test('future, still-forming, and stale candles cannot alert', () => {
  const candles = buyCandles();
  const closedAt = START + 40 * INTERVAL;
  assert.equal(evaluate(candles, { now: closedAt - 1 }).status, 'invalid-data');
  assert.equal(evaluate(candles, { now: START }).status, 'invalid-data');
  assert.equal(evaluate(candles, { now: closedAt + 2 * INTERVAL + 1 }).status, 'stale-data');
  assert.equal(evaluate(candles, { now: closedAt + 2 * INTERVAL }).status, 'signal');
});

test('a visible FVG with a weak middle candle is insufficient', () => {
  const candles = buyCandles();
  candles.at(-2).open = 102.6;
  const response = evaluate(candles);
  assert.equal(response.status, 'no-signal');
  assert.match(response.reason, /No enabled FVG or order block/);
});

test('a tiny FVG is ignored', () => {
  const candles = buyCandles();
  candles.at(-1).low = candles.at(-3).high + 0.01;
  const response = evaluate(candles, { orderBlockEnabled: false });
  assert.equal(response.status, 'no-signal');
  assert.match(response.reason, /No enabled FVG/);
});

test('a rejected close near mid-candle cannot alert', () => {
  const candles = buyCandles();
  candles.at(-1).high = 105;
  const response = evaluate(candles);
  assert.equal(response.status, 'no-signal');
  assert.match(response.reason, /outer 30%/);
});

test('an extreme range cannot alert', () => {
  const candles = buyCandles();
  candles.at(-1).high = 115;
  candles.at(-1).close = 114.8;
  const response = evaluate(candles);
  assert.equal(response.status, 'no-signal');
  assert.match(response.reason, /3 ATR/);
});

test('an uninterrupted overbought rise is filtered by RSI', () => {
  const candles = buyCandles().map((candle, index) => ({ ...candle,
    open: 90 + index * 0.25, low: 89.95 + index * 0.25,
    high: 90.2 + index * 0.25, close: 90.19 + index * 0.25 }));
  const response = evaluate(candles);
  assert.equal(response.status, 'no-signal');
  assert.match(response.reason, /RSI/);
});

test('flat price data cannot alert', () => {
  const candles = buyCandles().map((candle) => ({ ...candle, open: 100, high: 100, low: 100, close: 100 }));
  assert.equal(evaluate(candles).status, 'no-signal');
  assert.deepEqual(evaluate(candles).signals, []);
});

test('stable identity deduplicates repeated scans and harmless value revisions', () => {
  const candles = buyCandles();
  const first = evaluate(candles).signals[0];
  assert.equal(evaluate(candles).signals[0].key, first.key);
  candles.at(-1).close += 0.01;
  candles.at(-1).volume += 100;
  assert.equal(evaluate(candles).signals[0].key, first.key);
  candles.forEach((candle) => { candle.timestamp += INTERVAL; });
  const next = evaluate(candles, { now: START + 41 * INTERVAL }).signals[0];
  assert.notEqual(next.key, first.key);
});

test('evaluation leaves its input candles unchanged', () => {
  const candles = buyCandles();
  const before = structuredClone(candles);
  evaluate(candles);
  assert.deepEqual(candles, before);
});

test('interval parsing accepts only supported explicit intraday durations', () => {
  assert.equal(engine.intervalMilliseconds('1m'), 60_000);
  assert.equal(engine.intervalMilliseconds('60m'), 3_600_000);
  assert.equal(engine.intervalMilliseconds('5h'), 18_000_000);
  ['0m', '61m', '6h', '1d', '5', '', '1s'].forEach((value) => assert.equal(engine.intervalMilliseconds(value), null));
});
