"""Validate the JSON output against the JSON schema."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from jsonschema import validate

from quant.src import data as datalib
from quant.src import main as mainlib

from .test_smoke import _synth


@pytest.fixture
def smoke_payload(tmp_path: Path, monkeypatch):
    fx_index = pd.bdate_range("2024-01-02", periods=400)
    fx = pd.Series(np.linspace(0.92, 0.94, 400), index=fx_index, name="EURUSD=X")

    def fake_fh(tickers, days=400, cache_dir=None):
        out = {}
        for i, t in enumerate(tickers):
            drift = 0.0006 if t == "SPY" else 0.0005 * (i + 1)
            out[t] = _synth(400, drift, seed=i + 1)
        return out, []

    monkeypatch.setattr(datalib, "fetch_history", fake_fh)
    monkeypatch.setattr(datalib, "fetch_fx", lambda pair="EURUSD=X", days=400: fx)
    monkeypatch.setattr(datalib, "fetch_next_earnings", lambda t: None)

    cfg = Path(__file__).parent / "fixtures" / "tiny_universe.yml"
    out = tmp_path / "signals.json"
    return mainlib.run(cfg, out, cache_dir=None), out


def test_payload_matches_schema(smoke_payload):
    payload, path = smoke_payload
    schema = json.loads((Path(__file__).parent.parent / "schema" / "signals.schema.json").read_text())
    validate(payload, schema)


def test_payload_required_fields_present(smoke_payload):
    payload, _ = smoke_payload
    for key in (
        "model_version", "generated_at", "regime", "regime_score",
        "benchmark", "benchmark_spark", "portfolio", "sector_concentration",
        "tickers", "ranked_buys", "ranked_avoid", "holdings_summary", "errors",
    ):
        assert key in payload, f"missing top-level key: {key}"

    for t, v in payload["tickers"].items():
        for k in (
            "name", "sector", "score", "verdict", "is_holding",
            "is_pullback", "indicators", "spark",
        ):
            assert k in v, f"{t}: missing field {k}"
        assert 0 <= v["score"] <= 100
        assert v["verdict"] in ("BUY", "WATCH", "AVOID")
        ind = v["indicators"]
        for ik in ("rsi14", "trend_ok", "rs_6m", "donchian_high_20", "breakout_20d"):
            assert ik in ind, f"{t}: missing indicator {ik}"
