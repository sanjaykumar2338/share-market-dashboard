# RELIANCE PO3 / AMD Intraday Execution Engine

This folder contains a TradingView Pine strategy plus a Python broker-agnostic
execution engine for the SMC Power of 3 / AMD model on `NSE:RELIANCE`.

## Files

- `reliance_po3_amd_strategy.pine`
  - Use on a 5-minute TradingView chart.
  - Builds 09:15-10:00 IST accumulation range.
  - Blocks trading if the opening gap is above 0.50%.
  - Locks entries to the 1H/Daily directional bias.
  - Detects 15-minute sweep + displacement + FVG.
  - Waits for 5-minute liquidity grab + MSS inside the FVG.
  - Calculates quantity from fixed 1% cash risk and 5x buying power.
  - Scales 50% at Rs. 4-5 TP1, moves runner stop to breakeven, trails on 15m swings.
  - Force-closes at 15:15 IST.

- `reliance_po3_amd_engine.py`
  - Pure Python state machine for live automation.
  - Safe `PrintBroker` included for dry runs.
  - Implement the `Broker` protocol with your OMS/broker API before live use.

## Live Execution Notes

TradingView Pine cannot place exchange orders directly and cannot guarantee
literal millisecond execution. Use Pine alerts/webhooks or feed candles directly
into the Python engine, then let a broker adapter submit market orders.

For live capital, forward-test in paper mode first and verify:

- NSE instrument symbol mapping.
- Broker order variety/product for intraday margin.
- Exchange tick size and freeze quantity handling.
- Slippage, brokerage, STT, stamp duty, and turnover fees.
- Internet, broker API, and webhook latency.
