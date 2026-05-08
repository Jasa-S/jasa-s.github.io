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
    """Replace data.fetch_history and fetch_fx with deterministic fakes."""
    fx_index = pd.bdate_range("2024-01-02", periods=400)
    fx = pd.Series(np.linspace(0.92, 0.94, 400), index=fx_index, name="EURUSD=X")

    def fake_fetch_history(tickers, days=400, cache_dir=None):
        out: dict[str, pd.DataFrame] = {}
        for i, t in enumerate(tickers):
            drift = 0.0008 if i % 3 == 0 else (-0.0006 if i % 3 == 1 else 0.0)
            out[t] = _synth(400, drift, seed=hash(t) & 0xFFFF)
        return out, []

    def fake_fetch_fx(pair="EURUSD=X", days=400):
        return fx

    monkeypatch.setattr(datalib, "fetch_history", fake_fetch_history)
    monkeypatch.setattr(datalib, "fetch_fx", fake_fetch_fx)
    # main imports the module, so monkey-patching the module attribute is enough.
    yield


def test_main_run_writes_valid_payload(tmp_path: Path, fake_market):
    cfg = Path(__file__).parent / "fixtures" / "tiny_universe.yml"
    out = tmp_path / "signals.json"
    payload = mainlib.run(cfg, out, cache_dir=None)

    # Schema invariants.
    assert out.exists()
    assert payload["universe_size"] >= 1
    assert "generated_at" in payload
    assert isinstance(payload["tickers"], dict)
    assert isinstance(payload["ranked_buys"], list)
    assert isinstance(payload["ranked_avoid"], list)
    assert isinstance(payload["errors"], list)

    for t, v in payload["tickers"].items():
        assert 0 <= v["score"] <= 100
        assert v["verdict"] in ("BUY", "WATCH", "AVOID")
        if v["is_holding"]:
            assert v["holding_action"] in ("ADD", "HOLD", "TRIM")
        # Sparkline non-empty.
        assert isinstance(v["spark"], list) and len(v["spark"]) > 0

    # Holdings summary covers every holding for which features were computed.
    holdings_in_payload = {h["ticker"] for h in payload["holdings_summary"]}
    assert "GOOG" in holdings_in_payload
