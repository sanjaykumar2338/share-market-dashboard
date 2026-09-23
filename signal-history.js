const SIGNAL_HISTORY_KEY = 'signalHistory';
const signalsBody = document.getElementById('signalsBody');
const summary = document.getElementById('summary');
const signalCount = document.getElementById('signalCount');
const buyCount = document.getElementById('buyCount');
const sellCount = document.getElementById('sellCount');
const exportButton = document.getElementById('exportButton');
const clearButton = document.getElementById('clearButton');
const pagination = document.getElementById('pagination');
const pageRange = document.getElementById('pageRange');
const pageStatus = document.getElementById('pageStatus');
const previousPageButton = document.getElementById('previousPageButton');
const nextPageButton = document.getElementById('nextPageButton');
let allSignals = [];
const collapsedDates = new Set();
const PAGE_SIZE = 15;
let currentPage = 1;

document.addEventListener('DOMContentLoaded', initialize);
exportButton.addEventListener('click', exportCsv);
clearButton.addEventListener('click', clearHistory);
signalsBody.addEventListener('click', handleTableClick);
previousPageButton.addEventListener('click', () => changePage(-1));
nextPageButton.addEventListener('click', () => changePage(1));
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[SIGNAL_HISTORY_KEY]) {
    allSignals = normalizeSignals(changes[SIGNAL_HISTORY_KEY].newValue);
    currentPage = 1;
    render();
  }
});

async function initialize() {
  const { [SIGNAL_HISTORY_KEY]: history = [] } = await chrome.storage.local.get(SIGNAL_HISTORY_KEY);
  allSignals = normalizeSignals(history);

  render();
}

function normalizeSignals(history) {
  const unique = new Map();
  (Array.isArray(history) ? history : []).forEach((signal) => {
    if (signal?.isDummy || /dummy/i.test(signal?.pattern || '') || /^Dummy\b/i.test(signal?.message || '')) return;
    const key = signal?.dedupeKey || signal?.id;
    if (key) unique.set(key, signal);
  });
  return [...unique.values()].sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
}

function render() {
  const rows = allSignals;
  signalCount.textContent = String(rows.length);
  buyCount.textContent = String(rows.filter((signal) => signal.action === 'BUY').length);
  sellCount.textContent = String(rows.filter((signal) => signal.action === 'SELL').length);
  summary.textContent = rows.length
    ? `${rows.length} unique signal${rows.length === 1 ? '' : 's'} across all days.`
    : 'No signals stored yet.';

  if (!rows.length) {
    signalsBody.innerHTML = '<tr><td class="empty" colspan="6">No confirmed signals stored yet. Option-chain scanning runs automatically; preview records are not trading signals.</td></tr>';
    renderPagination(0, 1);
    return;
  }
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  currentPage = Math.min(Math.max(currentPage, 1), pageCount);
  const startIndex = (currentPage - 1) * PAGE_SIZE;
  const pageRows = rows.slice(startIndex, startIndex + PAGE_SIZE);
  const groups = groupSignalsByDate(pageRows);
  signalsBody.replaceChildren(...groups.flatMap(([date, signals]) => createDateRows(date, signals)));
  renderPagination(rows.length, pageCount);
}

function renderPagination(totalRows, pageCount) {
  pagination.hidden = totalRows <= PAGE_SIZE;
  const start = totalRows ? ((currentPage - 1) * PAGE_SIZE) + 1 : 0;
  const end = Math.min(currentPage * PAGE_SIZE, totalRows);
  pageRange.textContent = `Showing ${start}–${end} of ${totalRows}`;
  pageStatus.textContent = `Page ${currentPage} of ${pageCount}`;
  previousPageButton.disabled = currentPage <= 1;
  nextPageButton.disabled = currentPage >= pageCount;
}

