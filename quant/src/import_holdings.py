"""Import a Trade Republic portfolio CSV into universe.yml.

Run locally; not part of CI. Preserves watchlist/params/risk; only rewrites
the `holdings:` block.

Expected CSV columns (TR's "Portfolio" export — adjust if yours differs):
    ISIN, Name, Quantity, Avg Price (EUR)

Usage:
    python -m quant.src.import_holdings \\
        --csv tr_export.csv \\
        --config quant/config/universe.yml \\
        --map quant/config/isin_to_ticker.yml
"""
from __future__ import annotations

import argparse
import csv
from pathlib import Path

import yaml


def load_isin_map(path: Path) -> dict[str, dict]:
    return yaml.safe_load(path.read_text()) or {}


def parse_csv(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for r in reader:
            isin = (r.get("ISIN") or r.get("isin") or "").strip()
            qty = _to_float(r.get("Quantity") or r.get("Units") or r.get("quantity"))
            avg = _to_float(r.get("Avg Price (EUR)") or r.get("Avg Price") or r.get("avg_price_eur"))
            if not isin or qty is None or avg is None:
                continue
            rows.append({"isin": isin, "units": qty, "cost_basis_eur": avg})
    return rows


def merge_into_universe(
    universe_path: Path, holdings_rows: list[dict], isin_map: dict[str, dict]
) -> dict:
    raw = yaml.safe_load(universe_path.read_text()) or {}
    new_holdings = []
    skipped: list[str] = []
    for r in holdings_rows:
        m = isin_map.get(r["isin"])
        if not m:
            skipped.append(r["isin"])
            continue
        new_holdings.append({
            "ticker": m["ticker"],
            "name": m.get("name", m["ticker"]),
            "sector": m.get("sector", ""),
            "cost_basis_eur": round(float(r["cost_basis_eur"]), 4),
            "units": round(float(r["units"]), 4),
        })
    raw["holdings"] = new_holdings
    raw["_import_skipped_isins"] = skipped or None
    return raw


def write_universe(universe_path: Path, raw: dict) -> None:
    universe_path.write_text(yaml.safe_dump(raw, sort_keys=False, allow_unicode=True))


def _to_float(v) -> float | None:
    if v is None:
        return None
    s = str(v).strip().replace(",", ".")
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _cli() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--csv", type=Path, required=True, help="Trade Republic export CSV")
    p.add_argument("--config", type=Path, default=Path("quant/config/universe.yml"))
    p.add_argument("--map", type=Path, default=Path("quant/config/isin_to_ticker.yml"))
    args = p.parse_args()

    isin_map = load_isin_map(args.map)
    rows = parse_csv(args.csv)
    raw = merge_into_universe(args.config, rows, isin_map)
    write_universe(args.config, raw)
    skipped = raw.pop("_import_skipped_isins", None) or []
    print(f"updated {args.config} with {len(raw.get('holdings', []))} holdings")
    if skipped:
        print(f"skipped {len(skipped)} ISINs missing from {args.map}: {skipped}")


if __name__ == "__main__":
    _cli()
