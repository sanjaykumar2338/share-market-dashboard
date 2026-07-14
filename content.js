(function () {
  const CONTENT_SCRIPT_VERSION = '2026-06-16-sl-points-risk-lot-v1';

  if (window.upstoxAlertAgent?.version === CONTENT_SCRIPT_VERSION) {
    return;
  }

  if (window.upstoxAlertAgent) {
    window.upstoxAlertAgent.handleCommand?.({ type: 'STOP_SWITCHER' });
    window.upstoxAlertAgent.handleCommand?.({ type: 'STOP_SCANNER' });
    window.upstoxAlertAgent.handleCommand?.({ type: 'STOP_DAILY_PNL' });
    window.upstoxAlertAgent.handleCommand?.({ type: 'STOP_RISK_LOT_CALCULATOR' });
  }

  let currentIndex = 0;
  let switcherIntervalId = null;
  let scannerIntervalId = null;
  let dailyPnlIntervalId = null;
  let activeIntervalSeconds = 60;
  let activeScanSeconds = 15;
  let activeDailyPnlSeconds = 1;
  let scannerOptions = {
    fvgEnabled: true,
    orderBlockEnabled: true
  };
  let candleBuffer = [];
  let activeCandle = null;
  let lastAlertKeys = new Set();
  let lastDailyPnlValue = null;
  let lastTradingDetailsCount = 0;
  let topBarDisciplineRuleIntervalId = null;
  let topBarDisciplineRuleIndex = 0;
  let topBarOptionChainIntervalId = null;
  let riskLotCalculatorIntervalId = null;
  let profitProtectionEnabled = true;
  const DAILY_PNL_PROFIT_COLOR = '#16a34a';
  const DAILY_PNL_LOSS_COLOR = '#dc2626';
  const DAILY_PNL_NEUTRAL_COLOR = '#6b7280';
  const TOP_BAR_OPTION_CHAIN_ID = 'upstox-alert-agent-topbar-option-chain';
  const TOP_BAR_DAILY_PNL_ID = 'upstox-alert-agent-topbar-pnl';
  const TOP_BAR_DISCIPLINE_RULE_ID = 'upstox-alert-agent-topbar-rule';
  const DISCIPLINE_BANNER_ID = 'upstox-alert-agent-discipline-banner';
  const INTERVAL_HIGHLIGHT_STYLE_ID = 'upstox-alert-agent-interval-highlight-style';
  const RISK_LOT_CALCULATOR_ID = 'upstox-alert-agent-risk-lot-calculator';
  const RISK_LOT_DEFAULT_AMOUNT = 2000;
  const RISK_LOT_DEFAULT_SL_POINTS = 2;
  const UPSTOX_ORDER_QUANTITY_SELECTOR = 'input#quantity[data-id="Quantity"], input[data-id="Quantity"], input#quantity';
  const UPSTOX_OPTION_LOT_SIZE_CLASS = 'r+IDdJJujEUTIwxfT-v2lw==';
  const DISCIPLINE_RULES = [
    'Stop when the plan is done.',
    'Protect family capital.',
    'Respect your father’s hard work.',
    'Consistent profit beats one lucky day.',
    'No revenge trades. No boredom trades.',
    'Long run matters more than one extra trade.'
  ];

  function triggerRealClick(element) {
    ['mousedown', 'mouseup', 'click'].forEach((eventType) => {
      element.dispatchEvent(
        new MouseEvent(eventType, {
          view: window,
          bubbles: true,
          cancelable: true
        })
      );
    });
  }

  function switchTab() {
    if (!isSwitcherFrame()) {
      return { clicked: false, message: 'Switcher only runs on the main Upstox page.' };
    }

    const tabs = Array.from(document.querySelectorAll(
      '[data-testid="virtuoso-item-list"] [role="button"]'
    ));

    if (!tabs.length) {
      return { clicked: false, message: 'Watchlist tabs are hidden on this page.' };
    }

    const activeIndex = getActiveTabIndex(tabs);
    currentIndex = activeIndex >= 0 ? (activeIndex + 1) % tabs.length : currentIndex % tabs.length;

    const tab = tabs[currentIndex];

    console.log(`Switching to tab ${currentIndex + 1}/${tabs.length}`);

    tab.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });

    triggerRealClick(tab);
    currentIndex += 1;
    currentIndex %= tabs.length;

    return { clicked: true, message: `Switched to tab ${currentIndex || tabs.length}/${tabs.length}.` };
  }

  function getActiveTabIndex(tabs) {
    const activeSymbol = getCurrentSymbol();

    if (activeSymbol) {
      const symbolIndex = tabs.findIndex((tab) => {
        const container = tab.closest('[data-type="container"], [data-index], [data-item-index]') || tab;
        return getWatchlistSymbol(container).toUpperCase() === activeSymbol;
      });

      if (symbolIndex >= 0) {
        return symbolIndex;
      }
    }

    const activeIndex = tabs.findIndex((tab) => {
      const container = tab.closest('[data-type="container"], [data-index], [data-item-index]') || tab;
      const ariaSelected = tab.getAttribute('aria-selected') === 'true';
      const current = tab.getAttribute('aria-current') === 'true';
      const selected = container.getAttribute('aria-selected') === 'true';
      const dataSelected = container.getAttribute('data-selected') === 'true';
      const focused = tab === document.activeElement || container.contains(document.activeElement);
      const activeClass = /\b(active|selected)\b/i.test(`${tab.className} ${container.className}`);

      return ariaSelected || current || selected || dataSelected || focused || activeClass;
    });

    if (activeIndex >= 0) {
      return activeIndex;
    }

    return -1;
  }

  function getCurrentSymbol() {
    const titleSymbol = document.title
      .match(/^\s*([A-Z0-9&.-]+)(?:\s+(?:EQ|FUT|CE|PE))?\b/i)?.[1];

    if (titleSymbol) {
      return titleSymbol.toUpperCase();
    }

    const bodyText = document.body?.innerText || '';
    const chartSymbol = bodyText
      .match(/\b([A-Z0-9&.-]+)(?:\s+[A-Z0-9&.-]+)*\s*,\s*\d+\s*,\s*(?:NSE|BSE|NFO|MCX)\b/i)?.[1];

    return chartSymbol ? chartSymbol.toUpperCase() : '';
  }

  function getWatchlistSymbol(container) {
    const text = container.innerText || '';
    const symbol = text.match(/^\s*([A-Z0-9&.-]+)/)?.[1];
    return symbol || '';
  }

  function startSwitcher(intervalValue) {
    stopSwitcher();

    if (!isSwitcherFrame()) {
      return {
        ...getStatus(),
        message: 'Switcher skipped in chart frame.'
      };
    }

    activeIntervalSeconds = normalizeSwitchInterval(intervalValue);

    switcherIntervalId = window.setInterval(switchTab, activeIntervalSeconds * 1000);

    return {
      ...getStatus(),
      message: `Switcher started. First switch in ${formatDuration(activeIntervalSeconds)}.`
    };
  }

  function stopSwitcher() {
    if (switcherIntervalId) {
      window.clearInterval(switcherIntervalId);
      switcherIntervalId = null;
    }

    return getStatus();
  }

  function startScanner({ scanSeconds, fvgEnabled, orderBlockEnabled }) {
    stopScanner();

    if (!isUpstoxChartContext()) {
      return {
        ...getStatus(),
        message: 'Scanner skipped outside the chart frame.'
      };
    }

    activeScanSeconds = scanSeconds;
    scannerOptions = { fvgEnabled, orderBlockEnabled };
    candleBuffer = [];
    activeCandle = null;
    lastAlertKeys = new Set();

    const firstScan = scanChart();
    scannerIntervalId = window.setInterval(scanChart, scanSeconds * 1000);

    return {
      ...getStatus(),
      message: firstScan.message || 'Scanner started. Waiting for visible OHLC updates.'
    };
  }

  function stopScanner() {
    if (scannerIntervalId) {
      window.clearInterval(scannerIntervalId);
      scannerIntervalId = null;
    }

    return getStatus();
  }

  function startDailyPnlWatcher(intervalSeconds = 1) {
    stopDailyPnlWatcher();

    if (!isSwitcherFrame()) {
      return {
        ...getStatus(),
        message: 'Day P&L watcher only runs on the main Upstox page.'
      };
    }

    activeDailyPnlSeconds = normalizePositiveInteger(intervalSeconds, 1);
    lastDailyPnlValue = null;

    const firstScan = scanDailyPnl();
    dailyPnlIntervalId = window.setInterval(scanDailyPnl, activeDailyPnlSeconds * 1000);

    return {
      ...getStatus(),
      message: firstScan.message || `Day P&L watcher started. Checking every ${formatDuration(activeDailyPnlSeconds)}.`
    };
  }

  function stopDailyPnlWatcher() {
    if (dailyPnlIntervalId) {
      window.clearInterval(dailyPnlIntervalId);
      dailyPnlIntervalId = null;
    }

    return getStatus();
  }

  function scanDailyPnl() {
    const positions = readTradingDetails();
    const positionPnl = getPnlFromPositions(positions);
    const pnl = positionPnl || readDailyPnl();

    if (!pnl) {
      return { found: false, message: 'No visible Day P&L value found.' };
    }

    lastDailyPnlValue = pnl.value;
    colorDailyPnlValues(pnl.value);
    updateTopBarDailyPnl(pnl);
    publishDailyPnl(pnl, positions);

    return {
      found: true,
      message: `Day P&L: ${pnl.display} (${positions.length} trade${positions.length === 1 ? '' : 's'})`
    };
  }

  function scanChart() {
    const candle = readVisibleOhlc();

    if (!candle) {
      return { found: false, message: 'No visible OHLC legend found in this frame.' };
    }

    addOrUpdateCandle(candle);

    const patterns = detectPatterns(candleBuffer);
    patterns.forEach(sendPatternAlert);

    return {
      found: true,
      message: patterns.length
        ? `${patterns.length} pattern alert(s) detected.`
        : `Watching ${candle.symbol || 'chart'} with ${candleBuffer.length} candle(s).`
    };
  }

  function readVisibleOhlc() {
    const text = document.body?.innerText || '';
    const ohlc = extractOhlcFromText(text);

    if (!ohlc) {
      return null;
    }

    const symbolMatch = text.match(/([A-Z][A-Z0-9&.-]{1,24}(?:\s+[A-Z][A-Z0-9&.-]{1,24})*)\s*[.\-]\s*\d+\s*[.\-]\s*(?:NSE|BSE|NFO|MCX)/);
    const intervalMatch = text.match(/\b(1m|3m|5m|10m|15m|30m|45m|1h|2h|3h|4h|D|W|M)\b/);

    return {
      open: ohlc.open,
      high: ohlc.high,
      low: ohlc.low,
      close: ohlc.close,
      symbol: symbolMatch?.[1]?.trim() || document.title.split(/[|,▲▼]/)[0].trim() || 'Chart',
      interval: intervalMatch?.[1] || 'visible',
      seenAt: Date.now(),
      bucket: getCandleBucket(intervalMatch?.[1])
    };
  }

  function extractOhlcFromText(text) {
    const pricePattern = '[-+\\u2212]?[0-9][0-9,]*(?:\\.\\d+)?';
    const normalizedText = text.replace(/\s+/g, ' ');
    const compactLegendMatch = normalizedText.match(new RegExp(
      `\\bO(?:pen)?\\s*[:=]?\\s*(${pricePattern})\\s*`
        + `H(?:igh)?\\s*[:=]?\\s*(${pricePattern})\\s*`
        + `L(?:ow)?\\s*[:=]?\\s*(${pricePattern})\\s*`
        + `C(?:lose)?\\s*[:=]?\\s*(${pricePattern})`,
      'i'
    ));

    if (compactLegendMatch) {
      return {
        open: toNumber(compactLegendMatch[1]),
        high: toNumber(compactLegendMatch[2]),
        low: toNumber(compactLegendMatch[3]),
        close: toNumber(compactLegendMatch[4])
      };
    }

    const open = findLabeledPrice(normalizedText, 'O|Open');
    const high = findLabeledPrice(normalizedText, 'H|High');
    const low = findLabeledPrice(normalizedText, 'L|Low');
    const close = findLabeledPrice(normalizedText, 'C|Close');

    if ([open, high, low, close].every(Number.isFinite)) {
      return { open, high, low, close };
    }

    return null;
  }

  function findLabeledPrice(text, labelPattern) {
    const match = text.match(new RegExp(`(?:^|\\b)(?:${labelPattern})\\s*[:=]?\\s*([-+\\u2212]?[0-9][0-9,]*(?:\\.\\d+)?)`, 'i'));
    return match ? toNumber(match[1]) : NaN;
  }

  function addOrUpdateCandle(candle) {
    if (!isValidCandle(candle)) {
      return;
    }

    if (!activeCandle) {
      activeCandle = candle;
      candleBuffer.push(candle);
      return;
    }

    const sameCandle = activeCandle.bucket === candle.bucket
      && activeCandle.symbol === candle.symbol
      && activeCandle.interval === candle.interval;

    if (sameCandle) {
      activeCandle.open = candle.open;
      activeCandle.close = candle.close;
      activeCandle.high = Math.max(activeCandle.high, candle.high);
      activeCandle.low = Math.min(activeCandle.low, candle.low);
      activeCandle.seenAt = candle.seenAt;
      return;
    }

    const previous = candleBuffer[candleBuffer.length - 1];
    if (previous && previous.open === candle.open && previous.high === candle.high && previous.low === candle.low) {
      previous.close = candle.close;
      previous.seenAt = candle.seenAt;
      activeCandle = previous;
      return;
    }

    activeCandle = candle;
    candleBuffer.push(candle);

    if (candleBuffer.length > 80) {
      candleBuffer.shift();
    }
  }

  function detectPatterns(candles) {
    if (candles.length < 3) {
      return [];
    }

    const alerts = [];
    const a = candles[candles.length - 3];
    const b = candles[candles.length - 2];
    const c = candles[candles.length - 1];

    if (scannerOptions.fvgEnabled) {
      if (a.high < c.low) {
        alerts.push({
          type: 'Bullish FVG',
          symbol: c.symbol,
          interval: c.interval,
          priceRange: `${formatPrice(a.high)} - ${formatPrice(c.low)}`,
          key: `fvg-bull-${c.symbol}-${c.interval}-${a.high}-${c.low}`
        });
      }

      if (a.low > c.high) {
        alerts.push({
          type: 'Bearish FVG',
          symbol: c.symbol,
          interval: c.interval,
          priceRange: `${formatPrice(c.high)} - ${formatPrice(a.low)}`,
          key: `fvg-bear-${c.symbol}-${c.interval}-${c.high}-${a.low}`
        });
      }
    }

    if (scannerOptions.orderBlockEnabled) {
      const avgRange = averageRange(candles.slice(-8, -1));
      const displacement = range(c) >= avgRange * 1.5;

      if (isBearish(b) && isBullish(c) && displacement && c.close > b.high) {
        alerts.push({
          type: 'Bullish Order Block',
          symbol: c.symbol,
          interval: c.interval,
          priceRange: `${formatPrice(b.low)} - ${formatPrice(b.high)}`,
          key: `ob-bull-${c.symbol}-${c.interval}-${b.low}-${b.high}`
        });
      }

      if (isBullish(b) && isBearish(c) && displacement && c.close < b.low) {
        alerts.push({
          type: 'Bearish Order Block',
          symbol: c.symbol,
          interval: c.interval,
          priceRange: `${formatPrice(b.low)} - ${formatPrice(b.high)}`,
          key: `ob-bear-${c.symbol}-${c.interval}-${b.low}-${b.high}`
        });
      }
    }

    return alerts.filter((alert) => !lastAlertKeys.has(alert.key));
  }

  function sendPatternAlert(alert) {
    lastAlertKeys.add(alert.key);

    sendRuntimeMessage({
      type: 'SHOW_NOTIFICATION',
      title: alert.type,
      message: `${alert.symbol} ${alert.interval}: ${alert.priceRange}`
    });
  }

  function showDisciplineBanner(display) {
    if (!profitProtectionEnabled) {
      document.getElementById(DISCIPLINE_BANNER_ID)?.remove();
      return;
    }

    const existing = document.getElementById(DISCIPLINE_BANNER_ID);

    if (existing) {
      existing.remove();
    }

    const banner = document.createElement('div');
    const title = document.createElement('strong');
    const message = document.createElement('span');
    const closeButton = document.createElement('button');
    let ruleIndex = 0;
    let ruleIntervalId = null;

    banner.id = DISCIPLINE_BANNER_ID;
    title.textContent = `Protect today: ${display}`;
    message.textContent = DISCIPLINE_RULES[0];
    closeButton.type = 'button';
    closeButton.textContent = 'OK';
    closeButton.addEventListener('click', removeBanner);
    banner.append(title, message, closeButton);

    Object.assign(banner.style, {
      alignItems: 'center',
      background: '#111827',
      border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: '10px',
      boxShadow: '0 16px 40px rgba(15, 23, 42, 0.28)',
      boxSizing: 'border-box',
      color: '#ffffff',
      display: 'flex',
      gap: '12px',
      left: '50%',
      maxWidth: '720px',
      padding: '12px 14px',
      position: 'fixed',
      top: '72px',
      transform: 'translateX(-50%)',
      width: 'calc(100% - 48px)',
      zIndex: '2147483647'
    });
    Object.assign(title.style, {
      color: '#86efac',
      flex: '0 0 auto',
      font: '900 15px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      letterSpacing: '0'
    });
    Object.assign(message.style, {
      flex: '1 1 auto',
      font: '750 14px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      letterSpacing: '0',
      minWidth: '0',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    });
    Object.assign(closeButton.style, {
      background: '#22c55e',
      border: '0',
      borderRadius: '7px',
      color: '#052e16',
      cursor: 'pointer',
      flex: '0 0 auto',
      font: '900 12px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      height: '28px',
      padding: '0 12px'
    });

    document.documentElement.appendChild(banner);
    ruleIntervalId = window.setInterval(() => {
      ruleIndex = (ruleIndex + 1) % DISCIPLINE_RULES.length;
      message.textContent = DISCIPLINE_RULES[ruleIndex];
    }, 2200);

    const timeoutId = window.setTimeout(removeBanner, 12000);

    function removeBanner() {
      if (ruleIntervalId) {
        window.clearInterval(ruleIntervalId);
        ruleIntervalId = null;
      }

      window.clearTimeout(timeoutId);
      banner.remove();
    }
  }

  function publishDailyPnl(pnl, positions = readTradingDetails()) {
    lastTradingDetailsCount = positions.length;

    sendRuntimeMessage({
      type: 'UPDATE_DAILY_PNL',
      display: pnl.display,
      value: pnl.value,
      positions
    });
  }

  function sendRuntimeMessage(message) {
    try {
      if (!chrome?.runtime?.id) {
        stopAllTimers();
        return;
      }

      chrome.runtime.sendMessage(message, () => {
        if (chrome.runtime.lastError?.message?.includes('Extension context invalidated')) {
          stopAllTimers();
        }
      });
    } catch (error) {
      if (String(error?.message || error).includes('Extension context invalidated')) {
        stopAllTimers();
        return;
      }

      throw error;
    }
  }

  function stopAllTimers() {
    stopSwitcher();
    stopScanner();
    stopDailyPnlWatcher();

    if (topBarDisciplineRuleIntervalId) {
      window.clearInterval(topBarDisciplineRuleIntervalId);
      topBarDisciplineRuleIntervalId = null;
    }

    if (topBarOptionChainIntervalId) {
      window.clearInterval(topBarOptionChainIntervalId);
      topBarOptionChainIntervalId = null;
    }
  }

  function getStatus() {
    return {
      switcherRunning: Boolean(switcherIntervalId),
      scannerRunning: Boolean(scannerIntervalId),
      dailyPnlRunning: Boolean(dailyPnlIntervalId),
      intervalSeconds: activeIntervalSeconds,
      scanSeconds: activeScanSeconds,
      dailyPnlSeconds: activeDailyPnlSeconds,
      dailyPnl: lastDailyPnlValue,
      tradingDetailsCount: lastTradingDetailsCount,
      candlesTracked: candleBuffer.length
    };
  }

  function installIntervalHighlightStyles() {
    if (document.getElementById(INTERVAL_HIGHLIGHT_STYLE_ID)) {
      return;
    }

    const style = document.createElement('style');
    style.id = INTERVAL_HIGHLIGHT_STYLE_ID;
    style.textContent = `
      #header-toolbar-intervals [role="radio"][aria-checked="true"],
      #header-toolbar-intervals button[class*="isActive-"] {
        background: #5a298b !important;
        border-color: #5a298b !important;
        box-shadow:
          inset 0 0 0 1px rgba(255, 255, 255, 0.9),
          0 0 0 2px rgba(90, 41, 139, 0.35) !important;
        color: #ffffff !important;
        border-radius: 5px !important;
      }

      #header-toolbar-intervals [role="radio"][aria-checked="true"] *,
      #header-toolbar-intervals button[class*="isActive-"] * {
        color: #ffffff !important;
        font-weight: 800 !important;
      }
    `;

    (document.head || document.documentElement).appendChild(style);
  }

  function handleCommand(request) {
    if (request.type === 'START_SWITCHER') {
      return startSwitcher(request.intervalSeconds || request.intervalMinutes);
    }

    if (request.type === 'STOP_SWITCHER') {
      return stopSwitcher();
    }

    if (request.type === 'START_SCANNER') {
      return startScanner(request);
    }

    if (request.type === 'STOP_SCANNER') {
      return stopScanner();
    }

    if (request.type === 'START_DAILY_PNL') {
      return startDailyPnlWatcher(request.intervalSeconds);
    }

    if (request.type === 'STOP_DAILY_PNL') {
      return stopDailyPnlWatcher();
    }

    if (request.type === 'STOP_RISK_LOT_CALCULATOR') {
      return stopRiskLotCalculatorWatcher();
    }

    if (request.type === 'CAPTURE_DAILY_PNL') {
      const capture = scanDailyPnl();
      return {
        ...capture,
        ...getStatus()
      };
    }

    if (request.type === 'GET_STATUS' || request.type === 'GET_SWITCHER_STATUS') {
      return getStatus();
    }

    if (request.type === 'SHOW_DISCIPLINE_MESSAGE') {
      if (!profitProtectionEnabled) {
        removeTopBarDisciplineRuleElement();
        return {
          ...getStatus(),
          message: 'Discipline message disabled.'
        };
      }

      showDisciplineBanner(request.display || request.message || '₹5,800');
      return {
        ...getStatus(),
        message: 'Discipline message shown.'
      };
    }

    return null;
  }

  async function autoStartSwitcherIfNeeded() {
    if (!isSwitcherFrame()) {
      return;
    }

    const {
      switcherEnabled = false,
      intervalSeconds,
      intervalMinutes
    } = await chrome.storage.local.get([
      'switcherEnabled',
      'intervalSeconds',
      'intervalMinutes'
    ]);

    if (!switcherEnabled || switcherIntervalId) {
      return;
    }

    startSwitcher(intervalSeconds || intervalMinutes);
  }

  async function autoStartScannerIfNeeded() {
    if (!isUpstoxChartContext()) {
      return;
    }

    const {
      autoScannerEnabled = true,
      scanSeconds = activeScanSeconds,
      fvgEnabled = scannerOptions.fvgEnabled,
      orderBlockEnabled = scannerOptions.orderBlockEnabled
    } = await chrome.storage.local.get([
      'autoScannerEnabled',
      'scanSeconds',
      'fvgEnabled',
      'orderBlockEnabled'
    ]);

    if (!autoScannerEnabled || scannerIntervalId) {
      return;
    }

    startScanner({ scanSeconds, fvgEnabled, orderBlockEnabled });
  }

  async function autoStartDailyPnlWatcherIfNeeded() {
    if (!isSwitcherFrame()) {
      return;
    }

    const {
      dailyPnlEnabled = true,
      dailyPnlSeconds = activeDailyPnlSeconds
    } = await chrome.storage.local.get([
      'dailyPnlEnabled',
      'dailyPnlSeconds'
    ]);

    if (!dailyPnlEnabled || dailyPnlIntervalId) {
      return;
    }

    startDailyPnlWatcher(dailyPnlSeconds);
  }

  async function loadProfitProtectionSetting() {
    if (!chrome?.storage?.local) {
      return;
    }

    const { profitProtectionEnabled: storedValue = true } = await chrome.storage.local.get('profitProtectionEnabled');
    setProfitProtectionEnabled(storedValue !== false);
  }

  function setProfitProtectionEnabled(enabled) {
    profitProtectionEnabled = enabled;

    if (!profitProtectionEnabled) {
      removeTopBarDisciplineRuleElement();
      return;
    }

    const slot = getTopBarDailyPnlSlot();

    if (slot?.container && document.getElementById(TOP_BAR_DAILY_PNL_ID)) {
      ensureTopBarDisciplineRuleElement(slot);
    }
  }

  function isUpstoxChartContext() {
    try {
      return window.location.href.includes('pro.upstox.com/trading-charts')
        || isTradingViewBlobFrame();
    } catch {
      return false;
    }
  }

  function isUpstoxPageContext() {
    try {
      return window.location.hostname === 'pro.upstox.com';
    } catch {
      return false;
    }
  }

  function isMainFrame() {
    try {
      return window.top === window;
    } catch {
      return false;
    }
  }

  function isSwitcherFrame() {
    return isMainFrame() && isUpstoxPageContext();
  }

  function isOptionChainPage() {
    try {
      return isSwitcherFrame() && window.location.pathname.startsWith('/option-chain/');
    } catch {
      return false;
    }
  }

  function isTradingViewBlobFrame() {
    try {
      return window.location.href.startsWith('blob:https://pro.upstox.com/');
    } catch {
      return false;
    }
  }

  function toNumber(value) {
    return Number.parseFloat(String(value).replace(/\u2212/g, '-').replace(/,/g, ''));
  }

  function readDailyPnl() {
    const containers = [getPositionsTab()].filter(Boolean);

    for (const container of containers) {
      const pnl = extractDailyPnlFromText(container.innerText || '');

      if (pnl) {
        return pnl;
      }
    }

    return null;
  }

  function extractDailyPnlFromText(text) {
    const normalizedText = text.replace(/\s+/g, ' ');
    const match = normalizedText.match(/\bDay P&L\s*([-+\u2212]?\s*[\d,]+(?:\.\d+)?(?:\s*\([-+\u2212]?\d+(?:\.\d+)?%\))?)/i);

    if (!match) {
      return null;
    }

    const display = match[1].replace(/\u2212/g, '-').replace(/\s+/g, '').trim();
    const value = toNumber(display.match(/[-+]?\d[\d,]*(?:\.\d+)?/)?.[0]);

    if (!Number.isFinite(value)) {
      return null;
    }

    if (/^[\u2212-]/.test(display)) {
      return { value: -Math.abs(value), display };
    }

    return { value, display };
  }

  function readTradingDetails() {
    const positionsTab = getPositionsTab();
    const positionsList = positionsTab?.querySelector('[data-testid="virtuoso-item-list"]') || positionsTab;
    const rows = positionsTab
      ? uniqueElements([
        ...Array.from(positionsList.querySelectorAll('tr')),
        ...Array.from(positionsTab.querySelectorAll('[data-position-name-id]'))
          .map((element) => element.closest('tr, [data-index], [data-item-index]'))
          .filter(Boolean)
      ])
        .filter((row) => (
          row.querySelector('[data-position-name-id]')
          || isPositionSectionRow(row)
          || isPositionTableRow(row)
        ))
      : [];
    let section = 'Open';

    return rows.reduce((positions, row) => {
      const header = row.querySelector('td[colspan]');
      const headerText = getCleanText(header) || getCleanText(row);

      if (isPositionSectionText(headerText, 'closed')) {
        section = 'Closed';
        return positions;
      }

      if (isPositionSectionText(headerText, 'open')) {
        section = 'Open';
        return positions;
      }

      const symbolElement = row.querySelector('[data-position-name-id]');
      const position = symbolElement
        ? readDataAttributePosition(row, section, symbolElement)
        : readTablePosition(row, section);

      if (!position?.symbol) {
        return positions;
      }

      positions.push({
        ...position,
        netQtyValue: toNumber(position.netQty),
        avgPriceValue: toNumber(position.avgPrice),
        ltpValue: toNumber(position.ltp),
        dayPnlValue: toNumber(position.dayPnl),
        overallPnlValue: toNumber(position.overallPnl)
      });

      return positions;
    }, []);
  }

  function readDataAttributePosition(row, section, symbolElement) {
    const categoryElement = row.querySelector('[data-position-category-id]');

    return {
      section,
      symbol: symbolElement.getAttribute('data-position-name-id') || getCleanText(symbolElement),
      category: categoryElement?.getAttribute('data-position-category-id') || getCleanText(categoryElement),
      product: getDataIdText(row, 'booksProduct'),
      netQty: getDataIdText(row, 'booksNetQuantity'),
      avgPrice: getDataIdText(row, 'booksAvgPrice'),
      ltp: getDataIdText(row, 'booksLTP'),
      dayPnl: getDataIdText(row, 'booksDayPnL'),
      overallPnl: getDataIdText(row, 'booksOverallPnL')
    };
  }

  function readTablePosition(row, section) {
    const rawCells = Array.from(row.querySelectorAll('td'))
      .map((cell) => (cell.innerText || cell.textContent || '').trim())
      .filter(Boolean);
    const cells = rawCells.map((cell) => cell.replace(/\s+/g, ' ').trim());
    const dataCells = cells.filter((cell) => !/^\u2610|^\u2611|^\s*$/.test(cell));
    const symbolCellIndex = dataCells.findIndex((cell) => /[A-Z]/i.test(cell) && !/^(open|closed)\b/i.test(cell));
    const symbolCell = dataCells[symbolCellIndex];

    if (!symbolCell || dataCells.length - symbolCellIndex < 7) {
      return null;
    }

    const rawSymbolCell = rawCells[cells.indexOf(symbolCell)] || symbolCell;
    const { symbol, category } = splitPositionSymbol(rawSymbolCell);
    const values = dataCells.slice(symbolCellIndex + 1);

    return {
      section,
      symbol,
      category,
      product: values[0] || '',
      netQty: values[1] || '',
      avgPrice: values[2] || '',
      ltp: values[3] || '',
      dayPnl: values[4] || '',
      overallPnl: values[5] || ''
    };
  }

  function splitPositionSymbol(value) {
    const parts = String(value || '').split(/\n+/).map((part) => part.replace(/\s+/g, ' ').trim()).filter(Boolean);

    if (parts.length > 1) {
      return {
        symbol: parts[0],
        category: parts.slice(1).join(' ')
      };
    }

    const text = parts[0] || String(value || '').replace(/\s+/g, ' ').trim();
    const marketMatch = text.match(/^(.+?)\s+\b(NSE|BSE|NFO|MCX)\b\s*(.*)$/i);

    if (marketMatch) {
      return {
        symbol: marketMatch[1].trim(),
        category: [marketMatch[2], marketMatch[3]].join(' ').trim()
      };
    }

    return { symbol: text, category: '' };
  }

  function isPositionSectionRow(row) {
    return isPositionSectionText(getCleanText(row));
  }

  function isPositionSectionText(text, expected = '') {
    const pattern = expected ? expected : 'open|closed';
    return new RegExp(`^\\s*(?:${pattern})(?:\\s*\\(\\d+\\))?\\s*$`, 'i').test(text || '');
  }

  function isPositionTableRow(row) {
    const text = getCleanText(row);
    const cells = Array.from(row.querySelectorAll('td')).map((cell) => getCleanText(cell)).filter(Boolean);

    return cells.length >= 7
      && !/\b(Symbol|Product|Net Qty|Avg\.? Price|Overall P&L)\b/i.test(text)
      && cells.some((cell) => /[A-Z]{2,}/.test(cell))
      && cells.filter((cell) => Number.isFinite(toNumber(cell))).length >= 4;
  }

  function uniqueElements(elements) {
    return Array.from(new Set(elements));
  }

  function getPositionsTab() {
    const books = document.querySelector('#books');
    const booksPositionsTab = document.querySelector('#books [data-id="PositionsTab"]');

    if (books && booksPositionsTab) {
      return books;
    }

    return Array.from(document.querySelectorAll('[data-id="PositionsTab"]'))
      .find((tab) => (
        tab.querySelector('[data-position-name-id]')
        || /\bRegular Positions\b/i.test(getCleanText(tab))
      )) || getVisiblePositionsTableContainer();
  }

  function getVisiblePositionsTableContainer() {
    const positionRows = Array.from(document.querySelectorAll('[data-position-name-id]'))
      .map((element) => element.closest('tr'))
      .filter(Boolean);

    if (!positionRows.length) {
      return null;
    }

    const table = positionRows
      .map((row) => row.closest('table'))
      .find((candidate) => candidate && isElementVisible(candidate));

    if (table) {
      return table;
    }

    return positionRows[0].closest('[data-testid="virtuoso-scroller"], [data-virtuoso-scroller="true"]')
      || positionRows[0].parentElement;
  }

  function isElementVisible(element) {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getPnlFromPositions(positions) {
    const values = positions
      .map((position) => Number(position.dayPnlValue))
      .filter(Number.isFinite);

    if (!values.length) {
      return null;
    }

    const value = values.reduce((total, current) => total + current, 0);

    return {
      value,
      display: formatPnlValue(value)
    };
  }

  function formatPnlValue(value) {
    return Number(value).toLocaleString('en-IN', {
      maximumFractionDigits: 2,
      minimumFractionDigits: 2
    });
  }

  function getDataIdText(container, dataId) {
    return getCleanText(container.querySelector(`[data-id="${dataId}"]`));
  }

  function getCleanText(element) {
    return (element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function colorDailyPnlValues(value) {
    const color = value > 0
      ? DAILY_PNL_PROFIT_COLOR
      : value < 0
        ? DAILY_PNL_LOSS_COLOR
        : DAILY_PNL_NEUTRAL_COLOR;
    const background = value > 0
      ? '#ecfdf5'
      : value < 0
        ? '#fff1f2'
        : '#f8fafc';

    getDailyPnlRows().forEach((row) => {
      const valueElement = findDailyPnlValueElement(row);

      if (!valueElement) {
        return;
      }

      valueElement.style.setProperty('color', color, 'important');
      valueElement.style.setProperty('background', '#ffffff', 'important');
      valueElement.style.setProperty('border', `1px solid ${color}`, 'important');
      valueElement.style.setProperty('border-radius', '5px', 'important');
      valueElement.style.setProperty('box-shadow', '0 1px 2px rgba(15, 23, 42, 0.12)', 'important');
      valueElement.style.setProperty('font-size', '17px', 'important');
      valueElement.style.setProperty('font-weight', '900', 'important');
      valueElement.style.setProperty('line-height', '1', 'important');
      valueElement.style.setProperty('padding', '4px 8px', 'important');

      row.style.setProperty('align-items', 'center', 'important');
      row.style.setProperty('background', background, 'important');
      row.style.setProperty('border', `1px solid ${color}`, 'important');
      row.style.setProperty('border-radius', '6px', 'important');
      row.style.setProperty('box-shadow', `0 0 0 2px ${background}`, 'important');
      row.style.setProperty('box-sizing', 'border-box', 'important');
      row.style.setProperty('color', '#111827', 'important');
      row.style.setProperty('display', 'inline-flex', 'important');
      row.style.setProperty('font-weight', '800', 'important');
      row.style.setProperty('gap', '6px', 'important');
      row.style.setProperty('min-height', '26px', 'important');
      row.style.setProperty('padding', '3px 7px', 'important');
      row.style.setProperty('white-space', 'nowrap', 'important');
    });
  }

  function updateTopBarDailyPnl(pnl) {
    const slot = getTopBarDailyPnlSlot();

    if (!slot?.container || !pnl?.display) {
      return;
    }

    ensureTopBarOptionChainButton(slot);
    const pill = ensureTopBarDailyPnlElement(slot);
    if (profitProtectionEnabled) {
      ensureTopBarDisciplineRuleElement(slot);
    } else {
      removeTopBarDisciplineRuleElement();
    }
    const color = pnl.value > 0
      ? DAILY_PNL_PROFIT_COLOR
      : pnl.value < 0
        ? DAILY_PNL_LOSS_COLOR
        : DAILY_PNL_NEUTRAL_COLOR;

    pill.lastElementChild.textContent = pnl.display;
    pill.lastElementChild.style.setProperty('color', color, 'important');
  }

  function startTopBarOptionChainButtonWatcher() {
    if (!isSwitcherFrame()) {
      return;
    }

    updateTopBarOptionChainButton();

    if (!topBarOptionChainIntervalId) {
      topBarOptionChainIntervalId = window.setInterval(updateTopBarOptionChainButton, 1500);
    }
  }

  function startRiskLotCalculatorWatcher() {
    if (!isOptionChainPage()) {
      return;
    }

    syncRiskLotCalculator();

    if (riskLotCalculatorIntervalId) {
      return;
    }

    riskLotCalculatorIntervalId = window.setInterval(() => {
      if (!isOptionChainPage()) {
        stopRiskLotCalculatorWatcher();
        return;
      }

      syncRiskLotCalculator();
    }, 1000);
  }

  function stopRiskLotCalculatorWatcher() {
    if (riskLotCalculatorIntervalId) {
      window.clearInterval(riskLotCalculatorIntervalId);
      riskLotCalculatorIntervalId = null;
    }

    document.getElementById(RISK_LOT_CALCULATOR_ID)?.remove();
    return getStatus();
  }

  function syncRiskLotCalculator() {
    if (!isOptionChainPage()) {
      document.getElementById(RISK_LOT_CALCULATOR_ID)?.remove();
      return;
    }

    const orderForm = document.querySelector('#orderForm');

    if (!orderForm) {
      document.getElementById(RISK_LOT_CALCULATOR_ID)?.remove();
      return;
    }

    const nativeQtyInput = findOrderQuantityInput(orderForm);

    if (!nativeQtyInput) {
      document.getElementById(RISK_LOT_CALCULATOR_ID)?.remove();
      return;
    }

    const existing = document.getElementById(RISK_LOT_CALCULATOR_ID);

    if (existing && orderForm.contains(existing)) {
      updateRiskLotSuggestion(existing, nativeQtyInput);
      return;
    }

    const calculator = buildRiskLotCalculator();
    const targetContainer = getRiskCalculatorInsertionTarget(orderForm, nativeQtyInput);
    targetContainer.insertAdjacentElement('afterend', calculator);
    updateRiskLotSuggestion(calculator, nativeQtyInput);
  }

  function buildRiskLotCalculator() {
    const container = document.createElement('div');
    const fieldRow = document.createElement('div');
    const riskField = document.createElement('label');
    const riskLabel = document.createElement('span');
    const riskInput = document.createElement('input');
    const slField = document.createElement('label');
    const slLabel = document.createElement('span');
    const slInput = document.createElement('input');
    const displayRow = document.createElement('div');
    const suggestion = document.createElement('span');
    const button = document.createElement('button');

    container.id = RISK_LOT_CALCULATOR_ID;
    riskField.htmlFor = 'risk-amount-input';
    riskLabel.textContent = 'Max Risk Amount (₹):';
    riskInput.id = 'risk-amount-input';
    riskInput.type = 'number';
    riskInput.min = '0';
    riskInput.step = '100';
    riskInput.value = String(RISK_LOT_DEFAULT_AMOUNT);
    riskInput.inputMode = 'decimal';
    riskInput.autocomplete = 'off';
    slField.htmlFor = 'sl-points-input';
    slLabel.textContent = 'SL Option Points:';
    slInput.id = 'sl-points-input';
    slInput.type = 'number';
    slInput.min = '0';
    slInput.step = '0.05';
    slInput.value = String(RISK_LOT_DEFAULT_SL_POINTS);
    slInput.inputMode = 'decimal';
    slInput.autocomplete = 'off';
    suggestion.id = 'suggested-lots-val';
    suggestion.textContent = '-- Lots (-- Qty)';
    button.id = 'apply-lots-btn';
    button.type = 'button';
    button.textContent = 'Apply';
    button.addEventListener('click', () => {
      applyRiskLotSuggestion(container, getCurrentRiskCalculatorQuantityInput(container));
    });
    riskInput.addEventListener('input', () => {
      updateRiskLotSuggestion(container, getCurrentRiskCalculatorQuantityInput(container));
    });
    slInput.addEventListener('input', () => {
      updateRiskLotSuggestion(container, getCurrentRiskCalculatorQuantityInput(container));
    });

    riskField.append(riskLabel, riskInput);
    slField.append(slLabel, slInput);
    fieldRow.append(riskField, slField);
    displayRow.append(suggestion, button);
    container.append(fieldRow, displayRow);

    Object.assign(container.style, {
      background: '#f4f7f6',
      border: '1px solid #dce5e2',
      borderRadius: '6px',
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      margin: '8px 0',
      padding: '11px',
      position: 'relative',
      zIndex: '2',
      width: '100%'
    });
    Object.assign(fieldRow.style, {
      alignItems: 'end',
      display: 'flex',
      gap: '10px',
      width: '100%'
    });
    [riskField, slField].forEach((field) => {
      Object.assign(field.style, {
        display: 'flex',
        flex: '1 1 0',
        flexDirection: 'column',
        gap: '5px',
        minWidth: '0'
      });
    });
    [riskLabel, slLabel].forEach((label) => {
      Object.assign(label.style, {
        color: '#334155',
        font: '750 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        letterSpacing: '0'
      });
    });
    [riskInput, slInput].forEach((input) => {
      Object.assign(input.style, {
        border: '1px solid #cbd5e1',
        borderRadius: '5px',
        boxSizing: 'border-box',
        color: '#0f172a',
        font: '800 13px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        height: '30px',
        letterSpacing: '0',
        minWidth: '0',
        padding: '0 8px',
        textAlign: 'right',
        width: '100%'
      });
    });
    Object.assign(displayRow.style, {
      alignItems: 'center',
      display: 'flex',
      gap: '8px',
      justifyContent: 'space-between',
      width: '100%'
    });
    Object.assign(suggestion.style, {
      color: '#334155',
      flex: '1 1 auto',
      font: '850 12px/1.25 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      letterSpacing: '0',
      minWidth: '0',
      overflow: 'visible',
      whiteSpace: 'normal'
    });
    Object.assign(button.style, {
      background: '#16a34a',
      border: '1px solid #15803d',
      borderRadius: '5px',
      boxSizing: 'border-box',
      color: '#ffffff',
      cursor: 'pointer',
      font: '850 12px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      height: '30px',
      letterSpacing: '0',
      padding: '0 12px',
      whiteSpace: 'nowrap'
    });

    return container;
  }

  function updateRiskLotSuggestion(container, nativeQtyInput) {
    const suggestion = container.querySelector('#suggested-lots-val');
    const button = container.querySelector('#apply-lots-btn');
    const calculation = calculateRiskLots(container);

    if (!suggestion || !button) {
      return;
    }

    container.dataset.suggestedLots = String(calculation.lots);
    container.dataset.suggestedQty = String(calculation.quantity);

    if (!calculation.valid) {
      suggestion.textContent = calculation.message;
      suggestion.style.color = '#df4747';
      button.disabled = true;
      button.style.opacity = '0.55';
      button.style.cursor = 'not-allowed';
      return;
    }

    if (calculation.lots > 0) {
      suggestion.textContent = `${calculation.lots} Lots (${calculation.quantity} Qty)`;
      suggestion.style.color = '#02a77d';
      button.disabled = !nativeQtyInput;
    } else {
      suggestion.textContent = `0 Lots (1 Lot requires min ₹${calculation.riskPerLot.toFixed(2)} risk)`;
      suggestion.style.color = '#df4747';
      button.disabled = true;
    }
    button.style.opacity = button.disabled ? '0.55' : '1';
    button.style.cursor = button.disabled ? 'not-allowed' : 'pointer';
  }

  function applyRiskLotSuggestion(container, nativeQtyInput) {
    const calculation = calculateRiskLots(container);

    if (!calculation.valid || calculation.quantity <= 0 || !nativeQtyInput) {
      updateRiskLotSuggestion(container, nativeQtyInput);
      return;
    }

    setNativeInputValue(nativeQtyInput, String(calculation.lots));
    nativeQtyInput.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function getCurrentRiskCalculatorQuantityInput(container) {
    const orderForm = container.closest('#orderForm') || document.querySelector('#orderForm');
    return orderForm ? findOrderQuantityInput(orderForm) : null;
  }

  function calculateRiskLots(container) {
    const riskAmount = Number.parseFloat(container.querySelector('#risk-amount-input')?.value || '');
    const slPoints = Number.parseFloat(container.querySelector('#sl-points-input')?.value || '');
    const lotSize = getOptionPanelLotSize();
    const riskPerLot = slPoints * lotSize;

    if (!Number.isFinite(riskAmount) || riskAmount <= 0) {
      return { valid: false, lots: 0, quantity: 0, message: 'Enter max risk amount' };
    }

    if (!Number.isFinite(slPoints) || slPoints <= 0) {
      return { valid: false, lots: 0, quantity: 0, message: 'Enter SL option points' };
    }

    if (!Number.isFinite(lotSize) || lotSize <= 0) {
      return { valid: false, lots: 0, quantity: 0, message: 'Waiting for lot size' };
    }

    if (!Number.isFinite(riskPerLot) || riskPerLot <= 0) {
      return { valid: false, lots: 0, quantity: 0, message: 'Calculation unavailable' };
    }

    const lots = Math.max(0, Math.floor(riskAmount / riskPerLot));
    return {
      valid: true,
      lots,
      quantity: lots * lotSize,
      riskAmount,
      slPoints,
      lotSize,
      riskPerLot
    };
  }

  function getOptionPanelLotSize() {
    const orderForm = document.querySelector('#orderForm');
    const exactElement = orderForm ? findElementByExactClass(UPSTOX_OPTION_LOT_SIZE_CLASS, orderForm) : null;
    const exactValue = parseLotSizeText(exactElement?.innerText || exactElement?.textContent || '');

    if (Number.isFinite(exactValue)) {
      return exactValue;
    }

    return parseLotSizeText(orderForm?.innerText || '');
  }

  function parseLotSizeText(text) {
    const normalizedText = String(text || '').replace(/\s+/g, ' ');
    const explicitLotMatch = normalizedText.match(/\b\d+\s*[xX]\s*([\d,]+)\b/);

    if (explicitLotMatch) {
      return toNumber(explicitLotMatch[1]);
    }

    const lotSizeMatch = normalizedText.match(/\b(?:lot size|lot)\D+([\d,]+)\b/i);
    return lotSizeMatch ? toNumber(lotSizeMatch[1]) : NaN;
  }

  function findElementByExactClass(className, scope = document) {
    return Array.from(scope.querySelectorAll('div, span')).find((element) => (
      element.classList?.contains(className) && isVisibleElement(element)
    )) || null;
  }

  function findOrderQuantityInput(orderForm) {
    const stableQuantityInput = orderForm.querySelector(UPSTOX_ORDER_QUANTITY_SELECTOR);

    if (stableQuantityInput && !stableQuantityInput.closest(`#${RISK_LOT_CALCULATOR_ID}`)) {
      return stableQuantityInput;
    }

    const inputCandidates = Array.from(orderForm.querySelectorAll('input')).filter((input) => {
      const type = (input.getAttribute('type') || '').toLowerCase();
      return !input.closest(`#${RISK_LOT_CALCULATOR_ID}`)
        && (!type || ['number', 'text', 'tel'].includes(type));
    });
    const quantityInput = inputCandidates.find((input) => {
      const labelText = getElementContextText(input);
      return /\b(quantity|qty|lot)\b/i.test(labelText);
    });

    return quantityInput || inputCandidates[0] || null;
  }

  function getRiskCalculatorInsertionTarget(orderForm, input) {
    const quantityField = input.closest('[data-id="quantity"]');
    const row = quantityField?.parentElement;
    const priceField = row?.querySelector('[data-id="price"]');

    if (row && priceField) {
      return row;
    }

    return quantityField
      || input.closest('label, [role="group"], [class*="input"], [class*="Input"]')
      || input.parentElement
      || orderForm;
  }

  function getElementContextText(element) {
    const container = element.closest('label, div') || element.parentElement || element;
    const parent = container.parentElement;
    return `${container.innerText || container.textContent || ''} ${parent?.innerText || parent?.textContent || ''}`;
  }

  function isVisibleElement(element) {
    return Boolean(element.offsetParent || element.getClientRects().length);
  }

  function setNativeInputValue(input, value) {
    const prototype = Object.getPrototypeOf(input);
    const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

    if (valueSetter) {
      valueSetter.call(input, value);
      return;
    }

    input.value = value;
  }

  function updateTopBarOptionChainButton() {
    const slot = getTopBarDailyPnlSlot();

    if (!slot?.container) {
      return;
    }

    ensureTopBarOptionChainButton(slot);
  }

  function getTopBarDailyPnlSlot() {
    const accountDropdown = document.querySelector('[data-id="accountDropdown"]');
    const accountWrapper = accountDropdown?.parentElement;
    const rightActions = accountWrapper?.parentElement;

    if (rightActions && accountWrapper) {
      return { container: rightActions, before: accountWrapper };
    }

    const funds = document.getElementById('funds');
    const fundsWrapper = funds?.closest('div');
    const fundsActions = fundsWrapper?.parentElement;

    if (fundsActions) {
      return { container: fundsActions, before: null };
    }

    const ticker = document.getElementById('ticker');
    return {
      container: ticker?.parentElement || document.querySelector('header') || document.body,
      before: null
    };
  }

  function ensureTopBarDailyPnlElement({ container, before }) {
    let pill = document.getElementById(TOP_BAR_DAILY_PNL_ID);

    if (!pill) {
      pill = document.createElement('div');
      const label = document.createElement('span');
      const value = document.createElement('strong');

      pill.id = TOP_BAR_DAILY_PNL_ID;
      pill.setAttribute('aria-label', 'Current profit and loss');
      label.textContent = 'P/L';
      value.textContent = '--';
      pill.append(label, value);
      Object.assign(pill.style, {
        alignItems: 'center',
        background: '#f8fafc',
        border: '1px solid #e5e7eb',
        borderRadius: '6px',
        boxSizing: 'border-box',
        display: 'inline-flex',
        flex: '0 0 auto',
        gap: '6px',
        height: '32px',
        marginLeft: '8px',
        marginRight: '8px',
        padding: '0 10px',
        whiteSpace: 'nowrap',
        zIndex: '10'
      });
      Object.assign(pill.firstElementChild.style, {
        color: '#64748b',
        font: '700 14px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        letterSpacing: '0'
      });
      Object.assign(pill.lastElementChild.style, {
        font: '900 18px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        letterSpacing: '0'
      });
    }

    if (
      pill.parentElement !== container ||
      (pill.nextSibling !== before && pill.nextSibling?.id !== TOP_BAR_DISCIPLINE_RULE_ID)
    ) {
      container.insertBefore(pill, before);
    }

    return pill;
  }

  function ensureTopBarOptionChainButton({ container, before }) {
    let button = document.getElementById(TOP_BAR_OPTION_CHAIN_ID);

    if (!button) {
      button = document.createElement('button');
      button.id = TOP_BAR_OPTION_CHAIN_ID;
      button.type = 'button';
      button.textContent = 'Option Chain';
      button.setAttribute('aria-label', 'Open option chain for current stock');
      button.addEventListener('click', openCurrentOptionChain);
      Object.assign(button.style, {
        alignItems: 'center',
        background: '#111827',
        border: '1px solid #111827',
        borderRadius: '6px',
        boxSizing: 'border-box',
        color: '#ffffff',
        cursor: 'pointer',
        display: 'inline-flex',
        flex: '0 0 auto',
        font: '850 12px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        height: '32px',
        letterSpacing: '0',
        marginLeft: '8px',
        marginRight: '0',
        padding: '0 11px',
        whiteSpace: 'nowrap',
        zIndex: '10'
      });
    }

    const instrumentKey = getCurrentInstrumentKey();
    const optionChainUrl = instrumentKey ? buildOptionChainUrl(instrumentKey) : '';

    button.disabled = !optionChainUrl;
    button.dataset.optionChainUrl = optionChainUrl;
    button.title = optionChainUrl || 'Select a stock from the watchlist to open option chain';
    button.style.opacity = optionChainUrl ? '1' : '0.55';
    button.style.cursor = optionChainUrl ? 'pointer' : 'not-allowed';

    if (
      button.parentElement !== container ||
      (button.nextSibling !== before && button.nextSibling?.id !== TOP_BAR_DAILY_PNL_ID)
    ) {
      container.insertBefore(button, before);
    }

    return button;
  }

  function openCurrentOptionChain(event) {
    const instrumentKey = getCurrentInstrumentKey();
    const optionChainUrl = instrumentKey ? buildOptionChainUrl(instrumentKey) : '';

    if (!optionChainUrl) {
      return;
    }

    window.open(optionChainUrl, '_blank', 'noopener');
  }

  function buildOptionChainUrl(instrumentKey) {
    const [exchange, token] = String(instrumentKey || '').split('|');

    if (!exchange || !token) {
      return '';
    }

    return `${window.location.origin}/option-chain/${encodeURIComponent(exchange)}/${encodeURIComponent(token)}`;
  }

  function getCurrentInstrumentKey() {
    return getInstrumentKeyFromLocation()
      || getInstrumentKeyFromActiveWatchlist()
      || '';
  }

  function getInstrumentKeyFromLocation() {
    const match = window.location.pathname.match(/\/(?:option-chain|trading-charts)\/([^/?#]+)\/([^/?#]+)/i);

    if (!match) {
      return '';
    }

    return `${decodeURIComponent(match[1])}|${decodeURIComponent(match[2])}`;
  }

  function getInstrumentKeyFromActiveWatchlist() {
    const handles = Array.from(document.querySelectorAll('[data-rbd-drag-handle-draggable-id*="|"]'));

    if (!handles.length) {
      return '';
    }

    const currentSymbol = getCurrentSymbol();
    const matchedSymbolHandle = currentSymbol
      ? handles.find((handle) => {
        const row = getWatchlistRow(handle);
        return getWatchlistSymbol(row).toUpperCase() === currentSymbol;
      })
      : null;

    if (matchedSymbolHandle) {
      return matchedSymbolHandle.getAttribute('data-rbd-drag-handle-draggable-id') || '';
    }

    const activeHandle = handles.find((handle) => isActiveWatchlistRow(getWatchlistRow(handle)));
    return activeHandle?.getAttribute('data-rbd-drag-handle-draggable-id') || '';
  }

  function getWatchlistRow(element) {
    return element.closest('[data-type="container"], [data-index], [data-item-index]')
      || element.parentElement?.closest('[role="button"]')
      || element.parentElement
      || element;
  }

  function isActiveWatchlistRow(row) {
    if (!row) {
      return false;
    }

    const ariaSelected = row.getAttribute('aria-selected') === 'true';
    const ariaCurrent = row.getAttribute('aria-current') === 'true';
    const dataSelected = row.getAttribute('data-selected') === 'true';
    const focused = row === document.activeElement || row.contains(document.activeElement);
    const activeClass = /\b(active|selected)\b/i.test(String(row.className || ''));

    return ariaSelected || ariaCurrent || dataSelected || focused || activeClass;
  }

  function ensureTopBarDisciplineRuleElement({ container, before }) {
    if (!profitProtectionEnabled) {
      removeTopBarDisciplineRuleElement();
      return null;
    }

    let pill = document.getElementById(TOP_BAR_DISCIPLINE_RULE_ID);

    if (!pill) {
      pill = document.createElement('div');
      const label = document.createElement('span');
      const value = document.createElement('strong');

      pill.id = TOP_BAR_DISCIPLINE_RULE_ID;
      pill.setAttribute('aria-label', 'Trading discipline rule');
      label.textContent = 'Rule';
      value.textContent = DISCIPLINE_RULES[topBarDisciplineRuleIndex % DISCIPLINE_RULES.length];
      pill.append(label, value);
      Object.assign(pill.style, {
        alignItems: 'center',
        background: '#ecfdf5',
        border: '1px solid #86efac',
        borderRadius: '6px',
        boxSizing: 'border-box',
        color: '#064e3b',
        display: 'inline-flex',
        flex: '0 0 300px',
        gap: '6px',
        height: '32px',
        marginLeft: '0',
        marginRight: '8px',
        maxWidth: '300px',
        minWidth: '300px',
        overflow: 'hidden',
        padding: '0 10px',
        whiteSpace: 'nowrap',
        zIndex: '10'
      });
      Object.assign(label.style, {
        color: '#047857',
        flex: '0 0 auto',
        font: '900 12px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        letterSpacing: '0'
      });
      Object.assign(value.style, {
        flex: '1 1 auto',
        font: '850 12px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        letterSpacing: '0',
        minWidth: '0',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      });
    }

    if (pill.parentElement !== container || pill.nextSibling !== before) {
      container.insertBefore(pill, before);
    }

    if (!topBarDisciplineRuleIntervalId) {
      topBarDisciplineRuleIntervalId = window.setInterval(() => {
        const current = document.getElementById(TOP_BAR_DISCIPLINE_RULE_ID);

        if (!current?.lastElementChild) {
          window.clearInterval(topBarDisciplineRuleIntervalId);
          topBarDisciplineRuleIntervalId = null;
          return;
        }

        topBarDisciplineRuleIndex = (topBarDisciplineRuleIndex + 1) % DISCIPLINE_RULES.length;
        current.lastElementChild.textContent = DISCIPLINE_RULES[topBarDisciplineRuleIndex];
      }, 2500);
    }

    return pill;
  }

  function removeTopBarDisciplineRuleElement() {
    document.getElementById(TOP_BAR_DISCIPLINE_RULE_ID)?.remove();
    document.getElementById(DISCIPLINE_BANNER_ID)?.remove();

    if (topBarDisciplineRuleIntervalId) {
      window.clearInterval(topBarDisciplineRuleIntervalId);
      topBarDisciplineRuleIntervalId = null;
    }
  }

  function getDailyPnlRows() {
    const containers = [
      getPositionsTab(),
      document.querySelector('[data-id="HoldingsTab"]')
    ].filter(Boolean);

    return containers.flatMap((container) => {
      const rows = Array.from(container.querySelectorAll('div, span')).filter((element) => {
        const text = element.innerText || element.textContent || '';

        return /\bDay P&L\b/i.test(text)
          && Boolean(extractDailyPnlFromText(text))
          && !Array.from(element.children).some((child) => {
            const childText = child.innerText || child.textContent || '';
            return /\bDay P&L\b/i.test(childText) && Boolean(extractDailyPnlFromText(childText));
          });
      });

      return rows;
    });
  }

  function findDailyPnlValueElement(row) {
    const candidates = Array.from(row.querySelectorAll('span, div')).filter((element) => {
      const text = (element.innerText || element.textContent || '').trim();
      return /^[-+\u2212]?\s*[\d,]+(?:\.\d+)?(?:\s*\([-+\u2212]?\d+(?:\.\d+)?%\))?$/.test(text);
    });

    return candidates[candidates.length - 1] || (row === document.body ? null : row);
  }

  function normalizePositiveInteger(value, fallback) {
    const number = Number.parseInt(value, 10);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  function normalizeSwitchInterval(value) {
    const number = Number.parseInt(value, 10);

    if ([10, 20, 30, 60, 120, 180, 240, 300].includes(number)) {
      return number;
    }

    if (Number.isFinite(number) && number > 0 && number <= 5) {
      return number * 60;
    }

    return 60;
  }

  function formatDuration(seconds) {
    if (seconds < 60) {
      return `${seconds} second(s)`;
    }

    return `${seconds / 60} minute(s)`;
  }

  function isValidCandle(candle) {
    return [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)
      && candle.high >= candle.low;
  }

  function range(candle) {
    return candle.high - candle.low;
  }

  function averageRange(candles) {
    const valid = candles.filter(isValidCandle);

    if (!valid.length) {
      return 0;
    }

    return valid.reduce((total, candle) => total + range(candle), 0) / valid.length;
  }

  function isBullish(candle) {
    return candle.close > candle.open;
  }

  function isBearish(candle) {
    return candle.close < candle.open;
  }

  function formatPrice(price) {
    return price.toLocaleString('en-IN', {
      maximumFractionDigits: 2,
      minimumFractionDigits: 2
    });
  }

  function getCandleBucket(interval) {
    const minutes = intervalToMinutes(interval);
    const bucketSize = minutes ? minutes * 60 * 1000 : activeScanSeconds * 1000;

    return Math.floor(Date.now() / bucketSize);
  }

  function intervalToMinutes(interval) {
    if (!interval) {
      return null;
    }

    if (interval === 'D') {
      return 24 * 60;
    }

    if (interval === 'W') {
      return 7 * 24 * 60;
    }

    if (interval === 'M') {
      return 30 * 24 * 60;
    }

    const match = interval.match(/^(\d+)(m|h)$/i);

    if (!match) {
      return null;
    }

    const value = Number.parseInt(match[1], 10);
    return match[2].toLowerCase() === 'h' ? value * 60 : value;
  }

  window.upstoxAlertAgent = { handleCommand, version: CONTENT_SCRIPT_VERSION };
  installIntervalHighlightStyles();
  loadProfitProtectionSetting();
  startTopBarOptionChainButtonWatcher();
  startRiskLotCalculatorWatcher();
  autoStartSwitcherIfNeeded();
  autoStartScannerIfNeeded();
  autoStartDailyPnlWatcherIfNeeded();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.profitProtectionEnabled) {
      setProfitProtectionEnabled(changes.profitProtectionEnabled.newValue !== false);
    }
  });

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    sendResponse(handleCommand(request));
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.type !== 'UPSTOX_ALERT_TEST_PROFIT_PROTECTION') {
      return;
    }

    showDisciplineBanner(event.data.display || '₹5,800');
  });
})();
