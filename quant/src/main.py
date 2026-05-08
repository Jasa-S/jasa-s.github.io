"""Orchestrator: fetch -> features -> z-scores -> verdicts -> JSON."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from . import data as datalib
from . import score as scorelib
from . import signal as signallib
from .report import write_json


def run(config_path: Path, out_path: Path, cache_dir: Path | None = None) -> dict:
    universe = datalib.load_universe(config_path)
    params = universe.params
    days = int(params.get("lookback_days", 400))

    tickers = universe.all_tickers
    frames, errors = datalib.fetch_history(tickers, days=days, cache_dir=cache_dir)

    fx_pair = universe.fx_pair
    fx_series = datalib.fetch_fx(fx_pair, days=days)
    fx_rate = float(fx_series.iloc[-1]) if len(fx_series) else float("nan")

    holdings_by_t = {h.ticker: h for h in universe.holdings}
    sectors_by_t = {h.ticker: h.sector for h in universe.holdings}
    for w in universe.watchlist:
        sectors_by_t.setdefault(w.ticker, w.sector)
    names_by_t = {h.ticker: h.name for h in universe.holdings}

    # Pass 1: features per ticker.
    features: dict[str, dict] = {}
    for t, df in frames.items():
        try:
            features[t] = scorelib.compute_features(df, params)
        except Exception as e:
            errors.append({"ticker": t, "stage": "features", "error": str(e)})

    # Cross-sectional z-scores across the whole universe.
    z = scorelib.cross_sectional_z(features)

    # Pass 2: scores, verdicts, holding actions, EUR conversion.
    portfolio_value_eur = 0.0
    holding_eur_values: dict[str, float] = {}
    for h in universe.holdings:
        f = z.get(h.ticker)
        if f is None or "price_usd" not in f:
            continue
        if not np.isfinite(fx_rate) or fx_rate <= 0:
            continue
        price_eur = f["price_usd"] / fx_rate
        value_eur = price_eur * float(h.units)
        holding_eur_values[h.ticker] = value_eur
        portfolio_value_eur += value_eur

    tickers_out: dict[str, dict] = {}
    holdings_summary = []
    for t, f in z.items():
        score = scorelib.composite(f)
        verdict = signallib.classify(score, f.get("rsi"), bool(f.get("trend_ok")))

        is_holding = t in holdings_by_t
        h = holdings_by_t.get(t)
        price_usd = f.get("price_usd")
        price_eur = (
            (price_usd / fx_rate)
            if (price_usd is not None and np.isfinite(fx_rate) and fx_rate > 0)
            else None
        )
        action = None
        drawdown_vs_basis = None
        weight = None
        if is_holding and h is not None and price_eur is not None:
            drawdown_vs_basis = (price_eur - h.cost_basis_eur) / h.cost_basis_eur if h.cost_basis_eur else None
            weight = (
                holding_eur_values.get(t, 0.0) / portfolio_value_eur
                if portfolio_value_eur > 0
                else 0.0
            )
            action = signallib.holding_action(
                score=score,
                rsi=f.get("rsi"),
                trend_ok=bool(f.get("trend_ok")),
                weight=float(weight or 0.0),
                drawdown_vs_basis=float(drawdown_vs_basis or 0.0),
            )
            holdings_summary.append({"ticker": t, "score": score, "action": action})

        tickers_out[t] = {
            "name": names_by_t.get(t, t),
            "sector": sectors_by_t.get(t, ""),
            "price_usd": _round(price_usd, 4),
            "price_eur": _round(price_eur, 4),
            "score": score,
            "verdict": verdict,
            "is_holding": is_holding,
            "holding_action": action,
            "drawdown_vs_basis": _round(drawdown_vs_basis, 4),
            "weight": _round(weight, 4),
            "indicators": {
                "sma50": f.get("sma_fast"),
                "sma200": f.get("sma_slow"),
                "rsi14": f.get("rsi"),
                "macd_hist": f.get("macd_hist"),
                "mom_12_1": f.get("mom_12_1"),
                "atr14": f.get("atr"),
                "vol_63d_ann": f.get("vol_63d_ann"),
                "trend_ok": bool(f.get("trend_ok")),
            },
            "spark": f.get("spark", []),
        }

    ranked = sorted(tickers_out.items(), key=lambda kv: kv[1]["score"], reverse=True)
    ranked_buys = [t for t, v in ranked if v["verdict"] in ("BUY", "WATCH")][:10]
    ranked_avoid = [t for t, v in ranked if v["verdict"] == "AVOID"][:10]

    payload = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "fx_eur_usd": _round(fx_rate, 4),
        "universe_size": len(tickers_out),
        "params": {
            "rsi_window": params.get("rsi_window", 14),
            "sma_fast": params.get("sma_fast", 50),
            "sma_slow": params.get("sma_slow", 200),
            "weights": scorelib.WEIGHTS,
        },
        "tickers": tickers_out,
        "ranked_buys": ranked_buys,
        "ranked_avoid": ranked_avoid,
        "holdings_summary": sorted(holdings_summary, key=lambda x: x["score"], reverse=True),
        "errors": errors,
    }
    write_json(payload, out_path)
    return payload


def _round(v, n: int):
    if v is None:
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(x):
        return None
    return round(x, n)


def _cli() -> None:
    p = argparse.ArgumentParser(description="Run the quant buy-signal model.")
    p.add_argument("--config", type=Path, default=Path("quant/config/universe.yml"))
    p.add_argument("--out", type=Path, default=Path("quant/output/signals.json"))
    p.add_argument("--cache", type=Path, default=Path("quant/cache"))
    args = p.parse_args()
    payload = run(args.config, args.out, cache_dir=args.cache)
    print(
        f"wrote {args.out} (universe={payload['universe_size']}, "
        f"buys={len(payload['ranked_buys'])}, errors={len(payload['errors'])})"
    )


if __name__ == "__main__":
    _cli()
