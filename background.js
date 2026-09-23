importScripts('option-chain.js');

const DAILY_PNL_ALARM_NAME = 'upstox-daily-pnl-notification';
const CHART_SCREENSHOT_ALARM_NAME = 'upstox-chart-screenshot-schedule';
const BACKGROUND_SCANNER_ALARM_NAME = 'upstox-background-signal-scanner';
const DAILY_PNL_NOTIFICATION_ID = 'upstox-daily-pnl';
const PROFIT_PROTECTION_NOTIFICATION_ID = 'upstox-profit-protection';
const DAILY_PNL_PERIOD_MINUTES = 0.5;
const CHART_SCREENSHOT_PERIOD_MINUTES = 1;
const BACKGROUND_SCANNER_PERIOD_MINUTES = 0.5;
const CHART_SCREENSHOT_INTERVAL_MINUTES = 15;
const MARKET_START_MINUTES_IST = (9 * 60) + 15;
const MARKET_END_MINUTES_IST = (15 * 60) + 30;
const NOTIFICATION_TIMEOUT_MS = 2500;
const DAILY_PNL_IMMEDIATE_NOTIFICATION_INTERVAL_MS = 20000;
const NOTIFICATION_ICON_URL = 'icon-128.png';
const DAILY_PNL_HISTORY_KEY = 'dailyPnlHistory';
const ACTIVE_POSITION_JOURNAL_KEY = 'activePositionJournal';
const SIGNAL_HISTORY_KEY = 'signalHistory';
const DAILY_PNL_HISTORY_LIMIT = 120;
const SIGNAL_HISTORY_LIMIT = 5000;
const PROFIT_PROTECTION_THRESHOLD = 5000;
const PROFIT_PROTECTION_INTERVAL_MS = 10000;
const PROFIT_PROTECTION_RULES = [
  'Stop when the plan is done.',
  'Protect family capital.',
  'Respect your father’s hard work.',
  'Consistent profit beats one lucky day.',
  'No revenge trades. No boredom trades.',
  'Long run matters more than one extra trade.'
];
const DAILY_PNL_PROFIT_COLOR = '#16a34a';
const DAILY_PNL_LOSS_COLOR = '#dc2626';
const DAILY_PNL_NEUTRAL_COLOR = '#6b7280';
const DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1510245284507287783/6W8nJrQYUL1UqoQWM4atIwtovtoM7AHBxd3x0F-qMDSkVQ5GDMx_0fZYt0yiVidZy0Ph';
const DISCORD_TRADES_WEBHOOK_URL = 'https://discord.com/api/webhooks/1511021517604126870/UpMKCrk4fXf-ObkpUzunsmuQa8h7xj9KZQEOIut-HspOtlmTJtizvKYC-HngQW2fC_iB';
const DISCORD_DAILY_PNL_INTERVAL_MS = 20000;
let lastDailyPnlNotificationAt = 0;
let lastDiscordDailyPnlSentAt = 0;
let lastProfitProtectionAlertAt = 0;
let profitProtectionRuleIndex = 0;
let audioDocumentCreationPromise = null;
let signalHistoryWriteQueue = Promise.resolve();
const backgroundScanTabIds = new Set();
let apiScanPromise = null;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request, sender)
    .then(sendResponse)
    .catch((error) => {
      console.error('Upstox notification error:', error);
      sendResponse({ ok: false, error: error.message || String(error) });
    });

  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DAILY_PNL_ALARM_NAME) {
    showLatestDailyPnlNotification();
    return;
  }

  if (alarm.name === CHART_SCREENSHOT_ALARM_NAME) {
    sendScheduledChartScreenshot();
    return;
  }

  if (alarm.name === BACKGROUND_SCANNER_ALARM_NAME) {
    scanUpstoxTabsInBackground().catch((error) => {
      console.error('Background Upstox scan failed:', error);
    });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== 'complete' && changeInfo.discarded !== true) {
    return;
  }

  if (!isUpstoxOptionChainUrl(changeInfo.url || tab.url)) {
    return;
  }

  chrome.tabs.update(tabId, { autoDiscardable: false }).catch((error) => {
    console.error(`Could not keep Upstox option-chain tab ${tabId} resident:`, error);
  });

  if (changeInfo.status === 'complete') {
    scanUpstoxTabInBackground({ ...tab, id: tabId }).catch((error) => {
      console.error(`Could not scan loaded Upstox option-chain tab ${tabId}:`, error);
    });
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') {
    return;
  }

  if (changes.notificationsEnabled?.newValue === false) {
    chrome.alarms.clear(DAILY_PNL_ALARM_NAME);
  }

  if (changes.chartScreenshotsEnabled) {
    syncChartScreenshotAlarm();
  }

});

chrome.runtime.onInstalled.addListener(syncExtensionAlarms);
chrome.runtime.onStartup.addListener(syncExtensionAlarms);
syncExtensionAlarms().catch((error) => {
  console.error('Could not initialize extension alarms:', error);
});

async function syncExtensionAlarms() {
  // Serialize preview cleanup with signal writes so live records cannot be lost.
  const cleanup = signalHistoryWriteQueue.then(async () => {
    const { signalHistory = [] } = await chrome.storage.local.get(SIGNAL_HISTORY_KEY);
    if (!Array.isArray(signalHistory)) return;
    const kept = signalHistory.filter((row) => !(row?.isDummy || /dummy/i.test(row?.pattern || '') || /^Dummy\b/i.test(row?.message || '')));
    if (kept.length !== signalHistory.length) await chrome.storage.local.set({ [SIGNAL_HISTORY_KEY]: kept });
  });
  signalHistoryWriteQueue = cleanup.catch(() => {});
  await cleanup;
  // Remove credentials from the abandoned API configuration, if it was used.
  await chrome.storage.session.remove(['upstoxSignalAccessToken', 'optionChainSnapshots']);
  await Promise.all([
    syncChartScreenshotAlarm(),
    syncBackgroundScannerAlarm()
  ]);
  await scanUpstoxTabsInBackground();
}

