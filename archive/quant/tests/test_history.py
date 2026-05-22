"""Tests for the daily snapshot archive."""
from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

from quant.src import history


def _payload(date_iso: str, scores: dict[str, int]) -> dict:
    return {
        "model_version": 2,
        "generated_at": date_iso + "T22:35:14Z",
        "regime": "RISK_ON",
        "regime_score": 70,
        "tickers": {
            t: {"score": s, "verdict": "BUY", "holding_action": "HOLD", "indicators": {}}
            for t, s in scores.items()
        },
    }


def test_write_snapshot_creates_slim_file(tmp_path: Path):
    p = history.write_snapshot(tmp_path, _payload("2026-05-08", {"NVDA": 78}))
    assert p.exists()
    assert p.name == "2026-05-08.json"
    data = json.loads(p.read_text())
    assert data["date"] == "2026-05-08"
    assert data["model_version"] == 2
    assert data["regime"] == "RISK_ON"
    assert data["tickers"]["NVDA"] == {"score": 78, "verdict": "BUY", "action": "HOLD"}


def test_write_snapshot_overwrites_same_day(tmp_path: Path):
    history.write_snapshot(tmp_path, _payload("2026-05-08", {"NVDA": 78}))
    history.write_snapshot(tmp_path, _payload("2026-05-08", {"NVDA": 80}))
    data = json.loads((tmp_path / "2026-05-08.json").read_text())
    assert data["tickers"]["NVDA"]["score"] == 80


def test_load_recent_returns_oldest_first(tmp_path: Path):
    for d, score in [("2026-05-06", 70), ("2026-05-07", 72), ("2026-05-08", 75)]:
        history.write_snapshot(tmp_path, _payload(d, {"NVDA": score}))
    snaps = history.load_recent(tmp_path, days=10)
    assert [s["date"] for s in snaps] == ["2026-05-06", "2026-05-07", "2026-05-08"]


def test_load_recent_caps_at_days(tmp_path: Path):
    for d in ["2026-05-04", "2026-05-05", "2026-05-06", "2026-05-07", "2026-05-08"]:
        history.write_snapshot(tmp_path, _payload(d, {"NVDA": 70}))
    snaps = history.load_recent(tmp_path, days=2)
    assert [s["date"] for s in snaps] == ["2026-05-07", "2026-05-08"]


def test_load_recent_empty_dir(tmp_path: Path):
    assert history.load_recent(tmp_path / "nope") == []


def test_prune_old_deletes_only_old_files(tmp_path: Path):
    today = date.today()
    fresh = (today - timedelta(days=10)).isoformat()
    stale = (today - timedelta(days=200)).isoformat()
    history.write_snapshot(tmp_path, _payload(fresh, {"NVDA": 70}))
    history.write_snapshot(tmp_path, _payload(stale, {"NVDA": 60}))
    removed = history.prune_old(tmp_path, keep_days=120)
    assert removed == 1
    remaining = sorted(p.name for p in tmp_path.iterdir())
    assert remaining == [f"{fresh}.json"]


def test_find_prior_picks_most_recent_before_today(tmp_path: Path):
    snaps = [
        _payload("2026-05-06", {"NVDA": 70}),
        _payload("2026-05-07", {"NVDA": 72}),
        _payload("2026-05-08", {"NVDA": 75}),
    ]
    snaps = [{"date": s["generated_at"][:10], "tickers": s["tickers"]} for s in snaps]
    prior = history.find_prior(snaps, "2026-05-08")
    assert prior["date"] == "2026-05-07"


def test_find_prior_returns_none_when_no_earlier(tmp_path: Path):
    snaps = [{"date": "2026-05-08", "tickers": {}}]
    assert history.find_prior(snaps, "2026-05-08") is None


def test_find_n_days_ago(tmp_path: Path):
    snaps = [
        {"date": "2026-05-01", "tickers": {}},
        {"date": "2026-05-03", "tickers": {}},
        {"date": "2026-05-07", "tickers": {}},
    ]
    # 5 days before 2026-05-08 = 2026-05-03; pick that one (or earlier).
    snap = history.find_n_days_ago(snaps, "2026-05-08", 5)
    assert snap["date"] == "2026-05-03"


def test_ignores_non_date_files(tmp_path: Path):
    history.write_snapshot(tmp_path, _payload("2026-05-08", {"NVDA": 70}))
    (tmp_path / "README.md").write_text("hi")
    (tmp_path / "garbage.json").write_text("{}")
    snaps = history.load_recent(tmp_path)
    assert len(snaps) == 1
