const HISTORY_KEY = 'dailyPnlHistory';
const EXPIRY_CACHE_KEY = 'optionExpiryCalendarV2';
const UPSTOX_INSTRUMENT_URLS = [
  { exchange: 'NSE', url: 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz' },
  { exchange: 'BSE', url: 'https://assets.upstox.com/market-quote/instruments/exchange/BSE.json.gz' }
];
const historyBody = document.getElementById('historyBody');
const summary = document.getElementById('summary');
const monthProfit = document.getElementById('monthProfit');
const monthLoss = document.getElementById('monthLoss');
const monthNet = document.getElementById('monthNet');
const monthFilter = document.getElementById('monthFilter');
const allMonthsButton = document.getElementById('allMonthsButton');
const profitProtectionEnabledInput = document.getElementById('profitProtectionEnabled');
const ruleStrip = document.querySelector('.ruleStrip');
const disciplineRuleText = document.getElementById('disciplineRuleText');
const historyHead = document.querySelector('thead');
const sendAllDiscordButton = document.getElementById('sendAllDiscordButton');
const exportButton = document.getElementById('exportButton');
const clearButton = document.getElementById('clearButton');
const expiryPanel = document.getElementById('expiryPanel');
const expiryPanelBody = document.getElementById('expiryPanelBody');
const toggleExpiryPanelButton = document.getElementById('toggleExpiryPanel');
const expiryToggleIcon = document.getElementById('expiryToggleIcon');
const expiryStatus = document.getElementById('expiryStatus');
const expirySummary = document.getElementById('expirySummary');
const expiryBody = document.getElementById('expiryBody');
const expiryTypeFilter = document.getElementById('expiryTypeFilter');
const expirySearch = document.getElementById('expirySearch');
const refreshExpiryButton = document.getElementById('refreshExpiryButton');
const screenshotDialog = document.getElementById('screenshotDialog');
const screenshotDialogTitle = document.getElementById('screenshotDialogTitle');
const screenshotDialogImage = document.getElementById('screenshotDialogImage');
const closeScreenshotDialog = document.getElementById('closeScreenshotDialog');
// Fixed fee estimate requested by the user: ₹728 gross − ₹71 fees = ₹657 net.
const TRADING_FEES_PER_COMPLETED_TRADE = 71;
const EXPIRY_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const DISCIPLINE_RULES = [
  'Stop when the plan is done.',
  'Protect family capital.',
  'Respect your father’s hard work.',
  'Consistent profit beats one lucky day.',
  'No revenge trades. No boredom trades.',
  'Long run matters more than one extra trade.'
];

let allHistory = [];
let currentHistory = [];
let expandedDate = '';
let noteEditing = false;
let selectedMonth = '';
let expiryRows = [];
let sortState = {
  key: 'date',
  direction: 'desc'
};

document.addEventListener('DOMContentLoaded', () => {
  renderDisciplineRuleLine();
  updateSortHeaders();
  loadHistory();
  loadExpiryCalendar();
});
monthFilter.addEventListener('change', handleMonthFilterChange);
allMonthsButton.addEventListener('click', showAllMonths);
profitProtectionEnabledInput.addEventListener('change', updateProfitProtectionEnabled);
sendAllDiscordButton.addEventListener('click', sendAllTradesToDiscord);
exportButton.addEventListener('click', exportCsv);
clearButton.addEventListener('click', clearHistory);
toggleExpiryPanelButton.addEventListener('click', toggleExpiryPanel);
expiryTypeFilter.addEventListener('change', renderExpiryCalendar);
expirySearch.addEventListener('input', renderExpiryCalendar);
refreshExpiryButton.addEventListener('click', () => loadExpiryCalendar({ force: true }));
closeScreenshotDialog.addEventListener('click', closeScreenshotViewer);
screenshotDialog.addEventListener('click', handleScreenshotDialogClick);
historyBody.addEventListener('click', handleHistoryClick);
historyBody.addEventListener('focusin', handleNoteFocusIn);
historyBody.addEventListener('focusout', handleNoteFocusOut);
historyHead.addEventListener('click', handleSortClick);
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.profitProtectionEnabled) {
    syncProfitProtectionEnabled(changes.profitProtectionEnabled.newValue !== false);
  }

  if (areaName === 'local' && changes[HISTORY_KEY]) {
    const history = Array.isArray(changes[HISTORY_KEY].newValue) ? changes[HISTORY_KEY].newValue : [];

    if (noteEditing) {
      allHistory = sortHistoryByDateAsc(history);
      currentHistory = sortHistoryRows(filterHistoryByMonth(allHistory));
      return;
    }

    renderHistory(history);
  }
});

function toggleExpiryPanel() {
  const expanded = toggleExpiryPanelButton.getAttribute('aria-expanded') !== 'true';

  toggleExpiryPanelButton.setAttribute('aria-expanded', String(expanded));
  toggleExpiryPanelButton.title = expanded ? 'Hide option expiry calendar' : 'Show option expiry calendar';
  expiryPanel.classList.toggle('isCollapsed', !expanded);
  expiryPanelBody.hidden = !expanded;
  expiryToggleIcon.textContent = expanded ? '▾' : '▸';

  if (expanded && expiryRows.length) {
    renderExpiryCalendar();
  }
}