async function syncBackgroundScannerAlarm() {
  const existing = await chrome.alarms.get(BACKGROUND_SCANNER_ALARM_NAME);
  if (existing?.periodInMinutes === BACKGROUND_SCANNER_PERIOD_MINUTES) return;
  await chrome.alarms.create(BACKGROUND_SCANNER_ALARM_NAME, {
    delayInMinutes: BACKGROUND_SCANNER_PERIOD_MINUTES,
    periodInMinutes: BACKGROUND_SCANNER_PERIOD_MINUTES
  });
}

async function scanUpstoxTabsInBackground() {
  if (apiScanPromise) return apiScanPromise;
  apiScanPromise = (async () => {
    const tabs = (await chrome.tabs.query({ url: 'https://pro.upstox.com/*' })).filter((tab) => isUpstoxOptionChainUrl(tab.url));
    const messages = [];
    for (const tab of tabs) {
      try { messages.push((await processChainPage(tab)).message); }
      catch { messages.push('Could not read an option-chain tab. Keep it open and logged in.'); }
    }
    const message = messages.length ? messages.join(' | ') : 'Open an option-chain page for a stock/index to start reading signals.';
    await updateSignalScannerStatus(message);
    return { ok: true, message };
  })().finally(() => { apiScanPromise = null; });
  return apiScanPromise;
}

async function scanUpstoxTabInBackground() { return scanUpstoxTabsInBackground(); }

function isUpstoxOptionChainUrl(url) {
  try {
    const parsed = new URL(url || '');
    return parsed.hostname === 'pro.upstox.com'
      && (parsed.pathname === '/option-chain' || parsed.pathname.startsWith('/option-chain/'));
  } catch {
    return false;
  }
}

async function handleMessage(request, sender = {}, internalChainSignal = false) {
  if (request.type === 'SCAN_SIGNALS_NOW') {
    if (sender.url !== chrome.runtime.getURL('popup.html')) return { ok: false, error: 'Use the extension popup to scan.' };
    return scanUpstoxTabsInBackground();
  }
  if (request.type === 'TEST_SIGNAL_AUDIO') {
    const action = request.action === 'SELL' ? 'SELL' : 'BUY';
    return playSignalVoice({
      action,
      symbol: request.symbol || 'test'
    });
  }

  if (request.type === 'SHOW_NOTIFICATION') {
    if (!internalChainSignal
      || request.source !== 'option-chain-dom' || request.signalVersion !== UpstoxOptionChain.VERSION) {
      return { ok: true, skipped: true, reason: 'Untrusted source or old scanner version.' };
    }
    const storedSignal = await recordSignalHistory(request);
    if (!storedSignal.stored) {
      return { ok: true, skipped: true, reason: storedSignal.reason || 'Duplicate signal.', signalId: storedSignal.signalId };
    }
    let notificationResult = { ok: true, skipped: true };
    const signalVoicePromise = playSignalVoice(request).catch((error) => {
      console.error('Could not play signal voice:', error);
      return { ok: false, error: error.message || String(error) };
    });

    try {
      notificationResult = await showNotification({
        title: request.title || 'Upstox Alert',
        message: request.message || 'Pattern detected.',
        timeoutMs: request.timeoutMs || NOTIFICATION_TIMEOUT_MS
      });
    } catch (error) {
      console.error('Could not show Chrome notification:', error);
      notificationResult = { ok: false, error: error.message || String(error) };
    }

    const discordResult = await sendSignalToDiscord(request).catch((error) => {
      console.error('Could not send signal to Discord:', error);
      return { ok: false, error: error.message || String(error) };
    });
    await signalVoicePromise;

    const result = notificationResult.ok ? notificationResult : discordResult;
    return { ...result, signalStored: storedSignal.stored, signalId: storedSignal.signalId };
  }

  if (request.type === 'TEST_PROFIT_PROTECTION_ALERT') {
    const display = request.display || '₹5,800';
    const { profitProtectionEnabled = true } = await chrome.storage.local.get('profitProtectionEnabled');

    if (profitProtectionEnabled === false) {
      return { ok: true, skipped: true, reason: 'Profit protection alert disabled.' };
    }

    await showNotification({
      notificationId: `${PROFIT_PROTECTION_NOTIFICATION_ID}-test`,
      title: 'Protect Today’s Profit',
      message: `Hey man, you are up ${display}. ${getNextProfitProtectionRule()}`,
      timeoutMs: 12000
    });
    await showProfitProtectionBannerInUpstox(display);
    return { ok: true };
  }

  if (request.type === 'UPDATE_DAILY_PNL') {
    const now = Date.now();
    const positions = normalizeTradingDetails(request.positions);
    const journal = await updatePositionJournal(positions, now);

    await chrome.storage.local.set({
      latestDailyPnl: {
        display: request.display,
        value: request.value,
        updatedAt: now,
        positions: journal
      }
    });
    await recordDailyPnlHistory(request, now, journal);
    await updateDailyPnlBadge(request.value);
    await ensureDailyPnlAlarm();
    await showDailyPnlNotification(request, { throttle: true }).catch((error) => {
      console.error('Could not show Day P&L notification:', error);
    });
    await showProfitProtectionNotification(request, now).catch((error) => {
      console.error('Could not show profit protection notification:', error);
    });
    await sendDailyPnlToDiscord(request);
    return { ok: true };
  }

  if (request.type === 'CAPTURE_DAILY_PNL_FROM_UPSTOX') {
    return captureDailyPnlFromUpstox();
  }

  if (request.type === 'SEND_TODAY_TRADES_TO_DISCORD') {
    return sendTradesTableToDiscord(request);
  }

  if (request.type === 'SEND_CHART_SCREENSHOT_NOW') {
    return sendChartScreenshotToDiscord({ reason: 'manual' });
  }

  if (request.type === 'CAPTURE_CHART_SCREENSHOT_FOR_TRADE') {
    return captureChartScreenshotForTrade();
  }

  if (request.type === 'UPDATE_CHART_SCREENSHOT_SCHEDULE') {
    await chrome.storage.local.set({
      chartScreenshotsEnabled: Boolean(request.enabled)
    });
    await syncChartScreenshotAlarm();
    return { ok: true };
  }

  return { ok: false, error: 'Unsupported message type.' };
}

async function recordSignalHistory(signal) {
  const write = signalHistoryWriteQueue.then(() => writeSignalHistory(signal));
  signalHistoryWriteQueue = write.catch(() => {});
  return write;
}

