"""Tests for position sizing and stop-loss helpers."""
from __future__ import annotations

import math

from quant.src import sizing


def test_add_size_eur_basic():
    # Portfolio €10k, ATR €2 in EUR, price €100, 1% risk, 2-ATR stop:
    #   shares = (0.01 * 10000) / (2 * 2) = 25
    #   notional = 25 * 100 = 2500
    notional = sizing.add_size_eur(
        portfolio_eur=10000.0, price_eur=100.0, atr_eur=2.0,
        risk_per_trade=0.01, stop_mult=2.0, max_position_pct=0.30,
    )
    assert math.isclose(notional, 2500.0, rel_tol=1e-9)


def test_add_size_eur_capped_by_max_position():
    # Same as above but cap at 10% of portfolio = 1000.
    notional = sizing.add_size_eur(
        portfolio_eur=10000.0, price_eur=100.0, atr_eur=2.0,
        risk_per_trade=0.01, stop_mult=2.0, max_position_pct=0.10,
    )
    assert notional == 1000.0


def test_add_size_eur_zero_atr_returns_zero():
    assert sizing.add_size_eur(10000.0, 100.0, 0.0) == 0.0


def test_add_size_eur_bad_inputs_return_zero():
    assert sizing.add_size_eur(0.0, 100.0, 2.0) == 0.0
    assert sizing.add_size_eur(10000.0, float("nan"), 2.0) == 0.0


def test_stop_eur_uses_atr_when_above_floor():
    s = sizing.stop_eur(price_eur=100.0, atr_eur=3.0, cost_basis_eur=80.0,
                         stop_mult=2.0, hard_stop_pct=0.85)
    # ATR stop = 100 - 6 = 94; floor = 0.85 * 80 = 68; ATR wins.
    assert math.isclose(s, 94.0)


def test_stop_eur_falls_back_to_hard_floor():
    # Tight ATR stop would land below the hard catastrophic floor.
    s = sizing.stop_eur(price_eur=100.0, atr_eur=20.0, cost_basis_eur=100.0,
                         stop_mult=2.0, hard_stop_pct=0.85)
    # ATR stop = 100 - 40 = 60; floor = 0.85 * 100 = 85; floor wins.
    assert math.isclose(s, 85.0)


def test_stop_eur_no_basis():
    s = sizing.stop_eur(price_eur=100.0, atr_eur=3.0, cost_basis_eur=None,
                         stop_mult=2.0)
    assert math.isclose(s, 94.0)


def test_stop_eur_bad_inputs_return_nan():
    assert math.isnan(sizing.stop_eur(price_eur=0.0, atr_eur=3.0, cost_basis_eur=80.0))
    assert math.isnan(sizing.stop_eur(price_eur=100.0, atr_eur=0.0, cost_basis_eur=80.0))
