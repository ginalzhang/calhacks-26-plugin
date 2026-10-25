"""Claude fallback for text the brain's grammar could not match (§8). Python port of src/app/api/command/
{handler,schema,systemBlock,mock}.ts; there is no server route any more, the tracker calls Anthropic directly.

- ``claude-haiku-5-5``, the cached byte-identical SYSTEM_BLOCK, ``thinking: disabled``, ``effort: low``,
  ``max_tokens: 512``, timeout 2.5 s, no retries, never a forced tool_choice. Structured output via
  ``output_config.format`` (json_schema) on ``messages.create``; we validate the JSON ourselves (normalise_output)
  so a schema or SDK-side parse difference can never execute an unknown id. The schema is the same JSON the TS
  SDK's zodOutputFormat(ActionsSchema) sent (enums carried in descriptions), checked byte-for-byte in tests.
- No ANTHROPIC_API_KEY -> the keyword mock (mock.ts), ``mock: True``; resolve.py shows "Claude key missing".
- Privacy (§0 rule 9): the request carries only the text plus tool, preset, size, opacity, colour, Steadiness and
  the last three actions, rebuilt field by field. Never audio.
- Every call is logged to ``~/Library/Application Support/Steady/claude-log.jsonl`` (resolve.py writes it).
"""

from __future__ import annotations

import json
import math
import os
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from .actions import ActionTable, table
from .system_text import MIDDLE, PREFIX, SUFFIX

MODEL = "claude-haiku-5-5"
TIMEOUT_S = 2.5
PREWARM_TIMEOUT_S = 30.0
MAX_TOKENS = 512

PREWARM_PAYLOAD = json.dumps(
    {"text": "um", "context": {"tool": None, "preset": None, "size": None, "opacity": None, "color": None, "steadiness": 50, "lastActions": []}},
    separators=(",", ":"),
)


# ---------------------------------------------------------------------------------------------- SYSTEM_BLOCK
def grammar_lines(t: ActionTable) -> str:
    lines = []
    for aid in t.claude_action_ids():
        a = t.by_id[aid]
        phrases = ", ".join(f'"{p}"' for p in a.voice_phrases)
        extras = []
        if a.arg == "number":
            extras.append("takes a number in arg")
        if a.destructive:
            extras.append("destructive: the app asks for confirmation")
        if a.mode_changing:
            extras.append("mode change")
        if a.help:
            extras.append(a.help)
        lines.append(f"- {aid} ({a.label}): {phrases}" + (f" — {'; '.join(extras)}" if extras else ""))
    return "\n".join(lines)


def build_system_block(t: Optional[ActionTable] = None) -> str:
    t = t or table()
    families = ", ".join(f'"{f}"' for f in t.preset_families)
    return PREFIX + grammar_lines(t) + MIDDLE + families + SUFFIX


def build_output_format(t: Optional[ActionTable] = None) -> Dict[str, Any]:
    """Same JSON the TS SDK produced from zodOutputFormat(ActionsSchema)."""
    t = t or table()
    ids = t.claude_action_ids()
    action = {"$ref": "#/$defs/__schema0"}
    return {
        "type": "json_schema",
        "schema": {
            "$defs": {"__schema0": {"type": "string", "description": "{enum: " + json.dumps(ids, separators=(",", ":")) + "}"}},
            "anyOf": [
                {
                    "type": "object",
                    "properties": {
                        "kind": {"type": "string", "description": '{const: "actions"}'},
                        "first": action,
                        "second": {"anyOf": [action, {"type": "null"}]},
                        "arg": {"type": ["number", "null"]},
                    },
                    "additionalProperties": False,
                    "required": ["kind", "first", "second", "arg"],
                },
                {
                    "type": "object",
                    "properties": {
                        "kind": {"type": "string", "description": '{const: "clarify"}'},
                        "options": {"type": "array", "items": action},
                    },
                    "additionalProperties": False,
                    "required": ["kind", "options"],
                },
                {
                    "type": "object",
                    "properties": {"kind": {"type": "string", "description": '{const: "noop"}'}},
                    "additionalProperties": False,
                    "required": ["kind"],
                },
            ],
            "description": '{$schema: "https://json-schema.org/draft/2020-12/schema"}',
        },
    }