async function updateSignalScannerStatus(message, source = 'option-chain-dom') {
  await chrome.storage.local.set({ signalScannerStatus: { message, source, updatedAt: Date.now() } });
}

async function processChainPage(tab) {
  const now = Date.now();
  const ist = new Date(now + 330 * 60000);
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if ([0, 6].includes(ist.getUTCDay()) || minutes < 555 || minutes >= 930) {
    await chrome.storage.session.remove('optionChainPageSamples');
    return { ok: true, message: 'Outside the NSE/BSE session. No option-chain decisions.' };
  }
  await chrome.tabs.update(tab.id, { autoDiscardable: false });
  if (tab.discarded) return { ok: false, message: 'Option-chain tab was unloaded. Reload it to resume live data.' };
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['option-chain-reader.js'] });
  const [response] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => globalThis.UpstoxOptionChainReader.read(document, location.href)
  });
  const result = response?.result;
  const { optionChainPageSamples = {} } = await chrome.storage.session.get('optionChainPageSamples');
  const streams = Object.fromEntries(Object.entries(optionChainPageSamples).filter(([, samples]) => samples?.at(-1)?.receivedAt > now - 120000));
  if (!result?.found) {
    delete streams[tab.id];
    await chrome.storage.session.set({ optionChainPageSamples: streams });
    return { ok: false, message: result?.message || 'Cannot read this option-chain page.' };
  }
  const snapshot = result.snapshot;
  const currentTab = await chrome.tabs.get(tab.id);
  if (currentTab.url !== tab.url) return { ok: true, message: 'Underlying changed while reading; waiting for the next snapshot.' };
  const previous = streams[tab.id]?.at(-1);
  const sameContext = previous?.instrumentKey === snapshot.instrumentKey && previous?.expiry === snapshot.expiry
    && previous?.selectedUnderlying === snapshot.selectedUnderlying;
  if (sameContext && snapshot.receivedAt - previous.receivedAt < 25000) {
    return { ok: true, message: result.message + ' Waiting for the next 30-second comparison.' };
  }
  const continuous = sameContext && snapshot.receivedAt - previous.receivedAt <= 75000;
  const samples = [...(continuous ? streams[tab.id] : []), snapshot].slice(-3);
  streams[tab.id] = samples;
  await chrome.storage.session.set({ optionChainPageSamples: streams });
  const decision = UpstoxOptionChain.evaluate(samples, Date.now());
  for (const signal of decision.signals) {
    await handleMessage({
      ...signal, type: 'SHOW_NOTIFICATION', title: signal.type,
      signalVersion: UpstoxOptionChain.VERSION, signalKey: signal.key,
      message: `${signal.symbol} · expiry ${signal.expiry}. ${signal.reasons.join(' ')}`
    }, {}, true);
  }
  return { ok: true, message: `${snapshot.instrumentKey} · ${snapshot.expiry}: ${decision.reason}` };
}

async function writeSignalHistory(signal) {
  if (signal.source !== 'option-chain-dom') return { stored: false, reason: 'Invalid source.' };
  const now = new Date();
  const date = getIstDateKey(now);
  const timestamp = now.getTime();
  const action = normalizeSignalAction(signal);
  const pattern = String(signal.pattern || signal.title || 'Option-chain signal').trim();
  const symbol = String(signal.symbol || extractSignalSymbol(signal.message) || 'Chart').trim();
  const interval = String(signal.interval || extractSignalInterval(signal.message) || 'visible').trim();
  const priceRange = String(signal.priceRange || extractSignalPriceRange(signal.message) || '--').trim();
  const sourceKey = String(signal.signalKey || signal.key || '').trim();
  const dedupeKey = [date, sourceKey || [action, pattern, symbol, interval, priceRange].join('|')].join('|');
  const signalId = `${date}-${timestamp}-${action}`;
  const { [SIGNAL_HISTORY_KEY]: history = [], signalAlertState = {} } = await chrome.storage.local.get([SIGNAL_HISTORY_KEY, 'signalAlertState']);
  const rows = Array.isArray(history) ? history : [];
  const barTime = Number(signal.observedAt);
  const streamKey = JSON.stringify([signal.source, symbol, signal.expiry]);
  const previousAlert = signalAlertState[streamKey];
  if (!action || !Number.isFinite(barTime) || barTime > timestamp || timestamp - barTime > 45000) {
    return { stored: false, reason: 'Invalid or stale signal.' };
  }
  if (previousAlert && barTime - previousAlert.barTime < 180000) {
    return { stored: false, reason: 'Duplicate signal or three-minute cooldown.' };
  }

  if (rows.some((row) => row?.dedupeKey === dedupeKey)) {
    return { stored: false, signalId: rows.find((row) => row?.dedupeKey === dedupeKey)?.id || '' };
  }

  const nextHistory = [...rows, {
    id: signalId,
    dedupeKey,
    date,
    timestamp,
    time: new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    }).format(now),
    action,
    pattern,
    symbol,
    interval,
    priceRange,
    barTime,
    observedAt: signal.observedAt,
    expiry: signal.expiry,
    source: signal.source,
    confirmation: signal.confirmation,
    signalVersion: signal.signalVersion,
    reasons: signal.reasons,
    metrics: signal.metrics,
    message: `${action === 'BUY' ? 'Bullish' : 'Bearish'} option-chain confirmation for ${symbol}, expiry ${signal.expiry || '--'}. ${Array.isArray(signal.reasons) ? signal.reasons.join(' ') : 'Confirmed using displayed OI, traded volume and option premiums.'}`
  }].slice(-SIGNAL_HISTORY_LIMIT);

  const recentStates = Object.fromEntries(Object.entries(signalAlertState)
    .filter(([, value]) => value?.updatedAt > timestamp - 86400000));
  recentStates[streamKey] = { barTime, updatedAt: timestamp };
  await chrome.storage.local.set({ [SIGNAL_HISTORY_KEY]: nextHistory, signalAlertState: recentStates });
  return { stored: true, signalId };
}

async function captureDailyPnlFromUpstox() {
  const tab = await findUpstoxTab();

  if (!tab?.id) {
    return { ok: false, error: 'Open https://pro.upstox.com first.' };
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    injectImmediately: true,
    files: ['content.js']
  });

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => window.upstoxAlertAgent?.handleCommand({ type: 'CAPTURE_DAILY_PNL' }) || null
  });
  const responses = results.map((result) => result.result).filter(Boolean);
  const response = responses.find((item) => item.found && item.tradingDetailsCount > 0)
    || responses.find((item) => item.found)
    || responses[0];

  return response
    ? { ok: true, ...response }
    : { ok: false, error: 'Could not read visible Upstox P&L.' };
}

