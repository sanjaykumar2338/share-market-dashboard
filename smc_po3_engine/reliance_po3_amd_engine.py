"""
Broker-agnostic SMC PO3 / AMD intraday execution engine for NSE:RELIANCE.

This module contains the execution state machine and risk logic. It does not
place real orders by itself; connect a concrete Broker implementation before
using live capital.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time
from enum import Enum
from math import floor
from typing import Iterable, Optional, Protocol


IST_OPEN = time(9, 15)
ACCUMULATION_END = time(10, 0)
ENTRY_WINDOW_END = time(12, 0)
FORCE_QUIT_TIME = time(15, 15)


class Direction(str, Enum):
    LONG = "LONG"
    SHORT = "SHORT"


class SystemStatus(str, Enum):
    MONITORING = "MONITORING"
    INACTIVE_GAP = "INACTIVE (Gap Too Large)"
    LOCKED_OUT = "LOCKED OUT"


@dataclass(frozen=True)
class Candle:
    """OHLCV candle. Timestamp must be timezone-aware in Asia/Kolkata."""

    ts: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0


@dataclass(frozen=True)
class FvgZone:
    direction: Direction
    top: float
    bottom: float
    created_at: datetime

    def contains(self, candle: Candle) -> bool:
        return candle.high >= self.bottom and candle.low <= self.top


@dataclass
class Position:
    direction: Direction
    qty: int
    remaining_qty: int
    entry: float
    stop: float
    tp1: float
    tp1_done: bool = False


class Broker(Protocol):
    """Implement this Protocol with your live broker API."""

    def market_buy(self, symbol: str, qty: int, tag: str) -> str:
        ...

    def market_sell(self, symbol: str, qty: int, tag: str) -> str:
        ...

    def flatten(self, symbol: str, tag: str) -> None:
        ...


class PrintBroker:
    """Safe development broker that only prints intended orders."""

    def market_buy(self, symbol: str, qty: int, tag: str) -> str:
        print(f"BUY {symbol} qty={qty} tag={tag}")
        return "paper-buy"

    def market_sell(self, symbol: str, qty: int, tag: str) -> str:
        print(f"SELL {symbol} qty={qty} tag={tag}")
        return "paper-sell"

    def flatten(self, symbol: str, tag: str) -> None:
        print(f"FLATTEN {symbol} tag={tag}")


class ReliancePo3AmdEngine:
    """
    Institutional-grade execution state machine:
    1. Reject oversized opening gaps.
    2. Lock direction from HTF structural bias.
    3. Build 09:15-10:00 accumulation range.
    4. Detect 15m manipulation + FVG.
    5. Enter on 5m liquidity grab + MSS inside the FVG.
    6. Risk-size quantity, scale TP1, trail runner, force quit at 15:15.
    """

    def __init__(
        self,
        broker: Broker,
        symbol: str = "NSE:RELIANCE",
        cash_capital: float = 300000.0,
        margin_multiplier: float = 5.0,
        risk_pct: float = 1.0,
        max_gap_pct: float = 0.50,
        tp1_move: float = 4.5,
        structure_lookback: int = 6,
    ) -> None:
        if risk_pct != 1.0:
            raise ValueError("Risk ceiling is fixed at exactly 1% of cash capital.")
        if not 4.0 <= tp1_move <= 5.0:
            raise ValueError("TP1 move must stay between Rs. 4.00 and Rs. 5.00.")

        self.broker = broker
        self.symbol = symbol
        self.cash_capital = cash_capital
        self.buying_power = cash_capital * margin_multiplier
        self.max_loss = cash_capital * 0.01
        self.max_gap_pct = max_gap_pct
        self.tp1_move = tp1_move
        self.structure_lookback = structure_lookback

        self.status = SystemStatus.MONITORING
        self.direction_lock: Optional[Direction] = None
        self.prev_close: Optional[float] = None
        self.yesterday_high: Optional[float] = None
        self.yesterday_low: Optional[float] = None
        self.accum_high: Optional[float] = None
        self.accum_low: Optional[float] = None
        self.active_fvg: Optional[FvgZone] = None
        self.position: Optional[Position] = None
        self.five_minute_window: list[Candle] = []

    def initialize_day(
        self,
        opening_candle: Candle,
        prev_close: float,
        yesterday_high: float,
        yesterday_low: float,
        htf_bias: Optional[Direction],
    ) -> None:
        """Run once at 09:15 IST after the first live/open candle is available."""

        self.prev_close = prev_close
        self.yesterday_high = yesterday_high
        self.yesterday_low = yesterday_low
        self.direction_lock = htf_bias
        self.accum_high = None
        self.accum_low = None
        self.active_fvg = None
        self.position = None
        self.five_minute_window.clear()

        gap_pct = abs(opening_candle.open - prev_close) / prev_close * 100.0
        if gap_pct > self.max_gap_pct:
            self.status = SystemStatus.INACTIVE_GAP
        elif htf_bias is None:
            self.status = SystemStatus.LOCKED_OUT
        else:
            self.status = SystemStatus.MONITORING

    def on_5m_candle(self, candle: Candle, latest_15m_swing: Optional[float] = None) -> None:
        """Call on every confirmed 5-minute candle close."""

        if candle.ts.time() >= FORCE_QUIT_TIME:
            self.force_quit()
            return

        self._update_accumulation_range(candle)
        self._remember_5m_candle(candle)
        self._manage_open_position(candle, latest_15m_swing)

        if self.status != SystemStatus.MONITORING or self.position is not None:
            return
        if not (ACCUMULATION_END <= candle.ts.time() < ENTRY_WINDOW_END):
            return
        if self.active_fvg is None or not self.active_fvg.contains(candle):
            return

        if self._long_entry_confirmed(candle):
            self._enter(Direction.LONG, candle.close, candle.low)
        elif self._short_entry_confirmed(candle):
            self._enter(Direction.SHORT, candle.close, candle.high)

    def on_15m_candle(self, candles: Iterable[Candle]) -> None:
        """Call on every confirmed 15-minute candle close with at least 3 candles."""

        last_three = list(candles)[-3:]
        if len(last_three) < 3 or self.status != SystemStatus.MONITORING:
            return

        c1, _, c3 = last_three
        atr_proxy = sum(c.high - c.low for c in last_three) / 3.0
        bullish_fvg = c3.low > c1.high
        bearish_fvg = c3.high < c1.low
        bullish_displacement = c3.close > c3.open and (c3.close - c3.open) > atr_proxy * 0.6
        bearish_displacement = c3.close < c3.open and (c3.open - c3.close) > atr_proxy * 0.6

        swept_low = self._swept_low(c3)
        swept_high = self._swept_high(c3)

        if (
            self.direction_lock == Direction.LONG
            and swept_low
            and bullish_fvg
            and bullish_displacement
        ):
            self.active_fvg = FvgZone(Direction.LONG, top=c3.low, bottom=c1.high, created_at=c3.ts)

        if (
            self.direction_lock == Direction.SHORT
            and swept_high
            and bearish_fvg
            and bearish_displacement
        ):
            self.active_fvg = FvgZone(Direction.SHORT, top=c1.low, bottom=c3.high, created_at=c3.ts)

    def _update_accumulation_range(self, candle: Candle) -> None:
        if IST_OPEN <= candle.ts.time() < ACCUMULATION_END:
            self.accum_high = candle.high if self.accum_high is None else max(self.accum_high, candle.high)
            self.accum_low = candle.low if self.accum_low is None else min(self.accum_low, candle.low)

    def _remember_5m_candle(self, candle: Candle) -> None:
        self.five_minute_window.append(candle)
        self.five_minute_window = self.five_minute_window[-(self.structure_lookback + 1) :]

    def _long_entry_confirmed(self, candle: Candle) -> bool:
        if self.direction_lock != Direction.LONG or self.active_fvg.direction != Direction.LONG:
            return False
        previous = self.five_minute_window[:-1]
        if len(previous) < self.structure_lookback:
            return False
        return candle.low < min(c.low for c in previous) and candle.close > max(c.high for c in previous)

    def _short_entry_confirmed(self, candle: Candle) -> bool:
        if self.direction_lock != Direction.SHORT or self.active_fvg.direction != Direction.SHORT:
            return False
        previous = self.five_minute_window[:-1]
        if len(previous) < self.structure_lookback:
            return False
        return candle.high > max(c.high for c in previous) and candle.close < min(c.low for c in previous)

    def _enter(self, direction: Direction, entry: float, stop: float) -> None:
        qty = self._calculate_qty(entry, stop)
        if qty <= 0:
            return

        tp1 = entry + self.tp1_move if direction == Direction.LONG else entry - self.tp1_move
        self.position = Position(direction=direction, qty=qty, remaining_qty=qty, entry=entry, stop=stop, tp1=tp1)

        if direction == Direction.LONG:
            self.broker.market_buy(self.symbol, qty, "PO3_AMD_ENTRY")
        else:
            self.broker.market_sell(self.symbol, qty, "PO3_AMD_ENTRY")

    def _calculate_qty(self, entry: float, stop: float) -> int:
        sl_distance = abs(entry - stop)
        if sl_distance <= 0:
            return 0

        risk_qty = floor(self.max_loss / sl_distance)
        margin_qty = floor(self.buying_power / entry)
        return max(0, min(risk_qty, margin_qty))

    def _manage_open_position(self, candle: Candle, latest_15m_swing: Optional[float]) -> None:
        if self.position is None:
            return

        pos = self.position
        if pos.direction == Direction.LONG:
            if not pos.tp1_done and candle.high >= pos.tp1:
                self._scale_out_half("PO3_AMD_TP1")
                pos.stop = pos.entry
                pos.tp1_done = True
            if pos.tp1_done and latest_15m_swing is not None:
                pos.stop = max(pos.stop, latest_15m_swing)
            if candle.low <= pos.stop:
                self.force_quit("PO3_AMD_LONG_STOP")

        if pos.direction == Direction.SHORT:
            if not pos.tp1_done and candle.low <= pos.tp1:
                self._scale_out_half("PO3_AMD_TP1")
                pos.stop = pos.entry
                pos.tp1_done = True
            if pos.tp1_done and latest_15m_swing is not None:
                pos.stop = min(pos.stop, latest_15m_swing)
            if candle.high >= pos.stop:
                self.force_quit("PO3_AMD_SHORT_STOP")

    def _scale_out_half(self, tag: str) -> None:
        if self.position is None:
            return
        qty = max(1, self.position.remaining_qty // 2)
        if self.position.direction == Direction.LONG:
            self.broker.market_sell(self.symbol, qty, tag)
        else:
            self.broker.market_buy(self.symbol, qty, tag)
        self.position.remaining_qty -= qty

    def force_quit(self, tag: str = "PO3_AMD_FORCE_QUIT_1515") -> None:
        if self.position is None:
            return
        self.broker.flatten(self.symbol, tag)
        self.position = None

    def _swept_low(self, candle: Candle) -> bool:
        return (
            (self.yesterday_low is not None and candle.low <= self.yesterday_low)
            or (self.accum_low is not None and candle.low <= self.accum_low)
        )

    def _swept_high(self, candle: Candle) -> bool:
        return (
            (self.yesterday_high is not None and candle.high >= self.yesterday_high)
            or (self.accum_high is not None and candle.high >= self.accum_high)
        )


def infer_htf_bias(hourly_candles: Iterable[Candle]) -> Optional[Direction]:
    """
    Simple structural bias helper.

    For production, replace this with your own HH/HL and LH/LL swing parser or
    pass the locked bias from a higher-level market-structure service.
    """

    candles = list(hourly_candles)[-6:]
    if len(candles) < 6:
        return None

    highs = [c.high for c in candles]
    lows = [c.low for c in candles]
    if highs[-1] > highs[-3] > highs[-5] and lows[-1] > lows[-3] > lows[-5]:
        return Direction.LONG
    if highs[-1] < highs[-3] < highs[-5] and lows[-1] < lows[-3] < lows[-5]:
        return Direction.SHORT
    return None


if __name__ == "__main__":
    print("Import ReliancePo3AmdEngine and wire it to live NSE candle data plus a Broker implementation.")