function changePage(offset) {
  currentPage += offset;
  render();
  document.querySelector('.tablePanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function groupSignalsByDate(signals) {
  const groups = new Map();
  signals.forEach((signal) => {
    if (!groups.has(signal.date)) groups.set(signal.date, []);
    groups.get(signal.date).push(signal);
  });
  return [...groups.entries()].sort(([dateA], [dateB]) => dateB.localeCompare(dateA));
}

function createDateRows(date, signals) {
  const collapsed = collapsedDates.has(date);
  const buyTotal = signals.filter((signal) => signal.action === 'BUY').length;
  const sellTotal = signals.filter((signal) => signal.action === 'SELL').length;
  const latest = signals.reduce((current, signal) => Number(signal.timestamp || 0) > Number(current.timestamp || 0) ? signal : current, signals[0]);
  const groupRow = document.createElement('tr');
  groupRow.className = 'dateGroupRow';

  const dateCell = document.createElement('td');
  dateCell.innerHTML = `<strong>${escapeHtml(formatDateHeading(date))}</strong><span>${signals.length} signal${signals.length === 1 ? '' : 's'} recorded</span>`;
  groupRow.append(dateCell);

  const buyCell = document.createElement('td');
  buyCell.className = 'buy groupMetric';
  buyCell.innerHTML = `<span class="countBadge buyBadge">${buyTotal}</span>`;
  groupRow.append(buyCell);

  const sellCell = document.createElement('td');
  sellCell.className = 'sell groupMetric';
  sellCell.innerHTML = `<span class="countBadge sellBadge">${sellTotal}</span>`;
  groupRow.append(sellCell);

  const summaryCell = document.createElement('td');
  summaryCell.className = 'groupSummary';
  summaryCell.innerHTML = `<span class="countBadge totalBadge">${signals.length}</span>`;
  groupRow.append(summaryCell);

  const latestCell = document.createElement('td');
  latestCell.className = 'groupSummary';
  latestCell.textContent = latest?.time || '--';
  groupRow.append(latestCell);

  const actionCell = document.createElement('td');
  const toggleButton = document.createElement('button');
  toggleButton.type = 'button';
  toggleButton.className = 'toggleButton';
  toggleButton.dataset.date = date;
  toggleButton.textContent = collapsed ? 'Show Signals' : 'Hide Signals';
  toggleButton.setAttribute('aria-expanded', String(!collapsed));
  actionCell.append(toggleButton);
  groupRow.append(actionCell);

  return [groupRow, createSignalDetailsRow(date, signals, collapsed)];
}

function createSignalDetailsRow(date, signals, hidden) {
  const row = document.createElement('tr');
  row.className = 'signalDetailRow';
  row.dataset.date = date;
  row.hidden = hidden;
  const cell = document.createElement('td');
  cell.colSpan = 6;
  cell.className = 'nestedCell';
  const table = document.createElement('table');
  table.className = 'signalTable';
  table.innerHTML = '<thead><tr><th>Time (IST)</th><th>Signal</th><th>Symbol</th><th>Expiry</th><th>Sampling</th><th>Strikes Evaluated</th><th>Option-chain Explanation</th></tr></thead>';
  const body = document.createElement('tbody');
  body.append(...signals.map(createSignalTableRow));
  table.append(body);
  cell.append(table);
  row.append(cell);
  return row;
}

function createSignalTableRow(signal) {
  const row = document.createElement('tr');
  [signal.time, signal.action, signal.symbol, signal.expiry, signal.interval, signal.priceRange, signal.message || '--']
    .forEach((value, index) => {
      const cell = document.createElement('td');
      cell.textContent = value || '--';
      if (index === 1) {
        cell.className = 'signalCell';
        const badge = document.createElement('span');
        badge.className = signal.action === 'SELL' ? 'signalBadge sellBadge' : 'signalBadge buyBadge';
        badge.textContent = signal.action || '--';
        cell.replaceChildren(badge);
      }
      if (index === 0) cell.className = 'timeCell';
      if (index === 6) cell.classList.add('messageCell');
      row.append(cell);
    });
  return row;
}

function handleTableClick(event) {
  const button = event.target.closest('.toggleButton');
  if (!button) return;
  const date = button.dataset.date;
  if (collapsedDates.has(date)) collapsedDates.delete(date);
  else collapsedDates.add(date);
  render();
}

function exportCsv() {
  const rows = allSignals;
  if (!rows.length) return;
  const values = [['Date', 'Time (IST)', 'Signal', 'Symbol', 'Expiry', 'Sampling', 'Strikes Evaluated', 'Option-chain Explanation'], ...rows.map((signal) => [
    signal.date, signal.time, signal.action, signal.symbol, signal.expiry, signal.interval, signal.priceRange, signal.message
  ])];
  const csv = values.map((row) => row.map(csvCell).join(',')).join('\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  link.download = 'upstox-signal-history-all.csv';
  link.click();
  URL.revokeObjectURL(link.href);
}

function csvCell(value) {
  return `"${String(value || '').replaceAll('"', '""')}"`;
}

async function clearHistory() {
  if (!allSignals.length || !confirm('Clear all stored signal data? This cannot be undone.')) return;
  currentPage = 1;
  collapsedDates.clear();
  await chrome.storage.local.set({ [SIGNAL_HISTORY_KEY]: [] });
}

function getIstDateKey(date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function formatIstTime(date) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
  }).format(date);
}

function formatDateLabel(dateKey) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  if (!year || !month || !day) return dateKey;
  return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
    .format(new Date(Date.UTC(year, month - 1, day, 12)));
}

function formatDateHeading(dateKey) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  if (!year || !month || !day) return dateKey;
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric'
  }).format(new Date(Date.UTC(year, month - 1, day, 12)));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}