async function sendTradesTableToDiscord({ date, dayPnl, trades }) {
  const rows = Array.isArray(trades) ? trades.filter((trade) => trade?.symbol) : [];

  if (!rows.length) {
    return { ok: false, error: 'No trades available to send.' };
  }

  const title = `Upstox trades ${date || getIstDateKey(new Date())} | Day P&L ${dayPnl || '--'}`;
  const messages = buildDiscordTradeMessages(title, rows);

  for (const content of messages) {
    const response = await fetch(DISCORD_TRADES_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ content })
    });

    if (!response.ok) {
      throw new Error(`Discord webhook returned HTTP ${response.status}`);
    }
  }

  return { ok: true, sent: rows.length };
}

function buildDiscordTradeMessages(title, trades) {
  const header = ['Symbol', 'Qty', 'Avg', 'LTP', 'Day P&L', 'Overall', 'Cost', 'Net', 'Note'];
  const widths = [18, 7, 8, 8, 10, 10, 8, 10, 18];
  const divider = widths.map((width) => '-'.repeat(width)).join('-|-');
  const headerLine = formatDiscordTableRow(header, widths);
  const tableRows = trades.map((trade) => formatDiscordTableRow([
    trade.symbol || '--',
    trade.netQty || '--',
    trade.avgPrice || '--',
    trade.ltp || '--',
    trade.dayPnl || '--',
    trade.overallPnl || '--',
    trade.tradeCost || '--',
    trade.netPnl || '--',
    trade.note || ''
  ], widths));
  const messages = [];
  let current = `${title}\n\`\`\`\n${headerLine}\n${divider}\n`;

  tableRows.forEach((row) => {
    const next = `${current}${row}\n`;

    if (next.length > 1850) {
      messages.push(`${current}\`\`\``);
      current = `${title} continued\n\`\`\`\n${headerLine}\n${divider}\n${row}\n`;
      return;
    }

    current = next;
  });

  messages.push(`${current}\`\`\``);
  return messages;
}

function formatDiscordTableRow(cells, widths) {
  return cells.map((cell, index) => fitTableCell(cell, widths[index])).join(' | ');
}

function fitTableCell(value, width) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();

  if (text.length > width) {
    return `${text.slice(0, Math.max(width - 1, 0))}.`;
  }

  return text.padEnd(width, ' ');
}

async function recordDailyPnlHistory(pnl, timestamp, scannedPositions) {
  const value = Number(pnl.value);

  if (!Number.isFinite(value) || !pnl.display) {
    return;
  }

  const dateKey = getIstDateKey(new Date(timestamp));
  const { [DAILY_PNL_HISTORY_KEY]: history = [] } = await chrome.storage.local.get(DAILY_PNL_HISTORY_KEY);
  const rows = Array.isArray(history) ? history : [];
  const existing = rows.find((row) => row.date === dateKey);
  const existingHigh = Number.isFinite(Number(existing?.highValue)) ? Number(existing.highValue) : value;
  const existingLow = Number.isFinite(Number(existing?.lowValue)) ? Number(existing.lowValue) : value;
  const positions = mergePositionDetails(
    normalizeTradingDetails(scannedPositions || pnl.positions),
    existing?.positions
  );
  const nextRow = existing
    ? {
        ...existing,
        display: pnl.display,
        value,
        updatedAt: timestamp,
        highValue: Math.max(existingHigh, value),
        lowValue: Math.min(existingLow, value),
        positions,
        scans: Number(existing.scans || 0) + 1
      }
    : {
        date: dateKey,
        display: pnl.display,
        value,
        firstDisplay: pnl.display,
        firstValue: value,
        highValue: value,
        lowValue: value,
        positions,
        firstSeenAt: timestamp,
        updatedAt: timestamp,
        scans: 1
      };
  const nextHistory = rows
    .filter((row) => row.date !== dateKey)
    .concat(nextRow)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, DAILY_PNL_HISTORY_LIMIT);

  await chrome.storage.local.set({ [DAILY_PNL_HISTORY_KEY]: nextHistory });
}

function normalizeTradingDetails(positions) {
  if (!Array.isArray(positions)) {
    return [];
  }

  const uniquePositions = new Map();

  positions.map(normalizeTradingDetail).filter((position) => position.symbol)
    .forEach((position) => {
      uniquePositions.set(getTradingDetailKey(position), position);
    });

  return Array.from(uniquePositions.values());
}

function normalizeTradingDetail(position) {
  const normalized = {
    section: String(position.section || ''),
    symbol: String(position.symbol || ''),
    category: String(position.category || ''),
    product: String(position.product || ''),
    netQty: String(position.netQty || ''),
    avgPrice: String(position.avgPrice || ''),
    ltp: String(position.ltp || ''),
    dayPnl: String(position.dayPnl || ''),
    overallPnl: String(position.overallPnl || ''),
    note: String(position.note || ''),
    tradeId: String(position.tradeId || ''),
    entryTimestamp: toFiniteNumber(position.entryTimestamp),
    entryDate: String(position.entryDate || ''),
    status: String(position.status || ''),
    buyPriceValue: toFiniteNumber(position.buyPriceValue ?? position.avgPriceValue),
    lotSizeValue: toFiniteNumber(position.lotSizeValue ?? position.netQtyValue),
    netQtyValue: toFiniteNumber(position.netQtyValue),
    avgPriceValue: toFiniteNumber(position.avgPriceValue),
    ltpValue: toFiniteNumber(position.ltpValue),
    dayPnlValue: toFiniteNumber(position.dayPnlValue),
    overallPnlValue: toFiniteNumber(position.overallPnlValue),
    chartScreenshot: normalizeChartScreenshot(position.chartScreenshot)
  };
  const contract = getOptionContractIdentity(normalized);

  return {
    ...normalized,
    ...contract
  };
}

function getTradingDetailKey(position) {
  if (position.contractKey) {
    return position.contractKey;
  }

  return [
    position.symbol,
    position.category,
    position.product
  ].map((part) => String(part || '').trim().toUpperCase()).join('|');
}

