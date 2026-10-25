"""Keys: ``<repo>/.env.local`` first, then the environment (tracker/PROTOCOL.md › Persistence). Never logged."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, Mapping, Optional

KEY_NAMES = ("CARTESIA_API_KEY", "ANTHROPIC_API_KEY", "CARTESIA_VOICE_ID")


def parse_env_file(text: str) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        elif " #" in v:
            v = v.split(" #", 1)[0].rstrip()
        out[k] = v
    return out


def load_keys(env_file: Optional[os.PathLike] = None, environ: Optional[Mapping[str, str]] = None) -> Dict[str, str]:
    """Returns {name: value} for KEY_NAMES; empty string when missing. .env.local wins over the environment."""
    environ = os.environ if environ is None else environ
    if env_file is None:
        env_file = Path(__file__).resolve().parents[3] / ".env.local"
    file_vals: Dict[str, str] = {}
    try:
        file_vals = parse_env_file(Path(env_file).read_text(encoding="utf-8"))
    except OSError:
        pass
    return {k: (file_vals.get(k) or environ.get(k) or "").strip() for k in KEY_NAMES}


def key(keys: Any, name: str) -> str:
    """Read one key from a dict, an object with attributes, or a zero-arg callable returning either."""
    if callable(keys) and not isinstance(keys, Mapping):
        keys = keys()
    if keys is None:
        return ""
    if isinstance(keys, Mapping):
        v = keys.get(name) or keys.get(name.lower())
    else:
        v = getattr(keys, name, None) or getattr(keys, name.lower(), None)
    return str(v).strip() if v else ""
