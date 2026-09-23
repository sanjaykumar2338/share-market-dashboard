(function (root) {
  'use strict';

  const VERSION = 'confirmed-v1';
  const MIN_CANDLES = 30;
  const PERIOD = 14;
  const SOURCES = new Set(['upstox-api', 'observed-chart']);

  // These are conservative, inspectable heuristics, not calibrated win probabilities.
  const RULES = Object.freeze({
    fastEma: 9,
    slowEma: 21,
    minSeparationAtr: 0.1,
    minGapAtr: 0.1,
    minDisplacementAtr: 1.2,
    minBodyShare: 0.6,
    maxRangeAtr: 3,
    closeEdgeShare: 0.3,
    minVolumeRatio: 1.2
  });

  function ema(values, period) {
    const result = Array(values.length).fill(null);
    if (!Number.isInteger(period) || period < 1 || values.length < period) return result;
    let average = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
    result[period - 1] = average;
    const multiplier = 2 / (period + 1);
    for (let i = period; i < values.length; i += 1) {
      average += (values[i] - average) * multiplier;
      result[i] = average;
    }
    return result;
  }

  function wilderAtr(candles, period = PERIOD) {
    const ranges = candles.map((candle, index) => index === 0
      ? candle.high - candle.low
      : Math.max(candle.high - candle.low,
        Math.abs(candle.high - candles[index - 1].close),
        Math.abs(candle.low - candles[index - 1].close)));
    const result = Array(candles.length).fill(null);
    if (!Number.isInteger(period) || period < 1 || candles.length < period) return result;
    let average = ranges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
    result[period - 1] = average;
    for (let i = period; i < ranges.length; i += 1) {
      average = ((period - 1) * average + ranges[i]) / period;
      result[i] = average;
    }
    return result;
  }

  function wilderRsi(values, period = PERIOD) {
    const result = Array(values.length).fill(null);
    if (!Number.isInteger(period) || period < 1 || values.length <= period) return result;
    let gain = 0;
    let loss = 0;
    for (let i = 1; i <= period; i += 1) {
      const change = values[i] - values[i - 1];
      gain += Math.max(change, 0);
      loss += Math.max(-change, 0);
    }
    gain /= period;
    loss /= period;
    const score = () => gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    result[period] = score();
    for (let i = period + 1; i < values.length; i += 1) {
      const change = values[i] - values[i - 1];
      gain = ((period - 1) * gain + Math.max(change, 0)) / period;
      loss = ((period - 1) * loss + Math.max(-change, 0)) / period;
      result[i] = score();
    }
    return result;
  }

  function intervalMilliseconds(interval) {
    const match = /^(\d{1,2})(m|h)$/.exec(interval || '');
    if (!match) return null;
    const value = Number(match[1]);
    if (value < 1 || value > (match[2] === 'm' ? 60 : 5)) return null;
    return value * (match[2] === 'm' ? 60_000 : 3_600_000);
  }

  function result(status, reason, metrics) {
    return { signals: [], status, reason, ...(metrics ? { metrics } : {}) };
  }

  function validate(candles, now) {
    if (!Array.isArray(candles)) return result('invalid-data', 'Candle history must be an array.');
    if (!Number.isFinite(now)) return result('invalid-data', 'A valid current timestamp is required.');
    if (!candles.length) return result('warming-up', `Waiting for ${MIN_CANDLES} consecutive closed candles.`);
    const first = candles[0];
    const duration = intervalMilliseconds(first?.interval);
    if (!duration) return result('invalid-data', 'A known minute or hour candle interval is required.');
    if (typeof first.symbol !== 'string' || !first.symbol.trim() || /^(unknown|n\/a|--?)$/i.test(first.symbol.trim())) {
      return result('invalid-data', 'A known symbol is required.');
    }
    for (let i = 0; i < candles.length; i += 1) {
      const candle = candles[i];
      if (!candle || ['open', 'high', 'low', 'close'].some((field) => !Number.isFinite(candle[field]) || candle[field] <= 0)) {
        return result('invalid-data', 'Every candle must contain positive numeric OHLC values.');
      }
      if (candle.high < Math.max(candle.open, candle.close, candle.low) || candle.low > Math.min(candle.open, candle.close)) {
        return result('invalid-data', 'Inconsistent candle high, low, open, or close.');
      }
      if (candle.symbol !== first.symbol || candle.interval !== first.interval) {
        return result('invalid-data', 'Candle history contains mixed symbols or intervals.');
      }
      if (!SOURCES.has(candle.source)) return result('invalid-data', 'The candle data source is unknown.');
      if (candle.source !== first.source) return result('invalid-data', 'Candle history contains mixed data sources.');
      if (candle.closed !== true) return result('invalid-data', 'Only candles with a recorded interval close can generate a signal.');
      if (!Number.isSafeInteger(candle.timestamp) || candle.timestamp <= 0 || candle.timestamp + duration > now) {
        return result('invalid-data', 'A candle timestamp is missing, in the future, or still forming.');
      }
      if (i > 0 && candle.timestamp - candles[i - 1].timestamp !== duration) {
        return result('invalid-data', 'Candle timestamps must be ordered and consecutive, without duplicates or gaps.');
      }
      if (candle.volume != null && (!Number.isFinite(candle.volume) || candle.volume < 0)) {
        return result('invalid-data', 'Candle volume must be a non-negative number when available.');
      }
    }
    if (now - (candles[candles.length - 1].timestamp + duration) > 2 * duration) {
      return result('stale-data', first.source === 'observed-chart'
        ? 'The latest observed interval close is stale; waiting for fresh data.'
        : 'The latest closed feed candle is stale; waiting for fresh data.');
    }
    if (candles.length < MIN_CANDLES) {
      const candleDescription = first.source === 'observed-chart' ? 'observed interval closes' : 'closed feed candles';
      return result('warming-up', `Waiting for ${MIN_CANDLES} consecutive ${candleDescription} (${candles.length}/${MIN_CANDLES}).`);
    }
    return null;
  }

  function isDisplacement(candle, direction, atr) {
    const range = candle.high - candle.low;
    return direction * (candle.close - candle.open) > 0 && range > 0 &&
      Math.abs(candle.close - candle.open) / range >= RULES.minBodyShare &&
      range >= RULES.minDisplacementAtr * atr && range <= RULES.maxRangeAtr * atr;
  }

  function breaksStructure(candles, index, direction) {
    const prior = candles.slice(index - 5, index);
    return prior.length === 5 && (direction > 0
      ? candles[index].close > Math.max(...prior.map((candle) => candle.high))
      : candles[index].close < Math.min(...prior.map((candle) => candle.low)));
  }

  function patternCandidates(candles, atr, options, direction) {
    const index = candles.length - 1;
    const [a, b, c] = candles.slice(-3);
    const prefix = direction > 0 ? 'Bullish' : 'Bearish';
    const candidates = [];
    if (options.fvgEnabled !== false) {
      const gap = direction > 0 ? c.low - a.high : a.low - c.high;
      if (gap >= RULES.minGapAtr * atr && isDisplacement(b, direction, atr)) {
        candidates.push({ name: `${prefix} FVG`, low: direction > 0 ? a.high : c.high,
          high: direction > 0 ? c.low : a.low,
          reason: `${prefix} three-candle FVG of at least 0.10 ATR, with a strong middle candle.` });
      }
    }
    if (options.orderBlockEnabled !== false) {
      // A block can confirm on the displacement close or the following close.
      // The latter lets one alert describe an overlapping FVG and order block.
      for (const displacementIndex of [index, index - 1]) {
        const displacement = candles[displacementIndex];
        const origin = candles[displacementIndex - 1];
        if (direction * (origin.close - origin.open) < 0 &&
          isDisplacement(displacement, direction, atr) && breaksStructure(candles, displacementIndex, direction)) {
          candidates.push({ name: `${prefix} Order Block`, low: origin.low, high: origin.high,
            reason: `${prefix} order block followed by displacement and a five-candle structure break.` });
          break;
        }
      }
    }
    return candidates;
  }

  function evaluate(candleHistory, options = {}) {
    if (options.fvgEnabled === false && options.orderBlockEnabled === false) {
      return result('disabled', 'FVG and order block signals are disabled.');
    }
    const now = options.now ?? Date.now();
    const invalid = validate(candleHistory, now);
    if (invalid) return invalid;
    // Keep the seed consistent: use the complete contiguous input history.
    const candles = candleHistory;
    const closes = candles.map((candle) => candle.close);
    const fast = ema(closes, RULES.fastEma);
    const slow = ema(closes, RULES.slowEma);
    const atrValues = wilderAtr(candles);
    const rsiValues = wilderRsi(closes);
    const index = candles.length - 1;
    const candle = candles[index];
    const atr = atrValues[index];
    const rsi = rsiValues[index];
    const range = candle.high - candle.low;
    const priorVolumeCandles = candles.slice(-21, -1);
    const volumeAvailable = priorVolumeCandles.every((entry) => Number.isFinite(entry.volume) && entry.volume > 0) &&
      Number.isFinite(candle.volume) && candle.volume >= 0;
    const priorVolume = volumeAvailable
      ? priorVolumeCandles.reduce((sum, entry) => sum + entry.volume, 0) / 20 : null;
    const volumeRatio = volumeAvailable ? candle.volume / priorVolume : null;
    const metrics = {
      emaFast: fast[index], emaSlow: slow[index],
      emaFastSlope: fast[index] - fast[index - 1], emaSlowSlope: slow[index] - slow[index - 1],
      atr, rsi, emaSeparationAtr: atr > 0 ? Math.abs(fast[index] - slow[index]) / atr : 0,
      rangeAtr: atr > 0 ? range / atr : 0, volumeAvailable,
      volumeConfirmed: volumeAvailable && volumeRatio >= RULES.minVolumeRatio, volumeRatio
    };
    const noSignal = (reason) => result('no-signal', reason, metrics);
    if (!(atr > 0) || !(range > 0)) return noSignal('No meaningful candle range or ATR is available.');
    if (range > RULES.maxRangeAtr * atr) return noSignal('The latest candle exceeds the 3 ATR range limit.');
    const direction = fast[index] > slow[index] && metrics.emaFastSlope > 0 && metrics.emaSlowSlope > 0 ? 1
      : fast[index] < slow[index] && metrics.emaFastSlope < 0 && metrics.emaSlowSlope < 0 ? -1 : 0;
    if (!direction) return noSignal('EMA 9 and EMA 21 are not aligned with a shared trend direction.');
    if (metrics.emaSeparationAtr < RULES.minSeparationAtr) return noSignal('EMA separation is below 0.10 ATR; the trend is too narrow.');
    if (!breaksStructure(candles, index, direction)) return noSignal('The close has not broken the prior five-candle structure.');
    const closePlacement = direction > 0 ? (candle.high - candle.close) / range : (candle.close - candle.low) / range;
    if (closePlacement > RULES.closeEdgeShare) return noSignal('The close is outside the directional outer 30% of the candle.');
    if (direction > 0 ? rsi < 52 || rsi > 78 : rsi < 22 || rsi > 48) {
      return noSignal('RSI is outside the directional momentum range.');
    }
    if (volumeAvailable && !metrics.volumeConfirmed) return noSignal('Volume is below 1.2 times the preceding 20-candle average.');
    const candidates = patternCandidates(candles, atr, options, direction);
    if (!candidates.length) return noSignal('No enabled FVG or order block meets the displacement and size filters.');

    const action = direction > 0 ? 'BUY' : 'SELL';
    const pattern = candidates.map((candidate) => candidate.name).join(' + ');
    const formatPrice = (value) => value.toLocaleString('en-IN', { maximumFractionDigits: 4 });
    const zones = candidates.map((candidate) => `${formatPrice(candidate.low)} - ${formatPrice(candidate.high)}`);
    const priceRange = [...new Set(zones)].join(' / ');
    const reasons = [
      candle.source === 'observed-chart' ? `Observed ${candle.interval} interval close from chart snapshots.`
        : `Closed ${candle.interval} feed candle confirmed.`,
      `EMA 9 is ${direction > 0 ? 'above' : 'below'} EMA 21; both are ${direction > 0 ? 'rising' : 'falling'}.`,
      'EMA separation is at least 0.10 ATR.',
      `Close breaks the prior five-candle ${direction > 0 ? 'high' : 'low'}.`,
      `RSI ${rsi.toFixed(1)} is within the ${action} momentum range (${direction > 0 ? '52–78' : '22–48'}).`,
      `Close is in the ${direction > 0 ? 'top' : 'bottom'} 30% of the candle; range is at most 3 ATR.`,
      ...candidates.map((candidate) => candidate.reason),
      volumeAvailable ? `Volume is ${volumeRatio.toFixed(2)} times its preceding 20-candle average.`
        : 'Reliable volume is unavailable; volume confirmation was not used.'
    ];
    const signal = {
      action, type: pattern, pattern, symbol: candle.symbol, interval: candle.interval, priceRange,
      key: `${VERSION}:${encodeURIComponent(candle.symbol)}:${candle.interval}:${candle.timestamp}:${action}`,
      barTime: candle.timestamp, candleClosedAt: candle.timestamp + intervalMilliseconds(candle.interval),
      source: candle.source, confirmation: candle.source === 'upstox-api' ? 'closed-feed' : 'observed-close',
      reasons, metrics
    };
    const closeDescription = candle.source === 'observed-chart' ? 'detected at an observed interval close' : 'confirmed on a closed feed candle';
    return { signals: [signal], status: 'signal', reason: `${action}: ${pattern} ${closeDescription}.`, metrics };
  }

  const engine = Object.freeze({ VERSION, MIN_CANDLES, RULES, evaluate,
    intervalMilliseconds, indicators: Object.freeze({ ema, wilderAtr, wilderRsi }) });
  if (typeof module !== 'undefined' && module.exports) module.exports = engine;
  root.UpstoxSignalEngine = engine;
})(globalThis);
