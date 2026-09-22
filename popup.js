const intervalInput = document.getElementById('intervalSeconds');
const scanSecondsInput = document.getElementById('scanSeconds');
const fvgEnabledInput = document.getElementById('fvgEnabled');
const orderBlockEnabledInput = document.getElementById('orderBlockEnabled');
const notificationsEnabledInput = document.getElementById('notificationsEnabled');
const discordPnlEnabledInput = document.getElementById('discordPnlEnabled');
const discordSignalsEnabledInput = document.getElementById('discordSignalsEnabled');
const profitProtectionEnabledInput = document.getElementById('profitProtectionEnabled');
const chartScreenshotsEnabledInput = document.getElementById('chartScreenshotsEnabled');
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const startScannerButton = document.getElementById('startScannerButton');
const stopScannerButton = document.getElementById('stopScannerButton');
const openPnlHistoryButton = document.getElementById('openPnlHistoryButton');
const openSignalHistoryButton = document.getElementById('openSignalHistoryButton');
const sendScreenshotButton = document.getElementById('sendScreenshotButton');
const testBuySoundButton = document.getElementById('testBuySoundButton');
const testSellSoundButton = document.getElementById('testSellSoundButton');
const message = document.getElementById('message');
const statusBadge = document.getElementById('statusBadge');
const dailyPnlValue = document.getElementById('dailyPnlValue');

const DEFAULT_INTERVAL_SECONDS = 60;
const DEFAULT_SCAN_SECONDS = 15;

document.addEventListener('DOMContentLoaded', initializePopup);
startButton.addEventListener('click', startSwitcher);
stopButton.addEventListener('click', stopSwitcher);
startScannerButton.addEventListener('click', startScanner);
stopScannerButton.addEventListener('click', stopScanner);
openPnlHistoryButton.addEventListener('click', openPnlHistory);
openSignalHistoryButton.addEventListener('click', openSignalHistory);
notificationsEnabledInput.addEventListener('change', updateNotificationsEnabled);
discordPnlEnabledInput.addEventListener('change', updateDiscordPnlEnabled);
discordSignalsEnabledInput.addEventListener('change', updateDiscordSignalsEnabled);
profitProtectionEnabledInput.addEventListener('change', updateProfitProtectionEnabled);
chartScreenshotsEnabledInput.addEventListener('change', updateChartScreenshotsEnabled);
sendScreenshotButton.addEventListener('click', sendScreenshotNow);
testBuySoundButton.addEventListener('click', () => testSignalAudio('BUY'));
testSellSoundButton.addEventListener('click', () => testSignalAudio('SELL'));
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.latestDailyPnl) {
    renderDailyPnl(changes.latestDailyPnl.newValue);
  }

  if (areaName === 'local' && changes.profitProtectionEnabled) {
    profitProtectionEnabledInput.checked = changes.profitProtectionEnabled.newValue !== false;
  }
});

async function initializePopup() {
  const {
    intervalSeconds,
    intervalMinutes,
    scanSeconds = DEFAULT_SCAN_SECONDS,
    fvgEnabled = true,
    orderBlockEnabled = true,
    notificationsEnabled = true,
    discordPnlEnabled = true,
    discordSignalsEnabled = true,
    profitProtectionEnabled = true,
    chartScreenshotsEnabled = false,
    latestDailyPnl
  } = await chrome.storage.local.get([
    'intervalSeconds',
    'intervalMinutes',
    'scanSeconds',
    'fvgEnabled',
    'orderBlockEnabled',
    'notificationsEnabled',
    'discordPnlEnabled',
    'discordSignalsEnabled',
    'profitProtectionEnabled',
    'chartScreenshotsEnabled',
    'latestDailyPnl'
  ]);

  intervalInput.value = String(normalizeSwitchInterval(intervalSeconds, intervalMinutes));
  scanSecondsInput.value = scanSeconds;
  fvgEnabledInput.checked = fvgEnabled;
  orderBlockEnabledInput.checked = orderBlockEnabled;
  notificationsEnabledInput.checked = notificationsEnabled;
  discordPnlEnabledInput.checked = discordPnlEnabled;
  discordSignalsEnabledInput.checked = discordSignalsEnabled;
  profitProtectionEnabledInput.checked = profitProtectionEnabled !== false;
  chartScreenshotsEnabledInput.checked = chartScreenshotsEnabled;
  renderDailyPnl(latestDailyPnl);

  try {
    await ensureContentScript();
    const statuses = await runCommandInFrames({ type: 'GET_STATUS' });
    renderStatus(mergeStatus(statuses));
  } catch {
    renderStatus({ running: false });
  }

}

