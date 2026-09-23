(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.UpstoxChartCandles = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // A chart legend is only an observation, not an exchange-confirmed candle.
  // Strict continuity checks reduce accidental use of hovered or frozen values.
  const IST_OFFSET_MS = 330 * 60 * 1000;
  const EDGE_GRACE_MS = 35 * 1000;
  const MAX_OBSERVATION_GAP_MS = 70 * 1000;
  const HISTORY_LIMIT = 100;
  const SUPPORTED_MINUTES = new Set([1, 3, 5, 10, 15, 30, 45, 60]);
  const PRICE_FIELDS = ['open', 'high', 'low', 'close'];

  function normalizeInterval(value) {
    if (typeof value !== 'string') return null;
    const match = value.trim().toLowerCase().match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/);
    if (!match) return null;
    const minutes = Number(match[1]) * (/^h/.test(match[2] || '') ? 60 : 1);
    return SUPPORTED_MINUTES.has(minutes) ? `${minutes}m` : null;
  }

  function normalizeSymbol(value) {
    if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) return null;
    const symbol = value.trim().replace(/\s+/g, ' ').toUpperCase();
    if (!symbol || symbol.length > 120 || !/[A-Z0-9]/.test(symbol)) return null;
    if (/^(UNKNOWN|N\/A|NA|NONE|NULL|SYMBOL|CHART|UNDEFINED)$/.test(symbol)) return null;
    if (/^(MCX|CDS|BCD):/.test(symbol)) return null;
    return symbol;
  }

  function sessionBucket(seenAt, interval) {
    const local = new Date(seenAt + IST_OFFSET_MS);
    const day = local.getUTCDay();
    const sessionStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 3, 45);
    const sessionEnd = sessionStart + 375 * 60 * 1000;
    if (day === 0 || day === 6 || seenAt < sessionStart || seenAt >= sessionEnd) return null;
    const duration = Number.parseInt(interval, 10) * 60 * 1000;
    const start = sessionStart + Math.floor((seenAt - sessionStart) / duration) * duration;
    return { start, end: Math.min(start + duration, sessionEnd), sessionStart };
  }

  function validOhlc(sample) {
    return PRICE_FIELDS.every((field) => typeof sample[field] === 'number' && Number.isFinite(sample[field]) && sample[field] > 0)
      && sample.high >= Math.max(sample.open, sample.close)
      && sample.low <= Math.min(sample.open, sample.close)
      && sample.high >= sample.low;
  }

  function equalPrices(a, b) {
    return PRICE_FIELDS.every((field) => a[field] === b[field]);
  }

  function createTracker() {
    let candles = [];
    let active = null;
    let context = null;
    let lastSeenAt = null;

    function result(reason, updated = false) {
      return { candles: candles.map((candle) => ({ ...candle })), reason, updated };
    }

    function reset() {
      candles = [];
      active = null;
      context = null;
      lastSeenAt = null;
      return result('Waiting for live chart observations.');
    }

    function start(sample, bucket, newContext) {
      context = newContext;
      lastSeenAt = sample.seenAt;
      active = {
        ...sample,
        start: bucket.start,
        end: bucket.end,
        firstSeenAt: sample.seenAt,
        observationCount: 1
      };
    }

    function restart(sample, bucket, newContext, reason) {
      reset();
      start(sample, bucket, newContext);
      return result(reason);
    }

    function observe(value) {
      if (!value || typeof value !== 'object' || !validOhlc(value)
        || typeof value.seenAt !== 'number' || !Number.isSafeInteger(value.seenAt)
        || value.seenAt <= 0 || value.seenAt > 8640000000000000 - IST_OFFSET_MS) {
        reset();
        return result('Invalid chart prices or observation time; waiting for fresh data.');
      }
      const interval = normalizeInterval(value.interval);
      const symbol = normalizeSymbol(value.symbol);
      if (!interval || !symbol) {
        reset();
        return result('A supported intraday interval and an unambiguous NSE/BSE symbol are required.');
      }
      const bucket = sessionBucket(value.seenAt, interval);
      if (!bucket) {
        reset();
        return result('Chart observations are available during 09:15–15:30 IST, Monday–Friday.');
      }
      const sample = { open: value.open, high: value.high, low: value.low, close: value.close, symbol, interval, seenAt: value.seenAt };
      const newContext = `${symbol}|${interval}|${bucket.sessionStart}`;
      if (!active || newContext !== context) {
        return restart(sample, bucket, newContext, context ? 'Chart symbol, interval or trading day changed; collecting fresh candles.' : 'Warming up: observing a complete live chart candle.');
      }
      if (sample.seenAt < lastSeenAt) {
        reset();
        return result('Observation time moved backwards; waiting for fresh chart data.');
      }
      if (sample.seenAt === lastSeenAt) {
        // Duplicate timer callbacks cannot count as independent observations.
        return result('Waiting for the next chart observation.');
      }
      if (sample.seenAt - lastSeenAt > MAX_OBSERVATION_GAP_MS) {
        return restart(sample, bucket, newContext, 'Chart observation gap; collecting a new uninterrupted candle sequence.');
      }
      lastSeenAt = sample.seenAt;

      if (bucket.start === active.start) {
        if (sample.open !== active.open || sample.high < active.high || sample.low > active.low) {
          return restart(sample, bucket, newContext, 'Chart prices changed inconsistently; collecting fresh live candles.');
        }
        Object.assign(active, sample);
        active.observationCount += 1;
        return result('Observing the live candle; waiting for its close.');
      }

      if (bucket.start !== active.end) {
        return restart(sample, bucket, newContext, 'A chart candle was missed; collecting a new uninterrupted sequence.');
      }
      if (sample.seenAt - bucket.start > EDGE_GRACE_MS) {
        return restart(sample, bucket, newContext, 'The next candle arrived too late to verify the previous close.');
      }
      if (equalPrices(sample, active)) {
        // Keep the previous observation untouched during the boundary grace
        // period. Identical values may be a stale legend or a truly flat bar;
        // neither supplies enough evidence to manufacture another candle.
        return result('Waiting for changed chart prices to confirm the candle rollover.');
      }

      const span = active.end - active.start;
      const covered = active.firstSeenAt - active.start <= EDGE_GRACE_MS
        && active.end - active.seenAt <= EDGE_GRACE_MS
        && active.observationCount >= 2
        && active.seenAt - active.firstSeenAt >= Math.max(span / 2, span - 2 * EDGE_GRACE_MS);
      if (!covered) {
        return restart(sample, bucket, newContext, 'The previous candle was only partly observed; waiting for a complete candle.');
      }
      candles.push({
        timestamp: active.start,
        open: active.open,
        high: active.high,
        low: active.low,
        close: active.close,
        symbol: active.symbol,
        interval: active.interval,
        closed: true,
        source: 'observed-chart'
      });
      if (candles.length > HISTORY_LIMIT) candles.shift();
      start(sample, bucket, newContext);
      return result('A complete chart candle was observed.', true);
    }

    return { observe, reset, count: () => candles.length };
  }

  return { createTracker, normalizeInterval };
});