function mergePositionDetails(nextPositions, existingPositions) {
  if (!Array.isArray(existingPositions) || !existingPositions.length) {
    return nextPositions;
  }

  if (!nextPositions.length) {
    return existingPositions;
  }

  const existingByKey = new Map(
    existingPositions
      .filter((position) => position?.symbol)
      .map((position) => [getTradingDetailKey(position), position])
  );

  return nextPositions.map((position) => ({
    ...position,
    note: existingByKey.get(getTradingDetailKey(position))?.note || position.note || '',
    chartScreenshot: existingByKey.get(getTradingDetailKey(position))?.chartScreenshot || position.chartScreenshot || null
  }));
}

function normalizeChartScreenshot(screenshot) {
  if (!screenshot?.dataUrl) {
    return null;
  }

  return {
    dataUrl: String(screenshot.dataUrl),
    capturedAt: Number(screenshot.capturedAt) || Date.now(),
    label: String(screenshot.label || '')
  };
}

async function updatePositionJournal(scannedPositions, timestamp) {
  const dateKey = getIstDateKey(new Date(timestamp));
  const { [ACTIVE_POSITION_JOURNAL_KEY]: storedJournal = [] } = await chrome.storage.local.get(ACTIVE_POSITION_JOURNAL_KEY);
  const journal = Array.isArray(storedJournal)
    ? storedJournal.map(normalizeTradingDetail).filter((position) => position.symbol)
    : [];
  const scannedKeys = new Set(scannedPositions.map(getTradingDetailKey));
  const nextJournal = [...journal];

  scannedPositions.forEach((position) => {
    const contractKey = getTradingDetailKey(position);
    const existingIndex = nextJournal.findIndex((entry) => (
      getTradingDetailKey(entry) === contractKey && (
        !isClosedPosition(entry)
        || (isClosedPosition(position) && shouldShowJournalEntry(entry, dateKey))
      )
    ));

    if (existingIndex < 0) {
      nextJournal.push(createJournalEntry(position, timestamp, dateKey));
      return;
    }

    nextJournal[existingIndex] = mergeJournalEntry(nextJournal[existingIndex], position, timestamp, dateKey);
  });

  await chrome.storage.local.set({ [ACTIVE_POSITION_JOURNAL_KEY]: nextJournal });
  return nextJournal.filter((position) => (
    scannedKeys.has(getTradingDetailKey(position))
    && shouldShowJournalEntry(position, dateKey)
  ));
}

function createJournalEntry(position, timestamp, dateKey) {
  const quantity = Math.abs(Number(position.netQtyValue || 0));

  return {
    ...position,
    tradeId: position.tradeId || createTradeId(position, timestamp),
    entryTimestamp: position.entryTimestamp || timestamp,
    entryDate: position.entryDate || dateKey,
    buyPriceValue: Number.isFinite(Number(position.avgPriceValue)) ? Number(position.avgPriceValue) : null,
    lotSizeValue: Number.isFinite(quantity) ? quantity : null,
    status: isClosedPosition(position) ? 'Closed' : 'Open',
    updatedAt: timestamp
  };
}

function mergeJournalEntry(existing, position, timestamp, dateKey) {
  const previousQuantity = Math.abs(Number(existing.lotSizeValue ?? existing.netQtyValue ?? 0));
  const currentQuantity = Math.abs(Number(position.netQtyValue ?? 0));
  const currentPrice = Number(position.avgPriceValue);
  const addedToday = existing.entryDate === dateKey
    && currentQuantity > previousQuantity
    && Number.isFinite(currentPrice);
  const lotSizeValue = Number.isFinite(currentQuantity) ? currentQuantity : existing.lotSizeValue;
  const buyPriceValue = addedToday && currentQuantity > 0 ? currentPrice : existing.buyPriceValue;

  return {
    ...existing,
    ...position,
    tradeId: existing.tradeId || position.tradeId || createTradeId(position, existing.entryTimestamp || timestamp),
    entryTimestamp: existing.entryTimestamp || position.entryTimestamp || timestamp,
    entryDate: existing.entryDate || position.entryDate || dateKey,
    buyPriceValue: Number.isFinite(buyPriceValue) ? buyPriceValue : existing.buyPriceValue,
    lotSizeValue,
    note: existing.note || position.note || '',
    chartScreenshot: existing.chartScreenshot || position.chartScreenshot || null,
    status: getJournalStatus(existing, position, dateKey),
    updatedAt: timestamp
  };
}

function getJournalStatus(existing, position, dateKey) {
  if (isClosedPosition(position)) {
    return 'Closed';
  }

  if (existing.entryDate && existing.entryDate !== dateKey) {
    return 'Held/Carried Forward';
  }

  return 'Open';
}

function isClosedPosition(position) {
  const section = String(position.section || '').trim();
  const quantity = Number(position.netQtyValue);

  return /closed/i.test(section) || (Number.isFinite(quantity) && quantity === 0);
}

function shouldShowJournalEntry(position, dateKey) {
  if (!isClosedPosition(position)) {
    return true;
  }

  if (position.entryDate === dateKey) {
    return true;
  }

  const updatedAt = Number(position.updatedAt);
  return Number.isFinite(updatedAt) && getIstDateKey(new Date(updatedAt)) === dateKey;
}

function createTradeId(position, timestamp) {
  return [
    'TRD',
    getIstDateKey(new Date(timestamp)).replace(/-/g, ''),
    Math.abs(hashString(`${getTradingDetailKey(position)}|${timestamp}`)).toString(36).toUpperCase()
  ].join('-');
}

function hashString(value) {
  return String(value).split('').reduce((hash, char) => {
    const nextHash = ((hash << 5) - hash) + char.charCodeAt(0);
    return nextHash | 0;
  }, 0);
}