async function startSwitcher() {
  const intervalSeconds = Number.parseInt(intervalInput.value, 10);

  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 10) {
    setMessage('Select a switch interval.');
    return;
  }

  await chrome.storage.local.set({
    intervalSeconds,
    switcherEnabled: true
  });

  try {
    await ensureContentScript();
    const responses = await runCommandInFrames({
      type: 'START_SWITCHER',
      intervalSeconds
    });
    const response = pickResponse(responses, 'switcherRunning');
    renderStatus(response);
    setMessage(response.message || 'Started on this tab.');
  } catch (error) {
    setMessage(error.message || 'Could not start on this page.');
  }
}

async function stopSwitcher() {
  try {
    await chrome.storage.local.set({ switcherEnabled: false });
    await ensureContentScript();
    const responses = await runCommandInFrames({ type: 'STOP_SWITCHER' });
    const response = mergeStatus(responses);
    renderStatus(response);
    setMessage('Stopped.');
  } catch {
    renderStatus({ running: false });
    setMessage('Nothing is running on this tab.');
  }
}

async function startScanner() {
  const scanSeconds = Number.parseInt(scanSecondsInput.value, 10);
  const fvgEnabled = fvgEnabledInput.checked;
  const orderBlockEnabled = orderBlockEnabledInput.checked;

  if (!Number.isFinite(scanSeconds) || scanSeconds < 5) {
    setMessage('Enter a scan interval of 5 seconds or more.');
    return;
  }

  if (!fvgEnabled && !orderBlockEnabled) {
    setMessage('Enable at least one pattern alert.');
    return;
  }

  await chrome.storage.local.set({
    scanSeconds,
    fvgEnabled,
    orderBlockEnabled,
    autoScannerEnabled: true
  });

  try {
    await ensureContentScript();
    const responses = await runCommandInFrames({
      type: 'START_SCANNER',
      scanSeconds,
      fvgEnabled,
      orderBlockEnabled
    });
    const response = pickResponse(responses, 'scannerRunning') || mergeStatus(responses);
    renderStatus(response);
    setMessage(response.message || 'Scanner started. Keep the chart visible.');
  } catch (error) {
    setMessage(error.message || 'Could not start scanner on this page.');
  }
}

async function stopScanner() {
  try {
    await chrome.storage.local.set({ autoScannerEnabled: false });
    await ensureContentScript();
    const responses = await runCommandInFrames({ type: 'STOP_SCANNER' });
    renderStatus(mergeStatus(responses));
    setMessage('Scanner stopped.');
  } catch {
    setMessage('Scanner is not running on this tab.');
  }
}

async function updateNotificationsEnabled() {
  const notificationsEnabled = notificationsEnabledInput.checked;

  await chrome.storage.local.set({ notificationsEnabled });
  setMessage(notificationsEnabled ? 'Notifications enabled.' : 'Notifications disabled.');
}

async function updateDiscordPnlEnabled() {
  const discordPnlEnabled = discordPnlEnabledInput.checked;

  await chrome.storage.local.set({ discordPnlEnabled });
  setMessage(discordPnlEnabled ? 'Discord P&L enabled.' : 'Discord P&L disabled.');
}

async function updateDiscordSignalsEnabled() {
  const discordSignalsEnabled = discordSignalsEnabledInput.checked;

  await chrome.storage.local.set({ discordSignalsEnabled });
  setMessage(discordSignalsEnabled ? 'Discord signals enabled.' : 'Discord signals disabled.');
}

async function updateProfitProtectionEnabled() {
  const profitProtectionEnabled = profitProtectionEnabledInput.checked;

  await chrome.storage.local.set({ profitProtectionEnabled });
  setMessage(profitProtectionEnabled ? 'Long-run rules enabled.' : 'Long-run rules disabled.');
}

async function updateChartScreenshotsEnabled() {
  const enabled = chartScreenshotsEnabledInput.checked;

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'UPDATE_CHART_SCREENSHOT_SCHEDULE',
      enabled
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Could not update screenshot schedule.');
    }

    setMessage(enabled
      ? 'Chart screenshots enabled for 09:15-15:30 IST.'
      : 'Chart screenshots disabled.');
  } catch (error) {
    chartScreenshotsEnabledInput.checked = !enabled;
    setMessage(error.message || 'Could not update screenshot schedule.');
  }
}