async function loadExpiryCalendar({ force = false } = {}) {
  setExpiryLoading(true, force ? 'Refreshing option expiries...' : 'Loading option expiries...');

  try {
    const { [EXPIRY_CACHE_KEY]: cached } = await chrome.storage.local.get(EXPIRY_CACHE_KEY);
    const canUseCache = !force && cached?.createdAt && Date.now() - cached.createdAt < EXPIRY_CACHE_MAX_AGE_MS;

    if (canUseCache && Array.isArray(cached.rows)) {
      expiryRows = cached.rows;
      renderExpiryCalendar();
      return;
    }

    const instruments = await fetchUpstoxInstruments();
    expiryRows = buildExpiryRows(instruments);

    await chrome.storage.local.set({
      [EXPIRY_CACHE_KEY]: {
        createdAt: Date.now(),
        rows: expiryRows
      }
    });
    renderExpiryCalendar();
  } catch (error) {
    const { [EXPIRY_CACHE_KEY]: cached } = await chrome.storage.local.get(EXPIRY_CACHE_KEY);

    if (Array.isArray(cached?.rows) && cached.rows.length) {
      expiryRows = cached.rows;
      renderExpiryCalendar(`Using cached expiries. Refresh failed: ${error.message || String(error)}`);
      return;
    }

    expiryRows = [];
    renderExpiryError(error);
  } finally {
    setExpiryLoading(false);
  }
}

async function fetchUpstoxInstruments() {
  const batches = await Promise.all(UPSTOX_INSTRUMENT_URLS.map(async ({ exchange, url }) => {
    const response = await fetch(url, { cache: 'no-store' });

    if (!response.ok) {
      throw new Error(`Upstox ${exchange} instruments returned HTTP ${response.status}`);
    }

    if (!('DecompressionStream' in window)) {
      throw new Error('This Chrome version cannot decompress the Upstox instrument file.');
    }

    const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
    const instruments = await new Response(stream).json();
    return instruments.map((instrument) => ({ ...instrument, source_exchange: exchange }));
  }));

  return batches.flat();
}

function buildExpiryRows(instruments) {
  const groups = new Map();

  (Array.isArray(instruments) ? instruments : []).forEach((instrument) => {
    if (!isOptionContract(instrument)) {
      return;
    }

    const symbol = String(instrument.underlying_symbol || instrument.name || '').trim().toUpperCase();
    const expiryDate = formatExpiryDate(instrument.expiry);
    const underlyingType = String(instrument.underlying_type || '').trim().toUpperCase();
    const exchange = String(instrument.exchange || instrument.source_exchange || '').trim().toUpperCase();

    if (!symbol || !expiryDate || !exchange || !['INDEX', 'EQUITY'].includes(underlyingType)) {
      return;
    }

    const key = `${exchange}|${underlyingType}|${symbol}`;
    const group = groups.get(key) || {
      symbol,
      exchange,
      underlyingType,
      lotSize: Number(instrument.lot_size) || null,
      weeklyExpiries: new Set(),
      monthlyExpiries: new Set()
    };

    if (instrument.weekly === true) {
      group.weeklyExpiries.add(expiryDate);
    } else {
      group.monthlyExpiries.add(expiryDate);
    }

    if (!group.lotSize && Number(instrument.lot_size)) {
      group.lotSize = Number(instrument.lot_size);
    }

    groups.set(key, group);
  });

  return Array.from(groups.values())
    .map((group) => {
      const weeklyExpiries = sortExpiryDates(Array.from(group.weeklyExpiries));
      const monthlyExpiries = sortExpiryDates(Array.from(group.monthlyExpiries));
      const allExpiries = sortExpiryDates([...weeklyExpiries, ...monthlyExpiries]);

      return {
        symbol: group.symbol,
        exchange: group.exchange,
        underlyingType: group.underlyingType,
        lotSize: group.lotSize,
        weeklyExpiries,
        monthlyExpiries,
        nextExpiry: allExpiries[0] || ''
      };
    })
    .filter((row) => row.nextExpiry)
    .sort((a, b) => {
      const typeOrder = a.underlyingType.localeCompare(b.underlyingType);
      return typeOrder
        || String(a.nextExpiry).localeCompare(String(b.nextExpiry))
        || a.exchange.localeCompare(b.exchange)
        || a.symbol.localeCompare(b.symbol);
    });
}

function isOptionContract(instrument) {
  return /_FO$/.test(String(instrument?.segment || ''))
    && (instrument.instrument_type === 'CE' || instrument.instrument_type === 'PE')
    && Number.isFinite(Number(instrument.expiry));
}

function renderExpiryCalendar(message = '') {
  const visibleRows = getVisibleExpiryRows();
  const statusRows = getExpiryStatusRows();

  renderExpirySummary(expiryRows);
  expiryStatus.classList.remove('isNextExpiry');

  if (!expiryRows.length) {
    expiryStatus.textContent = message || 'No option expiries loaded.';
    expiryBody.innerHTML = '<tr><td class="empty" colspan="7">No option expiries loaded.</td></tr>';
    return;
  }

  const status = message
    ? { text: message, highlight: false }
    : getExpiryStatus(statusRows);

  expiryStatus.textContent = status.text;
  expiryStatus.classList.toggle('isNextExpiry', status.highlight);

  if (!visibleRows.length) {
    expiryBody.innerHTML = '<tr><td class="empty" colspan="7">No symbols match this filter.</td></tr>';
    return;
  }

  expiryBody.replaceChildren(...visibleRows.map(createExpiryRow));
}

function getVisibleExpiryRows() {
  const selectedType = expiryTypeFilter.value;
  const searchText = expirySearch.value.trim().toUpperCase();

  return expiryRows.filter((row) => {
    const matchesType = selectedType === 'all' || row.underlyingType === selectedType;
    const matchesSearch = !searchText || row.symbol.includes(searchText) || row.exchange.includes(searchText);
    return matchesType && matchesSearch;
  });
}

