const HISTORY_KEY = 'dailyPnlHistory';
const tradesBody = document.getElementById('tradesBody');
const summary = document.getElementById('summary');
const dayPnlTotal = document.getElementById('dayPnlTotal');
const tradeCount = document.getElementById('tradeCount');
const captureButton = document.getElementById('captureButton');
const sendDiscordButton = document.getElementById('sendDiscordButton');
const exportButton = document.getElementById('exportButton');
// Fixed fee estimate requested by the user: ₹728 gross − ₹71 fees = ₹657 net.
const TRADING_FEES_PER_COMPLETED_TRADE = 71;

let todayRow = null;
let todayTrades = [];

document.addEventListener('DOMContentLoaded', loadTodayTrades);
captureButton.addEventListener('click', captureNow);
sendDiscordButton.addEventListener('click', sendToDiscord);
exportButton.addEventListener('click', exportCsv);
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[HISTORY_KEY]) {
    renderTodayTrades(changes[HISTORY_KEY].newValue || []);
  }
});

async function loadTodayTrades() {
  const { [HISTORY_KEY]: history = [] } = await chrome.storage.local.get(HISTORY_KEY);
  renderTodayTrades(history);
}

async function captureNow() {
  captureButton.disabled = true;
  captureButton.textContent = 'Capturing...';

  try {
    const response = await chrome.runtime.sendMessage({ type: 'CAPTURE_DAILY_PNL_FROM_UPSTOX' });

    if (!response?.ok) {
      throw new Error(response?.error || 'Capture failed.');
    }

    const { [HISTORY_KEY]: history = [] } = await chrome.storage.local.get(HISTORY_KEY);
    renderTodayTrades(history);
    summary.textContent = `Captured ${response.tradingDetailsCount || 0} trade(s). ${response.message || ''}`.trim();
  } catch (error) {
    summary.textContent = error.message || 'Capture failed.';
  } finally {
    captureButton.disabled = false;
    captureButton.textContent = 'Capture Now';
  }
}

function renderTodayTrades(history) {
  const todayKey = getTodayIstDateKey();
  const rows = Array.isArray(history) ? history : [];

  todayRow = rows.find((row) => row.date === todayKey) || null;
  todayTrades = dedupeTrades(todayRow?.positions || []);
  exportButton.disabled = todayTrades.length === 0;
  sendDiscordButton.disabled = todayTrades.length === 0;
  tradeCount.textContent = String(todayTrades.length);

  if (!todayRow || !todayTrades.length) {
    summary.textContent = `No trades stored for ${todayKey}.`;
    dayPnlTotal.textContent = '--';
    dayPnlTotal.className = 'neutral';
    tradesBody.innerHTML = '<tr><td class="empty" colspan="12">No trades stored for today.</td></tr>';
    return;
  }

  const value = Number(todayRow.value);
  summary.textContent = `Last updated ${formatDateTime(todayRow.updatedAt)}.`;
  dayPnlTotal.textContent = todayRow.display || formatSignedValue(value);
  dayPnlTotal.className = getValueClass(value);
  tradesBody.replaceChildren(...todayTrades.map(createTradeRow));
}

async function sendToDiscord() {
  if (!todayRow || !todayTrades.length) {
    summary.textContent = 'No trades available to send.';
    return;
  }

  sendDiscordButton.disabled = true;
  sendDiscordButton.textContent = 'Sending...';

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'SEND_TODAY_TRADES_TO_DISCORD',
      date: todayRow.date || getTodayIstDateKey(),
      dayPnl: todayRow.display || formatSignedValue(Number(todayRow.value)),
      trades: todayTrades.map((trade) => {
        const grossPnl = getPositionPnlValue(trade);
        const tradeCost = getTradeCostValue(trade);
        const netPnl = Number.isFinite(grossPnl) ? grossPnl - tradeCost : null;

        return {
          section: trade.status || trade.section || '',
          symbol: trade.symbol || '',
          category: trade.category || '',
          product: trade.product || '',
          netQty: trade.netQty || '',
          avgPrice: trade.avgPrice || '',
          ltp: trade.ltp || '',
          dayPnl: trade.dayPnl || '',
          overallPnl: trade.overallPnl || '',
          tradeCost: formatSignedValue(tradeCost),
          netPnl: formatSignedValue(netPnl),
          note: trade.note || ''
        };
      })
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Could not send trades to Discord.');
    }

    summary.textContent = `Sent ${todayTrades.length} trade(s) to Discord.`;
  } catch (error) {
    summary.textContent = error.message || 'Could not send trades to Discord.';
  } finally {
    sendDiscordButton.disabled = todayTrades.length === 0;
    sendDiscordButton.textContent = 'Send Discord';
  }
}

