"""Tests for the v2 indicator additions: donchian, atr_stop, relative_strength."""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from quant.src import indicators as ind


def test_donchian_high_basic():
    # Last 21 closes (we exclude today): max of [10..30] is 30; today=31.
    s = pd.Series(np.arange(1, 32), dtype=float)
    assert ind.donchian_high(s, 20) == 30.0


def test_donchian_high_too_short():
    s = pd.Series([1.0, 2.0, 3.0])
    assert math.isnan(ind.donchian_high(s, 20))


def test_atr_stop_subtracts_multiple_of_atr():
    assert ind.atr_stop(100.0, 2.0, 2.0) == 96.0
    assert ind.atr_stop(50.0, 1.5, 3.0) == 45.5


def test_atr_stop_handles_nan():
    assert math.isnan(ind.atr_stop(float("nan"), 2.0))
    assert math.isnan(ind.atr_stop(100.0, float("nan")))


def test_relative_strength_zero_when_identical():
    s = pd.Series([100.0 * (1.001 ** i) for i in range(200)])
    bench = s.copy()
    assert abs(ind.relative_strength(s, bench, 126)) < 1e-12


def test_relative_strength_positive_when_outperforming():
    n = 200
    s = pd.Series([100.0 * (1.002 ** i) for i in range(n)])
    bench = pd.Series([100.0 * (1.000 ** i) for i in range(n)])
    rs = ind.relative_strength(s, bench, 126)
    # Ticker compounded ~28% over 126d, bench flat. RS should be ~+0.28.
    assert rs > 0.20


def test_relative_strength_negative_when_underperforming():
    n = 200
    s = pd.Series([100.0 * (0.999 ** i) for i in range(n)])
    bench = pd.Series([100.0 * (1.001 ** i) for i in range(n)])
    rs = ind.relative_strength(s, bench, 126)
    assert rs < 0.0


def test_relative_strength_too_short():
    s = pd.Series([1.0, 2.0, 3.0])
    bench = pd.Series([1.0, 2.0, 3.0])
    assert math.isnan(ind.relative_strength(s, bench, 126))
