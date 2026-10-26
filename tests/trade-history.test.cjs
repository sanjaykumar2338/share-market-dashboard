const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

function setup() {
  const data = {};
  const source = readFileSync(require.resolve('../background.js'), 'utf8');
  const context = vm.createContext({
    chrome: { storage: { local: {
      get: async () => structuredClone(data),
      set: async (values) => Object.assign(data, structuredClone(values))
    } } }
  });
  vm.runInContext(source.slice(0, source.indexOf('chrome.runtime.onMessage'))
    + source.slice(source.indexOf('async function recordDailyPnlHistory')), context);
  return { context, data };
}

const timestamp = Date.parse('2026-10-26T05:00:00Z');
const position = (symbol, netQtyValue = 10) => ({
  symbol, product: 'Intraday', netQtyValue, avgPriceValue: 100,
  section: netQtyValue ? 'Open' : 'Closed'
});

test('partial and empty scans preserve captured trades in journal and history', async () => {
  const { context, data } = setup();
  for (const [index, scan] of [[position('AAA')], [position('BBB')], []].entries()) {
    const journal = await context.updatePositionJournal(scan, timestamp + index);
    await context.recordDailyPnlHistory({ value: 10, display: '10' }, timestamp + index, journal);
  }
  assert.equal(data.dailyPnlHistory[0].positions.length, 2);
  assert.equal((await context.updatePositionJournal([], timestamp + 4)).length, 2);
});

test('reopening a contract preserves both trades and updates the latest close', async () => {
  const { context, data } = setup();
  for (const [index, qty] of [10, 0, 10, 0, 0].entries()) {
    const journal = await context.updatePositionJournal([position('AAA', qty)], timestamp + index);
    await context.recordDailyPnlHistory({ value: 10, display: '10' }, timestamp + index, journal);
  }
  const trades = data.dailyPnlHistory[0].positions;
  assert.equal(trades.length, 2);
  assert.equal(new Set(trades.map((trade) => trade.tradeId)).size, 2);
  assert.ok(trades.every((trade) => trade.status === 'Closed'));
});

test('a carried position closed today survives another scan but not the next day', async () => {
  const { context } = setup();
  await context.updatePositionJournal([position('AAA')], timestamp - 86400000);
  await context.updatePositionJournal([position('AAA', 0)], timestamp);
  assert.equal((await context.updatePositionJournal([], timestamp + 1)).length, 1);
  assert.equal((await context.updatePositionJournal([], timestamp + 86400000)).length, 0);
});

test('history merges partial scans and migrates legacy rows without losing notes', () => {
  const { context } = setup();
  const merged = context.mergePositionDetails(
    [{ ...position('AAA'), tradeId: 'new-id' }],
    [{ ...position('AAA'), note: 'saved note' }, position('BBB')]
  );
  assert.equal(merged.length, 2);
  assert.equal(merged.find((trade) => trade.tradeId === 'new-id').note, 'saved note');
});

test('old open positions stay out of today until observed again', async () => {
  const { context } = setup();
  await context.updatePositionJournal([position('OLD')], timestamp - 86400000 * 100);
  const today = await context.updatePositionJournal([position('NEW')], timestamp);
  assert.equal(today.length, 1);
  assert.equal(today[0].symbol, 'NEW');
  const refreshed = await context.updatePositionJournal([position('OLD')], timestamp + 1);
  assert.equal(refreshed.length, 2);
});

test('repair backs up contaminated history and rebuilds only the current date', async () => {
  const { context, data } = setup();
  const oldRow = { date: '2026-10-25', positions: [position('OLDER')] };
  data.dailyPnlHistory = [oldRow, {
    date: '2026-10-26', value: -11696.75, positions: [position('STALE')]
  }];
  const journal = await context.updatePositionJournal([position('CURRENT', 0)], timestamp);
  await context.recordDailyPnlHistory({ value: -11696.75, display: '-11,696.75' }, timestamp, journal);
  assert.equal(data.dailyPnlHistory[0].positions.length, 1);
  assert.equal(data.dailyPnlHistory[0].positions[0].symbol, 'CURRENT');
  assert.deepEqual(data.dailyPnlHistory[1], oldRow);
  assert.equal(data['dailyPnlHistoryBeforeRepair:2026-10-26'].positions[0].symbol, 'STALE');
});

function parseRow(cells) {
  const { parseHTML } = require('linkedom');
  const { document } = parseHTML(`<table><tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr></table>`);
  const source = readFileSync(require.resolve('../content.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('  function readTablePosition('),
    source.indexOf('  function isPositionSectionRow(')), context);
  return context.readTablePosition(document.querySelector('tr'), 'Closed');
}

test('current Upstox columns skip LTP percent and place product after average', () => {
  const parsed = parseRow(['', 'NIFTY 27 Oct 26 22400 CE NFO', '0', '--', 'Delivery', '385.45', '+59.21%', '+354.25', '+354.25']);
  assert.equal(parsed.product, 'Delivery');
  assert.equal(parsed.netQty, '0');
  assert.equal(parsed.avgPrice, '--');
  assert.equal(parsed.dayPnl, '+354.25');
  assert.equal(parsed.overallPnl, '+354.25');
});

test('legacy product-first table remains supported', () => {
  const parsed = parseRow(['NIFTY CE', 'Delivery', '10', '100', '105', '50', '50']);
  assert.equal(parsed.product, 'Delivery');
  assert.equal(parsed.netQty, '10');
  assert.equal(parsed.avgPrice, '100');
  assert.equal(parsed.dayPnl, '50');
});
