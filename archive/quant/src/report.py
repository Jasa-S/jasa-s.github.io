"""Build and atomically write signals.json."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any


def write_json(payload: dict[str, Any], path: Path) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".signals.", suffix=".json", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, sort_keys=True, default=_default)
            f.write("\n")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def _default(v):
    # Fallback for numpy scalars and similar.
    try:
        return float(v)
    except Exception:
        return str(v)