# ---------------------------------------------------------------------------------------------- validation
def normalise_output(raw: Any, t: Optional[ActionTable] = None) -> Optional[Dict[str, Any]]:
    """Port of schema.ts normaliseOutput: validate + canonicalise ids; None = "Didn't catch that"."""
    t = t or table()
    allowed = set(t.claude_action_ids())
    if not isinstance(raw, dict):
        return None

    def fix(v: Any) -> Optional[str]:
        c = t.canonical(v)
        return c if c in allowed else None

    kind = raw.get("kind")
    if kind == "actions":  # zod object: unknown keys are stripped; first/second/arg are required
        if "first" not in raw or "second" not in raw or "arg" not in raw:
            return None
        first = fix(raw.get("first"))
        if first is None:
            return None
        second = None
        if raw.get("second") is not None:
            second = fix(raw.get("second"))
            if second is None:
                return None
        if second == first:
            second = None
        arg = raw.get("arg")
        if arg is not None:
            if isinstance(arg, bool) or not isinstance(arg, (int, float)):
                return None
            if not math.isfinite(arg):
                arg = None
        return {"kind": "actions", "first": first, "second": second, "arg": arg}
    if kind == "clarify":
        opts = raw.get("options")
        if not isinstance(opts, list):
            return None
        out: List[str] = []
        for o in opts:
            c = fix(o)
            if c is None:
                return None
            if c not in out:
                out.append(c)
        out = out[:3]
        return {"kind": "clarify", "options": out} if out else None
    if kind == "noop":
        return {"kind": "noop"}
    return None


def to_response(out: Optional[Dict[str, Any]], latency_ms: float, mock: bool) -> Dict[str, Any]:
    lat = int(round(latency_ms))
    if out is None:
        return {"kind": "error", "reason": "invalid", "latencyMs": lat, "mock": mock}
    return {**out, "latencyMs": lat, "mock": mock}


# ---------------------------------------------------------------------------------------------- mock (mock.ts)
_RULES = [
    (r"\b(thinner|finer|narrower|tinier|smaller|thin|skinnier)\b", "smaller"),
    (r"\b(thicker|fatter|wider|larger|bigger|chunkier)\b", "bigger"),
    (r"\b(softer|soft|fuzzier|fuzzy|blurr(y|ier)|gentler|misty|airbrush)\b", "airbrush"),
    (r"\b(see[- ]through|fainter|faint|ghostly|transparent)\b", "fade"),
    (r"\b(opaque|solid)\b", "solid"),
    (r"\b(rub (it|that) out|erase|eraser|rubber)\b", "eraser"),
    (r"\b(pencil|sketchy)\b", "pencil"),
    (r"\b(inky|crisp|sharp line|ink pen)\b", "ink"),
    (r"\b(back to (painting|the brush|brush)|normal brush|paintbrush)\b", "brush"),
    (r"\b(oops|go back|take (that|it) back|undo)\b", "undo"),
    (r"\b(do (it|that) again|redo|put (it|that) back)\b", "redo"),
    (r"\b(closer|magnify|enlarge the view|zoom in)\b", "zoom_in"),
    (r"\b(further away|farther|see more|zoom out)\b", "zoom_out"),
    (r"\b(whole (thing|picture|image|canvas)|fit)\b", "fit"),
    (r"\b(fresh layer|another layer|new layer|blank layer)\b", "new_layer"),
    (r"\b(wobbl\w*|shak\w*|smoother|steadier|jitter\w*)\b", "steadier"),
    (r"\b(lagg?ing|too slow|more responsive|looser)\b", "looser"),
    (r"\b(tilt|rotate|turn)\b.*\bleft\b", "turn_left"),
    (r"\b(tilt|rotate|turn)\b.*\bright\b", "turn_right"),
    (r"\b(flip|mirror)\b", "mirror"),
    (r"\b(save|keep (it|this))\b", "save"),
    (r"\b(navy|sky|teal|blue)\b", "colour_blue"),
    (r"\b(crimson|scarlet|red)\b", "colour_red"),
    (r"\b(gr[ae]y|silver)\b", "colour_grey"),
    (r"\b(violet|purple)\b", "colour_purple"),
    (r"\b(tan|brown)\b", "colour_brown"),
    (r"\b(lime|green)\b", "colour_green"),
    (r"\b(gold|yellow)\b", "colour_yellow"),
    (r"\b(orange)\b", "colour_orange"),
    (r"\b(black)\b", "colour_black"),
    (r"\b(white)\b", "colour_white"),
    (r"\b(deeper|richer|darker)\b", "darker"),
]
_RULES_RE = [(re.compile(p), i) for p, i in _RULES]
_AMBIGUOUS = [
    (re.compile(r"^(make (it|this) )?(a bit |a little )?(lighter|paler)$"), ["lighter", "fade"]),
    (re.compile(r"^(something|make (it|this)) softer$"), ["airbrush", "fade"]),
]
_FILLER = re.compile(r"^(\W|um+|uh+|hmm+|erm|okay|ok|yeah|cough|\*cough\*|thanks|thank you)*$")
_NUMBER_WORDS = {
    "five": 5, "ten": 10, "fifteen": 15, "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
    "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90, "hundred": 100,
}


