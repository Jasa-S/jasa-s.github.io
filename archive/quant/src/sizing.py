"""Position-sizing helpers. Pure math, no I/O."""
from __future__ import annotations

import math


def add_size_eur(
    portfolio_eur: float,
    price_eur: float,
    atr_eur: float,
    risk_per_trade: float = 0.01,
    stop_mult: float = 2.0,
    max_position_pct: float = 0.10,
) -> float:
    """Risk-based position sizing in EUR notional.

    Dollar-at-risk = risk_per_trade * portfolio.
    Stop distance per share = stop_mult * ATR.
    Shares = risk / stop_distance; notional = shares * price.
    Result is capped at max_position_pct of the portfolio.
    """
    if not all(_finite_pos(x) for x in (portfolio_eur, price_eur, atr_eur, risk_per_trade, stop_mult)):
        return 0.0
    stop_dist = stop_mult * atr_eur
    if stop_dist <= 0:
        return 0.0
    shares = (risk_per_trade * portfolio_eur) / stop_dist
    notional = shares * price_eur
    cap = max_position_pct * portfolio_eur
    return float(min(notional, cap))


def stop_eur(
    price_eur: float,
    atr_eur: float,
    cost_basis_eur: float | None,
    stop_mult: float = 2.0,
    hard_stop_pct: float = 0.85,
) -> float:
    """Trailing stop = max(price - mult*ATR, cost_basis * hard_stop_pct).

    The hard floor protects against ATR collapsing in low-vol regimes that
    would otherwise place the stop way below the catastrophic-loss line.
    Returns NaN if price or ATR aren't usable.
    """
    if not (_finite_pos(price_eur) and _finite_pos(atr_eur)):
        return float("nan")
    raw = price_eur - stop_mult * atr_eur
    if cost_basis_eur is not None and _finite_pos(cost_basis_eur):
        raw = max(raw, hard_stop_pct * cost_basis_eur)
    return float(raw)


def _finite_pos(x) -> bool:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return False
    return math.isfinite(v) and v > 0
