"""Allowed WebSocket Origins.

Default is exactly http://localhost:3000. `--origin` (repeatable) or env STEADY_ORIGIN
(comma-separated) replace it, e.g. when the dev server runs on :3100. Only http(s) origins on
localhost / 127.0.0.1 with an optional port are accepted; '*', other hosts, paths, userinfo
and anything else are refused at startup (otherwise any website could move the mouse).

Flags win over the env var; the env var wins over the default. Stdlib only (the fake helper
has a copy of `validate_origin` so it stays a standalone script).
"""

from __future__ import annotations

import re
from typing import Iterable, List, Mapping, Optional

from .config import ALLOWED_ORIGIN

ENV_VAR = "STEADY_ORIGIN"
_ORIGIN_RE = re.compile(r"^https?://(localhost|127\.0\.0\.1)(:(\d{1,5}))?$")


class BadOrigin(ValueError):
    pass


def validate_origin(origin: str) -> str:
    o = origin.strip()
    m = _ORIGIN_RE.match(o)
    if not m or (m.group(3) is not None and not 0 < int(m.group(3)) < 65536):
        raise BadOrigin(
            f"Refusing Origin {origin!r}: only http://localhost:<port> or http://127.0.0.1:<port> "
            f"are allowed (no '*', no other hosts, no paths). Default: {ALLOWED_ORIGIN}"
        )
    return o


def resolve_origins(flags: Optional[Iterable[str]], env: Optional[Mapping[str, str]] = None) -> List[str]:
    """Allowed origins from --origin flags, else STEADY_ORIGIN, else the default. Raises BadOrigin."""
    raw: List[str] = [f for f in (flags or []) if f is not None]
    if not raw and env is not None and env.get(ENV_VAR, "").strip():
        raw = [p for p in env[ENV_VAR].split(",") if p.strip()]
    if not raw:
        return [ALLOWED_ORIGIN]
    out: List[str] = []
    for o in raw:
        v = validate_origin(o)
        if v not in out:
            out.append(v)
    return out
