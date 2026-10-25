"""Cartesia REST from Python (no Next server any more): access-token minting and the Sonic voice lookup.

Token: POST https://api.cartesia.ai/access-token, headers ``Authorization: Bearer $CARTESIA_API_KEY``,
``Cartesia-Version: 2026-08-14``, body ``{"grants":{"stt":true,"tts":true},"expires_in":3600}``.
Re-minted after 45 min; the STT socket is only replaced between utterances (stt.py / controller.py).
Voice id: CARTESIA_VOICE_ID if set, else the first English voice from GET /voices; None -> TTS "voice unavailable".
The API key and the token are never logged.
"""

from __future__ import annotations

import json
import os
import ssl
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Callable, Optional, Tuple

API_BASE = "https://api.cartesia.ai"
CARTESIA_VERSION = "2026-08-14"
TOKEN_TTL_S = 3600
REMINT_AFTER_S = 45 * 60

# (method, url, headers, body bytes | None, timeout) -> (status, body bytes)
HttpFn = Callable[[str, str, dict, Optional[bytes], float], Tuple[int, bytes]]


_SSL: Optional[ssl.SSLContext] = None


def ssl_context() -> ssl.SSLContext:
    """Default trust store; if this Python has none (python.org builds inside an app bundle), use certifi."""
    global _SSL
    if _SSL is None:
        ctx = ssl.create_default_context()
        paths = ssl.get_default_verify_paths()
        if not (paths.cafile and os.path.exists(paths.cafile)) and not (paths.capath and os.path.isdir(paths.capath)):
            try:
                import certifi

                ctx = ssl.create_default_context(cafile=certifi.where())
            except Exception:
                pass
        _SSL = ctx
    return _SSL


def urllib_http(method: str, url: str, headers: dict, body: Optional[bytes], timeout: float) -> Tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ssl_context()) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as e:
        try:
            return e.code, e.read()
        except Exception:
            return e.code, b""


class TokenError(Exception):
    def __init__(self, reason: str, status: int = 0) -> None:
        super().__init__(f"{reason} ({status})" if status else reason)
        self.reason = reason  # "key_missing" | "upstream" | "network"
        self.status = status


@dataclass
class CartesiaToken:
    token: str
    minted_at: float  # time.monotonic()
    expires_at: float  # time.monotonic()

    def __repr__(self) -> str:  # never print the token
        return f"CartesiaToken(minted_at={self.minted_at:.0f}, expires_at={self.expires_at:.0f})"


def needs_remint(t: Optional[CartesiaToken], now: float) -> bool:
    return t is None or now - t.minted_at >= REMINT_AFTER_S or now >= t.expires_at - 60


def mint_token(api_key: str, http: HttpFn = urllib_http, now: Callable[[], float] = time.monotonic, timeout: float = 5.0) -> CartesiaToken:
    if not api_key:
        raise TokenError("key_missing")
    body = json.dumps({"grants": {"stt": True, "tts": True}, "expires_in": TOKEN_TTL_S}).encode()
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Cartesia-Version": CARTESIA_VERSION,
        "Content-Type": "application/json",
    }
    try:
        status, raw = http("POST", f"{API_BASE}/access-token", headers, body, timeout)
    except Exception as e:  # DNS, refused, timeout
        raise TokenError("network") from e
    if status < 200 or status >= 300:
        raise TokenError("upstream", status)
    try:
        tok = json.loads(raw.decode("utf-8")).get("token")
    except Exception:
        tok = None
    if not isinstance(tok, str) or not tok:
        raise TokenError("upstream", status)
    t = now()
    return CartesiaToken(token=tok, minted_at=t, expires_at=t + TOKEN_TTL_S)


class TokenSource:
    """Thread-safe cached token. ``get()`` re-mints when due (call it only between utterances)."""

    def __init__(self, api_key_fn: Callable[[], str], http: HttpFn = urllib_http, now: Callable[[], float] = time.monotonic) -> None:
        self._key = api_key_fn
        self._http = http
        self._now = now
        self._lock = threading.Lock()
        self.current: Optional[CartesiaToken] = None

    def get(self, force: bool = False) -> CartesiaToken:
        with self._lock:
            if not force and self.current and not needs_remint(self.current, self._now()):
                return self.current
            self.current = mint_token(self._key(), self._http, self._now)
            return self.current

    def due(self) -> bool:
        return needs_remint(self.current, self._now())


def first_english_voice(api_key: str, http: HttpFn = urllib_http, timeout: float = 5.0) -> Optional[str]:
    """Same endpoint the SDK's voices.list() pages over (GET /voices -> {data: Voice[]})."""
    if not api_key:
        return None
    try:
        status, raw = http(
            "GET",
            f"{API_BASE}/voices?limit=100",
            {"Authorization": f"Bearer {api_key}", "Cartesia-Version": CARTESIA_VERSION},
            None,
            timeout,
        )
        if status < 200 or status >= 300:
            return None
        body = json.loads(raw.decode("utf-8"))
        items = body if isinstance(body, list) else (body.get("data") or [])
        for v in items:
            if isinstance(v, dict) and isinstance(v.get("id"), str) and str(v.get("language") or "").lower().startswith("en"):
                return v["id"]
    except Exception:
        return None
    return None


def ws_connect(url: str, max_size: int = 2**22):
    """websockets sync client (send/recv/close) held open outside a ``with`` block: ``legacy=True`` where the
    installed websockets (>= 17.1) asks for it, so it never warns or breaks on newer releases."""
    import inspect

    from websockets.sync.client import connect

    kw = dict(open_timeout=5, close_timeout=2, max_size=max_size, ssl=ssl_context())
    try:
        if "legacy" in inspect.signature(connect).parameters:
            kw["legacy"] = True
    except (TypeError, ValueError):
        pass
    return connect(url, **kw)
