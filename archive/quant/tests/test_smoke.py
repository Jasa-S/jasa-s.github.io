"""End-to-end smoke test with synthetic data (no network)."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from quant.src import data as datalib
from quant.src import main as mainlib


def _synth(n: int, drift: float, seed: int) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    rets = rng.normal(drift, 0.015, n)
    prices = 100.0 * np.exp(np.cumsum(rets))
    return pd.DataFrame(
        {
            "Open": prices * 0.999,
            "High": prices * 1.01,
            "Low": prices * 0.99,
            "Close": prices,
        },
        index=pd.bdate_range("2024-01-02", periods=n),
    )


@pytest.fixture
def fake_market(monkeypatch):
    """Replace data.fetch_history, fetch_fx, fetch_next_earnings with fakes."""
    fx_index = pd.bdate_range("2024-01-02", periods=400)
    fx = pd.Series(np.linspace(0.92, 0.94, 400), index=fx_index, name="EURUSD=X")

    def fake_fetch_history(tickers, days=400, cache_dir=None):
        out: dict[str, pd.DataFrame] = {}
        for i, t in enumerate(tickers):
            # Make SPY a steady uptrend so regime is clearly ON.
            if t == "SPY":
                out[t] = _synth(400, 0.0006, seed=42)
                continue
            drift = 0.0008 if i % 3 == 0 else (-0.0006 if i % 3 == 1 else 0.0)
            out[t] = _synth(400, drift, seed=hash(t) & 0xFFFF)
        return out, []

    def fake_fetch_fx(pair="EURUSD=X", days=400):
        return fx

    def fake_fetch_next_earnings(ticker):
        # No earnings dates in tests by default; the gate stays off.
        return None

    monkeypatch.setattr(datalib, "fetch_history", fake_fetch_history)
    monkeypatch.setattr(datalib, "fetch_fx", fake_fetch_fx)
    monkeypatch.setattr(datalib, "fetch_next_earnings", fake_fetch_next_earnings)
    yield


def test_main_run_writes_valid_payload(tmp_path: Path, fake_market):
    cfg = Path(__file__).parent / "fixtures" / "tiny_universe.yml"
    out = tmp_path / "signals.json"
    payload = mainlib.run(cfg, out, cache_dir=None)

    # Schema invariants.
    assert out.exists()
    assert payload["universe_size"] >= 1
    assert payload["model_version"] >= 2
    assert payload["regime"] in ("RISK_ON", "RISK_OFF")
    assert "generated_at" in payload
    assert isinstance(payload["tickers"], dict)
    assert isinstance(payload["ranked_buys"], list)
    assert isinstance(payload["ranked_avoid"], list)
    assert isinstance(payload["errors"], list)
    # Benchmark is excluded from the scored universe.
    assert "SPY" not in payload["tickers"]
    assert isinstance(payload["benchmark_spark"], list) and len(payload["benchmark_spark"]) > 0

    for t, v in payload["tickers"].items():
        assert 0 <= v["score"] <= 100
        assert v["verdict"] in ("BUY", "WATCH", "AVOID")
        assert "is_pullback" in v
        if v["is_holding"]:
            assert v["holding_action"] in ("ADD", "HOLD", "TRIM")
        # Sparkline non-empty.
        assert isinstance(v["spark"], list) and len(v["spark"]) > 0

    # Holdings summary covers every holding for which features were computed.
    holdings_in_payload = {h["ticker"] for h in payload["holdings_summary"]}
    assert "GOOG" in holdings_in_payload

    # Portfolio P&L summary present.
    p = payload["portfolio"]
    assert p["value_eur"] is not None
    assert p["cost_eur"] is not None
    assert isinstance(p["by_holding"], list) and len(p["by_holding"]) > 0


def test_regime_off_downgrades_buys(tmp_path: Path, monkeypatch):
    """When SPY is in a downtrend, BUY verdicts should be downgraded to WATCH."""
    fx_index = pd.bdate_range("2024-01-02", periods=400)
    fx = pd.Series(np.linspace(0.92, 0.94, 400), index=fx_index, name="EURUSD=X")

    def fake_fetch_history(tickers, days=400, cache_dir=None):
        out = {}
        for t in tickers:
            if t == "SPY":
                out[t] = _synth(400, -0.001, seed=99)  # firm downtrend
            else:
                # All other names rip upward so they would normally score BUY.
                out[t] = _synth(400, 0.002, seed=hash(t) & 0xFFFF)
        return out, []

    monkeypatch.setattr(datalib, "fetch_history", fake_fetch_history)
    monkeypatch.setattr(datalib, "fetch_fx", lambda pair="EURUSD=X", days=400: fx)
    monkeypatch.setattr(datalib, "fetch_next_earnings", lambda t: None)

    cfg = Path(__file__).parent / "fixtures" / "tiny_universe.yml"
    payload = mainlib.run(cfg, tmp_path / "signals.json", cache_dir=None)

    assert payload["regime"] == "RISK_OFF"
    # No ticker should carry a BUY verdict in RISK_OFF mode.
    verdicts = [v["verdict"] for v in payload["tickers"].values()]
    assert "BUY" not in verdicts
    # And no holding should be told to ADD.
    actions = [h["action"] for h in payload["holdings_summary"]]
    assert "ADD" not in actions