function getExpiryStatusRows() {
  const selectedType = expiryTypeFilter.value;
  const searchText = expirySearch.value.trim().toUpperCase();
  const filteredRows = expiryRows.filter((row) => {
    const matchesType = selectedType === 'all' || row.underlyingType === selectedType;
    const matchesSearch = !searchText || row.symbol.includes(searchText) || row.exchange.includes(searchText);
    return matchesType && matchesSearch;
  });

  if (selectedType === 'INDEX' && !searchText) {
    return filteredRows.slice(0, 1);
  }

  return filteredRows;
}

function getExpiryStatus(visibleRows) {
  const selectedType = expiryTypeFilter.value;
  const searchText = expirySearch.value.trim();

  if (selectedType === 'INDEX' && !searchText && visibleRows[0]) {
    return {
      highlight: true,
      text: `Next index expiry: ${visibleRows[0].exchange} ${visibleRows[0].symbol} - ${formatExpiryLabel(visibleRows[0].nextExpiry)}`
    };
  }

  return {
    highlight: false,
    text: `${visibleRows.length} of ${expiryRows.length} symbols shown. Source: Upstox NSE + BSE instrument masters.`
  };
}

function renderExpirySummary(rows) {
  if (!expirySummary) {
    return;
  }

  const indexRows = rows.filter((row) => row.underlyingType === 'INDEX');
  const stockRows = rows.filter((row) => row.underlyingType === 'EQUITY');
  const nextIndex = getNearestExpiry(indexRows);
  const nextStock = getNearestExpiry(stockRows);

  expirySummary.replaceChildren(
    createExpiryMetric('Index Symbols', String(indexRows.length), nextIndex ? `Next ${formatExpiryLabel(nextIndex)}` : 'No index expiry'),
    createExpiryMetric('Stock Symbols', String(stockRows.length), nextStock ? `Next ${formatExpiryLabel(nextStock)}` : 'No stock expiry'),
    createExpiryMetric('Weekly Contracts', String(countRowsWithExpiry(rows, 'weeklyExpiries')), 'Index weekly + any weekly stock contracts'),
    createExpiryMetric('Monthly Contracts', String(countRowsWithExpiry(rows, 'monthlyExpiries')), 'Monthly stock and index expiries')
  );
}

function createExpiryMetric(label, value, helper) {
  const metric = document.createElement('div');
  const labelElement = document.createElement('span');
  const valueElement = document.createElement('strong');
  const helperElement = document.createElement('small');

  metric.className = 'expiryMetric';
  labelElement.className = 'summaryLabel';
  valueElement.className = 'summaryValue neutral';
  helperElement.className = 'expiryMetricHelper';

  labelElement.textContent = label;
  valueElement.textContent = value;
  helperElement.textContent = helper;
  metric.append(labelElement, valueElement, helperElement);

  return metric;
}

function createExpiryRow(row) {
  const tableRow = document.createElement('tr');

  tableRow.append(
    createCell(row.symbol),
    createCell(row.exchange || '--', 'muted'),
    createCell(row.underlyingType === 'INDEX' ? 'Index' : 'Stock', 'muted'),
    createExpiryListCell(row.weeklyExpiries),
    createExpiryListCell(row.monthlyExpiries),
    createCell(formatExpiryLabel(row.nextExpiry), getExpiryToneClass(row.nextExpiry)),
    createCell(row.lotSize ? row.lotSize.toLocaleString('en-IN') : '--', 'numeric muted')
  );

  return tableRow;
}

function createExpiryListCell(expiries) {
  const cell = document.createElement('td');
  const list = document.createElement('div');
  const upcoming = sortExpiryDates(expiries).slice(0, 4);

  list.className = 'expiryChips';

  if (!upcoming.length) {
    cell.textContent = '--';
    cell.className = 'muted';
    return cell;
  }

  list.append(...upcoming.map((expiry) => {
    const chip = document.createElement('span');
    chip.className = `expiryChip ${getExpiryToneClass(expiry)}`;
    chip.textContent = formatExpiryLabel(expiry);
    return chip;
  }));
  cell.append(list);

  return cell;
}

function countRowsWithExpiry(rows, key) {
  return rows.filter((row) => Array.isArray(row[key]) && row[key].length).length;
}

function getNearestExpiry(rows) {
  return sortExpiryDates(rows.flatMap((row) => [
    ...(row.weeklyExpiries || []),
    ...(row.monthlyExpiries || [])
  ]))[0] || '';
}

function sortExpiryDates(expiries) {
  return Array.from(new Set(expiries)).sort((a, b) => String(a).localeCompare(String(b)));
}

function formatExpiryDate(value) {
  const timestamp = Number(value);

  if (!Number.isFinite(timestamp)) {
    return '';
  }

  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Asia/Kolkata',
    year: 'numeric'
  }).formatToParts(new Date(timestamp)).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});

  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatExpiryLabel(dateKey) {
  const match = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    return '--';
  }

  const date = new Date(`${dateKey}T00:00:00+05:30`);
  const formatted = new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    timeZone: 'Asia/Kolkata',
    weekday: 'short'
  }).format(date);
  const days = getDaysUntilExpiry(dateKey);

  if (days === 0) {
    return `${formatted} (Today)`;
  }

  if (days === 1) {
    return `${formatted} (1 day)`;
  }

  return `${formatted} (${days} days)`;
}

