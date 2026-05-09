"""Display-only sentiment overlays: analyst consensus + news headline tone.

Both halves are best-effort: any failure returns None and the caller is
expected to log to errors[]. Nothing here feeds into composite scoring.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

_ANALYZER = SentimentIntensityAnalyzer()

ANALYST_KEY_TO_SCORE = {
    "strongbuy": 2,
    "buy": 1,
    "hold": 0,
    "sell": -1,
    "strongsell": -2,
    # yfinance occasionally returns these variants:
    "strong_buy": 2,
    "strong_sell": -2,
    "underperform": -1,
    "outperform": 1,
}

_VALID_KEYS = {"strongBuy", "buy", "hold", "sell", "strongSell"}
_KEY_NORMALIZE = {
    "strongbuy": "strongBuy",
    "strong_buy": "strongBuy",
    "buy": "buy",
    "outperform": "buy",
    "hold": "hold",
    "neutral": "hold",
    "sell": "sell",
    "underperform": "sell",
    "strongsell": "strongSell",
    "strong_sell": "strongSell",
}


def label_from_compound(c: float) -> str:
    """Map VADER compound score to a coarse label."""
    if c is None:
        return "NEUTRAL"
    if c >= 0.15:
        return "POS"
    if c <= -0.15:
        return "NEG"
    return "NEUTRAL"


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def analyst_sentiment(ticker: str, *, ticker_obj=None) -> dict | None:
    """Return analyst consensus snapshot from yfinance Ticker.info, or None.

    None when analyst coverage is too sparse (< 3 analysts) or any field is
    missing / yfinance throws.
    """
    try:
        if ticker_obj is None:
            import yfinance as yf  # local import to keep tests light
            ticker_obj = yf.Ticker(ticker)
        info = getattr(ticker_obj, "info", None) or {}
        n = int(info.get("numberOfAnalystOpinions") or 0)
        if n < 3:
            return None
        raw_key = (info.get("recommendationKey") or "").strip().lower()
        key = _KEY_NORMALIZE.get(raw_key)
        if key not in _VALID_KEYS:
            return None
        score = ANALYST_KEY_TO_SCORE.get(raw_key, 0)
        target = info.get("targetMeanPrice")
        spot = info.get("currentPrice") or info.get("regularMarketPrice")
        upside = None
        try:
            if target is not None and spot is not None and float(spot) > 0:
                upside = round((float(target) - float(spot)) / float(spot), 4)
        except (TypeError, ValueError):
            upside = None
        return {
            "key": key,
            "score": score,
            "target_upside_pct": upside,
            "n_analysts": n,
            "as_of": _now_iso(),
        }
    except Exception:
        return None


def news_sentiment(ticker: str, *, ticker_obj=None, days: int = 7) -> dict | None:
    """Return aggregate VADER compound for the last `days` of headlines."""
    try:
        if ticker_obj is None:
            import yfinance as yf
            ticker_obj = yf.Ticker(ticker)
        items = list(getattr(ticker_obj, "news", None) or [])
        cutoff_ts = (datetime.now(timezone.utc) - timedelta(days=days)).timestamp()
        scores = []
        for it in items:
            title = _extract_title(it)
            ts = _extract_ts(it)
            if not title:
                continue
            if ts is not None and ts < cutoff_ts:
                continue
            scores.append(_ANALYZER.polarity_scores(title)["compound"])
        if not scores:
            return None
        compound = round(sum(scores) / len(scores), 4)
        return {
            "compound": compound,
            "label": label_from_compound(compound),
            "n_headlines": len(scores),
            "as_of": _now_iso(),
        }
    except Exception:
        return None


def _extract_title(item: dict) -> str | None:
    """yfinance v0.2.40+ wraps each item in a `content` dict; older was flat."""
    if not isinstance(item, dict):
        return None
    if isinstance(item.get("title"), str):
        return item["title"]
    content = item.get("content") if isinstance(item.get("content"), dict) else None
    if content and isinstance(content.get("title"), str):
        return content["title"]
    return None


def _extract_ts(item: dict) -> float | None:
    if not isinstance(item, dict):
        return None
    if isinstance(item.get("providerPublishTime"), (int, float)):
        return float(item["providerPublishTime"])
    content = item.get("content") if isinstance(item.get("content"), dict) else None
    if content:
        for k in ("pubDate", "displayTime"):
            v = content.get(k)
            if isinstance(v, str):
                try:
                    return datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp()
                except ValueError:
                    continue
    return None


def cached_sentiment(
    ticker: str,
    cache_dir: Path | None,
    *,
    analyst_ttl: timedelta = timedelta(days=7),
    news_ttl: timedelta = timedelta(hours=24),
    analyst_fetcher=analyst_sentiment,
    news_fetcher=news_sentiment,
    now: datetime | None = None,
) -> dict:
    """Return {analyst, news}, refreshing only the stale half from disk."""
    now = now or datetime.now(timezone.utc)
    disk = _read_cache(cache_dir, ticker)
    out_analyst = disk.get("analyst") if _is_fresh(disk.get("analyst"), now, analyst_ttl) else None
    out_news = disk.get("news") if _is_fresh(disk.get("news"), now, news_ttl) else None

    if out_analyst is None:
        fresh = analyst_fetcher(ticker)
        if fresh is not None:
            fresh["fetched_at"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
        out_analyst = fresh

    if out_news is None:
        fresh = news_fetcher(ticker)
        if fresh is not None:
            fresh["fetched_at"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
        out_news = fresh

    _write_cache(cache_dir, ticker, {"analyst": out_analyst, "news": out_news})
    # Strip cache-only field before returning to the payload.
    return {
        "analyst": _strip(out_analyst, "fetched_at"),
        "news": _strip(out_news, "fetched_at"),
    }


def _is_fresh(entry: dict | None, now: datetime, ttl: timedelta) -> bool:
    if not entry:
        return False
    fetched = entry.get("fetched_at")
    if not isinstance(fetched, str):
        return False
    try:
        ts = datetime.fromisoformat(fetched.replace("Z", "+00:00"))
    except ValueError:
        return False
    return (now - ts) < ttl


def _read_cache(cache_dir: Path | None, ticker: str) -> dict:
    if cache_dir is None:
        return {}
    path = cache_dir / f"{ticker}.json"
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def _write_cache(cache_dir: Path | None, ticker: str, data: dict) -> None:
    if cache_dir is None:
        return
    try:
        cache_dir.mkdir(parents=True, exist_ok=True)
        (cache_dir / f"{ticker}.json").write_text(json.dumps(data, indent=2, sort_keys=True))
    except OSError:
        pass


def _strip(entry: dict | None, key: str) -> dict | None:
    if not entry:
        return None
    out = {k: v for k, v in entry.items() if k != key}
    return out
