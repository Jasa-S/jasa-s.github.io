"""Score -> verdict and per-holding action, with regime + earnings gates."""
from __future__ import annotations

from typing import Literal

Verdict = Literal["BUY", "WATCH", "AVOID"]
Action = Literal["ADD", "HOLD", "TRIM"]


def classify(
    score: int,
    rsi: float | None,
    trend_ok: bool,
    regime_on: bool = True,
    earnings_in_days: int | None = None,
    earnings_block_days: int = 3,
) -> Verdict:
    """Apply thresholds with regime + earnings + downtrend-oversold downgrades."""
    base: Verdict
    if score >= 70:
        base = "BUY"
    elif score >= 40:
        base = "WATCH"
    else:
        base = "AVOID"

    # Veto: high score in a downtrend with oversold RSI is suspicious.
    if base == "BUY" and not trend_ok and rsi is not None and rsi < 40:
        base = "WATCH"

    # Regime gate: in a market downtrend, downgrade BUY -> WATCH (don't suppress AVOID/TRIM).
    if not regime_on and base == "BUY":
        base = "WATCH"

    # Earnings gate: don't issue BUY within `earnings_block_days` of a report.
    if (
        base == "BUY"
        and earnings_in_days is not None
        and 0 <= earnings_in_days <= earnings_block_days
    ):
        base = "WATCH"

    return base


def holding_action(
    score: int,
    rsi: float | None,
    trend_ok: bool,
    weight: float,
    drawdown_vs_basis: float,
    regime_on: bool = True,
    earnings_in_days: int | None = None,
    earnings_block_days: int = 3,
) -> Action:
    """Decide ADD / HOLD / TRIM for a current position."""
    if score < 40:
        return "TRIM"
    if weight > 0.35 and score < 60:
        return "TRIM"
    if rsi is not None and rsi > 80 and drawdown_vs_basis > 0.40:
        return "TRIM"

    add_eligible = score >= 65 and weight < 0.30 and trend_ok
    if add_eligible and not regime_on:
        return "HOLD"
    if (
        add_eligible
        and earnings_in_days is not None
        and 0 <= earnings_in_days <= earnings_block_days
    ):
        return "HOLD"
    if add_eligible:
        return "ADD"
    return "HOLD"


def pullback_buy(features: dict, params: dict) -> bool:
    """Pullback overlay: trend on AND oversold AND price near SMA50.

    Independent of the BUY/WATCH/AVOID verdict. Useful for adding to existing
    winners on a healthy dip.
    """
    if not features.get("trend_ok"):
        return False
    rsi = features.get("rsi")
    if rsi is None:
        return False
    rsi_max = float(params.get("pullback_rsi_max", 35))
    if rsi > rsi_max:
        return False
    return bool(features.get("near_sma_fast"))