function getDaysUntilExpiry(dateKey) {
  const today = getCurrentIstDateKey();
  const start = new Date(`${today}T00:00:00+05:30`).getTime();
  const end = new Date(`${dateKey}T00:00:00+05:30`).getTime();
  return Math.max(0, Math.round((end - start) / 86400000));
}

function getCurrentIstDateKey() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Asia/Kolkata',
    year: 'numeric'
  }).formatToParts(new Date()).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});

  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getExpiryToneClass(dateKey) {
  const days = getDaysUntilExpiry(dateKey);

  if (days <= 1) {
    return 'expiryNear';
  }

  if (days <= 7) {
    return 'expirySoon';
  }

  return 'expiryLater';
}

function renderExpiryError(error) {
  expiryStatus.textContent = error.message || 'Could not load option expiries.';
  expirySummary.replaceChildren();
  expiryBody.innerHTML = '<tr><td class="empty" colspan="7">Could not load option expiries.</td></tr>';
}

function setExpiryLoading(loading, message = '') {
  refreshExpiryButton.disabled = loading;
  refreshExpiryButton.textContent = loading ? 'Loading...' : 'Refresh';

  if (message) {
    expiryStatus.textContent = message;
  }
}

function renderDisciplineRuleLine() {
  if (!disciplineRuleText) {
    return;
  }

  disciplineRuleText.replaceChildren(...DISCIPLINE_RULES.map((rule, index) => {
    const ruleItem = document.createElement('span');
    ruleItem.className = 'ruleItem';
    ruleItem.textContent = rule;
    ruleItem.style.animationDelay = `${index * 0.35}s`;
    return ruleItem;
  }));
}

async function loadHistory() {
  const {
    [HISTORY_KEY]: history = [],
    profitProtectionEnabled = true
  } = await chrome.storage.local.get([HISTORY_KEY, 'profitProtectionEnabled']);

  profitProtectionEnabledInput.checked = profitProtectionEnabled !== false;
  syncProfitProtectionEnabled(profitProtectionEnabled !== false);
  renderHistory(history);
}

async function updateProfitProtectionEnabled() {
  syncProfitProtectionEnabled(profitProtectionEnabledInput.checked);
  await chrome.storage.local.set({
    profitProtectionEnabled: profitProtectionEnabledInput.checked
  });
}

function syncProfitProtectionEnabled(enabled) {
  profitProtectionEnabledInput.checked = enabled;

  if (ruleStrip) {
    ruleStrip.hidden = !enabled;
  }
}

function renderHistory(history) {
  allHistory = sortHistoryByDateAsc(Array.isArray(history) ? history : []);
  syncMonthFilter(allHistory);
  currentHistory = sortHistoryRows(filterHistoryByMonth(allHistory));
  sendAllDiscordButton.disabled = getAllTradeRows(currentHistory).length === 0;
  exportButton.disabled = currentHistory.length === 0;
  clearButton.disabled = allHistory.length === 0;
  updateSortHeaders();

  if (!allHistory.length) {
    summary.textContent = 'No stored P&L rows yet.';
    renderMonthlySummary(currentHistory);
    historyBody.innerHTML = '<tr><td class="empty" colspan="11">No stored P&amp;L rows yet.</td></tr>';
    return;
  }

  if (!currentHistory.length) {
    summary.textContent = `No stored P&L rows for ${formatMonthLabel(selectedMonth)}.`;
    renderMonthlySummary(currentHistory);
    historyBody.innerHTML = '<tr><td class="empty" colspan="11">No stored P&amp;L rows for this month.</td></tr>';
    return;
  }

  const latest = getLatestHistoryRow(currentHistory);
  summary.textContent = `${currentHistory.length} day(s) shown for ${formatMonthLabel(selectedMonth)}. Latest ${formatSignedValue(Number(latest.value))} on ${latest.date}.`;
  renderMonthlySummary(currentHistory);
  historyBody.replaceChildren(...currentHistory.flatMap(createRows));
}

function handleSortClick(event) {
  const button = event.target.closest('[data-sort-key]');

  if (!button) {
    return;
  }

  const nextKey = button.dataset.sortKey;

  sortState = {
    key: nextKey,
    direction: sortState.key === nextKey && sortState.direction === 'desc' ? 'asc' : 'desc'
  };
  expandedDate = '';
  renderHistory(allHistory);
}

function handleMonthFilterChange() {
  selectedMonth = monthFilter.value || 'all';
  expandedDate = '';
  renderHistory(allHistory);
}

function showAllMonths() {
  monthFilter.value = '';
  selectedMonth = 'all';
  expandedDate = '';
  renderHistory(allHistory);
}

function syncMonthFilter(history) {
  const months = getHistoryMonths(history);
  const fallbackMonth = months.includes(getCurrentIstMonthKey())
    ? getCurrentIstMonthKey()
    : months[months.length - 1] || 'all';
  const nextSelected = selectedMonth && (selectedMonth === 'all' || isMonthKey(selectedMonth))
    ? selectedMonth
    : fallbackMonth;

  monthFilter.removeAttribute('min');
  monthFilter.removeAttribute('max');
  monthFilter.value = nextSelected === 'all' ? '' : nextSelected;
  selectedMonth = nextSelected;
}

function getHistoryMonths(history) {
  return Array.from(new Set(
    (Array.isArray(history) ? history : [])
      .map((row) => String(row?.date || '').slice(0, 7))
      .filter((month) => /^\d{4}-\d{2}$/.test(month))
  )).sort();
}

