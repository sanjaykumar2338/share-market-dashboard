(function (root) {
  'use strict';
  const VERSION = 'option-chain-page-v1';
  const RULES = Object.freeze({ minOiChange: 0.005, minPremiumChange: 0.005,
    maxSpread: 0.05, minOi: 100,
    minSampleGap: 25000, maxSampleGap: 75000, maxAge: 45000 });
  const dateKey = (time) => new Date(time + 330 * 60000).toISOString().slice(0, 10);
  const hasQuotes = (leg) => Number.isFinite(leg?.bid) && Number.isFinite(leg?.ask);
  const midpoint = (leg) => hasQuotes(leg) ? (leg.bid + leg.ask) / 2 : leg.ltp;
  const liquid = (leg) => leg && Number.isFinite(leg.oi) && leg.oi >= RULES.minOi
    && Number.isFinite(leg.volume) && leg.volume > 0 && Number.isFinite(leg.ltp) && leg.ltp > 0
    && (!hasQuotes(leg) || (leg.bid > 0 && leg.ask >= leg.bid && (leg.ask - leg.bid) / midpoint(leg) <= RULES.maxSpread));
  function evaluate(snapshots, now = Date.now()) {
    const no = (reason) => ({ signals: [], reason });
    if (!Array.isArray(snapshots) || snapshots.length < 3) return no('Gathering three option-chain snapshots (about one minute).');
    const samples = snapshots.slice(-3);
    const first = samples[0];
    const last = samples[2];
    if (!Number.isFinite(now) || samples.some((s) => !s || !Number.isFinite(s.receivedAt) || s.receivedAt > now
      || !Array.isArray(s.rows) || s.source !== 'option-chain-dom'
      || s.instrumentKey !== first.instrumentKey || s.expiry !== first.expiry
      || s.selectedUnderlying !== first.selectedUnderlying
      || dateKey(s.receivedAt) !== dateKey(now))) return no('Invalid or mixed option-chain snapshots.');
    if (now - last.receivedAt > RULES.maxAge) return no('Latest option-chain snapshot is stale.');
    for (let i = 1; i < 3; i += 1) {
      const gap = samples[i].receivedAt - samples[i - 1].receivedAt;
      if (gap < RULES.minSampleGap || gap > RULES.maxSampleGap) return no('Waiting for continuous option-chain samples about 30 seconds apart.');
    }
    const ordered = [...first.rows].sort((a, b) => a.strike - b.strike);
    const center = Math.max(0, Math.floor((ordered.length - 5) / 2));
    const nearby = ordered.slice(center, center + 5);
    if (nearby.length < 5) return no('Five matching visible central strikes are required.');
    const selected = samples.map((s) => nearby.map((row) => s.rows.find((r) => r.strike === row.strike)));
    if (selected.some((rows) => rows.some((r) => !r || !liquid(r.call) || !liquid(r.put)))) {
      return no('Visible central quotes need positive OI, trading volume and premiums; when bid/ask is shown, spreads must be at most 5%.');
    }
    const votes = [];
    for (let step = 1; step < 3; step += 1) {
      let buyVotes = 0;
      let sellVotes = 0;
      for (let i = 0; i < 5; i += 1) {
        const before = selected[step - 1][i];
        const after = selected[step][i];
        if (hasQuotes(before.call) !== hasQuotes(after.call) || hasQuotes(before.put) !== hasQuotes(after.put)
          || before.call.instrumentKey !== after.call.instrumentKey || before.put.instrumentKey !== after.put.instrumentKey
          || after.call.volume < before.call.volume || after.put.volume < before.put.volume) {
          return no('Contracts or cumulative volume changed inconsistently. Waiting for fresh snapshots.');
        }
        const callOi = after.call.oi / before.call.oi - 1;
        const putOi = after.put.oi / before.put.oi - 1;
        const callPrice = midpoint(after.call) / midpoint(before.call) - 1;
        const putPrice = midpoint(after.put) / midpoint(before.put) - 1;
        if (callOi >= RULES.minOiChange && putOi >= RULES.minOiChange
          && after.call.volume > before.call.volume && after.put.volume > before.put.volume) {
          if (callPrice >= RULES.minPremiumChange && putPrice <= -RULES.minPremiumChange) buyVotes += 1;
          if (callPrice <= -RULES.minPremiumChange && putPrice >= RULES.minPremiumChange) sellVotes += 1;
        }
      }
      const direction = buyVotes >= 3 ? 1 : sellVotes >= 3 ? -1 : 0;
      if (!direction) return no('Waiting for OI, call/put premiums and volume to agree at three of five visible central strikes.');
      votes.push({ direction, agreeing: Math.max(buyVotes, sellVotes) });
    }
    if (votes[0].direction !== votes[1].direction) return no('Option-chain direction reversed; waiting for stable confirmation.');
    const action = votes[1].direction > 0 ? 'BUY' : 'SELL';
    const callOi = selected[2].reduce((sum, row) => sum + row.call.oi, 0);
    const putOi = selected[2].reduce((sum, row) => sum + row.put.oi, 0);
    const reasons = [
      `${action === 'BUY' ? 'Bullish' : 'Bearish'} underlying bias from option-chain data only.`,
      `Two consecutive snapshot comparisons agree at ${votes.map((v) => v.agreeing).join(' then ')} of five visible central strikes.`,
      'Call and put OI each increased at least 0.5%; opposing premium moves are at least 0.5%, with increasing traded volume.',
      selected.every((rows) => rows.every((r) => hasQuotes(r.call) && hasQuotes(r.put)))
        ? 'Displayed bid/ask spreads are at most 5%.'
        : 'Bid/ask is not displayed for every contract; liquidity checks use visible OI and volume only.',
      `Visible-strike OI put/call ratio: ${(putOi / callOi).toFixed(2)} (context only, not a probability).`
    ];
    return { reason: `${action}: option-chain confirmations agree.`, signals: [{
      action, type: 'Option-chain confirmation', pattern: 'Option-chain confirmation',
      symbol: last.instrumentKey, interval: '30s snapshots', expiry: last.expiry,
      priceRange: `Strikes ${nearby[0].strike} - ${nearby.at(-1).strike}`,
      key: `${VERSION}:${last.instrumentKey}:${last.expiry}:${Math.floor(last.receivedAt / 30000)}:${action}`,
      observedAt: last.receivedAt, source: 'option-chain-dom', confirmation: 'page-snapshots',
      reasons, metrics: { pcr: putOi / callOi, strikes: nearby.map((r) => r.strike), votes }
    }] };
  }
  const api = Object.freeze({ VERSION, RULES, evaluate });
  root.UpstoxOptionChain = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
