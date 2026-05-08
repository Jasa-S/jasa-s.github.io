"""Feature extraction, cross-sectional z-scores, composite score."""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from . import indicators as ind

FEATURE_KEYS = ("mom_12_1", "vol_adj_ret", "rs_6m", "macd_pos", "rsi_norm")
WEIGHTS = {
    "z_mom_12_1": 0.30,
    "z_vol_adj_ret": 0.25,
    "trend_centered": 0.20,
    "z_rs_6m": 0.15,
    "z_macd_pos": 0.05,
    "z_rsi_norm": 0.05,
}


def compute_features(df: pd.DataFrame, params: dict, bench_close: pd.Series | None = None) -> dict:
    """Last-row indicator snapshot for one ticker."""
    close = df["Close"]
    high = df["High"]
    low = df["Low"]

    sma_fast = ind.sma(close, params.get("sma_fast", 50))
    sma_slow = ind.sma(close, params.get("sma_slow", 200))
    rsi_series = ind.rsi(close, params.get("rsi_window", 14))
    macd_line, macd_sig, macd_hist = ind.macd(
        close,
        params.get("macd_fast", 12),
        params.get("macd_slow", 26),
        params.get("macd_signal", 9),
    )
    atr_series = ind.atr(high, low, close, params.get("atr_window", 14))
    mom = ind.momentum_12_1(
        close,
        params.get("momentum_lookback_days", 252),
        params.get("momentum_skip_days", 21),
    )
    vol = ind.realized_vol(close, params.get("vol_window", 63))
    donchian_n = int(params.get("donchian_window", 20))
    donchian_hi = ind.donchian_high(close, donchian_n)
    rs_6m = float("nan")
    if bench_close is not None and len(bench_close) > 0:
        rs_6m = ind.relative_strength(close, bench_close, int(params.get("rs_window", 126)))

    p_last = float(close.iloc[-1])
    sma_f_last = _safe_last(sma_fast)
    sma_s_last = _safe_last(sma_slow)
    rsi_last = _safe_last(rsi_series)
    macd_hist_last = _safe_last(macd_hist)
    atr_last = _safe_last(atr_series)

    trend_ok = bool(
        np.isfinite(sma_f_last)
        and np.isfinite(sma_s_last)
        and p_last > sma_s_last
        and sma_f_last > sma_s_last
    )

    macd_pos = float("nan")
    if np.isfinite(macd_hist_last) and p_last > 0:
        macd_pos = math.copysign(1.0, macd_hist_last) * min(abs(macd_hist_last) / p_last * 100.0, 1.0)

    rsi_norm = float("nan")
    if np.isfinite(rsi_last):
        rsi_norm = max(-1.0, min(1.0, (rsi_last - 50.0) / 20.0))

    vol_adj_ret = float("nan")
    if np.isfinite(mom) and np.isfinite(vol) and vol > 0:
        vol_adj_ret = mom / vol  # already annualized denominator

    spark_n = int(params.get("spark_days", 60))
    spark = [round(float(x), 4) for x in close.tail(spark_n).tolist() if np.isfinite(x)]

    breakout_20d = bool(np.isfinite(donchian_hi) and p_last >= donchian_hi)
    near_sma_fast = bool(
        np.isfinite(sma_f_last) and np.isfinite(atr_last)
        and abs(p_last - sma_f_last) <= atr_last
    )

    return {
        "price_usd": p_last,
        "sma_fast": _round(sma_f_last, 4),
        "sma_slow": _round(sma_s_last, 4),
        "rsi": _round(rsi_last, 2),
        "macd_hist": _round(macd_hist_last, 4),
        "atr": _round(atr_last, 4),
        "mom_12_1": _round(mom, 4),
        "vol_63d_ann": _round(vol, 4),
        "vol_adj_ret": _round(vol_adj_ret, 4),
        "rs_6m": _round(rs_6m, 4),
        "macd_pos": _round(macd_pos, 4),
        "rsi_norm": _round(rsi_norm, 4),
        "donchian_high_20": _round(donchian_hi, 4),
        "breakout_20d": breakout_20d,
        "near_sma_fast": near_sma_fast,
        "trend_ok": trend_ok,
        "spark": spark,
    }


def cross_sectional_z(
    features_by_ticker: dict[str, dict], keys: tuple[str, ...] = FEATURE_KEYS
) -> dict[str, dict]:
    """Add z_<key> entries to each ticker's feature dict."""
    out = {t: dict(f) for t, f in features_by_ticker.items()}
    for k in keys:
        vals = pd.Series(
            {t: f.get(k) for t, f in out.items() if _isfinite(f.get(k))}, dtype=float
        )
        if len(vals) >= 2 and vals.std(ddof=0) > 0:
            mu = vals.mean()
            sd = vals.std(ddof=0)
            for t in out:
                v = out[t].get(k)
                out[t][f"z_{k}"] = float((v - mu) / sd) if _isfinite(v) else 0.0
        else:
            for t in out:
                out[t][f"z_{k}"] = 0.0
    return out


def composite(features: dict) -> int:
    """Map z-features + trend to a 0-100 score."""
    trend = 1.0 if features.get("trend_ok") else 0.0
    trend_centered = (trend - 0.5) * 2.0  # in {-1, +1}
    raw = (
        WEIGHTS["z_mom_12_1"] * _f(features.get("z_mom_12_1"))
        + WEIGHTS["z_vol_adj_ret"] * _f(features.get("z_vol_adj_ret"))
        + WEIGHTS["trend_centered"] * trend_centered
        + WEIGHTS["z_rs_6m"] * _f(features.get("z_rs_6m"))
        + WEIGHTS["z_macd_pos"] * _f(features.get("z_macd_pos"))
        + WEIGHTS["z_rsi_norm"] * _f(features.get("z_rsi_norm"))
    )
    raw = max(-4.0, min(4.0, raw))
    return int(round(50.0 + 12.5 * raw))


def _isfinite(v) -> bool:
    try:
        return v is not None and np.isfinite(float(v))
    except (TypeError, ValueError):
        return False


def _f(v) -> float:
    return float(v) if _isfinite(v) else 0.0


def _safe_last(s: pd.Series) -> float:
    if s is None or len(s) == 0:
        return float("nan")
    v = s.iloc[-1]
    return float(v) if pd.notna(v) else float("nan")


def _round(v, n: int):
    if not _isfinite(v):
        return None
    return round(float(v), n)