function getOptionContractIdentity(position) {
  const source = [
    position.symbol,
    position.category,
    position.product
  ].map((part) => String(part || '').toUpperCase()).join(' ').replace(/\s+/g, ' ').trim();
  const optionType = source.match(/\b(CE|PE)\b/)?.[1] || '';
  const strikeMatch = optionType
    ? source.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${optionType}\\b`))
    : null;
  const strikePrice = strikeMatch?.[1] || '';
  const expiryDate = normalizeExpiryDate(source);
  const stockSymbol = source
    .replace(/\b(?:NFO|NSE|BSE|OPT|FUT|INDEX|OPTION|INTRADAY|DELIVERY)\b/g, ' ')
    .replace(/\b(?:CE|PE)\b/g, ' ')
    .replace(/\b\d{1,2}\s*(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(?:\s*\d{2,4})?\b/g, ' ')
    .replace(/\b(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s*\d{1,2}(?:\s*\d{2,4})?\b/g, ' ')
    .replace(strikePrice, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!optionType || !strikePrice || !expiryDate) {
    return {
      contractKey: [
        position.symbol,
        position.category,
        position.product
      ].map((part) => String(part || '').trim().toUpperCase()).join('|')
    };
  }

  return {
    stockSymbol,
    optionType,
    strikePrice,
    expiryDate,
    contractKey: [stockSymbol, optionType, strikePrice, expiryDate].join('|')
  };
}

function normalizeExpiryDate(value) {
  const text = String(value || '').toUpperCase();
  const monthMap = {
    JAN: '01',
    FEB: '02',
    MAR: '03',
    APR: '04',
    MAY: '05',
    JUN: '06',
    JUL: '07',
    AUG: '08',
    SEP: '09',
    OCT: '10',
    NOV: '11',
    DEC: '12'
  };
  const dayMonthYear = text.match(/\b(\d{1,2})\s*(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(?:\s*(\d{2,4}))?\b/);
  const monthDayYear = text.match(/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s*(\d{1,2})(?:\s*(\d{2,4}))?\b/);
  const match = dayMonthYear || monthDayYear;

  if (!match) {
    return '';
  }

  const day = dayMonthYear ? match[1] : match[2];
  const month = dayMonthYear ? match[2] : match[1];
  const rawYear = match[3] || String(new Date().getFullYear());
  const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;

  return `${year}-${monthMap[month]}-${pad2(day)}`;
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function syncChartScreenshotAlarm() {
  const { chartScreenshotsEnabled = false } = await chrome.storage.local.get('chartScreenshotsEnabled');

  if (!chartScreenshotsEnabled) {
    await chrome.alarms.clear(CHART_SCREENSHOT_ALARM_NAME);
    return;
  }

  await chrome.alarms.create(CHART_SCREENSHOT_ALARM_NAME, {
    delayInMinutes: CHART_SCREENSHOT_PERIOD_MINUTES,
    periodInMinutes: CHART_SCREENSHOT_PERIOD_MINUTES
  });
}

async function sendScheduledChartScreenshot() {
  const { chartScreenshotsEnabled = false, lastChartScreenshotSlot = '' } = await chrome.storage.local.get([
    'chartScreenshotsEnabled',
    'lastChartScreenshotSlot'
  ]);

  if (!chartScreenshotsEnabled) {
    await chrome.alarms.clear(CHART_SCREENSHOT_ALARM_NAME);
    return { ok: true, skipped: true };
  }

  const slot = getCurrentMarketScreenshotSlot();

  if (!slot || slot.key === lastChartScreenshotSlot) {
    return { ok: true, skipped: true };
  }

  const result = await sendChartScreenshotToDiscord({
    reason: 'scheduled',
    slotLabel: slot.label
  });

  if (result.ok) {
    await chrome.storage.local.set({ lastChartScreenshotSlot: slot.key });
  }

  return result;
}

function getCurrentMarketScreenshotSlot(date = new Date()) {
  const ist = getIstDateParts(date);
  const currentMinutes = (ist.hour * 60) + ist.minute;

  if (
    currentMinutes < MARKET_START_MINUTES_IST
    || currentMinutes > MARKET_END_MINUTES_IST
    || (currentMinutes - MARKET_START_MINUTES_IST) % CHART_SCREENSHOT_INTERVAL_MINUTES !== 0
  ) {
    return null;
  }

  const dateKey = `${ist.year}-${pad2(ist.month)}-${pad2(ist.day)}`;
  const timeKey = `${pad2(ist.hour)}:${pad2(ist.minute)}`;

  return {
    key: `${dateKey} ${timeKey}`,
    label: `${timeKey} IST`
  };
}

function getIstDateKey(date) {
  const parts = getIstDateParts(date);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function getIstDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date).reduce((values, part) => ({
    ...values,
    [part.type]: part.value
  }), {});

  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  };
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

async function sendChartScreenshotToDiscord({ reason, slotLabel } = {}) {
  const previousTab = await getCurrentActiveTab();

  try {
    const tab = await findChartTab();

    if (!tab?.id || !tab.windowId) {
      throw new Error('Open https://pro.upstox.com/trading-charts first.');
    }

    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
    await delay(800);

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'png'
    });
    const blob = await fetch(dataUrl).then((response) => response.blob());
    const timestamp = formatIstTimestamp(new Date());
    const caption = reason === 'scheduled'
      ? `Upstox chart screenshot ${slotLabel || timestamp}`
      : `Upstox chart screenshot ${timestamp}`;
    const formData = new FormData();

    formData.append('payload_json', JSON.stringify({ content: caption }));
    formData.append('file', blob, `upstox-chart-${timestamp.replace(/[: ]/g, '-')}.png`);

    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      throw new Error(`Discord webhook returned HTTP ${response.status}`);
    }

    await chrome.storage.local.set({
      latestChartScreenshot: {
        display: caption,
        sentAt: Date.now()
      }
    });

    return { ok: true, message: 'Screenshot sent to Discord.' };
  } catch (error) {
    console.error('Could not send chart screenshot to Discord:', error);
    return { ok: false, error: error.message || String(error) };
  } finally {
    await restoreActiveTab(previousTab);
  }
}

async function captureChartScreenshotForTrade() {
  const previousTab = await getCurrentActiveTab();

  try {
    const tab = await findChartTab();

    if (!tab?.id || !tab.windowId) {
      throw new Error('Open https://pro.upstox.com/trading-charts first.');
    }

    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
    await delay(800);

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'jpeg',
      quality: 76
    });
    const capturedAt = Date.now();

    return {
      ok: true,
      screenshot: {
        dataUrl,
        capturedAt,
        label: `Captured ${formatIstTimestamp(new Date(capturedAt))}`
      }
    };
  } catch (error) {
    console.error('Could not capture chart screenshot:', error);
    return { ok: false, error: error.message || String(error) };
  } finally {
    await restoreActiveTab(previousTab);
  }
}

async function getCurrentActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  return tab || null;
}

async function restoreActiveTab(tab) {
  if (!tab?.id || !tab.windowId) {
    return;
  }

  try {
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
  } catch (error) {
    console.error('Could not restore previous tab:', error);
  }
}

async function findChartTab() {
  const chartTabs = await chrome.tabs.query({
    url: 'https://pro.upstox.com/trading-charts*'
  });

  if (chartTabs.length) {
    return chartTabs.find((tab) => tab.active) || chartTabs[0];
  }

  const upstoxTabs = await chrome.tabs.query({
    url: 'https://pro.upstox.com/*'
  });

  return upstoxTabs.find((tab) => tab.url?.includes('/trading-charts')) || upstoxTabs[0] || null;
}

async function findUpstoxTab() {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (activeTab?.url?.startsWith('https://pro.upstox.com/')) {
    return activeTab;
  }

  const upstoxTabs = await chrome.tabs.query({
    url: 'https://pro.upstox.com/*'
  });

  return upstoxTabs[0] || null;
}

async function showProfitProtectionBannerInUpstox(display) {
  const tab = await findUpstoxTab();

  if (!tab?.id) {
    return { ok: true, skipped: true };
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    injectImmediately: true,
    files: ['content.js']
  });

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (messageDisplay) => window.upstoxAlertAgent?.handleCommand({
      type: 'SHOW_DISCIPLINE_MESSAGE',
      display: messageDisplay
    }) || null,
    args: [display]
  });
  const shown = results.some((result) => result.result?.message === 'Discipline message shown.');

  return { ok: true, shown };
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function formatIstTimestamp(date) {
  const parts = getIstDateParts(date);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(parts.minute)} IST`;
}