function isMonthKey(value) {
  return /^\d{4}-\d{2}$/.test(String(value || ''));
}

function filterHistoryByMonth(history) {
  if (selectedMonth === 'all') {
    return history;
  }

  return history.filter((row) => String(row?.date || '').startsWith(selectedMonth));
}

function sortHistoryByDateAsc(history) {
  return [...history].sort((a, b) => String(a?.date || '').localeCompare(String(b?.date || '')));
}

function sortHistoryRows(history) {
  const direction = sortState.direction === 'asc' ? 1 : -1;

  return [...history].sort((a, b) => {
    const left = getSortValue(a, sortState.key);
    const right = getSortValue(b, sortState.key);

    if (isMissingSortValue(left) && isMissingSortValue(right)) {
      return 0;
    }

    if (isMissingSortValue(left)) {
      return 1;
    }

    if (isMissingSortValue(right)) {
      return -1;
    }

    const comparison = compareSortValues(left, right);
    return comparison * direction;
  });
}

function getLatestHistoryRow(history) {
  return [...history].sort((a, b) => String(b?.date || '').localeCompare(String(a?.date || '')))[0] || {};
}

function getSortValue(row, key) {
  const positions = dedupePositions(row?.positions);
  const grossPnl = sumPositionValues(positions, 'overallPnlValue');
  const tradeCost = sumTradeCosts(positions);
  const netPnl = Number.isFinite(grossPnl) && Number.isFinite(tradeCost) ? grossPnl - tradeCost : null;

  if (key === 'date') {
    return String(row?.date || '');
  }

  if (key === 'latest') {
    return Number(row?.value);
  }

  if (key === 'first') {
    return Number(row?.firstValue);
  }

  if (key === 'high') {
    return Number(row?.highValue);
  }

  if (key === 'low') {
    return Number(row?.lowValue);
  }

  if (key === 'gross') {
    return grossPnl;
  }

  if (key === 'cost') {
    return tradeCost;
  }

  if (key === 'net') {
    return netPnl;
  }

  if (key === 'trades') {
    return positions.length;
  }

  if (key === 'updatedAt') {
    return Number(row?.updatedAt);
  }

  return '';
}

function compareSortValues(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  const leftIsNumber = Number.isFinite(leftNumber);
  const rightIsNumber = Number.isFinite(rightNumber);

  if (leftIsNumber || rightIsNumber) {
    if (!leftIsNumber) {
      return 1;
    }

    if (!rightIsNumber) {
      return -1;
    }

    return leftNumber - rightNumber;
  }

  return String(left || '').localeCompare(String(right || ''));
}

function isMissingSortValue(value) {
  if (value === null || value === undefined || value === '') {
    return true;
  }

  return typeof value === 'number' && !Number.isFinite(value);
}

function updateSortHeaders() {
  document.querySelectorAll('[data-sort-key]').forEach((button) => {
    const active = button.dataset.sortKey === sortState.key;
    const header = button.closest('th');
    const indicator = button.querySelector('.sortIndicator');

    button.classList.toggle('active', active);

    if (header) {
      header.setAttribute('aria-sort', active ? (sortState.direction === 'asc' ? 'ascending' : 'descending') : 'none');
    }

    if (indicator) {
      indicator.textContent = active ? (sortState.direction === 'asc' ? '↑' : '↓') : '';
    }
  });
}

function renderMonthlySummary(history) {
  const monthlyTotals = getHistoryTotals(history);

  setSummaryValue(monthProfit, monthlyTotals.profit);
  setSummaryValue(monthLoss, monthlyTotals.loss);
  setSummaryValue(monthNet, monthlyTotals.net);
}

function getHistoryTotals(history) {
  return (Array.isArray(history) ? history : []).reduce((totals, row) => {
    const grossPnl = Number(row.value);
    const tradeCost = sumTradeCosts(dedupePositions(row.positions)) ?? 0;
    const value = grossPnl - tradeCost;

    if (!Number.isFinite(value)) {
      return totals;
    }

    return {
      profit: totals.profit + (value > 0 ? value : 0),
      loss: totals.loss + (value < 0 ? value : 0),
      net: totals.net + value
    };
  }, { profit: 0, loss: 0, net: 0 });
}

function getCurrentIstMonthKey() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    month: '2-digit',
    timeZone: 'Asia/Kolkata',
    year: 'numeric'
  }).formatToParts(new Date()).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});

  return `${parts.year}-${parts.month}`;
}

function formatMonthLabel(monthKey) {
  if (monthKey === 'all') {
    return 'all months';
  }

  const match = String(monthKey || '').match(/^(\d{4})-(\d{2})$/);

  if (!match) {
    return 'selected month';
  }

  return new Intl.DateTimeFormat('en-IN', {
    month: 'long',
    timeZone: 'Asia/Kolkata',
    year: 'numeric'
  }).format(new Date(`${match[1]}-${match[2]}-01T00:00:00+05:30`));
}

function setSummaryValue(element, value) {
  if (!element) {
    return;
  }

  element.classList.remove('profit', 'loss', 'neutral');
  element.classList.add(getValueClass(value));
  element.textContent = formatSignedValue(value);
}

