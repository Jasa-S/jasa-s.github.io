"""Data layer: universe loading, yfinance fetch with cache, FX conversion."""
from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import yaml


@dataclass
class Holding:
    ticker: str
    name: str
    sector: str
    cost_basis_eur: float
    units: float


@dataclass
class WatchItem:
    ticker: str
    sector: str


@dataclass
class Universe:
    holdings: list[Holding]
    watchlist: list[WatchItem]
    fx_pair: str
    fx_base: str
    params: dict

    @property
    def all_tickers(self) -> list[str]:
        seen: set[str] = set()
        out: list[str] = []
        for h in self.holdings:
            if h.ticker not in seen:
                out.append(h.ticker)
                seen.add(h.ticker)
        for w in self.watchlist:
            if w.ticker not in seen:
                out.append(w.ticker)
                seen.add(w.ticker)
        return out


def load_universe(path: Path) -> Universe:
    raw = yaml.safe_load(Path(path).read_text())
    holdings = [Holding(**h) for h in raw.get("holdings", [])]
    watchlist = [WatchItem(**w) for w in raw.get("watchlist", [])]
    fx = raw.get("fx") or {}
    return Universe(
        holdings=holdings,
        watchlist=watchlist,
        fx_pair=fx.get("pair", "EURUSD=X"),
        fx_base=fx.get("base", "EUR"),
        params=raw.get("params", {}) or {},
    )


def _cache_path(cache_dir: Path, ticker: str) -> Path:
    safe = ticker.replace("/", "_").replace("=", "_")
    return cache_dir / f"{safe}.parquet"


def _read_cache(p: Path) -> pd.DataFrame | None:
    if not p.exists():
        return None
    try:
        return pd.read_parquet(p)
    except Exception:
        return None


def _write_cache(p: Path, df: pd.DataFrame) -> None:
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        df.to_parquet(p)
    except Exception:
        # Caching is best-effort.
        pass


def _yf_download(tickers: list[str], days: int) -> pd.DataFrame:
    """Single yfinance call with retry/backoff. Returns the multi-column frame."""
    import yfinance as yf  # imported lazily so tests can monkey-patch fetch_history

    end = datetime.now(timezone.utc) + timedelta(days=1)
    start = end - timedelta(days=int(days * 1.6) + 30)
    last_err: Exception | None = None
    for attempt in range(4):
        try:
            df = yf.download(
                tickers=tickers,
                start=start.date().isoformat(),
                end=end.date().isoformat(),
                auto_adjust=True,
                progress=False,
                threads=True,
                group_by="ticker",
            )
            if df is None or df.empty:
                raise RuntimeError("yfinance returned empty frame")
            return df
        except Exception as e:  # network blip, throttling, etc.
            last_err = e
            time.sleep(2 ** attempt)
    raise RuntimeError(f"yfinance download failed after 4 retries: {last_err}")


def fetch_history(
    tickers: list[str], days: int = 400, cache_dir: Path | None = None
) -> tuple[dict[str, pd.DataFrame], list[dict]]:
    """Fetch OHLC for tickers. Returns (frames_by_ticker, errors).

    Each frame has columns Open/High/Low/Close at minimum, indexed by date.
    Failures don't crash the run - they surface in the errors list.
    """
    errors: list[dict] = []
    if not tickers:
        return {}, errors

    raw = _yf_download(tickers, days)
    out: dict[str, pd.DataFrame] = {}
    for t in tickers:
        try:
            if isinstance(raw.columns, pd.MultiIndex):
                if t in raw.columns.levels[0]:
                    df = raw[t].dropna(how="all")
                else:
                    raise KeyError(f"ticker {t} missing from yfinance response")
            else:
                df = raw.dropna(how="all")
            df = df.rename(columns=str.title)
            needed = {"Open", "High", "Low", "Close"}
            if not needed.issubset(df.columns):
                raise KeyError(f"missing OHLC for {t}: have {list(df.columns)}")
            if len(df) < 50:
                raise ValueError(f"too few rows for {t}: {len(df)}")
            out[t] = df[["Open", "High", "Low", "Close"]].copy()
            if cache_dir is not None:
                _write_cache(_cache_path(cache_dir, t), out[t])
        except Exception as e:
            cached = _read_cache(_cache_path(cache_dir, t)) if cache_dir else None
            if cached is not None and len(cached) >= 50:
                out[t] = cached
                errors.append({"ticker": t, "stage": "fetch", "warn": f"using cache: {e}"})
            else:
                errors.append({"ticker": t, "stage": "fetch", "error": str(e)})
    return out, errors


def fetch_fx(pair: str = "EURUSD=X", days: int = 400) -> pd.Series:
    """Daily close for the FX pair (EUR/USD). Returns a Series indexed by date."""
    frames, _ = fetch_history([pair], days=days, cache_dir=None)
    if pair not in frames:
        return pd.Series(dtype=float, name=pair)
    return frames[pair]["Close"].rename(pair)


def to_eur(price_usd: pd.Series, eurusd: pd.Series) -> pd.Series:
    """Convert a USD price series to EUR using EURUSD=X (USD per 1 EUR)."""
    fx = eurusd.reindex(price_usd.index).ffill().bfill()
    safe = fx.replace(0.0, pd.NA)
    return (price_usd / safe).astype(float)