async function testSignalAudio(action) {
  setMessage(`Playing ${action} test sound...`);

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'TEST_SIGNAL_AUDIO',
      action
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Could not play signal sound.');
    }

    setMessage(`${action} test sound played.`);
  } catch (error) {
    setMessage(error.message || 'Could not play signal sound.');
  }
}

async function sendScreenshotNow() {
  sendScreenshotButton.disabled = true;
  setMessage('Sending screenshot...');

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'SEND_CHART_SCREENSHOT_NOW'
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Could not send screenshot.');
    }

    setMessage(response.message || 'Screenshot sent to Discord.');
  } catch (error) {
    setMessage(error.message || 'Could not send screenshot.');
  } finally {
    sendScreenshotButton.disabled = false;
  }
}

async function openPnlHistory() {
  setMessage('Capturing latest Upstox P&L...');

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'CAPTURE_DAILY_PNL_FROM_UPSTOX'
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Could not capture latest P&L.');
    }

    renderDailyPnl(response);
    setMessage(response.message || `Captured ${response.tradingDetailsCount || 0} trade(s).`);
  } catch (error) {
    setMessage(error.message || 'Opening history without fresh capture.');
  }

  await chrome.tabs.create({
    url: chrome.runtime.getURL('pnl-history.html')
  });
}

async function openSignalHistory() {
  await chrome.tabs.create({
    url: chrome.runtime.getURL('signal-history.html')
  });
}

async function ensureContentScript() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    throw new Error('No active tab found.');
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    injectImmediately: true,
    files: ['content.js']
  });
}

async function runCommandInFrames(payload) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    throw new Error('No active tab found.');
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: (command) => window.upstoxAlertAgent?.handleCommand(command) || null,
    args: [payload]
  });

  return results.map((result) => result.result).filter(Boolean);
}

function renderStatus(status = {}) {
  const running = Boolean(
    status.switcherRunning
      || status.scannerRunning
      || status.dailyPnlRunning
      || status.running
  );
  statusBadge.textContent = running ? 'Running' : 'Stopped';
  statusBadge.classList.toggle('running', running);
  startButton.disabled = Boolean(status.switcherRunning);
  stopButton.disabled = !status.switcherRunning;
  startScannerButton.disabled = Boolean(status.scannerRunning);
  stopScannerButton.disabled = !status.scannerRunning;
}

function setMessage(text) {
  message.textContent = text;
}

function renderDailyPnl(pnl) {
  dailyPnlValue.classList.remove('profit', 'loss', 'neutral');

  if (!pnl || !Number.isFinite(Number(pnl.value))) {
    dailyPnlValue.textContent = '--';
    return;
  }

  const value = Number(pnl.value);
  dailyPnlValue.textContent = pnl.display || formatDailyPnl(value);
  dailyPnlValue.classList.add(value > 0 ? 'profit' : value < 0 ? 'loss' : 'neutral');
}

function formatDailyPnl(value) {
  return value.toLocaleString('en-IN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  });
}

function mergeStatus(statuses = []) {
  return statuses.reduce((merged, status) => ({
    ...merged,
    ...status,
    switcherRunning: merged.switcherRunning || status.switcherRunning,
    scannerRunning: merged.scannerRunning || status.scannerRunning,
    dailyPnlRunning: merged.dailyPnlRunning || status.dailyPnlRunning
  }), {
    switcherRunning: false,
    scannerRunning: false,
    dailyPnlRunning: false
  });
}

function pickResponse(responses, runningKey) {
  return responses.find((response) => response?.[runningKey]) || responses[0];
}

function normalizeSwitchInterval(intervalSeconds, intervalMinutes) {
  const seconds = Number.parseInt(intervalSeconds, 10);

  if ([10, 20, 30, 60, 120, 180, 240, 300].includes(seconds)) {
    return seconds;
  }

  const minutes = Number.parseInt(intervalMinutes, 10);

  if (Number.isFinite(minutes) && minutes > 0) {
    return Math.min(minutes * 60, 300);
  }

  return DEFAULT_INTERVAL_SECONDS;
}
