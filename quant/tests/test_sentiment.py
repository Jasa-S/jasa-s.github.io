"""Tests for the sentiment overlay module."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from quant.src import sentiment


class _FakeTicker:
    def __init__(self, info=None, news=None):
        self.info = info or {}
        self.news = news or []


def test_label_from_compound_thresholds():
    assert sentiment.label_from_compound(0.20) == "POS"
    assert sentiment.label_from_compound(0.15) == "POS"
    assert sentiment.label_from_compound(0.10) == "NEUTRAL"
    assert sentiment.label_from_compound(0.0) == "NEUTRAL"
    assert sentiment.label_from_compound(-0.10) == "NEUTRAL"
    assert sentiment.label_from_compound(-0.15) == "NEG"
    assert sentiment.label_from_compound(-0.50) == "NEG"


def test_analyst_sentiment_returns_none_when_few_analysts():
    fake = _FakeTicker(info={
        "recommendationKey": "buy",
        "numberOfAnalystOpinions": 2,
        "currentPrice": 100, "targetMeanPrice": 120,
    })
    assert sentiment.analyst_sentiment("X", ticker_obj=fake) is None


def test_analyst_sentiment_full_payload():
    fake = _FakeTicker(info={
        "recommendationKey": "buy",
        "numberOfAnalystOpinions": 27,
        "currentPrice": 100, "targetMeanPrice": 118,
    })
    out = sentiment.analyst_sentiment("X", ticker_obj=fake)
    assert out["key"] == "buy"
    assert out["score"] == 1
    assert abs(out["target_upside_pct"] - 0.18) < 1e-6
    assert out["n_analysts"] == 27


def test_analyst_sentiment_handles_missing_target():
    fake = _FakeTicker(info={
        "recommendationKey": "hold",
        "numberOfAnalystOpinions": 5,
        "currentPrice": 100,
    })
    out = sentiment.analyst_sentiment("X", ticker_obj=fake)
    assert out["key"] == "hold"
    assert out["score"] == 0
    assert out["target_upside_pct"] is None


def test_analyst_sentiment_normalizes_strong_buy_variants():
    fake = _FakeTicker(info={
        "recommendationKey": "strong_buy",
        "numberOfAnalystOpinions": 10,
        "currentPrice": 50, "targetMeanPrice": 60,
    })
    out = sentiment.analyst_sentiment("X", ticker_obj=fake)
    assert out["key"] == "strongBuy"
    assert out["score"] == 2


def test_news_sentiment_aggregates_compound():
    now_ts = datetime.now(timezone.utc).timestamp()
    fake = _FakeTicker(news=[
        {"title": "Company posts record profit, beats estimates", "providerPublishTime": now_ts},
        {"title": "Stock surges on excellent guidance", "providerPublishTime": now_ts},
        {"title": "Layoffs announced amid disappointing quarter", "providerPublishTime": now_ts},
    ])
    out = sentiment.news_sentiment("X", ticker_obj=fake)
    assert out is not None
    assert out["n_headlines"] == 3
    # Two strongly positive + one strongly negative -> mean should be positive.
    assert out["compound"] > 0
    assert out["label"] == "POS"


def test_news_sentiment_filters_old_headlines():
    now = datetime.now(timezone.utc)
    fresh = now.timestamp()
    old = (now - timedelta(days=30)).timestamp()
    fake = _FakeTicker(news=[
        {"title": "Strong gains today on great news", "providerPublishTime": fresh},
        {"title": "Layoffs and losses dominated last month", "providerPublishTime": old},
    ])
    out = sentiment.news_sentiment("X", ticker_obj=fake, days=7)
    assert out["n_headlines"] == 1


def test_news_sentiment_handles_v2_content_wrapper():
    now_ts = datetime.now(timezone.utc).timestamp()
    fake = _FakeTicker(news=[
        {"content": {"title": "Outstanding earnings beat",
                     "pubDate": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}},
        {"content": {"title": "Company crushes targets",
                     "pubDate": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}},
    ])
    out = sentiment.news_sentiment("X", ticker_obj=fake)
    assert out is not None
    assert out["n_headlines"] == 2
    assert out["compound"] > 0


def test_news_sentiment_no_headlines_returns_none():
    assert sentiment.news_sentiment("X", ticker_obj=_FakeTicker(news=[])) is None


def test_cached_sentiment_uses_disk_within_ttl(tmp_path: Path):
    now = datetime(2026, 5, 9, 12, 0, tzinfo=timezone.utc)
    cache = {
        "analyst": {"key": "buy", "score": 1, "n_analysts": 10,
                    "target_upside_pct": 0.10,
                    "fetched_at": (now - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ")},
        "news": {"compound": 0.30, "label": "POS", "n_headlines": 4,
                 "fetched_at": (now - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ")},
    }
    (tmp_path / "X.json").write_text(json.dumps(cache))

    calls = {"analyst": 0, "news": 0}
    def afetch(t):
        calls["analyst"] += 1
        return None
    def nfetch(t):
        calls["news"] += 1
        return None

    out = sentiment.cached_sentiment(
        "X", tmp_path, analyst_fetcher=afetch, news_fetcher=nfetch, now=now
    )
    assert calls == {"analyst": 0, "news": 0}
    assert out["analyst"]["key"] == "buy"
    assert out["news"]["label"] == "POS"
    # `fetched_at` should be stripped from the returned payload
    assert "fetched_at" not in out["analyst"]
    assert "fetched_at" not in out["news"]


def test_cached_sentiment_refreshes_after_ttl(tmp_path: Path):
    now = datetime(2026, 5, 9, 12, 0, tzinfo=timezone.utc)
    cache = {
        "analyst": {"key": "buy", "score": 1, "n_analysts": 10,
                    "fetched_at": (now - timedelta(days=8)).strftime("%Y-%m-%dT%H:%M:%SZ")},
        "news": {"compound": 0.0, "label": "NEUTRAL", "n_headlines": 1,
                 "fetched_at": (now - timedelta(days=8)).strftime("%Y-%m-%dT%H:%M:%SZ")},
    }
    (tmp_path / "X.json").write_text(json.dumps(cache))

    def afetch(t):
        return {"key": "strongBuy", "score": 2, "n_analysts": 12, "target_upside_pct": 0.2}
    def nfetch(t):
        return {"compound": 0.5, "label": "POS", "n_headlines": 7}

    out = sentiment.cached_sentiment(
        "X", tmp_path, analyst_fetcher=afetch, news_fetcher=nfetch, now=now
    )
    assert out["analyst"]["key"] == "strongBuy"
    assert out["news"]["compound"] == 0.5
    # Disk was rewritten with fetched_at stamped on the new entries.
    rewritten = json.loads((tmp_path / "X.json").read_text())
    assert "fetched_at" in rewritten["analyst"]
    assert "fetched_at" in rewritten["news"]


def test_cached_sentiment_with_no_cache_dir():
    def afetch(t): return {"key": "hold", "score": 0, "n_analysts": 5, "target_upside_pct": None}
    def nfetch(t): return {"compound": 0.1, "label": "NEUTRAL", "n_headlines": 2}
    out = sentiment.cached_sentiment("X", None, analyst_fetcher=afetch, news_fetcher=nfetch)
    assert out["analyst"]["key"] == "hold"
    assert out["news"]["label"] == "NEUTRAL"