async function ensureDailyPnlAlarm() {
  const { notificationsEnabled = true } = await chrome.storage.local.get('notificationsEnabled');

  if (!notificationsEnabled) {
    await chrome.alarms.clear(DAILY_PNL_ALARM_NAME);
    return;
  }

  const alarm = await chrome.alarms.get(DAILY_PNL_ALARM_NAME);

  if (alarm) {
    return;
  }

  await chrome.alarms.create(DAILY_PNL_ALARM_NAME, {
    delayInMinutes: DAILY_PNL_PERIOD_MINUTES,
    periodInMinutes: DAILY_PNL_PERIOD_MINUTES
  });
}

async function showLatestDailyPnlNotification() {
  const {
    latestDailyPnl,
    notificationsEnabled = true
  } = await chrome.storage.local.get(['latestDailyPnl', 'notificationsEnabled']);

  if (!notificationsEnabled) {
    await chrome.alarms.clear(DAILY_PNL_ALARM_NAME);
    return;
  }

  if (!latestDailyPnl?.display) {
    return;
  }

  await showDailyPnlNotification(latestDailyPnl, { force: true });
}

async function updateDailyPnlBadge(value) {
  const numericValue = Number(value);
  const state = getDailyPnlState(numericValue);
  const color = state === 'profit'
    ? DAILY_PNL_PROFIT_COLOR
    : state === 'loss'
      ? DAILY_PNL_LOSS_COLOR
      : DAILY_PNL_NEUTRAL_COLOR;
  const label = state === 'profit' ? 'P' : state === 'loss' ? 'L' : '0';

  await chrome.action.setBadgeText({ text: label });
  await chrome.action.setBadgeBackgroundColor({ color });
  await updateActionIcon(color, label);
}

function getDailyPnlState(value) {
  if (value > 0) {
    return 'profit';
  }

  if (value < 0) {
    return 'loss';
  }

  return 'neutral';
}