function createTradeRow(trade) {
  const row = document.createElement('tr');
  const grossPnl = getPositionPnlValue(trade);
  const tradeCost = getTradeCostValue(trade);
  const netPnl = Number.isFinite(grossPnl) ? grossPnl - tradeCost : null;

  row.append(
    createCell(trade.status || trade.section || '--', 'muted'),
    createCell(trade.symbol || '--'),
    createCell(trade.category || '--', 'muted'),
    createCell(trade.product || '--', 'muted'),
    createCell(trade.netQty || '--', 'numeric muted'),
    createCell(trade.avgPrice || '--', 'numeric muted'),
    createCell(trade.ltp || '--', 'numeric muted'),
    createValueCell(trade.dayPnlValue, trade.dayPnl),
    createValueCell(trade.overallPnlValue, trade.overallPnl),
    createValueCell(tradeCost),
    createValueCell(netPnl),
    createCell(trade.note || '--', 'muted')
  );

  return row;
}

function createCell(text, className = '') {
  const cell = document.createElement('td');
  cell.textContent = text;

  if (className) {
    cell.className = className;
  }

  return cell;
}

function createValueCell(value, display) {
  const numericValue = Number(value);
  const hasNumericValue = value !== null && value !== undefined && value !== '' && Number.isFinite(numericValue);
  return createCell(
    hasNumericValue ? display || formatSignedValue(numericValue) : '--',
    `numeric value ${getValueClass(numericValue)}`
  );
}

function dedupeTrades(trades) {
  const uniqueTrades = new Map();

  if (!Array.isArray(trades)) {
    return [];
  }

  trades.filter((trade) => trade?.symbol).forEach((trade) => {
    uniqueTrades.set(getTradeKey(trade), trade);
  });

  return Array.from(uniqueTrades.values());
}

function getTradeKey(trade) {
  if (trade?.tradeId) {
    return String(trade.tradeId);
  }

  if (trade?.contractKey) {
    return String(trade.contractKey);
  }

  return [
    trade.symbol,
    trade.category,
    trade.product
  ].map((part) => String(part || '').trim().toUpperCase()).join('|');
}

function getValueClass(value) {
  if (value > 0) {
    return 'profit';
  }

  if (value < 0) {
    return 'loss';
  }

  return 'neutral';
}

function getPositionPnlValue(position) {
  const overallPnlValue = Number(position?.overallPnlValue);

  if (Number.isFinite(overallPnlValue)) {
    return overallPnlValue;
  }

  const dayPnlValue = Number(position?.dayPnlValue);
  return Number.isFinite(dayPnlValue) ? dayPnlValue : null;
}

function getTradeCostValue(position) {
  return (TRADING_FEES_PER_COMPLETED_TRADE / 2) * getEstimatedOrderCount(position);
}

function getEstimatedOrderCount(position) {
  const quantity = Number(position?.netQtyValue ?? position?.netQty);
  const closed = /closed/i.test(`${position?.status || ''} ${position?.section || ''}`)
    || (Number.isFinite(quantity) && quantity === 0);

  return closed ? 2 : 1;
}

function formatSignedValue(value) {
  if (!Number.isFinite(value)) {
    return '--';
  }

  return value.toLocaleString('en-IN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  });
}

function formatDateTime(timestamp) {
  const value = Number(timestamp);

  if (!Number.isFinite(value)) {
    return '--';
  }

  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata'
  }).format(new Date(value));
}

function getTodayIstDateKey() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date()).reduce((values, part) => ({
    ...values,
    [part.type]: part.value
  }), {});

  return `${parts.year}-${parts.month}-${parts.day}`;
}

function exportCsv() {
  if (!todayTrades.length) {
    return;
  }

  const header = ['Date', 'Section', 'Symbol', 'Category', 'Product', 'Net Qty', 'Avg Price', 'LTP', 'Day P&L', 'Overall P&L', 'Estimated Trade Cost', 'Net P&L After Cost', 'Note'];
  const rows = todayTrades.map((trade) => {
    const grossPnl = getPositionPnlValue(trade);
    const tradeCost = getTradeCostValue(trade);
    const netPnl = Number.isFinite(grossPnl) ? grossPnl - tradeCost : null;

    return [
      todayRow?.date || getTodayIstDateKey(),
      trade.status || trade.section || '',
      trade.symbol || '',
      trade.category || '',
      trade.product || '',
      trade.netQty || '',
      trade.avgPrice || '',
      trade.ltp || '',
      trade.dayPnl || '',
      trade.overallPnl || '',
      formatSignedValue(tradeCost),
      formatSignedValue(netPnl),
      trade.note || ''
    ];
  });
  const csv = [header, ...rows]
    .map((cells) => cells.map(escapeCsvCell).join(','))
    .join('\n');
  const blobUrl = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const link = document.createElement('a');

  link.href = blobUrl;
  link.download = 'upstox-today-trades.csv';
  link.click();
  URL.revokeObjectURL(blobUrl);
}

function escapeCsvCell(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}
