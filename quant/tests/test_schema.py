"""Validate the JSON output schema (using the smoke run output)."""
from __future__ import annotations

import json
from pathlib import Path

from quant.src import data as datalib
from quant.src import main as mainlib

from .test_smoke import _synth  # reuse


def test_schema_keys_and_types(tmp_path: Path, monkeypatch):
    import numpy as np
    import pandas as pd

    fx_index = pd.bdate_range("2024-01-02", periods=400)
    fx = pd.Series(np.linspace(0.92, 0.94, 400), index=fx_index, name="EURUSD=X")
    monkeypatch.setattr(
        datalib,
        "fetch_history",
        lambda tickers, days=400, cache_dir=None: (
            {t: _synth(400, 0.0005 * (i + 1), seed=i + 1) for i, t in enumerate(tickers)},
            [],
        ),
    )
    monkeypatch.setattr(datalib, "fetch_fx", lambda pair="EURUSD=X", days=400: fx)

    cfg = Path(__file__).parent / "fixtures" / "tiny_universe.yml"
    out = tmp_path / "signals.json"
    mainlib.run(cfg, out, cache_dir=None)

    raw = json.loads(out.read_text())
    for key in (
        "generated_at", "fx_eur_usd", "universe_size", "params",
        "tickers", "ranked_buys", "ranked_avoid", "holdings_summary", "errors",
    ):
        assert key in raw, f"missing top-level key: {key}"

    assert isinstance(raw["tickers"], dict) and len(raw["tickers"]) > 0
    for t, v in raw["tickers"].items():
        for k in (
            "name", "sector", "price_usd", "price_eur", "score", "verdict",
            "is_holding", "indicators", "spark",
        ):
            assert k in v, f"{t}: missing field {k}"
        assert 0 <= v["score"] <= 100
        assert v["verdict"] in ("BUY", "WATCH", "AVOID")
        ind = v["indicators"]
        for ik in ("sma50", "sma200", "rsi14", "macd_hist", "mom_12_1", "atr14", "vol_63d_ann", "trend_ok"):
            assert ik in ind, f"{t}: missing indicator {ik}"
