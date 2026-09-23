const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const reader = require('../option-chain-reader.js');
const engine = require('../option-chain.js');
const now = Date.parse('2026-09-23T10:00:00+05:30');
const headers = ['Volume', 'OI', 'LTP', 'Strike price', 'LTP', 'OI', 'Volume'];
test('reads supplied Upstox split tables without mixing percentage changes into values', () => {
  const { parseHTML } = require('linkedom');
  const { document } = parseHTML(fs.readFileSync(path.join(__dirname, '../sample-oi-data.html'), 'utf8'));
  const url = 'https://pro.upstox.com/option-chain/NSE_INDEX/Nifty%2050';
  const result = reader.read(document, url, now);
  assert.equal(result.found, true, result.message);
  assert.equal(result.snapshot.expiry, '29 Sep 2026');
  const row = result.snapshot.rows.find((row) => row.strike === 22950);
  assert.deepEqual(row.call, { instrumentKey: 'NSE_FO|73901', volume: 23400, oi: 10000, ltp: 476.3 });
  assert.deepEqual(row.put, { instrumentKey: 'NSE_FO|73902', volume: 5759000, oi: 908000, ltp: 19.2 });
  const frozen = [0, 1, 2].map((step) => ({ ...result.snapshot, receivedAt: now - 60000 + step * 30000 }));
  assert.equal(engine.evaluate(frozen, now).signals.length, 0);
  document.querySelector('tr[data-id="rightTableOCRow22950"]').remove();
  const partial = reader.read(document, url, now);
  assert.equal(partial.found, true);
  assert.equal(partial.snapshot.rows.some((row) => row.strike === 22950), false);
  document.querySelector('input[checked]').removeAttribute('checked');
  assert.equal(reader.read(document, url, now).found, false);
});
function snapshot(step, direction = 1) {
  const rows = Array.from({ length: 5 }, (_, i) => [
    String(1000 + step * 100), String(10000 + step * 100), String(100 + direction * step * 2),
    String(23000 + i * 50), String(100 - direction * step * 2), String(10000 + step * 100), String(1000 + step * 100)
  ]);
  return { instrumentKey: 'NSE_INDEX|Nifty 50', expiry: '29 Sep 2026', receivedAt: now - 60000 + step * 30000,
    rows: reader.parseTable(headers, rows), source: 'option-chain-dom' };
}
test('reads Indian numeric units and rejects percentages as absolute values', () => {
  assert.equal(reader.number('1.25 Cr'), 12500000);
  assert.equal(reader.number('2.4L'), 240000);
  assert.equal(reader.number('₹23,500.50'), 23500.5);
  assert.equal(reader.number('1,234\n(+5.4%)'), 1234);
  assert.equal(reader.number('23.5%'), null);
  assert.equal(reader.number('--'), null);
  assert.equal(reader.field('OI change %'), null);
});
test('column order follows headers on either side of strike', () => {
  const row = snapshot(0).rows[0];
  assert.equal(row.call.volume, 1000);
  assert.equal(row.put.oi, 10000);
  assert.equal(row.strike, 23000);
  assert.throws(() => reader.parseTable(['OI', 'Strike', 'OI'], []), /Volume/);
});
test('DOM adapter reads selected expiry and table, and blocks unidentifiable expiry', () => {
  const headerRow = { querySelectorAll: () => headers.map((textContent) => ({ textContent })) };
  const rows = Array.from({ length: 5 }, (_, i) => ({ querySelectorAll: () =>
    ['1000', '10000', '100', String(23000 + i * 50), '100', '10000', '1000'].map((textContent) => ({ textContent })) }));
  const table = { querySelectorAll: (selector) => selector.startsWith('thead') ? [headerRow] : rows };
  const expiry = { id: 'expiry', tagName: 'SELECT', selectedOptions: [{ textContent: '29 Sep 2026' }], getAttribute: () => '' };
  const doc = { querySelectorAll: (selector) => selector.startsWith('select') ? [expiry] : selector.startsWith('table,') ? [table] : [] };
  const url = 'https://pro.upstox.com/option-chain/NSE_INDEX/Nifty%2050';
  const result = reader.read(doc, url, now);
  assert.equal(result.found, true);
  assert.equal(result.snapshot.instrumentKey, 'NSE_INDEX|Nifty 50');
  assert.equal(result.snapshot.rows.length, 5);
  expiry.id = '';
  assert.equal(reader.read(doc, url, now).found, false);
  assert.equal(reader.read(doc, 'https://pro.upstox.com/trading-charts', now).found, false);
});
test('units in column headings scale absolute quantities', () => {
  const unitHeaders = ['Volume (K)', 'OI (Lakh)', 'LTP', 'Strike', 'LTP', 'OI (Lakh)', 'Volume (K)'];
  const rows = Array.from({ length: 5 }, (_, i) => ['2', '1.2', '100', String(23000 + i * 50), '100', '1.2', '2']);
  assert.equal(reader.parseTable(unitHeaders, rows)[0].call.oi, 120000);
  assert.equal(reader.parseTable(unitHeaders, rows)[0].put.volume, 2000);
});
test('requires five paired complete strikes and rejects duplicate strikes', () => {
  assert.throws(() => reader.parseTable(headers, []), /five/);
  const cells = ['100', '1000', '10', '23000', '10', '1000', '100'];
  assert.throws(() => reader.parseTable(headers, [cells, cells]), /Duplicate/);
});
for (const [direction, action] of [[1, 'BUY'], [-1, 'SELL']]) {
  test(`${action} uses page OI, volume and option premiums only`, () => {
    const result = engine.evaluate([0, 1, 2].map((i) => snapshot(i, direction)), now);
    assert.equal(result.signals.length, 1);
    assert.equal(result.signals[0].action, action);
    assert.equal(result.signals[0].source, 'option-chain-dom');
    assert.match(result.signals[0].reasons.join(' '), /Bid\/ask is not displayed/);
  });
}
test('unchanged page values never become a signal through repeated polling', () => {
  const samples = [0, 1, 2].map((i) => ({ ...snapshot(0), receivedAt: now - 60000 + i * 30000 }));
  assert.equal(engine.evaluate(samples, now).signals.length, 0);
});
test('mixed underlying, expiry, missing rows, stale reads and rapid retries are blocked', () => {
  for (const mutate of [
    (s) => { s[1].instrumentKey = 'NSE_INDEX|Nifty Bank'; },
    (s) => { s[1].expiry = '06 Oct 2026'; },
    (s) => { s[1].rows.pop(); },
    (s) => { s[2].receivedAt = s[1].receivedAt + 1000; },
    (s) => { s[1].source = 'observed-chart'; },
    (s) => { s[1].rows[0].call.volume = 0; }
  ]) {
    const samples = [0, 1, 2].map((i) => snapshot(i)); mutate(samples);
    assert.equal(engine.evaluate(samples, now).signals.length, 0);
  }
  assert.equal(engine.evaluate([0, 1, 2].map((i) => snapshot(i)), now + 60000).signals.length, 0);
});
test('wide displayed spreads and changing quote types are blocked', () => {
  const samples = [0, 1, 2].map((i) => snapshot(i));
  for (const s of samples) for (const row of s.rows) {
    row.call.bid = 10; row.call.ask = 20;
  }
  assert.equal(engine.evaluate(samples, now).signals.length, 0);
});
test('popup references only existing controls and loads no chart decision modules', () => {
  const html = fs.readFileSync(path.join(__dirname, '../popup.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '../popup.js'), 'utf8');
  for (const [, id] of script.matchAll(/getElementById\('([^']+)'\)/g)) assert.ok(html.includes(`id="${id}"`), id);
  assert.doesNotMatch(html, /type="password"|signalAccessToken|Chart Pattern Alerts/);
  assert.doesNotMatch(html + script, /startScannerButton|stopScannerButton|SCAN_SIGNALS_NOW/);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../manifest.json'), 'utf8'));
  assert.deepEqual(manifest.content_scripts[0].js, ['content.js']);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8'), /api\.upstox|fetchSnapshot|UpstoxCandles|UpstoxSignalEngine/);
});

function worker(url = 'https://pro.upstox.com/option-chain/NSE_INDEX/Nifty%2050') {
  const local = { autoScannerEnabled: true, chartScreenshotsEnabled: false };
  const session = {};
  const store = (data) => ({
    get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in data).map((k) => [k, structuredClone(data[k])])),
    set: async (value) => Object.assign(data, structuredClone(value)),
    remove: async (keys) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }
  });
  const event = { addListener() {}, removeListener() {} };
  const tab = { id: 1, url, active: false };
  let time = now - 60000;
  let index = 0;
  const effects = [];
  let alarmListener;
  const alarms = [];
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [time])); } static now() { return time; } }
  const context = vm.createContext({ Date: Clock, Intl, URL, console, setTimeout, clearTimeout,
    chrome: {
      runtime: { onMessage: event, onInstalled: event, onStartup: event, getURL: (p) => 'chrome-extension://test/' + p },
      storage: { local: store(local), session: store(session), onChanged: event },
      alarms: { onAlarm: { addListener(fn) { alarmListener = fn; } }, get: async () => undefined,
        create: async (name, options) => { alarms.push({ name, ...options }); }, clear: async () => {} },
      tabs: { onUpdated: event, query: async (query) => {
        assert.equal(query.active, undefined, 'Scanning must include inactive tabs');
        return [tab];
      }, get: async () => tab, update: async (_id, props) => {
        assert.equal(props.active, undefined, 'Scanning must not activate the tab');
        assert.equal(props.autoDiscardable, false, 'Keep the chain tab resident');
      } },
      scripting: { executeScript: async (args) => args.files ? [] : [{ result: { found: true, snapshot: snapshot(index), message: 'read' } }] }
    },
    fetch: () => { throw new Error('Unexpected external network request'); },
    importScripts: (...files) => files.forEach((file) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context))
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8'), context);
  context.mark = (type) => { effects.push(type); return { ok: true }; };
  vm.runInContext("showNotification = async () => mark('notification'); playSignalVoice = async () => mark('voice'); sendSignalToDiscord = async () => mark('discord');", context);
  return { local, effects, context, alarms, tick: async (i) => {
    index = i; time = now - 60000 + i * 30000;
    alarmListener({ name: vm.runInContext('BACKGROUND_SCANNER_ALARM_NAME', context) });
    await vm.runInContext('apiScanPromise', context);
  }, scan: async (i) => { index = i; time = now - 60000 + i * 30000; return vm.runInContext('scanUpstoxTabsInBackground()', context); } };
}
test('automatic alarms store history despite legacy stop setting and notifications off', async () => {
  const w = worker();
  w.local.autoScannerEnabled = false;
  w.local.notificationsEnabled = false;
  w.local.discordSignalsEnabled = false;
  await new Promise(setImmediate);
  assert.ok(w.alarms.some((alarm) => alarm.periodInMinutes === 0.5));
  for (const i of [0, 1, 2]) await w.tick(i);
  assert.equal(w.local.signalHistory.length, 1);
  assert.equal(w.local.signalHistory[0].source, 'option-chain-dom');
  assert.match(w.local.signalHistory[0].message, /Bullish option-chain confirmation/);
  assert.doesNotMatch(w.local.signalHistory[0].message, /Dummy|FVG/);
  const historyScript = fs.readFileSync(path.join(__dirname, '../signal-history.js'), 'utf8');
  assert.match(historyScript, /SIGNAL_HISTORY_KEY = 'signalHistory'/);
  assert.match(historyScript, /chrome\.storage\.onChanged\.addListener/);
});
test('startup removes only preview records and preserves genuine history', async () => {
  const w = worker();
  w.local.signalHistory = [
    { id: 'preview', isDummy: true },
    { id: 'legacy-preview', pattern: 'Sample FVG (Dummy)' },
    { id: 'real', source: 'option-chain-dom', message: 'Real confirmation' }
  ];
  await new Promise(setImmediate);
  assert.deepEqual(w.local.signalHistory.map((row) => row.id), ['real']);
  const script = fs.readFileSync(path.join(__dirname, '../signal-history.js'), 'utf8');
  assert.doesNotMatch(script, /createDummySignals|<th>Pattern<\/th>/);
  assert.match(script, /<th>Expiry<\/th>/);
});
test('background reads inactive page, saves one decision, and suppresses duplicates/cooldown', async () => {
  const w = worker();
  for (const i of [0, 1, 2]) await w.scan(i);
  assert.equal(w.local.signalHistory.length, 1);
  assert.deepEqual(w.effects, ['voice', 'notification', 'discord']);
  await w.scan(2); await w.scan(3);
  assert.equal(w.local.signalHistory.length, 1);
  assert.equal(w.effects.length, 3);
  w.local.autoScannerEnabled = false;
  await w.scan(4);
  assert.equal(w.effects.length, 3);
});
test('messages from old chart scripts cannot send BUY/SELL alerts', async () => {
  const w = worker();
  const result = await vm.runInContext("handleMessage({type:'SHOW_NOTIFICATION', action:'BUY', source:'observed-chart'})", w.context);
  assert.equal(result.skipped, true);
  assert.equal(w.effects.length, 0);
});
test('base routes read whichever stock or index is selected', () => {
  const { parseHTML } = require('linkedom');
  const { document } = parseHTML(fs.readFileSync(path.join(__dirname, '../sample-oi-data.html'), 'utf8'));
  const picker = document.querySelector('[data-id="searchButtonPrefillOC"]');
  for (const symbol of ['NIFTY', 'BANKNIFTY', 'SENSEX', 'RELIANCE', 'TCS']) {
    picker.textContent = `Option Chain for ${symbol}`;
    for (const route of ['/option-chain', '/option-chain/']) {
      const result = reader.read(document, `https://pro.upstox.com${route}`, now);
      assert.equal(result.found, true, result.message);
      assert.equal(result.snapshot.instrumentKey, symbol);
      assert.equal(result.snapshot.selectedUnderlying, symbol);
    }
  }
  const routed = reader.read(document, 'https://pro.upstox.com/option-chain/NSE_EQ/INE467B01029', now);
  assert.equal(routed.snapshot.instrumentKey, 'NSE_EQ|INE467B01029');
  picker.remove();
  assert.equal(reader.read(document, 'https://pro.upstox.com/option-chain/', now).found, false);
});
test('selection changes cannot combine snapshots even before the URL changes', () => {
  const samples = [0, 1, 2].map((i) => ({ ...snapshot(i), selectedUnderlying: i < 2 ? 'NIFTY' : 'TCS' }));
  assert.equal(engine.evaluate(samples, now).signals.length, 0);
});
test('inactive base-route tabs are scanned without activation', async () => {
  for (const route of ['/option-chain', '/option-chain/']) {
    const w = worker(`https://pro.upstox.com${route}`);
    for (const i of [0, 1, 2]) await w.scan(i);
    assert.equal(w.local.signalHistory.length, 1);
  }
});
