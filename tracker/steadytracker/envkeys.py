"""API keys: `<repo>/.env.local` first, then the environment. Values are never logged."""

from __future__ import annotations

import logging
import os
from typing import Dict, Iterable, Mapping, Optional

from .config import ENV_FILE, KEY_NAMES

log = logging.getLogger("steady.tracker.keys")


def parse_env_file(text: str) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
            v = v[1:-1]
        elif " #" in v:
            v = v.split(" #", 1)[0].rstrip()
        if k:
            out[k] = v
    return out


def load_keys(
    path: str = ENV_FILE, env: Optional[Mapping[str, str]] = None, names: Iterable[str] = KEY_NAMES
) -> Dict[str, str]:
    """{name: value} for every key found (.env.local wins over the environment)."""
    env = os.environ if env is None else env
    file_vals: Dict[str, str] = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            file_vals = parse_env_file(f.read())
    except OSError:
        pass
    out: Dict[str, str] = {}
    for n in names:
        v = file_vals.get(n) or env.get(n)
        if v:
            out[n] = v
    log.info("API keys present: %s", ", ".join(sorted(out)) or "none")  # names only
    return out
