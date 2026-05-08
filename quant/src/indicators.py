"""Pure technical indicators on pandas Series. No I/O, no side effects."""
from __future__ import annotations

import numpy as np
import pandas as pd


def sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n, min_periods=n).mean()


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False, min_periods=n).mean()


def rsi(s: pd.Series, n: int = 14) -> pd.Series:
    """Wilder's RSI. Returns 100 on pure uptrend, 0 on pure downtrend."""
    delta = s.diff()
    gain = delta.clip(lower=0.0)
    loss = -delta.clip(upper=0.0)
    avg_gain = gain.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    avg_loss = loss.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    safe_loss = avg_loss.where(avg_loss > 0, np.nan)
    rs = avg_gain / safe_loss
    out = 100.0 - (100.0 / (1.0 + rs))
    # avg_loss == 0 -> pure uptrend -> 100; avg_gain == 0 -> pure downtrend -> 0.
    pure_up = (avg_loss == 0) & (avg_gain > 0) & avg_loss.notna()
    pure_down = (avg_gain == 0) & (avg_loss > 0) & avg_gain.notna()
    out = out.mask(pure_up, 100.0).mask(pure_down, 0.0)
    return out


def macd(
    s: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9
) -> tuple[pd.Series, pd.Series, pd.Series]:
    line = ema(s, fast) - ema(s, slow)
    sig = line.ewm(span=signal, adjust=False, min_periods=signal).mean()
    hist = line - sig
    return line, sig, hist


def atr(high: pd.Series, low: pd.Series, close: pd.Series, n: int = 14) -> pd.Series:
    prev_close = close.shift(1)
    tr = pd.concat(
        [(high - low).abs(), (high - prev_close).abs(), (low - prev_close).abs()], axis=1
    ).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()


def momentum_12_1(s: pd.Series, lookback: int = 252, skip: int = 21) -> float:
    """12-1 month momentum: return from t-(lookback+skip) to t-skip."""
    if len(s) < lookback + skip + 1:
        return float("nan")
    p_now = s.iloc[-skip - 1]
    p_then = s.iloc[-skip - 1 - lookback]
    if not np.isfinite(p_now) or not np.isfinite(p_then) or p_then == 0:
        return float("nan")
    return float(p_now / p_then - 1.0)


def realized_vol(s: pd.Series, n: int = 63) -> float:
    """Annualized stdev of daily log returns over the last n observations."""
    if len(s) < n + 1:
        return float("nan")
    rets = np.log(s / s.shift(1)).dropna().iloc[-n:]
    if len(rets) < n:
        return float("nan")
    return float(rets.std(ddof=1) * np.sqrt(252))
