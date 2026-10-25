"""Cartesia keyterms (§6, §8): every voice phrase in the action table + EXTRA_KEYTERMS ("layer"), unique, exact
casing, aliases excluded; <= 100 terms and <= 1200 characters total (Cartesia's limits). Immutable per connection.
Same order and caps as src/pipeline/grammar.ts keyterms(), then the defensive limit of src/voice/keyterms.ts.
"""

from __future__ import annotations

from typing import Iterable, List, Optional

from .actions import PHASE_ORDER, ActionTable, table

KEYTERM_MAX_COUNT = 100
KEYTERM_MAX_CHARS = 1200

# Used only if the action table cannot be read at all (never expected: the snapshot ships with the package).
BUILTIN_KEYTERMS = [
    "down", "up", "stop", "resume", "undo that", "redo", "steadier", "looser", "brush", "pencil", "ink",
    "airbrush", "eraser", "bigger", "smaller", "fade", "solid", "black", "white", "red", "blue", "green",
    "yellow", "orange", "purple", "brown", "grey", "lighter", "darker", "zoom in", "zoom out", "fit",
    "new layer", "save", "quiet mode", "yes", "cancel", "one", "two", "three", "layer",
]


def grammar_keyterms(t: Optional[ActionTable] = None, phase: str = "P4") -> List[str]:
    t = t or table()
    maxp = PHASE_ORDER.index(phase) if phase in PHASE_ORDER else len(PHASE_ORDER) - 1
    out: List[str] = []
    seen = set()
    for a in t.actions:
        if a.phase in PHASE_ORDER and PHASE_ORDER.index(a.phase) > maxp:
            continue
        if a.page == "demo":  # grammar.ts: demo controls are matched but not biased in STT (budget <= 100)
            continue
        for p in a.voice_phrases:
            if p not in seen:
                seen.add(p)
                out.append(p)
    for p in t.extra_keyterms:
        if p not in seen:
            seen.add(p)
            out.append(p)
    while len(out) > KEYTERM_MAX_COUNT or len("".join(out)) > KEYTERM_MAX_CHARS:
        out.pop()
    return out


def limit_keyterms(terms: Iterable[str]) -> List[str]:
    out: List[str] = []
    seen = set()
    chars = 0
    for raw in terms:
        t = str(raw).strip()
        if not t or t in seen:
            continue
        if len(out) >= KEYTERM_MAX_COUNT:
            break
        if chars + len(t) > KEYTERM_MAX_CHARS:
            continue
        seen.add(t)
        out.append(t)
        chars += len(t)
    return out


def stt_keyterms(t: Optional[ActionTable] = None) -> List[str]:
    try:
        terms = grammar_keyterms(t)
    except Exception:
        terms = []
    return limit_keyterms(terms or BUILTIN_KEYTERMS)
