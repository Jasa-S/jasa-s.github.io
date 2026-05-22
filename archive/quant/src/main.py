"""Orchestrator: fetch -> features -> z-scores -> verdicts -> JSON."""
from __future__ import annotations

import argparse
from datetime import date, datetime, timezone
from pathlib import Path

import numpy as np

from . import data as datalib
from . import history as historylib
from . import score as scorelib
from . import sentiment as sentilib
from . import signal as signallib
from . import sizing as sizinglib
from .report import write_json

MODEL_VERSION = 2


def run(config_path: Path, out_path: Path, cache_dir: Path | None = None) -> dict:
    universe = datalib.load_universe(config_path)
    params = universe.params
    risk = universe.risk
    days = int(params.get("lookback_days", 400))
    earnings_block = int(risk.get("earnings_block_days", 3))
    sector_warn = float(risk.get("sector_warn_pct", 0.40))

    tickers = list(universe.all_tickers)
    benchmark = universe.benchmark or "SPY"
    fetch_list = tickers + ([benchmark] if benchmark not in tickers else [])
    frames, errors = datalib.fetch_history(fetch_list, days=days, cache_dir=cache_dir)

    fx_pair = universe.fx_pair
    fx_series = datalib.fetch_fx(fx_pair, days=days)
    fx_rate = float(fx_series.iloc[-1]) if len(fx_series) else float("nan")

    bench_df = frames.get(benchmark)
    bench_close = bench_df["Close"] if bench_df is not None else None

    # Market-regime gate from the benchmark itself.
    regime_on = True
    regime_score = None
    if bench_close is not None and len(bench_close):
        bench_features = scorelib.compute_features(bench_df, params, bench_close=bench_close)
        regime_on = bool(bench_features.get("trend_ok"))
        # Regime score = benchmark composite using its own features (reasonable proxy).
        bench_z = scorelib.cross_sectional_z({benchmark: bench_features})
        regime_score = scorelib.composite(bench_z[benchmark])

    holdings_by_t = {h.ticker: h for h in universe.holdings}
    sectors_by_t = {h.ticker: h.sector for h in universe.holdings}
    for w in universe.watchlist:
        sectors_by_t.setdefault(w.ticker, w.sector)
    names_by_t = {h.ticker: h.name for h in universe.holdings}

    # Pass 1: features per ticker (skip benchmark from the scored universe).
    features: dict[str, dict] = {}
    for t in tickers:
        df = frames.get(t)
        if df is None:
            continue
        try:
            features[t] = scorelib.compute_features(df, params, bench_close=bench_close)
        except Exception as e:
            errors.append({"ticker": t, "stage": "features", "error": str(e)})

    z = scorelib.cross_sectional_z(features)

    # Earnings dates for holdings only (rate-friendly).
    earnings_by_t: dict[str, str | None] = {}
    today = date.today()
    for t in holdings_by_t:
        try:
            earnings_by_t[t] = datalib.fetch_next_earnings(t)
        except Exception as e:
            errors.append({"ticker": t, "stage": "earnings", "warn": str(e)})
            earnings_by_t[t] = None

    # Pass 2: holdings P&L summary in EUR.
    holdings_value_eur: dict[str, float] = {}
    holdings_cost_eur: dict[str, float] = {}
    portfolio_value_eur = 0.0
    portfolio_cost_eur = 0.0
    for h in universe.holdings:
        f = z.get(h.ticker)
        if f is None or "price_usd" not in f:
            continue
        if not np.isfinite(fx_rate) or fx_rate <= 0:
            continue
        price_eur = f["price_usd"] / fx_rate
        value_eur = price_eur * float(h.units)
        cost_eur = float(h.cost_basis_eur) * float(h.units)
        holdings_value_eur[h.ticker] = value_eur
        holdings_cost_eur[h.ticker] = cost_eur
        portfolio_value_eur += value_eur
        portfolio_cost_eur += cost_eur

    # Pass 3: per-ticker output, verdicts, actions, sizing, stops.
    tickers_out: dict[str, dict] = {}
    holdings_summary = []
    sector_value_eur: dict[str, float] = {}
    bench_spark = []
    if bench_close is not None and len(bench_close):
        spark_n = int(params.get("spark_days", 60))
        bench_spark = [round(float(x), 4) for x in bench_close.tail(spark_n).tolist() if np.isfinite(x)]

    # Load prior daily snapshots for day-over-day deltas and verdict transitions.
    hist_dir = out_path.parent / "history"
    history_recent = historylib.load_recent(hist_dir, days=10)
    today_iso = today.isoformat()
    prior_1d = historylib.find_prior(history_recent, today_iso) or {}
    prior_5d = historylib.find_n_days_ago(history_recent, today_iso, 5) or {}
    prior_1d_t = prior_1d.get("tickers", {}) if prior_1d else {}
    prior_5d_t = prior_5d.get("tickers", {}) if prior_5d else {}

    for t, f in z.items():
        score = scorelib.composite(f)
        e_iso = earnings_by_t.get(t)
        e_in_days = _days_until(e_iso, today)
        verdict = signallib.classify(
            score=score,
            rsi=f.get("rsi"),
            trend_ok=bool(f.get("trend_ok")),
            regime_on=regime_on,
            earnings_in_days=e_in_days,
            earnings_block_days=earnings_block,
        )
        is_pullback = signallib.pullback_buy(f, params)

        is_holding = t in holdings_by_t
        h = holdings_by_t.get(t)
        price_usd = f.get("price_usd")
        price_eur = (
            (price_usd / fx_rate)
            if (price_usd is not None and np.isfinite(fx_rate) and fx_rate > 0)
            else None
        )
        atr_eur = None
        if f.get("atr") is not None and np.isfinite(fx_rate) and fx_rate > 0:
            atr_eur = float(f["atr"]) / fx_rate

        action = None
        drawdown_vs_basis = None
        weight = None
        suggested_add_eur = None
        stop_loss_eur = None
        if is_holding and h is not None and price_eur is not None:
            drawdown_vs_basis = (price_eur - h.cost_basis_eur) / h.cost_basis_eur if h.cost_basis_eur else None
            weight = (
                holdings_value_eur.get(t, 0.0) / portfolio_value_eur
                if portfolio_value_eur > 0
                else 0.0
            )
            action = signallib.holding_action(
                score=score,
                rsi=f.get("rsi"),
                trend_ok=bool(f.get("trend_ok")),
                weight=float(weight or 0.0),
                drawdown_vs_basis=float(drawdown_vs_basis or 0.0),
                regime_on=regime_on,
                earnings_in_days=e_in_days,
                earnings_block_days=earnings_block,
            )
            holdings_summary.append({"ticker": t, "score": score, "action": action})
            sector_value_eur[h.sector] = sector_value_eur.get(h.sector, 0.0) + holdings_value_eur.get(t, 0.0)
            if atr_eur is not None and price_eur is not None:
                stop_loss_eur = sizinglib.stop_eur(
                    price_eur=price_eur,
                    atr_eur=atr_eur,
                    cost_basis_eur=h.cost_basis_eur,
                    stop_mult=float(risk.get("stop_mult", 2.0)),
                    hard_stop_pct=float(risk.get("hard_stop_pct", 0.85)),
                )
            if action == "ADD" and atr_eur is not None and price_eur is not None and portfolio_value_eur > 0:
                suggested_add_eur = sizinglib.add_size_eur(
                    portfolio_eur=portfolio_value_eur,
                    price_eur=price_eur,
                    atr_eur=atr_eur,
                    risk_per_trade=float(risk.get("per_trade", 0.01)),
                    stop_mult=float(risk.get("stop_mult", 2.0)),
                    max_position_pct=float(risk.get("max_position_pct", 0.30)),
                )

        prev_1d = prior_1d_t.get(t) or {}
        prev_5d = prior_5d_t.get(t) or {}
        prev_score_1d = prev_1d.get("score")
        prev_score_5d = prev_5d.get("score")
        score_delta_1d = (score - prev_score_1d) if isinstance(prev_score_1d, int) else None
        score_delta_5d = (score - prev_score_5d) if isinstance(prev_score_5d, int) else None

        tickers_out[t] = {
            "name": names_by_t.get(t, t),
            "sector": sectors_by_t.get(t, ""),
            "price_usd": _round(price_usd, 4),
            "price_eur": _round(price_eur, 4),
            "score": score,
            "verdict": verdict,
            "is_holding": is_holding,
            "is_pullback": bool(is_pullback),
            "next_earnings": e_iso,
            "next_earnings_in_days": e_in_days,
            "holding_action": action,
            "drawdown_vs_basis": _round(drawdown_vs_basis, 4),
            "weight": _round(weight, 4),
            "suggested_add_eur": _round(suggested_add_eur, 2),
            "stop_loss_eur": _round(stop_loss_eur, 4),
            "score_delta_1d": score_delta_1d,
            "score_delta_5d": score_delta_5d,
            "prior_verdict": prev_1d.get("verdict"),
            "prior_action": prev_1d.get("action"),
            "factor_contributions": scorelib.factor_contributions(f),
            "indicators": {
                "sma50": f.get("sma_fast"),
                "sma200": f.get("sma_slow"),
                "rsi14": f.get("rsi"),
                "macd_hist": f.get("macd_hist"),
                "mom_12_1": f.get("mom_12_1"),
                "rs_6m": f.get("rs_6m"),
                "atr14": f.get("atr"),
                "vol_63d_ann": f.get("vol_63d_ann"),
                "donchian_high_20": f.get("donchian_high_20"),
                "breakout_20d": bool(f.get("breakout_20d")),
                "near_sma_fast": bool(f.get("near_sma_fast")),
                "trend_ok": bool(f.get("trend_ok")),
            },
            "spark": f.get("spark", []),
        }

    # Sentiment overlay (display-only): analyst consensus + VADER news tone.
    sentiment_cache = (cache_dir / "sentiment") if cache_dir else None
    for t in tickers_out:
        try:
            tickers_out[t]["sentiment"] = sentilib.cached_sentiment(t, sentiment_cache)
        except Exception as e:
            errors.append({"ticker": t, "stage": "sentiment", "warn": str(e)})
            tickers_out[t]["sentiment"] = {"analyst": None, "news": None}

    ranked = sorted(tickers_out.items(), key=lambda kv: kv[1]["score"], reverse=True)
    ranked_buys = [t for t, v in ranked if v["verdict"] in ("BUY", "WATCH")][:10]
    ranked_avoid = [t for t, v in ranked if v["verdict"] == "AVOID"][:10]

    sector_concentration = {
        s: round(v / portfolio_value_eur, 4) if portfolio_value_eur > 0 else 0.0
        for s, v in sector_value_eur.items()
    }
    over_concentrated = [s for s, w in sector_concentration.items() if w > sector_warn]

    by_holding = []
    for h in universe.holdings:
        v = holdings_value_eur.get(h.ticker)
        c = holdings_cost_eur.get(h.ticker)
        if v is None or c is None:
            continue
        pnl = v - c
        by_holding.append({
            "ticker": h.ticker,
            "value_eur": _round(v, 2),
            "cost_eur": _round(c, 2),
            "pnl_eur": _round(pnl, 2),
            "pnl_pct": _round(pnl / c, 4) if c > 0 else None,
        })

    portfolio_pnl = portfolio_value_eur - portfolio_cost_eur
    portfolio = {
        "value_eur": _round(portfolio_value_eur, 2),
        "cost_eur": _round(portfolio_cost_eur, 2),
        "pnl_eur": _round(portfolio_pnl, 2),
        "pnl_pct": _round(portfolio_pnl / portfolio_cost_eur, 4) if portfolio_cost_eur > 0 else None,
        "by_holding": sorted(by_holding, key=lambda x: x["value_eur"] or 0.0, reverse=True),
    }

    payload = {
        "model_version": MODEL_VERSION,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "fx_eur_usd": _round(fx_rate, 4),
        "universe_size": len(tickers_out),
        "benchmark": benchmark,
        "regime": "RISK_ON" if regime_on else "RISK_OFF",
        "regime_score": regime_score,
        "benchmark_spark": bench_spark,
        "params": {
            "rsi_window": params.get("rsi_window", 14),
            "sma_fast": params.get("sma_fast", 50),
            "sma_slow": params.get("sma_slow", 200),
            "rs_window": params.get("rs_window", 126),
            "weights": scorelib.WEIGHTS,
            "risk": risk,
        },
        "portfolio": portfolio,
        "sector_concentration": sector_concentration,
        "over_concentrated_sectors": over_concentrated,
        "tickers": tickers_out,
        "ranked_buys": ranked_buys,
        "ranked_avoid": ranked_avoid,
        "holdings_summary": sorted(holdings_summary, key=lambda x: x["score"], reverse=True),
        "errors": errors,
    }
    write_json(payload, out_path)

    # Persist a slim daily snapshot for tomorrow's deltas, then prune old files.
    try:
        historylib.write_snapshot(hist_dir, payload)
        historylib.prune_old(hist_dir, keep_days=120)
    except OSError as e:
        errors.append({"stage": "history", "warn": str(e)})

    return payload


def _days_until(iso: str | None, ref: date) -> int | None:
    if not iso:
        return None
    try:
        d = date.fromisoformat(iso)
        return (d - ref).days
    except Exception:
        return None


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
        f"regime={payload['regime']}, "
        f"buys={len(payload['ranked_buys'])}, errors={len(payload['errors'])})"
    )


if __name__ == "__main__":
    _cli()
