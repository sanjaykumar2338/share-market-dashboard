(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UpstoxCandles = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const INTERVAL_MINUTES = Object.freeze({ '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30 });
  const CLOSE_GRACE_MS = 3000;
  const REQUEST_TIMEOUT_MS = 10000;
  const IST_OFFSET_MS = 330 * 60 * 1000;
  const HISTORY_LIMIT = 100;

  class CandleDataError extends Error {
    constructor(message, code) {
      super(message);
      this.name = 'CandleDataError';
      this.code = code;
    }
  }

  function intervalMinutes(interval) {
    if (!Object.prototype.hasOwnProperty.call(INTERVAL_MINUTES, interval)) {
      throw new CandleDataError('Choose a supported candle interval: 1m, 3m, 5m, 15m or 30m.', 'INVALID_INTERVAL');
    }
    return INTERVAL_MINUTES[interval];
  }

  function validateInstrumentKey(instrumentKey) {
    if (typeof instrumentKey !== 'string'
      || !/^[A-Z][A-Z0-9_]{1,24}\|[A-Za-z0-9][A-Za-z0-9 _&().:+-]{0,159}$/.test(instrumentKey)) {
      throw new CandleDataError('Enter an Upstox instrument key such as NSE_INDEX|Nifty 50.', 'INVALID_INSTRUMENT');
    }
    return instrumentKey;
  }

  function validateNow(now) {
    if (!Number.isFinite(now) || now <= 0 || !Number.isFinite(new Date(now + IST_OFFSET_MS).getTime())) {
      throw new CandleDataError('The current time is invalid. Check your computer clock.', 'INVALID_TIME');
    }
  }

  function dateKey(timestamp) {
    return new Date(timestamp + IST_OFFSET_MS).toISOString().slice(0, 10);
  }

  function parseTimestamp(value) {
    // Upstox supplies the candle's opening time as an ISO timestamp with an
    // explicit timezone. Reject ambiguous local dates instead of guessing.
    const match = typeof value === 'string'
      && value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/);
    if (!match) {
      throw new CandleDataError('Upstox returned an invalid candle timestamp. No signals were evaluated.', 'INVALID_CANDLES');
    }
    const timestamp = Date.parse(value);
    const calendarDate = new Date(`${match[1]}T00:00:00Z`);
    if (!Number.isFinite(timestamp) || !Number.isFinite(calendarDate.getTime())
      || calendarDate.toISOString().slice(0, 10) !== match[1]
      || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) {
      throw new CandleDataError('Upstox returned an invalid candle timestamp. No signals were evaluated.', 'INVALID_CANDLES');
    }
    return timestamp;
  }

  function normalizeCandles(rows, { instrumentKey, interval = '1m', now = Date.now() } = {}) {
    const durationMs = intervalMinutes(interval) * 60000;
    validateInstrumentKey(instrumentKey);
    validateNow(now);
    if (!Array.isArray(rows)) {
      throw new CandleDataError('Upstox returned an unexpected candle response. Try again shortly.', 'INVALID_RESPONSE');
    }

    const today = dateKey(now);
    const byTimestamp = new Map();
    for (const row of rows) {
      if (!Array.isArray(row)) {
        throw new CandleDataError('Upstox returned malformed candle data. No signals were evaluated.', 'INVALID_CANDLES');
      }
      const timestamp = parseTimestamp(row[0]);
      if (dateKey(timestamp) !== today || timestamp + durationMs + CLOSE_GRACE_MS > now) continue;

      const [, open, high, low, close, rawVolume] = row;
      const volume = rawVolume == null ? undefined : rawVolume;
      if (![open, high, low, close].every((value) => Number.isFinite(value) && value > 0)
        || high < Math.max(open, low, close) || low > Math.min(open, close)
        || (volume !== undefined && (!Number.isFinite(volume) || volume < 0))) {
        throw new CandleDataError('Upstox returned invalid completed-candle prices or volume. No signals were evaluated.', 'INVALID_CANDLES');
      }

      const candle = {
        timestamp, open, high, low, close, volume,
        symbol: instrumentKey, interval, closed: true, source: 'upstox-api'
      };
      const previous = byTimestamp.get(timestamp);
      if (previous && ['open', 'high', 'low', 'close', 'volume'].some((key) => previous[key] !== candle[key])) {
        throw new CandleDataError('Upstox returned conflicting candles for the same time. No signals were evaluated.', 'CONFLICTING_CANDLES');
      }
      byTimestamp.set(timestamp, candle);
    }

    return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-HISTORY_LIMIT);
  }

  async function fetchClosedCandles({
    accessToken, instrumentKey, interval = '1m', now = Date.now(), fetchImpl = globalThis.fetch
  } = {}) {
    const minutes = intervalMinutes(interval);
    validateInstrumentKey(instrumentKey);
    validateNow(now);
    const token = typeof accessToken === 'string' ? accessToken.trim() : '';
    if (!token || token.length > 8192 || !/^[A-Za-z0-9._~+/-]+=*$/.test(token)) {
      throw new CandleDataError('Add a valid Upstox access token to enable verified candle signals.', 'AUTH_REQUIRED');
    }
    if (typeof fetchImpl !== 'function') {
      throw new CandleDataError('Candle requests are unavailable in this browser.', 'NETWORK_ERROR');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(
        `https://api.upstox.com/v3/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/minutes/${minutes}`,
        {
          method: 'GET',
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          signal: controller.signal
        }
      );
      if (response?.status === 401 || response?.status === 403) {
        throw new CandleDataError('Upstox authentication failed or the token expired. Update your access token.', 'AUTH_REQUIRED');
      }
      if (response?.status === 429) {
        throw new CandleDataError('Upstox request limit reached. Wait before scanning again.', 'RATE_LIMITED');
      }
      if (!response?.ok) {
        throw new CandleDataError('Upstox could not provide candles. Check the instrument key and try again shortly.', 'API_ERROR');
      }

      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError') throw error;
        throw new CandleDataError('Upstox returned an unreadable candle response. Try again shortly.', 'INVALID_RESPONSE');
      }
      if (payload?.status !== 'success' || !Array.isArray(payload?.data?.candles)) {
        throw new CandleDataError('Upstox returned an unexpected candle response. Try again shortly.', 'INVALID_RESPONSE');
      }
      return normalizeCandles(payload.data.candles, { instrumentKey, interval, now });
    } catch (error) {
      if (error instanceof CandleDataError) throw error;
      if (controller.signal.aborted || error?.name === 'AbortError') {
        throw new CandleDataError('Upstox candle request timed out. Check your connection and try again.', 'TIMEOUT');
      }
      // Never propagate a raw fetch error or response body: either can contain
      // request headers, credentials or other account details.
      throw new CandleDataError('Could not connect to Upstox for candle data. Check your connection and try again.', 'NETWORK_ERROR');
    } finally {
      clearTimeout(timeout);
    }
  }

  return Object.freeze({ fetchClosedCandles, normalizeCandles, CandleDataError });
});
