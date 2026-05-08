"""Score -> verdict and per-holding action."""
from __future__ import annotations

from typing import Literal

Verdict = Literal["BUY", "WATCH", "AVOID"]
Action = Literal["ADD", "HOLD", "TRIM"]


def classify(score: int, rsi: float | None, trend_ok: bool) -> Verdict:
    """Apply thresholds with a downtrend+oversold veto."""
    base: Verdict
    if score >= 70:
        base = "BUY"
    elif score >= 40:
        base = "WATCH"
    else:
        base = "AVOID"
    if base == "BUY" and not trend_ok and rsi is not None and rsi < 40:
        return "WATCH"
    return base


def holding_action(
    score: int,
    rsi: float | None,
    trend_ok: bool,
    weight: float,
    drawdown_vs_basis: float,
) -> Action:
    """Decide ADD / HOLD / TRIM for a current position."""
    if score < 40:
        return "TRIM"
    if weight > 0.35 and score < 60:
        return "TRIM"
    if rsi is not None and rsi > 80 and drawdown_vs_basis > 0.40:
        return "TRIM"
    if score >= 65 and weight < 0.30 and trend_ok:
        return "ADD"
    return "HOLD"
