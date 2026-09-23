(function (root) {
  'use strict';
  function number(text) {
    const cleaned = String(text ?? '').replace(/[₹,]/g, '').trim();
    // Take the main value only; a percentage change on a second line is not OI.
    const match = cleaned.match(/^([+-]?\d+(?:\.\d+)?)\s*(Cr|Lakh|Lac|L|K|M|B)?(?:\s|$|\()/i);
    if (!match || cleaned.slice(0, cleaned.indexOf('\n') < 0 ? undefined : cleaned.indexOf('\n')).includes('%')) return null;
    const scale = { cr: 1e7, lakh: 1e5, lac: 1e5, l: 1e5, k: 1e3, m: 1e6, b: 1e9 };
    return Number(match[1]) * (scale[(match[2] || '').toLowerCase()] || 1);
  }
  function field(label) {
    const text = String(label).toLowerCase().replace(/[_\n]/g, ' ').replace(/\s+/g, ' ').trim();
    if (/change|chg|%|delta|gamma|theta|vega|iv\b/.test(text)) return null;
    if (/strike/.test(text)) return 'strike';
    if (/\boi\b|open interest/.test(text)) return 'oi';
    if (/volume|\bvol\b/.test(text)) return 'volume';
    if (/ltp|last traded|premium/.test(text)) return 'ltp';
    if (/bid/.test(text) && !/qty|quantity|size/.test(text)) return 'bid';
    if (/ask|offer/.test(text) && !/qty|quantity|size/.test(text)) return 'ask';
    return null;
  }
  function parseTable(headers, rows) {
    const kinds = headers.map(field);
    const strike = kinds.indexOf('strike');
    if (strike < 1 || strike !== kinds.lastIndexOf('strike')) throw new Error('Cannot identify a single strike column.');
    const indices = {};
    for (const side of ['call', 'put']) {
      indices[side] = {};
      kinds.forEach((kind, index) => {
        if (!kind || kind === 'strike' || (side === 'call' ? index >= strike : index <= strike)) return;
        if (indices[side][kind] !== undefined) throw new Error('Ambiguous option-chain columns.');
        indices[side][kind] = index;
      });
      for (const required of ['oi', 'volume', 'ltp']) {
        if (indices[side][required] === undefined) throw new Error('Show OI, Volume and LTP columns on both sides of the option chain.');
      }
    }
    const result = [];
    const seen = new Set();
    for (const cells of rows) {
      if (cells.length !== headers.length) continue;
      const price = number(cells[strike]);
      if (!(price > 0)) continue;
      if (seen.has(price)) throw new Error('Duplicate strike rows detected. Wait for the table to finish updating.');
      seen.add(price);
      const item = { strike: price };
      for (const side of ['call', 'put']) {
        const leg = { instrumentKey: `${side}:${price}` };
        for (const [name, index] of Object.entries(indices[side])) {
          let value = number(cells[index]);
          // Some layouts put units in headers rather than each individual cell.
          if (value !== null && ['oi', 'volume'].includes(name) && !/[a-z]/i.test(String(cells[index]))) {
            const unit = headers[index].match(/\b(Cr|Lakh|Lakhs|Lac|L|K|M)\b/i)?.[1]?.toLowerCase();
            value *= ({ cr: 1e7, lakh: 1e5, lakhs: 1e5, lac: 1e5, l: 1e5, k: 1e3, m: 1e6 })[unit] || 1;
          }
          leg[name] = value;
        }
        item[side] = leg;
      }
      if (['call', 'put'].some((side) => ['oi', 'volume', 'ltp'].some((key) => !Number.isFinite(item[side][key]) || item[side][key] < 0))) continue;
      result.push(item);
    }
    if (result.length < 5) throw new Error('Keep at least five complete paired strikes visible (OI, Volume and LTP).');
    return result.sort((a, b) => a.strike - b.strike);
  }
  function expiryText(doc) {
    const selectedDates = [...doc.querySelectorAll('input[type="radio"]')]
      .filter((el) => (typeof el.checked === 'boolean' ? el.checked : el.hasAttribute('checked')) && /^\d{13}$/.test(el.id || ''))
      .map((el) => el.getAttribute('name') || '')
      .filter((name) => /^\d{1,2} [A-Za-z]{3} \d{4}$/.test(name));
    if (selectedDates.length) return selectedDates.length === 1 ? selectedDates[0] : null;
    // Only selected controls explicitly identified as expiry; never scan arbitrary
    // page dates (which may be news dates or an unselected expiry menu).
    const candidates = [...doc.querySelectorAll('select, [role="combobox"], [data-testid*="expiry" i], [data-id*="expiry" i], button[aria-label*="expiry" i]')];
    const values = new Set();
    for (const el of candidates) {
      const identity = `${el.id || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-testid') || ''} ${el.getAttribute('data-id') || ''} ${[...(el.labels || [])].map((label) => label.textContent).join(' ')}`;
      if (!/expiry|expiration/i.test(identity)) continue;
      const value = el.tagName === 'SELECT' ? el.selectedOptions?.[0]?.textContent : el.textContent;
      const text = String(value || '').replace(/\s+/g, ' ').trim();
      if (/\d/.test(text) && text.length < 65) values.add(text);
    }
    return values.size === 1 ? [...values][0] : null;
  }
  function read(doc, href, now = Date.now()) {
    try {
      const url = new URL(href);
      const match = url.pathname.match(/^\/option-chain\/([^/]+)\/([^/]+)\/?$/);
      if (url.protocol !== 'https:' || url.hostname !== 'pro.upstox.com' || (!match && !/^\/option-chain\/?$/.test(url.pathname))) throw new Error('Open the option-chain page for a stock or index.');
      const labels = [...doc.querySelectorAll('[data-id="searchButtonPrefillOC"]')]
        .map((el) => el.textContent.replace(/^\s*Option\s+Chain\s+for\s*/i, '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      if (labels.length > 1) throw new Error('Cannot identify a single selected stock/index.');
      const selectedUnderlying = labels[0] || '';
      const instrumentKey = match ? `${decodeURIComponent(match[1])}|${decodeURIComponent(match[2])}` : selectedUnderlying;
      if (!instrumentKey) throw new Error('Select a stock or index and wait for its option chain to load.');
      const expiry = expiryText(doc);
      if (!expiry) throw new Error('Cannot identify the selected expiry. Keep its selector visible and close any open expiry menu.');
      const tables = [...doc.querySelectorAll('table, [role="table"], [role="grid"]')];
      const snapshots = [];
      // Upstox renders calls and puts in separate tables. Join by strike IDs,
      // never by row position (virtualized tables can have different rows).
      const splitRows = { call: new Map(), put: new Map() };
      const splitHeaders = {};
      for (const [side, prefix] of [['call', 'leftTableOCRow'], ['put', 'rightTableOCRow']]) {
        for (const tr of doc.querySelectorAll(`tr[data-id^="${prefix}"]`)) {
          const strike = Number(tr.getAttribute('data-id').slice(prefix.length));
          if (!(strike > 0) || splitRows[side].has(strike)) throw new Error('Invalid or duplicate option-chain strike.');
          const table = tr.closest('table');
          const headers = [...table.querySelectorAll('thead th')].map((el) => el.textContent.trim());
          if (splitHeaders[side] && JSON.stringify(splitHeaders[side]) !== JSON.stringify(headers)) throw new Error('Ambiguous option-chain tables.');
          splitHeaders[side] = headers;
          const cells = [...tr.querySelectorAll('td')].map((el) => (el.firstElementChild || el).textContent.trim());
          const contract = tr.querySelector('[data-id="buyBtnOC"]')?.id;
          splitRows[side].set(strike, { cells, contract });
        }
      }
      if (splitRows.call.size || splitRows.put.size) {
        if (!splitHeaders.call || !splitHeaders.put) throw new Error('Both call and put tables must be loaded.');
        const paired = [...splitRows.call].filter(([strike]) => splitRows.put.has(strike));
        const headers = [...splitHeaders.call, 'Strike', ...splitHeaders.put];
        const rows = parseTable(headers, paired.map(([strike, call]) => [...call.cells, String(strike), ...splitRows.put.get(strike).cells]));
        for (const row of rows) for (const side of ['call', 'put']) {
          const contract = splitRows[side].get(row.strike).contract;
          if (!contract) throw new Error('Cannot identify the option contracts. Wait for the chain to load.');
          row[side].instrumentKey = contract;
        }
        return { found: true, snapshot: { instrumentKey, selectedUnderlying, expiry, receivedAt: now, rows, source: 'option-chain-dom' }, message: `Read ${rows.length} paired strikes for ${instrumentKey}, expiry ${expiry}.` };
      }
      let failure = 'No readable option-chain table found. Keep the chain table and its headers loaded.';
      for (const table of tables) {
        const headerRows = [...table.querySelectorAll('thead tr, [role="row"]')];
        for (const row of headerRows) {
          const headers = [...row.querySelectorAll('th, [role="columnheader"]')].map((el) => el.innerText || el.textContent || '');
          if (!headers.some((h) => /strike/i.test(h))) continue;
          try {
            const body = [...table.querySelectorAll('tbody tr, [role="row"]')]
              .map((tr) => [...tr.querySelectorAll('td, [role="cell"], [role="gridcell"]')].map((el) => el.innerText || el.textContent || ''));
            const rows = parseTable(headers, body);
            snapshots.push({ instrumentKey, selectedUnderlying, expiry, receivedAt: now, rows, source: 'option-chain-dom' });
          } catch (error) { failure = error.message; }
        }
      }
      if (snapshots.length !== 1) throw new Error(snapshots.length > 1 ? 'Multiple chain tables found; keep one underlying/expiry table open.' : failure);
      return { found: true, snapshot: snapshots[0], message: `Read ${snapshots[0].rows.length} paired strikes for ${instrumentKey}, expiry ${expiry}.` };
    } catch (error) { return { found: false, message: error.message }; }
  }
  const api = { number, field, parseTable, expiryText, read };
  root.UpstoxOptionChainReader = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