def _find_number(t: str) -> Optional[int]:
    m = re.search(r"\b(\d{1,4})\b", t)
    if m:
        return int(m.group(1))
    for w, n in _NUMBER_WORDS.items():
        if re.search(rf"\b{w}\b", t):
            return n
    if re.search(r"\bhalf\b", t):
        return 50
    return None


def mock_interpret(text: str, t: Optional[ActionTable] = None) -> Optional[Dict[str, Any]]:
    """Deterministic keyword matcher used when ANTHROPIC_API_KEY is missing. None = nothing matched."""
    t = t or table()
    allowed = set(t.claude_action_ids())
    s = re.sub(r"\s+", " ", re.sub(r"[^\w\s*'-]", " ", text.lower())).strip()
    if not s or _FILLER.match(re.sub(r"\s", "", s)):
        return {"kind": "noop"}
    for rx, options in _AMBIGUOUS:
        if rx.match(s):
            return {"kind": "clarify", "options": list(options)}
    n = _find_number(s)
    if n is not None and re.search(r"\b(size|brush|pen|width)\b", s):
        return {"kind": "actions", "first": "size", "second": None, "arg": n}
    if n is not None and re.search(r"\b(opacity|see[- ]through|transparen\w*)\b", s):
        return {"kind": "actions", "first": "opacity", "second": None, "arg": n}
    hits: List[tuple] = []
    for rx, aid in _RULES_RE:
        if aid not in allowed:
            continue
        m = rx.search(s)
        if m and not any(h[1] == aid for h in hits):
            hits.append((m.start(), aid))
    hits.sort(key=lambda h: h[0])  # stable, like Array.prototype.sort
    if not hits:
        return None
    return {"kind": "actions", "first": hits[0][1], "second": hits[1][1] if len(hits) > 1 else None, "arg": None}


