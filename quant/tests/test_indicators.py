"""Golden-value tests for the indicator math."""
from __future__ import annotations

import numpy as np
import pandas as pd

from quant.src import indicators as ind


def test_sma_basic():
    s = pd.Series([1, 2, 3, 4, 5], dtype=float)
    out = ind.sma(s, 3)
    assert pd.isna(out.iloc[0]) and pd.isna(out.iloc[1])
    assert out.iloc[2] == 2.0
    assert out.iloc[3] == 3.0
    assert out.iloc[4] == 4.0


def test_ema_converges_to_constant():
    s = pd.Series([5.0] * 50)
    out = ind.ema(s, 10)
    # Once warmed up, EMA of a constant series equals the constant.
    assert abs(out.iloc[-1] - 5.0) < 1e-9


def test_rsi_pure_uptrend_is_100():
    s = pd.Series(np.arange(1, 31), dtype=float)
    out = ind.rsi(s, 14)
    # Pure uptrend: average loss = 0 -> RSI defined as 100 by our impl.
    assert out.iloc[-1] == 100.0


def test_rsi_pure_downtrend_is_zero():
    s = pd.Series(np.arange(30, 0, -1), dtype=float)
    out = ind.rsi(s, 14)
    # Pure downtrend: average gain = 0 -> RSI = 0.
    assert out.iloc[-1] == 0.0


def test_rsi_neutral_oscillation_around_50():
    # Symmetric ±1 swings -> RSI hovers near 50.
    s = pd.Series([100.0 + (1 if i % 2 == 0 else -1) for i in range(60)])
    out = ind.rsi(s, 14)
    assert 40.0 <= out.iloc[-1] <= 60.0


def test_macd_hist_positive_for_uptrend():
    s = pd.Series(np.arange(1, 80), dtype=float)
    line, sig, hist = ind.macd(s)
    assert hist.iloc[-1] > 0
    # Line should be above signal in a steady uptrend.
    assert line.iloc[-1] > sig.iloc[-1]


def test_atr_constant_range():
    n = 30
    high = pd.Series([11.0] * n)
    low = pd.Series([9.0] * n)
    close = pd.Series([10.0] * n)
    out = ind.atr(high, low, close, 14)
    # True range each day = high - low = 2; ATR -> 2.
    assert abs(out.iloc[-1] - 2.0) < 1e-6


def test_momentum_12_1_constant_is_zero():
    s = pd.Series([100.0] * 400)
    assert ind.momentum_12_1(s) == 0.0


def test_momentum_12_1_geometric_growth():
    # 0.1% daily growth: M = (1.001)^252 - 1.
    s = pd.Series([100.0 * (1.001 ** i) for i in range(400)])
    expected = 1.001 ** 252 - 1
    got = ind.momentum_12_1(s)
    assert abs(got - expected) < 1e-9


def test_realized_vol_constant_is_zero():
    s = pd.Series([100.0] * 200)
    assert ind.realized_vol(s) == 0.0


def test_realized_vol_known_log_returns():
    # Construct a series whose log returns alternate +1%/-1%.
    rets = []
    for i in range(120):
        rets.append(0.01 if i % 2 == 0 else -0.01)
    prices = [100.0]
    for r in rets:
        prices.append(prices[-1] * np.exp(r))
    s = pd.Series(prices)
    vol = ind.realized_vol(s, 63)
    # Expected stdev of {+0.01, -0.01} ~ 0.01; annualized ~0.01 * sqrt(252).
    assert abs(vol - 0.01 * np.sqrt(252)) < 5e-3
