"""Daily snapshot archive for score history and day-over-day deltas."""
from __future__ import annotations

import json
import re
from datetime import date, timedelta
from pathlib import Path

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}\.json$")


def write_snapshot(out_dir: Path, payload: dict) -> Path:
    """Write a slim per-day snapshot derived from the full signals payload.

    File name is YYYY-MM-DD.json from payload['generated_at'][:10]; same-day
    re-runs overwrite cleanly.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    snap_date = (payload.get("generated_at") or "")[:10] or date.today().isoformat()
    slim_tickers = {
        t: {
            "score": v.get("score"),
            "verdict": v.get("verdict"),
            "action": v.get("holding_action"),
        }
        for t, v in (payload.get("tickers") or {}).items()
    }
    snap = {
        "date": snap_date,
        "model_version": payload.get("model_version"),
        "regime": payload.get("regime"),
        "regime_score": payload.get("regime_score"),
        "tickers": slim_tickers,
    }
    path = out_dir / f"{snap_date}.json"
    path.write_text(json.dumps(snap, indent=2, sort_keys=True) + "\n")
    return path


def load_recent(out_dir: Path, days: int = 30) -> list[dict]:
    """Return up to `days` most recent snapshots, sorted oldest-first."""
    if not out_dir.exists():
        return []
    files = sorted(p for p in out_dir.iterdir() if _DATE_RE.match(p.name))
    if days > 0:
        files = files[-days:]
    out = []
    for p in files:
        try:
            out.append(json.loads(p.read_text()))
        except (json.JSONDecodeError, OSError):
            continue
    return out


def prune_old(out_dir: Path, keep_days: int = 120) -> int:
    """Delete snapshots older than `keep_days` calendar days. Returns count."""
    if not out_dir.exists():
        return 0
    cutoff = (date.today() - timedelta(days=keep_days)).isoformat()
    removed = 0
    for p in out_dir.iterdir():
        if not _DATE_RE.match(p.name):
            continue
        if p.stem < cutoff:
            try:
                p.unlink()
                removed += 1
            except OSError:
                pass
    return removed


def find_prior(snapshots: list[dict], today_iso: str) -> dict | None:
    """Most recent snapshot strictly before today_iso, or None."""
    for s in reversed(snapshots):
        d = s.get("date")
        if d and d < today_iso:
            return s
    return None


def find_n_days_ago(snapshots: list[dict], today_iso: str, n: int) -> dict | None:
    """Most recent snapshot at or before (today - n days)."""
    try:
        target = (date.fromisoformat(today_iso) - timedelta(days=n)).isoformat()
    except ValueError:
        return None
    for s in reversed(snapshots):
        d = s.get("date")
        if d and d <= target:
            return s
    return None