# ---------------------------------------------------------------------------------------------- context
def pick_context(c: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Exactly the §0 rule 9 list, rebuilt field by field (nothing else ever leaves the machine)."""
    c = c or {}

    def num(v: Any) -> Optional[float]:
        return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None

    def s(v: Any, n: int) -> Optional[str]:
        return str(v)[:n] if isinstance(v, str) and v else None

    steadiness = num(c.get("steadiness"))
    last = c.get("lastActions") or c.get("last_actions") or []
    return {
        "tool": s(c.get("tool"), 64),
        "preset": s(c.get("preset"), 128),
        "size": num(c.get("size")),
        "opacity": num(c.get("opacity")),
        "color": s(c.get("color"), 32),
        "steadiness": steadiness if steadiness is not None else 50,
        "lastActions": [str(x)[:64] for x in list(last)[-3:]],
    }


def user_content(text: str, context: Dict[str, Any]) -> str:
    return json.dumps({"text": text[:500], "context": pick_context(context)}, separators=(",", ":"), ensure_ascii=False)


# ---------------------------------------------------------------------------------------------- client
def classify_error(err: BaseException) -> str:
    try:
        import anthropic
    except ImportError:  # pragma: no cover
        return "upstream"
    if isinstance(err, anthropic.APITimeoutError):
        return "timeout"
    if isinstance(err, (anthropic.AuthenticationError, anthropic.PermissionDeniedError)):
        return "key_missing"
    if isinstance(err, anthropic.APIConnectionError):
        return "offline"
    return "upstream"


def _first_text(msg: Any) -> Optional[str]:
    for b in getattr(msg, "content", None) or []:
        if getattr(b, "type", None) == "text":
            return getattr(b, "text", None)
    return None


class ClaudeInterpreter:
    """``interpret(text, context) -> response dict`` (docs/API.md /api/command response shapes).

    ``client_factory(api_key)`` returns an object with ``with_options(timeout=, max_retries=)`` and
    ``.messages.create(**params)``; default = ``anthropic.Anthropic``. Tests inject a fake.
    """

    def __init__(
        self,
        api_key_fn: Callable[[], str],
        client_factory: Optional[Callable[[str], Any]] = None,
        t: Optional[ActionTable] = None,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self._key = api_key_fn
        self._factory = client_factory
        self._t = t
        self._now = now
        self._client: Any = None
        self._client_key: Optional[str] = None
        self.system_block = build_system_block(self.table)
        self.output_format = build_output_format(self.table)
        self.prewarmed: Optional[Dict[str, Any]] = None

    @property
    def table(self) -> ActionTable:
        return self._t or table()

    @property
    def has_key(self) -> bool:
        return bool(self._key())

    def _get_client(self, key: str) -> Any:
        if self._client is None or self._client_key != key:
            if self._factory is not None:
                self._client = self._factory(key)
            else:
                import anthropic

                self._client = anthropic.Anthropic(api_key=key)
            self._client_key = key
        return self._client

    def build_params(self, content: str) -> Dict[str, Any]:
        return {
            "model": MODEL,
            "max_tokens": MAX_TOKENS,
            "system": [{"type": "text", "text": self.system_block, "cache_control": {"type": "ephemeral"}}],
            "messages": [{"role": "user", "content": content}],
            "thinking": {"type": "disabled"},
            "output_config": {"effort": "low", "format": self.output_format},
        }

    def interpret(self, text: str, context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        t0 = self._now()
        key = self._key()
        if not key:
            out = mock_interpret(text, self.table)
            lat = (self._now() - t0) * 1000
            if out is None:
                return {"kind": "error", "reason": "key_missing", "latencyMs": int(round(lat)), "mock": True}
            return to_response(normalise_output(out, self.table), lat, True)
        try:
            client = self._get_client(key).with_options(timeout=TIMEOUT_S, max_retries=0)
            msg = client.messages.create(**self.build_params(user_content(text, context or {})))
        except Exception as e:  # noqa: BLE001 - classified below
            return {"kind": "error", "reason": classify_error(e), "latencyMs": int(round((self._now() - t0) * 1000)), "mock": False}
        lat = (self._now() - t0) * 1000
        if getattr(msg, "stop_reason", None) == "refusal":
            return to_response(None, lat, False)
        raw_text = _first_text(msg)
        try:
            raw = json.loads(raw_text) if raw_text else None
        except ValueError:
            raw = None
        return to_response(normalise_output(raw, self.table), lat, False)

    def prewarm(self) -> Dict[str, Any]:
        """One real request with the same SYSTEM_BLOCK, 30 s timeout. Never raises; not logged as a call."""
        key = self._key()
        if not key:
            self.prewarmed = {"ok": True, "mock": True, "latencyMs": 0}
            return self.prewarmed
        t0 = self._now()
        try:
            client = self._get_client(key).with_options(timeout=PREWARM_TIMEOUT_S, max_retries=0)
            client.messages.create(**self.build_params(PREWARM_PAYLOAD))
            ok = True
        except Exception:  # noqa: BLE001
            ok = False
        self.prewarmed = {"ok": ok, "mock": False, "latencyMs": int(round((self._now() - t0) * 1000))}
        return self.prewarmed

    def prewarm_async(self) -> threading.Thread:
        th = threading.Thread(target=self.prewarm, name="steady-claude-prewarm", daemon=True)
        th.start()
        return th


# ---------------------------------------------------------------------------------------------- log
def default_log_path() -> Path:
    return Path(os.path.expanduser("~/Library/Application Support/Steady/claude-log.jsonl"))


CLAUDE_LOG_MAX = 200


class ClaudeLog:
    """Append-only JSONL: entries ``{id, t, summary, latencyMs, outcome, mock}``; outcome changes are appended as
    ``{id, t, outcome, update: true}`` and folded by ``read()``. Best-effort (never raises)."""

    def __init__(self, path: Optional[os.PathLike] = None) -> None:
        self.path = Path(path) if path else default_log_path()
        self._lock = threading.Lock()

    def _append(self, obj: Dict[str, Any]) -> None:
        try:
            with self._lock:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                with self.path.open("a", encoding="utf-8") as f:
                    f.write(json.dumps(obj, ensure_ascii=False) + "\n")
        except OSError:
            pass

    def log(self, summary: str, latency_ms: float, outcome: str, mock: bool) -> Dict[str, Any]:
        e = {
            "id": "c" + uuid.uuid4().hex[:12],
            "t": int(time.time() * 1000),
            "summary": summary[:160],
            "latencyMs": max(0, int(round(latency_ms))),
            "outcome": outcome,
            "mock": bool(mock),
        }
        self._append(e)
        return e

    def mark(self, entry_id: str, outcome: str) -> None:
        self._append({"id": entry_id, "t": int(time.time() * 1000), "outcome": outcome, "update": True})

    def read(self) -> List[Dict[str, Any]]:
        try:
            lines = self.path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return []
        entries: Dict[str, Dict[str, Any]] = {}
        order: List[str] = []
        for ln in lines:
            try:
                o = json.loads(ln)
            except ValueError:
                continue
            if not isinstance(o, dict) or "id" not in o:
                continue
            if o.get("update"):
                if o["id"] in entries:
                    entries[o["id"]]["outcome"] = o.get("outcome")
            else:
                entries[o["id"]] = o
                order.append(o["id"])
        return [entries[i] for i in order][-CLAUDE_LOG_MAX:]
