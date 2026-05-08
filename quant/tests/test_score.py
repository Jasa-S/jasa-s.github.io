"""Tests for cross-sectional z-scoring, composite, and verdict mapping."""
from __future__ import annotations

import numpy as np
import pandas as pd

from quant.src import score as scorelib
from quant.src import signal as signallib
from quant.src.score import composite, cross_sectional_z


def test_cross_sectional_z_centers_and_scales():
    feats = {
        "A": {"mom_12_1": 0.0, "vol_adj_ret": 0.0, "macd_pos": 0.0, "rsi_norm": 0.0},
        "B": {"mom_12_1": 1.0, "vol_adj_ret": 1.0, "macd_pos": 1.0, "rsi_norm": 1.0},
        "C": {"mom_12_1": 2.0, "vol_adj_ret": 2.0, "macd_pos": 2.0, "rsi_norm": 2.0},
    }
    z = cross_sectional_z(feats)
    # Mean of {0,1,2}=1, stdev (ddof=0)=sqrt(2/3); z for B should be 0.
    assert abs(z["B"]["z_mom_12_1"]) < 1e-9
    assert z["A"]["z_mom_12_1"] < 0 < z["C"]["z_mom_12_1"]
    # Symmetric around the median.
    assert abs(z["A"]["z_mom_12_1"] + z["C"]["z_mom_12_1"]) < 1e-9


def test_cross_sectional_z_zero_variance_returns_zero():
    feats = {
        "A": {"mom_12_1": 0.5, "vol_adj_ret": 0.5, "macd_pos": 0.5, "rsi_norm": 0.5},
        "B": {"mom_12_1": 0.5, "vol_adj_ret": 0.5, "macd_pos": 0.5, "rsi_norm": 0.5},
    }
    z = cross_sectional_z(feats)
    for t in ("A", "B"):
        assert z[t]["z_mom_12_1"] == 0.0


def test_composite_neutral_is_50():
    f = {
        "z_mom_12_1": 0.0, "z_vol_adj_ret": 0.0, "z_macd_pos": 0.0, "z_rsi_norm": 0.0,
        "trend_ok": False,
    }
    # trend off -> centered = -1, raw = 0.20 * -1 = -0.2 -> score = 47 or 48.
    score_off = composite(f)
    f["trend_ok"] = True
    score_on = composite(f)
    assert score_on > score_off
    # When trend is on AND z's are zero, raw = +0.2 -> 52.5 -> 52 or 53.
    assert 50 <= score_on <= 55


def test_composite_strong_buy_pegs_high():
    f = {
        "z_mom_12_1": 3.0, "z_vol_adj_ret": 3.0, "z_macd_pos": 3.0, "z_rsi_norm": 3.0,
        "trend_ok": True,
    }
    assert composite(f) >= 75


def test_composite_strong_avoid_pegs_low():
    f = {
        "z_mom_12_1": -3.0, "z_vol_adj_ret": -3.0, "z_macd_pos": -3.0, "z_rsi_norm": -3.0,
        "trend_ok": False,
    }
    assert composite(f) <= 25


def test_classify_thresholds():
    assert signallib.classify(80, 60.0, True) == "BUY"
    assert signallib.classify(50, 50.0, True) == "WATCH"
    assert signallib.classify(20, 30.0, False) == "AVOID"


def test_classify_veto_downgrades_to_watch():
    # High score but downtrend + oversold -> WATCH cap.
    assert signallib.classify(75, 35.0, False) == "WATCH"


def test_classify_regime_off_downgrades_buy():
    # BUY downgrades to WATCH when regime is off.
    assert signallib.classify(80, 60.0, True, regime_on=False) == "WATCH"
    # AVOID stays AVOID.
    assert signallib.classify(20, 30.0, False, regime_on=False) == "AVOID"


def test_classify_earnings_gate():
    # BUY downgrades to WATCH if earnings within block window.
    assert signallib.classify(80, 60.0, True, earnings_in_days=2) == "WATCH"
    # No effect when earnings are far enough out.
    assert signallib.classify(80, 60.0, True, earnings_in_days=10) == "BUY"
    # Negative days (already happened) shouldn't trigger the gate.
    assert signallib.classify(80, 60.0, True, earnings_in_days=-3) == "BUY"


def test_holding_action_regime_off_blocks_add():
    assert (
        signallib.holding_action(
            score=70, rsi=60.0, trend_ok=True, weight=0.10,
            drawdown_vs_basis=0.05, regime_on=False,
        )
        == "HOLD"
    )


def test_holding_action_earnings_blocks_add():
    assert (
        signallib.holding_action(
            score=70, rsi=60.0, trend_ok=True, weight=0.10,
            drawdown_vs_basis=0.05, earnings_in_days=1,
        )
        == "HOLD"
    )


def test_pullback_buy_fires_on_dip_in_uptrend():
    f = {"trend_ok": True, "rsi": 30.0, "near_sma_fast": True}
    assert signallib.pullback_buy(f, {}) is True


def test_pullback_buy_skips_weak_trend():
    f = {"trend_ok": False, "rsi": 30.0, "near_sma_fast": True}
    assert signallib.pullback_buy(f, {}) is False


def test_pullback_buy_skips_when_not_oversold():
    f = {"trend_ok": True, "rsi": 55.0, "near_sma_fast": True}
    assert signallib.pullback_buy(f, {}) is False


def test_holding_action_add():
    assert (
        signallib.holding_action(score=70, rsi=60.0, trend_ok=True, weight=0.10, drawdown_vs_basis=0.05)
        == "ADD"
    )


def test_holding_action_trim_low_score():
    assert (
        signallib.holding_action(score=30, rsi=50.0, trend_ok=False, weight=0.10, drawdown_vs_basis=0.0)
        == "TRIM"
    )


def test_holding_action_trim_overweight():
    assert (
        signallib.holding_action(score=55, rsi=60.0, trend_ok=True, weight=0.40, drawdown_vs_basis=0.10)
        == "TRIM"
    )


def test_holding_action_trim_overbought_with_big_gain():
    assert (
        signallib.holding_action(score=65, rsi=85.0, trend_ok=True, weight=0.20, drawdown_vs_basis=0.50)
        == "TRIM"
    )


def test_holding_action_hold_default():
    assert (
        signallib.holding_action(score=55, rsi=55.0, trend_ok=True, weight=0.20, drawdown_vs_basis=0.10)
        == "HOLD"
    )


def test_compute_features_constant_series():
    n = 400
    df = pd.DataFrame(
        {
            "Open": [100.0] * n,
            "High": [101.0] * n,
            "Low": [99.0] * n,
            "Close": [100.0] * n,
        }
    )
    params = {
        "sma_fast": 50, "sma_slow": 200, "rsi_window": 14,
        "macd_fast": 12, "macd_slow": 26, "macd_signal": 9,
        "atr_window": 14, "momentum_lookback_days": 252,
        "momentum_skip_days": 21, "vol_window": 63, "spark_days": 60,
    }
    f = scorelib.compute_features(df, params)
    assert f["price_usd"] == 100.0
    assert f["mom_12_1"] == 0.0
    assert f["vol_63d_ann"] == 0.0
    # Constant series: vol=0 -> vol_adj_ret undefined.
    assert f["vol_adj_ret"] is None
    # No drift: SMAs equal -> sma_fast not strictly > sma_slow -> trend off.
    assert f["trend_ok"] is False
    assert len(f["spark"]) == 60