function createRows(row) {
  const tableRow = document.createElement('tr');
  const positions = dedupePositions(row.positions);
  const isExpanded = expandedDate === row.date;
  const grossPnl = sumPositionValues(positions, 'overallPnlValue');
  const tradeCost = sumTradeCosts(positions);
  const netPnl = Number.isFinite(grossPnl) && Number.isFinite(tradeCost) ? grossPnl - tradeCost : null;

  tableRow.append(
    createCell(formatHistoryDate(row.date)),
    createValueCell(row.value, row.display),
    createValueCell(row.firstValue, row.firstDisplay),
    createValueCell(row.highValue),
    createValueCell(row.lowValue),
    createValueCell(grossPnl),
    createValueCell(tradeCost),
    createValueCell(netPnl),
    createCell(String(positions.length), 'numeric muted'),
    createCell(formatDateTime(row.updatedAt), 'muted'),
    createActionCell(row, positions, isExpanded)
  );

  if (!positions.length || !isExpanded) {
    return [tableRow];
  }

  const detailsRow = document.createElement('tr');
  const detailsCell = createCell('', 'detailsCell');
  detailsCell.colSpan = 11;
  detailsCell.append(createPositionsTable(row, positions));
  detailsRow.append(detailsCell);

  return [tableRow, detailsRow];
}

function createCell(text, className = '') {
  const cell = document.createElement('td');
  cell.textContent = text;

  if (className) {
    cell.className = className;
  }

  return cell;
}

function createActionCell(row, positions, isExpanded) {
  const cell = document.createElement('td');
  const actions = document.createElement('div');
  const viewButton = document.createElement('button');

  actions.className = 'rowActions';
  viewButton.className = 'smallButton';
  viewButton.dataset.action = 'toggle-trades';
  viewButton.dataset.date = row.date || '';
  viewButton.disabled = positions.length === 0;
  viewButton.textContent = isExpanded ? 'Hide Trades' : 'View Trades';

  actions.append(viewButton);
  cell.append(actions);

  return cell;
}

function createValueCell(value, display) {
  const numericValue = Number(value);
  const hasNumericValue = value !== null && value !== undefined && value !== '' && Number.isFinite(numericValue);
  const cell = createCell(
    hasNumericValue ? display || formatSignedValue(numericValue) : '--',
    `numeric value ${getValueClass(numericValue)}`
  );

  return cell;
}

function createPositionsTable(dayRow, positions) {
  const table = document.createElement('table');
  table.className = 'nestedTable';
  table.append(createPositionsHead(), createPositionsBody(dayRow, positions), createPositionsFoot(positions));
  return table;
}

function createPositionsHead() {
  const head = document.createElement('thead');
  const row = document.createElement('tr');

  ['Section', 'Symbol', 'Category', 'Product', 'Net Qty', 'Avg Price', 'LTP', 'Day P&L', 'Overall P&L', 'Trade Cost', 'Net P/L', 'Note', 'Chart']
    .forEach((label, index) => {
      const cell = document.createElement('th');
      cell.textContent = label;

      if (index >= 4 && index <= 10) {
        cell.className = 'numeric';
      }

      row.append(cell);
    });

  head.append(row);
  return head;
}

function createPositionsBody(dayRow, positions) {
  const body = document.createElement('tbody');

  body.append(...positions.map((position) => {
    const row = document.createElement('tr');
    const noteCell = document.createElement('td');
    const noteInput = document.createElement('input');
    const chartCell = document.createElement('td');
    const grossPnl = getPositionPnlValue(position);
    const tradeCost = getTradeCostValue(position);
    const netPnl = Number.isFinite(grossPnl) ? grossPnl - tradeCost : null;
    const positionKey = getPositionKey(position);

    noteInput.className = 'noteInput';
    noteInput.dataset.date = dayRow.date || '';
    noteInput.dataset.positionKey = positionKey;
    noteInput.maxLength = 180;
    noteInput.placeholder = 'Add note';
    noteInput.type = 'text';
    noteInput.value = position.note || '';
    noteCell.append(noteInput);
    chartCell.append(createChartActions(dayRow, position, positionKey));

    row.append(
      createCell(position.status || position.section || '--', 'muted'),
      createCell(position.symbol || '--'),
      createCell(position.category || '--', 'muted'),
      createCell(position.product || '--', 'muted'),
      createCell(position.netQty || '--', 'numeric muted'),
      createCell(position.avgPrice || '--', 'numeric muted'),
      createCell(position.ltp || '--', 'numeric muted'),
      createValueCell(position.dayPnlValue, position.dayPnl),
      createValueCell(position.overallPnlValue, position.overallPnl),
      createValueCell(tradeCost),
      createValueCell(netPnl),
      noteCell,
      chartCell
    );

    return row;
  }));

  return body;
}

function createPositionsFoot(positions) {
  const foot = document.createElement('tfoot');
  const row = document.createElement('tr');
  const labelCell = createCell('Total', 'totalLabel');
  const overallPnlTotal = sumPositionValues(positions, 'overallPnlValue');
  const tradeCostTotal = sumTradeCosts(positions);
  const netPnlTotal = Number.isFinite(overallPnlTotal) && Number.isFinite(tradeCostTotal)
    ? overallPnlTotal - tradeCostTotal
    : null;

  labelCell.colSpan = 8;
  row.append(
    labelCell,
    createValueCell(overallPnlTotal),
    createValueCell(tradeCostTotal),
    createValueCell(netPnlTotal),
    createCell('', 'muted'),
    createCell('', 'muted')
  );
  foot.append(row);
  return foot;
}

