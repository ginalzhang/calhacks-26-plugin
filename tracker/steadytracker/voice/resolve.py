"""Command resolution (§8), the same path for a voice transcript and for the typed box. Port of src/voice/resolve.ts.

  (1) the brain's grammar (exact first, fuzzy per §6; it coalesces "undo that undo that" into {undo, arg 2} and
      puts word arguments such as an alias into ``variant``);
  (2) only on no match, never for a refused alias, and never while a dialog/clarify prompt is open: Claude
      (claude.py; the keyword mock when there is no key). Ids are compared case-insensitively.
  On timeout / invalid output / offline / key missing -> kind "none" with the two closest grammar matches, so the
  panel shows "Didn't catch that" with tiles; the transcript is never discarded silently.

Resolution dicts (same shapes as src/pipeline/types.ts Resolution):
  {"kind": "commands", "commands": [{"action", "variant"?, "arg"?}], "heard", "via": "grammar"|"claude"}
  {"kind": "clarify", "options": [ids], "heard"}
  {"kind": "noop", "heard"}
  {"kind": "none", "heard", "closest": [ids], "reason": "nomatch"|"timeout"|"invalid"|"offline"|"key_missing",
   "refused"?: {"reason": "alias_taken", "word"}}
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

from .actions import ActionTable, table
from .claude import ClaudeLog

ParseFn = Callable[[str, Dict[str, Any]], Dict[str, Any]]
StatusFn = Callable[[str, str], None]


def short_quote(text: str) -> str:
    return f'"{text[:57]}…"' if len(text) > 60 else f'"{text}"'


class Resolver:
    def __init__(
        self,
        parse: ParseFn,
        interpreter: Any,  # ClaudeInterpreter-like: interpret(text, context) -> response dict
        log: Optional[ClaudeLog] = None,
        t: Optional[ActionTable] = None,
    ) -> None:
        self.parse = parse
        self.interpreter = interpreter
        self.log = log or ClaudeLog()
        self._t = t
        self.last_clarify_log_id: Optional[str] = None
        self.last_claude_log_id: Optional[str] = None

    @property
    def table(self) -> ActionTable:
        return self._t or table()

    def resolve_clarify(self, accepted: bool) -> None:
        """Call when a Claude clarify prompt closes: picked option = accepted, cancel = rejected."""
        if self.last_clarify_log_id:
            self.log.mark(self.last_clarify_log_id, "accepted" if accepted else "rejected")
        self.last_clarify_log_id = None

    def mark_last_rejected(self) -> None:
        """"Undo that" right after a Claude action."""
        if self.last_claude_log_id:
            self.log.mark(self.last_claude_log_id, "rejected")
            self.last_claude_log_id = None

    def resolve(
        self,
        text: str,
        mode: str = "voice",
        dialog_open: Optional[bool] = None,
        context: Optional[Dict[str, Any]] = None,
        aliases: Optional[Dict[str, str]] = None,
        on_status: Optional[StatusFn] = None,
        allow_claude: bool = True,
    ) -> Dict[str, Any]:
        heard = (text or "").strip()
        if not heard:
            return {"kind": "noop", "heard": heard}
        status = on_status or (lambda _t, _l: None)

        # (1) grammar (the brain)
        # dialog_open None = unknown here: the brain fills dialogOpen from its own dialog state (and merges its
        # stored aliases), so only send what we know.
        opts: Dict[str, Any] = {"mode": mode}
        if dialog_open is not None:
            opts["dialogOpen"] = bool(dialog_open)
        if aliases:
            opts["aliases"] = dict(aliases)
        try:
            parsed = self.parse(heard, opts) or {}
        except Exception:  # brain down / timed out: treat as no match, Claude may still help
            parsed = {"kind": "nomatch", "closest": []}
        if parsed.get("kind") == "match":
            return {"kind": "commands", "commands": list(parsed.get("commands") or []), "heard": heard, "via": "grammar"}

        refused = parsed.get("refused")
        if isinstance(refused, dict) and refused.get("reason") == "alias_taken":
            word = str(refused.get("word") or "")
            status(f'That word is taken: "{word}".', "status")
            return {"kind": "none", "heard": heard, "closest": [], "reason": "nomatch", "refused": {"reason": "alias_taken", "word": word}}

        # Dialogs and clarify prompts: exact grammar only, never Claude, no suggestion tiles.
        if dialog_open:
            return {"kind": "none", "heard": heard, "closest": [], "reason": "nomatch"}

        closest = [c for c in (parsed.get("closest") or []) if isinstance(c, str)][:2]

        def none(reason: str) -> Dict[str, Any]:
            return {"kind": "none", "heard": heard, "closest": list(closest), "reason": reason}

        def log(outcome: str, latency: float, mock: bool, what: str) -> Dict[str, Any]:
            return self.log.log(f"{short_quote(heard)} → {what}", latency, outcome, mock)

        if not allow_claude:  # always-listening: ambient speech never goes to Claude
            return none("nomatch")

        # (2) Claude fallback
        body = self.interpreter.interpret(heard, context or {})
        latency = float(body.get("latencyMs") or 0)
        mock = body.get("mock") is True
        if mock:
            status("Claude key missing: using the offline keyword matcher.", "status")
        kind = body.get("kind")
        t = self.table

        if kind == "actions":
            first = t.by_id.get(t.canonical(body.get("first")) or "")
            second_raw = body.get("second")
            second = None if second_raw is None else t.by_id.get(t.canonical(second_raw) or "")
            if first is None or (second_raw is not None and second is None):
                log("invalid", latency, mock, f"unknown id {body.get('first')}")
                return none("invalid")
            arg = body.get("arg")
            arg = arg if isinstance(arg, (int, float)) and not isinstance(arg, bool) and arg == arg else None
            arg_owner = first if first.arg == "number" else (second if second is not None and second.arg == "number" else None)
            commands: List[Dict[str, Any]] = []
            for a in (first, second):
                if a is None:
                    continue
                if a.arg == "word":  # word arguments (alias names) come from the user verbatim, never Claude
                    continue
                if a.arg == "number":
                    if a is not arg_owner or arg is None:
                        continue  # a size/opacity with no number is meaningless
                    commands.append({"action": a.id, "arg": arg})
                else:
                    commands.append({"action": a.id})
            if not commands:
                log("invalid", latency, mock, "no usable action")
                return none("invalid")
            what = " + ".join(f"{c['action']} {_fmt(c['arg'])}" if c.get("arg") is not None else c["action"] for c in commands)
            self.last_claude_log_id = log("accepted", latency, mock, what)["id"]
            return {"kind": "commands", "commands": commands, "heard": heard, "via": "claude"}
        if kind == "clarify":
            options: List[str] = []
            for o in body.get("options") or []:
                c = t.canonical(o)
                if c and c not in options:
                    options.append(c)
            options = options[:3]
            if not options:
                log("invalid", latency, mock, "empty clarify")
                return none("invalid")
            self.last_clarify_log_id = log("pending", latency, mock, f"clarify {' / '.join(options)}")["id"]
            return {"kind": "clarify", "options": options, "heard": heard}
        if kind == "noop":
            log("noop", latency, mock, "noop")
            return {"kind": "noop", "heard": heard}
        if kind == "error":
            reason = str(body.get("reason") or "upstream")
            log(reason, latency, mock, reason)
            if reason == "key_missing":
                status("Claude key missing: only exact commands work.", "status")
            if reason in ("timeout", "invalid", "key_missing"):
                return none(reason)
            if reason == "offline":
                status("Offline: only exact commands work. Tiles, keys and the typed box still work.", "status")
            return none("offline")
        log("invalid", latency, mock, "malformed response")
        return none("invalid")


def _fmt(v: Any) -> str:
    return str(int(v)) if isinstance(v, float) and v.is_integer() else str(v)
