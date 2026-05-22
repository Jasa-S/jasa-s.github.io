# Quant — buy-signal model

A small daily technical screener for AI / compute / quantum names. Runs on a
GitHub Actions cron, writes `quant/output/signals.json`, and renders the
dashboard at [`/quant.html`](https://jasa-s.github.io/quant.html).

> Not financial advice. This is a screener, not a backtest.

## Versions

- **v2** (current, `model_version: 2`): adds market-regime gate (SPY trend),
  relative-strength factor, pullback overlay, earnings-date gate, position
  sizing, trailing stops, sector concentration, and portfolio P&L. Composite
  weights re-balanced; scores are not directly comparable to v1.
- v1: pure cross-sectional momentum + trend + RSI + MACD.

## What it does

Scores a curated universe (your current holdings + watchlist) on a composite
of cross-sectional z-scores:

- **12-1 month momentum**: return from t-273 to t-21 trading days
- **Volatility-adjusted return**: momentum / annualized 63-day stdev
- **Trend filter** (binary): price > SMA<sub>200</sub> AND SMA<sub>50</sub> > SMA<sub>200</sub>
- **Relative strength vs SPY**: 6-month excess return
- **MACD histogram** (sign · normalized magnitude)
- **Normalized RSI(14)**: clip((RSI - 50) / 20, ±1)

Composite (raw):

```
R = 0.30 · z_M + 0.25 · z_S + 0.20 · trend + 0.15 · z_RS
  + 0.05 · z_MACD + 0.05 · z_RSI
```

Final score: `round(50 + 12.5 · clip(R, -4, 4))` → 0-100.

| Verdict | Score |
|---------|-------|
| BUY     | ≥ 70  |
| WATCH   | 40-69 |
| AVOID   | < 40  |

Downgrades to WATCH:

- High score with `trend_off AND RSI < 40` (oversold-in-downtrend trap).
- Market regime is `RISK_OFF` (benchmark in downtrend).
- Earnings within 3 trading days.

A separate **PULLBACK** overlay flags any name in an uptrend pulling back
to SMA<sub>50</sub> with RSI < 35 — useful for adding to existing winners
on a healthy dip.

For current holdings, the model also outputs an action:

- **ADD**: score ≥ 65, weight < 30 %, trend on, regime on, no imminent
  earnings. Sized via 1 %-risk-per-trade with a 2-ATR stop, capped at 30 %
  of portfolio.
- **TRIM**: score < 40 OR (weight > 35 % AND score < 60) OR (RSI > 80 AND
  drawdown vs basis > 40 %).
- **HOLD**: otherwise.

Each holding also carries a suggested trailing stop:
`max(price − 2·ATR, 0.85 · cost_basis)`.

## Layout

```
quant/
├── config/universe.yml       # holdings + watchlist + parameters
├── src/
│   ├── data.py               # yfinance fetch + parquet cache + FX
│   ├── indicators.py         # SMA, EMA, RSI (Wilder), MACD, ATR, momentum
│   ├── score.py              # features, cross-sectional z, composite
│   ├── signal.py             # classify + holding_action
│   ├── report.py             # atomic JSON writer
│   └── main.py               # orchestrator (python -m quant.src.main)
├── tests/                    # pytest, runs offline against synthetic data
├── output/signals.json       # committed by the Action; consumed by quant.html
└── cache/                    # parquet cache; gitignored
```

## Run locally

```bash
pip install -r quant/requirements.txt
python -m quant.src.main \
  --config quant/config/universe.yml \
  --out quant/output/signals.json \
  --cache quant/cache
pytest quant/tests
python -m http.server 8000     # then open http://localhost:8000/quant.html
```

## Edit holdings

Update `quant/config/universe.yml`:

- `holdings` — your actual positions (with `cost_basis_eur` and `units` so
  drawdown and weight can be computed).
- `watchlist` — names you want scored but don't hold.

The next workflow run picks up your edits automatically.

## How it runs in CI

`.github/workflows/quant.yml`:

- Triggers: weekdays at 22:30 UTC (≈ 1h after US close), or on demand via the
  Actions tab ("Run workflow").
- Runs pytest, generates `signals.json`, and commits it back to the branch if
  it changed. The site picks up the new JSON on the next page load (the page
  cache-busts the request).

## Risks / caveats

- **yfinance reliability**: undocumented Yahoo endpoint with occasional
  throttling and ticker-symbol drift (e.g., Nebius `NBIS` may need
  verification). Failures are captured in `errors[]` rather than crashing the
  run, and the previous parquet cache is reused when a fresh fetch fails.
- **Survivorship / look-ahead bias**: today's universe is biased toward names
  that already worked.
- **No backtest validation**: weights are heuristic, not optimized.
- **EUR vs USD**: prices fetched in USD, converted via `EURUSD=X`, ffilled on
  holiday mismatches. Cost basis is stored in EUR.

## Disclaimer

Educational use only. Past performance is not indicative of future returns.
Verify everything yourself before acting on any of this.