function createChartActions(dayRow, position, positionKey) {
  const actions = document.createElement('div');
  const captureButton = document.createElement('button');
  const screenshot = position.chartScreenshot;

  actions.className = 'chartActions';
  captureButton.className = 'smallButton';
  captureButton.dataset.action = 'capture-chart';
  captureButton.dataset.date = dayRow.date || '';
  captureButton.dataset.positionKey = positionKey;
  captureButton.textContent = screenshot?.dataUrl ? 'Replace' : 'Capture';
  actions.append(captureButton);

  if (screenshot?.dataUrl) {
    const viewButton = document.createElement('button');
    const removeButton = document.createElement('button');
    const capturedLabel = document.createElement('span');

    viewButton.className = 'smallButton secondaryButton';
    viewButton.dataset.action = 'view-chart';
    viewButton.dataset.date = dayRow.date || '';
    viewButton.dataset.positionKey = positionKey;
    viewButton.textContent = 'View';

    removeButton.className = 'smallButton secondaryButton';
    removeButton.dataset.action = 'remove-chart';
    removeButton.dataset.date = dayRow.date || '';
    removeButton.dataset.positionKey = positionKey;
    removeButton.textContent = 'Remove';

    capturedLabel.className = 'chartMeta';
    capturedLabel.textContent = formatScreenshotLabel(screenshot);

    actions.append(viewButton, removeButton, capturedLabel);
  }

  return actions;
}

function sumPositionValues(positions, key) {
  const result = positions.reduce((total, position) => {
    const value = Number(position?.[key]);
    return Number.isFinite(value)
      ? { count: total.count + 1, value: total.value + value }
      : total;
  }, { count: 0, value: 0 });

  return result.count ? result.value : null;
}