async function updateActionIcon(color, label) {
  if (typeof OffscreenCanvas === 'undefined') {
    return;
  }

  const imageData = [16, 32].reduce((icons, size) => {
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext('2d');
    const radius = Math.round(size * 0.22);

    context.clearRect(0, 0, size, size);
    context.fillStyle = color;
    drawRoundedRect(context, 0, 0, size, size, radius);
    context.fill();

    context.fillStyle = '#ffffff';
    context.font = `800 ${Math.round(size * 0.58)}px system-ui, sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(label, size / 2, size / 2 + Math.round(size * 0.02));

    return {
      ...icons,
      [size]: context.getImageData(0, 0, size, size)
    };
  }, {});

  await chrome.action.setIcon({ imageData });
}

function drawRoundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

async function showDailyPnlNotification(pnl, { force = false, throttle = false } = {}) {
  const now = Date.now();

  if (!force && throttle && now - lastDailyPnlNotificationAt < DAILY_PNL_IMMEDIATE_NOTIFICATION_INTERVAL_MS) {
    return { ok: true, skipped: true };
  }

  const state = getDailyPnlState(Number(pnl.value));
  const pnlType = state === 'profit' ? 'Profit' : state === 'loss' ? 'Loss' : 'Flat';

  const result = await showNotification({
    notificationId: DAILY_PNL_NOTIFICATION_ID,
    title: `Day P&L ${pnlType}`,
    message: `${pnlType}: ${pnl.display}`,
    timeoutMs: NOTIFICATION_TIMEOUT_MS
  });

  lastDailyPnlNotificationAt = now;
  return result;
}

async function showProfitProtectionNotification(pnl, timestamp) {
  const now = Number(timestamp) || Date.now();
  const value = Number(pnl.value);
  const { profitProtectionEnabled = true } = await chrome.storage.local.get('profitProtectionEnabled');

  if (profitProtectionEnabled === false || !Number.isFinite(value) || value < PROFIT_PROTECTION_THRESHOLD) {
    return { ok: true, skipped: true };
  }

  if (now - lastProfitProtectionAlertAt < PROFIT_PROTECTION_INTERVAL_MS) {
    return { ok: true, skipped: true };
  }

  const result = await showNotification({
    notificationId: PROFIT_PROTECTION_NOTIFICATION_ID,
    title: 'Protect Today’s Profit',
    message: `Hey man, you are up ${pnl.display}. ${getNextProfitProtectionRule()}`,
    timeoutMs: 12000
  });
  await showProfitProtectionBannerInUpstox(pnl.display);
  lastProfitProtectionAlertAt = now;

  return result;
}

function getNextProfitProtectionRule() {
  const rule = PROFIT_PROTECTION_RULES[profitProtectionRuleIndex % PROFIT_PROTECTION_RULES.length];
  profitProtectionRuleIndex = (profitProtectionRuleIndex + 1) % PROFIT_PROTECTION_RULES.length;
  return rule;
}

async function sendDailyPnlToDiscord(pnl) {
  const now = Date.now();
  const { discordPnlEnabled = true } = await chrome.storage.local.get('discordPnlEnabled');

  if (!discordPnlEnabled) {
    return { ok: true, skipped: true };
  }

  if (now - lastDiscordDailyPnlSentAt < DISCORD_DAILY_PNL_INTERVAL_MS) {
    return { ok: true, skipped: true };
  }

  const value = Number(pnl.value);

  if (!Number.isFinite(value) || !pnl.display) {
    return { ok: true, skipped: true };
  }

  const state = getDailyPnlState(value);
  const pnlType = state === 'profit' ? 'Profit' : state === 'loss' ? 'Loss' : 'Flat';
  const timestamp = formatIstTimestamp(new Date(now));

  try {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        content: `Day P&L ${pnlType}: ${pnl.display}\nDate/Time: ${timestamp}`
      })
    });

    if (!response.ok) {
      throw new Error(`Discord webhook returned HTTP ${response.status}`);
    }

    lastDiscordDailyPnlSentAt = now;
    return { ok: true };
  } catch (error) {
    console.error('Could not send Day P&L to Discord:', error);
    return { ok: false, error: error.message || String(error) };
  }
}

async function sendSignalToDiscord(signal) {
  const { discordSignalsEnabled = true } = await chrome.storage.local.get('discordSignalsEnabled');

  if (!discordSignalsEnabled) {
    return { ok: true, skipped: true };
  }

  const action = normalizeSignalAction(signal);

  if (!action) {
    return { ok: true, skipped: true };
  }

  const timestamp = formatIstTimestamp(new Date());
  const symbol = signal.symbol || extractSignalSymbol(signal.message) || 'Chart';
  const interval = signal.interval || extractSignalInterval(signal.message) || 'visible';
  const priceRange = signal.priceRange || extractSignalPriceRange(signal.message) || '--';
  const pattern = signal.pattern || signal.title || 'Option-chain signal';

  const response = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      allowed_mentions: { parse: [] },
      content: [
        `${action} Signal: ${symbol}`,
        `Pattern: ${pattern}`,
        `Expiry: ${signal.expiry || '--'}`,
        'Source: displayed option-chain table',
        `Interval: ${interval}`,
        `Range: ${priceRange}`,
        `Date/Time: ${timestamp}`,
        ...(Array.isArray(signal.reasons) ? signal.reasons : [])
      ].join('\n')
    })
  });

  if (!response.ok) {
    throw new Error(`Discord webhook returned HTTP ${response.status}`);
  }

  return { ok: true };
}

function normalizeSignalAction(signal) {
  const text = `${signal.action || ''} ${signal.title || ''}`.toLowerCase();

  if (/\b(buy|bullish)\b/.test(text)) {
    return 'BUY';
  }

  if (/\b(sell|bearish)\b/.test(text)) {
    return 'SELL';
  }

  return '';
}

async function playSignalVoice(signal) {
  const action = normalizeSignalAction(signal);

  if (!action) {
    return { ok: true, skipped: true };
  }

  const symbol = String(signal.symbol || extractSignalSymbol(signal.message) || '')
    .replace(/[^A-Z0-9&.-]+/gi, ' ')
    .trim();
  const label = signal.source === 'option-chain-dom'
    ? `${action === 'BUY' ? 'Buy, bullish' : 'Sell, bearish'} option chain signal`
    : `${action === 'BUY' ? 'Buy' : 'Sell'} signal`;
  const utterance = `${label}${symbol ? ` for ${symbol}` : ''}`;
  await ensureAudioDocument();
  const response = await chrome.runtime.sendMessage({
    type: 'PLAY_SIGNAL_AUDIO',
    action,
    utterance
  });

  if (!response?.ok) {
    throw new Error(response?.error || 'Signal audio did not play.');
  }

  return { ok: true, utterance };
}

async function ensureAudioDocument() {
  const audioDocumentUrl = chrome.runtime.getURL('offscreen.html');
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [audioDocumentUrl]
  });

  if (existingContexts.length) {
    return;
  }

  if (!audioDocumentCreationPromise) {
    audioDocumentCreationPromise = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Play audible buy and sell trading signal alerts.'
    }).finally(() => {
      audioDocumentCreationPromise = null;
    });
  }

  await audioDocumentCreationPromise;
}

function extractSignalSymbol(message) {
  return String(message || '').match(/^\s*([^:]+?)\s+\S+\s*:/)?.[1]?.trim() || '';
}

function extractSignalInterval(message) {
  return String(message || '').match(/^\s*[^:]+?\s+(\S+)\s*:/)?.[1]?.trim() || '';
}

function extractSignalPriceRange(message) {
  return String(message || '').match(/:\s*(.+)\s*$/)?.[1]?.trim() || '';
}

async function showNotification({ notificationId, title, message, timeoutMs }) {
  const { notificationsEnabled = true } = await chrome.storage.local.get('notificationsEnabled');

  if (!notificationsEnabled) {
    return { ok: true, skipped: true };
  }

  const permissionLevel = await chrome.notifications.getPermissionLevel();

  if (permissionLevel !== 'granted') {
    throw new Error(`Chrome notifications permission is ${permissionLevel}.`);
  }

  const options = {
    type: 'basic',
    iconUrl: NOTIFICATION_ICON_URL,
    title,
    message,
    priority: 2,
    silent: false,
    requireInteraction: false
  };
  const createdNotificationId = notificationId
    ? await chrome.notifications.create(notificationId, options)
    : await chrome.notifications.create(options);

  if (timeoutMs) {
    setTimeout(() => {
      chrome.notifications.clear(createdNotificationId).catch((error) => {
        console.error('Could not clear notification:', error);
      });
    }, timeoutMs);
  }

  return { ok: true, notificationId: createdNotificationId };
}
