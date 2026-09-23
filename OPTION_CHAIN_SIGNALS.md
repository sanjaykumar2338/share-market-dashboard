# Page-only option-chain signals

Reload the unpacked extension, open a stock/index page such as
`https://pro.upstox.com/option-chain/NSE_INDEX/Nifty%2050`, select the expiry,
and leave it open. Scanning starts automatically; there are no Scan/Stop buttons
and any old saved stop setting is ignored. Confirmed signals are stored in
`chrome.storage.local.signalHistory`, which `signal-history.html` reads and
updates live, independently of notification/Discord settings.
The expiry selector and at least five complete paired
strikes must be rendered. Show absolute **OI**, **Volume**, and **LTP** on both
sides. Percent OI change is not a substitute for absolute OI.

No access token or broker market-data API is used. The background worker reads
any selected stock/index, not a fixed Nifty instrument. Both `/option-chain`
and `/option-chain/` use the page's selected underlying; symbol-specific routes
also track the visible selection so changing it resets confirmation history.
All open option-chain tabs are scanned without activating them. Existing scan
alarms are retained across worker starts instead of resetting their countdown.
The background worker reads
the page DOM about every 30 seconds. Chart/candle modules from earlier work are
not loaded into the signal workflow. Watchlist, P&L and screenshot features are
separate from signal decisions.

## Decision rules

Three snapshots are required, with 25–75 seconds between reads. Each tab tracks
its own underlying and selected expiry. Context changes, gaps, missing columns
and malformed data prevent signals. The five central displayed strikes are
used; they are **not necessarily ATM** if the table has been scrolled away.

In each of two consecutive comparisons, at least three of those five strikes
must have both call and put OI increasing at least 0.5%, and traded volume
increasing on both sides. A bullish candidate additionally requires call
premium rising at least 0.5% and put premium falling at least 0.5%; a bearish
candidate requires the reverse. Both comparisons must agree. Positive OI of
at least 100 and positive premium/volume are required. Where both bid and ask
are displayed, their midpoint replaces LTP and spread must be at most 5%.
Missing bid/ask is disclosed, not invented. Switching between LTP and midpoint
within a comparison is rejected. PCR is descriptive context, not a trigger.

BUY means bullish underlying bias; SELL means bearish underlying bias. Neither
selects an option contract or places an order. OI/premium combinations suggest
positioning but do not establish the intent of individual buyers or writers.
Thresholds are development heuristics, not backtested accuracy claims.

History records retain expiry, source, evaluated strikes and reasons. A
three-minute cooldown per underlying/expiry suppresses repeated notifications
across tabs. Clearing the displayed history does not erase the cooldown.

## Limits and validation

The reader supports Upstox's separate call/strike/put tables, joined by strike
identifiers, and its selected expiry radio control. It also supports semantic
HTML tables and ARIA tables/grids with identifiable headers and expiry controls.
A new/custom page layout may need an
adapter. The popup reports the specific missing information. It does not guess
column meaning or silently use charts instead.

Inactive-tab reads cannot make the site update frozen prices. Unchanged OI,
volume and premiums cannot satisfy confirmation rules. DOM values have no
verified exchange timestamp; receipt times only measure when the page was read.
Chrome suspension, discarded tabs, logout and closed/sleeping browsers interrupt
sampling. Ordinary NSE/BSE weekday hours are enforced; exchange holidays are
not independently queried.

Run `npm ci` then `npm test` for the full regression suite, or
`node --test tests/option-chain-page.test.js` for reader, decision, popup and
mocked background checks. The reader is tested against the supplied
`sample-oi-data.html`, including units, contract IDs, expiry and incomplete rows.
These tests do not establish profitability or verify live authenticated updates.