function sumTradeCosts(positions) {
  if (!Array.isArray(positions) || !positions.length) {
    return null;
  }

  return positions.reduce((total, position) => total + getTradeCostValue(position), 0);
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

function getValueClass(value) {
  if (value > 0) {
    return 'profit';
  }

  if (value < 0) {
    return 'loss';
  }

  return 'neutral';
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

function formatHistoryDate(dateKey) {
  const value = String(dateKey || '');
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    return value || '--';
  }

  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00+05:30`);
  const weekday = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short'
  }).format(date);

  return `${weekday}, ${value}`;
}

function exportCsv() {
  if (!currentHistory.length) {
    return;
  }

  const header = [
    'Date',
    'Latest',
    'First',
    'High',
    'Low',
    'Last Updated',
    'Section',
    'Symbol',
    'Category',
    'Product',
    'Net Qty',
    'Avg Price',
    'LTP',
    'Position Day P&L',
    'Position Overall P&L',
    'Estimated Trade Cost',
    'Net P&L After Cost',
    'Note'
  ];
  const rows = currentHistory.flatMap((row) => {
    const base = [
      row.date || '',
      row.display || formatSignedValue(Number(row.value)),
      row.firstDisplay || formatSignedValue(Number(row.firstValue)),
      formatSignedValue(Number(row.highValue)),
      formatSignedValue(Number(row.lowValue)),
      formatDateTime(row.updatedAt)
    ];
    const positions = dedupePositions(row.positions);

    if (!positions.length) {
      return [[...base, '', '', '', '', '', '', '', '', '', '', '', '']];
    }

    return positions.map((position) => {
      const grossPnl = getPositionPnlValue(position);
      const tradeCost = getTradeCostValue(position);
      const netPnl = Number.isFinite(grossPnl) ? grossPnl - tradeCost : null;

      return [
        ...base,
        position.status || position.section || '',
        position.symbol || '',
        position.category || '',
        position.product || '',
        position.netQty || '',
        position.avgPrice || '',
        position.ltp || '',
        position.dayPnl || '',
        position.overallPnl || '',
        formatSignedValue(tradeCost),
        formatSignedValue(netPnl),
        position.note || ''
      ];
    });
  });
  const csv = [header, ...rows]
    .map((cells) => cells.map(escapeCsvCell).join(','))
    .join('\n');
  const blobUrl = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const link = document.createElement('a');

  link.href = blobUrl;
  link.download = 'upstox-daily-pnl-history.csv';
  link.click();
  URL.revokeObjectURL(blobUrl);
}

async function clearHistory() {
  if (!allHistory.length || !confirm('Clear all stored P&L history?')) {
    return;
  }

  await chrome.storage.local.set({ [HISTORY_KEY]: [] });
}

function handleHistoryClick(event) {
  const button = event.target.closest('[data-action]');

  if (!button) {
    return;
  }

  if (button.dataset.action === 'toggle-trades') {
    expandedDate = expandedDate === button.dataset.date ? '' : button.dataset.date;
    renderHistory(allHistory);
    return;
  }

  if (button.dataset.action === 'capture-chart') {
    captureChartForTrade(button);
    return;
  }

  if (button.dataset.action === 'view-chart') {
    viewChartForTrade(button);
    return;
  }

  if (button.dataset.action === 'remove-chart') {
    removeChartForTrade(button);
  }
}

function handleNoteFocusIn(event) {
  if (event.target.closest('.noteInput')) {
    noteEditing = true;
  }
}

async function handleNoteFocusOut(event) {
  const input = event.target.closest('.noteInput');

  if (!input) {
    return;
  }

  await saveNote(input);
  noteEditing = false;
}

async function saveNote(input) {
  const date = input.dataset.date;
  const positionKey = input.dataset.positionKey;
  const note = input.value.trim();
  const history = allHistory.map((row) => {
    if (row.date !== date || !Array.isArray(row.positions)) {
      return row;
    }

    return {
      ...row,
      positions: row.positions.map((position) => (
        getPositionKey(position) === positionKey
          ? { ...position, note }
          : position
      ))
    };
  });

  await chrome.storage.local.set({ [HISTORY_KEY]: history });
}

async function captureChartForTrade(button) {
  const originalText = button.textContent;

  button.disabled = true;
  button.textContent = 'Capturing...';
  summary.textContent = 'Capturing the active Upstox chart...';

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'CAPTURE_CHART_SCREENSHOT_FOR_TRADE'
    });

    if (!response?.ok || !response.screenshot?.dataUrl) {
      throw new Error(response?.error || 'Could not capture chart screenshot.');
    }

    await saveChartScreenshot(button.dataset.date, button.dataset.positionKey, response.screenshot);
    summary.textContent = 'Chart screenshot saved to this trade.';
  } catch (error) {
    summary.textContent = error.message || 'Could not capture chart screenshot.';
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function saveChartScreenshot(date, positionKey, screenshot) {
  await updateTradeScreenshot(date, positionKey, {
    dataUrl: screenshot.dataUrl,
    capturedAt: Number(screenshot.capturedAt) || Date.now(),
    label: screenshot.label || ''
  });
}

async function removeChartForTrade(button) {
  if (!confirm('Remove the saved chart screenshot for this trade?')) {
    return;
  }

  await updateTradeScreenshot(button.dataset.date, button.dataset.positionKey, null);
  summary.textContent = 'Chart screenshot removed from this trade.';
}

async function updateTradeScreenshot(date, positionKey, chartScreenshot) {
  const history = allHistory.map((row) => {
    if (row.date !== date || !Array.isArray(row.positions)) {
      return row;
    }

    return {
      ...row,
      positions: row.positions.map((position) => (
        getPositionKey(position) === positionKey
          ? { ...position, chartScreenshot }
          : position
      ))
    };
  });

  await chrome.storage.local.set({ [HISTORY_KEY]: history });
}

function viewChartForTrade(button) {
  const screenshot = findTradeScreenshot(button.dataset.date, button.dataset.positionKey);

  if (!screenshot?.dataUrl) {
    summary.textContent = 'No chart screenshot saved for this trade.';
    return;
  }

  screenshotDialogTitle.textContent = formatScreenshotLabel(screenshot);
  screenshotDialogImage.src = screenshot.dataUrl;
  screenshotDialog.showModal();
}

function findTradeScreenshot(date, positionKey) {
  const dayRow = allHistory.find((row) => row.date === date);
  const position = Array.isArray(dayRow?.positions)
    ? dayRow.positions.find((item) => getPositionKey(item) === positionKey)
    : null;

  return position?.chartScreenshot || null;
}

function closeScreenshotViewer() {
  screenshotDialog.close();
  screenshotDialogImage.removeAttribute('src');
}

function handleScreenshotDialogClick(event) {
  if (event.target === screenshotDialog) {
    closeScreenshotViewer();
  }
}

function formatScreenshotLabel(screenshot) {
  const capturedAt = Number(screenshot?.capturedAt);

  if (Number.isFinite(capturedAt)) {
    return `Chart ${formatDateTime(capturedAt)}`;
  }

  return screenshot?.label || 'Saved chart';
}

async function sendAllTradesToDiscord() {
  const trades = getAllTradeRows(currentHistory);

  if (!trades.length) {
    summary.textContent = 'No trades available to send.';
    return;
  }

  sendAllDiscordButton.disabled = true;
  sendAllDiscordButton.textContent = 'Sending...';

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'SEND_TODAY_TRADES_TO_DISCORD',
      date: selectedMonth === 'all' ? 'All history' : formatMonthLabel(selectedMonth),
      dayPnl: `${currentHistory.length} day(s)`,
      trades
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Could not send trades to Discord.');
    }

    summary.textContent = `Sent ${trades.length} trade(s) from all history to Discord.`;
  } catch (error) {
    summary.textContent = error.message || 'Could not send trades to Discord.';
  } finally {
    sendAllDiscordButton.disabled = getAllTradeRows(currentHistory).length === 0;
    sendAllDiscordButton.textContent = 'Send All Discord';
  }
}

function getAllTradeRows(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history.flatMap((row) => dedupePositions(row.positions).map((position) => {
    const grossPnl = getPositionPnlValue(position);
    const tradeCost = getTradeCostValue(position);
    const netPnl = Number.isFinite(grossPnl) ? grossPnl - tradeCost : null;

    return {
      section: row.date || position.status || position.section || '',
      symbol: position.symbol || '',
      category: position.category || '',
      product: position.product || '',
      netQty: position.netQty || '',
      avgPrice: position.avgPrice || '',
      ltp: position.ltp || '',
      dayPnl: position.dayPnl || '',
      overallPnl: position.overallPnl || '',
      tradeCost: formatSignedValue(tradeCost),
      netPnl: formatSignedValue(netPnl),
      note: position.note || ''
    };
  }));
}

function escapeCsvCell(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function dedupePositions(positions) {
  const uniquePositions = new Map();

  if (!Array.isArray(positions)) {
    return [];
  }

  positions.filter((position) => position?.symbol).forEach((position) => {
    uniquePositions.set(getPositionKey(position), position);
  });

  return Array.from(uniquePositions.values());
}

function getPositionKey(position) {
  if (position?.tradeId) {
    return String(position.tradeId);
  }

  if (position?.contractKey) {
    return String(position.contractKey);
  }

  return [
    position.symbol,
    position.category,
    position.product
  ].map((part) => String(part || '').trim().toUpperCase()).join('|');
}
