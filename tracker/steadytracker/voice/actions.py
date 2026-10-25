"""The action table as voice needs it: keyterms, the Claude id list, SYSTEM_BLOCK rows, canonical ids.

Source, in order:
1. ``$STEADY_ACTIONS_JSON`` or ``<repo>/krita-plugin/pykrita/steady/actions.json`` (agent D generates it from
   src/actions.ts). Rows missing fields (page, phase, arg, ...) are completed from the snapshot by id.
2. ``data/actions_snapshot.json``: a snapshot of src/actions.ts taken by agent E (travels with the package, so
   the app bundle always has a table).
Accepted shapes: a list of rows, or ``{"actions": [...], "extraKeyterms"?: [...], "presetFamilies"?: [...]}``;
row keys camelCase (``voicePhrases``) or snake_case (``voice_phrases``).
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

HERE = Path(__file__).resolve().parent
SNAPSHOT_PATH = HERE / "data" / "actions_snapshot.json"
REPO_ROOT = HERE.parents[2]  # tracker/steadytracker/voice -> repo
PLUGIN_ACTIONS_PATH = REPO_ROOT / "krita-plugin" / "pykrita" / "steady" / "actions.json"

PHASE_ORDER = ["P0", "P1", "P2a", "P2b", "P3", "P4"]
DEFAULT_EXTRA_KEYTERMS = ["layer"]
DEFAULT_PRESET_FAMILIES = ["basic", "pencil", "ink", "airbrush", "eraser"]
# Demo-panel controls and clearing the practice canvas are never Claude's call (schema.ts NEVER_CLAUDE).
NEVER_CLAUDE = {"simulate_tremor", "next_judge", "clear_practice"}

_CAMEL = {
    "voice_phrases": "voicePhrases",
    "mode_changing": "modeChanging",
    "tile_phase": "tilePhase",
}


@dataclass
class ActionRow:
    id: str
    label: str
    voice_phrases: List[str]
    phase: str = "P0"
    page: str = "paint"
    destructive: bool = False
    mode_changing: bool = False
    arg: Optional[str] = None
    help: Optional[str] = None


@dataclass
class ActionTable:
    actions: List[ActionRow]
    extra_keyterms: List[str] = field(default_factory=lambda: list(DEFAULT_EXTRA_KEYTERMS))
    preset_families: List[str] = field(default_factory=lambda: list(DEFAULT_PRESET_FAMILIES))
    build_phase: str = "P4"
    source: str = "snapshot"

    def __post_init__(self) -> None:
        self.by_id: Dict[str, ActionRow] = {a.id: a for a in self.actions}
        self._lower = {a.id.lower(): a.id for a in self.actions}

    def canonical(self, v: Any) -> Optional[str]:
        """Case-insensitive action id -> canonical id, or None."""
        if not isinstance(v, str):
            return None
        return self._lower.get(v.strip().lower())

    @property
    def claude_phase(self) -> str:
        bp = self.build_phase if self.build_phase in PHASE_ORDER else "P4"
        return bp if PHASE_ORDER.index(bp) > PHASE_ORDER.index("P2b") else "P2b"

    def claude_action_ids(self) -> List[str]:
        """Port of schema.ts CLAUDE_ACTION_IDS (order = table order)."""
        cp = PHASE_ORDER.index(self.claude_phase)
        out = []
        for a in self.actions:
            if not a.voice_phrases or a.page in ("dialog", "demo") or a.id in NEVER_CLAUDE or a.arg == "word":
                continue
            if PHASE_ORDER.index(a.phase if a.phase in PHASE_ORDER else "P4") > cp:
                continue
            out.append(a.id)
        return out


def _norm_row(raw: Dict[str, Any]) -> Dict[str, Any]:
    return {_CAMEL.get(k, k): v for k, v in raw.items()}


def _row(d: Dict[str, Any]) -> ActionRow:
    return ActionRow(
        id=str(d["id"]),
        label=str(d.get("label") or d["id"]),
        voice_phrases=[str(p) for p in (d.get("voicePhrases") or [])],
        phase=str(d.get("phase") or "P0"),
        page=str(d.get("page") or "paint"),
        destructive=bool(d.get("destructive", False)),
        mode_changing=bool(d.get("modeChanging", False)),
        arg=d.get("arg") if d.get("arg") in ("number", "word") else None,
        help=d.get("help") or None,
    )


def _read(path: Path) -> Optional[Dict[str, Any]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if isinstance(data, list):
        data = {"actions": data}
    if not isinstance(data, dict) or not isinstance(data.get("actions"), list):
        return None
    return data


def load_table(path: Optional[os.PathLike] = None) -> ActionTable:
    snap = _read(SNAPSHOT_PATH) or {"actions": []}
    snap_rows = {r["id"]: _norm_row(r) for r in snap["actions"] if isinstance(r, dict) and "id" in r}
    candidates = [Path(path)] if path else []
    env = os.environ.get("STEADY_ACTIONS_JSON")
    if env:
        candidates.append(Path(env))
    candidates.append(PLUGIN_ACTIONS_PATH)
    for c in candidates:
        data = _read(c)
        if not data:
            continue
        rows = []
        for r in data["actions"]:
            if not isinstance(r, dict) or "id" not in r:
                continue
            row = _norm_row(r)
            # D's file carries every field now: use it as is. Only an old-style row without voicePhrases is
            # completed from the snapshot by id.
            merged = {} if "voicePhrases" in row else dict(snap_rows.get(r["id"], {}))
            merged.update({k: v for k, v in row.items() if v is not None})
            rows.append(_row(merged))
        if rows:
            return ActionTable(
                actions=rows,
                extra_keyterms=list(data.get("extraKeyterms") or data.get("extra_keyterms") or snap.get("extraKeyterms") or DEFAULT_EXTRA_KEYTERMS),
                preset_families=list(data.get("presetFamilies") or data.get("preset_families") or snap.get("presetFamilies") or DEFAULT_PRESET_FAMILIES),
                build_phase=str(data.get("buildPhase") or data.get("build_phase") or snap.get("buildPhase") or "P4"),
                source=str(c),
            )
    return ActionTable(
        actions=[_row(r) for r in snap_rows.values()],
        extra_keyterms=list(snap.get("extraKeyterms") or DEFAULT_EXTRA_KEYTERMS),
        preset_families=list(snap.get("presetFamilies") or DEFAULT_PRESET_FAMILIES),
        build_phase=str(snap.get("buildPhase") or "P4"),
        source="snapshot",
    )


_table: Optional[ActionTable] = None


def table() -> ActionTable:
    global _table
    if _table is None:
        _table = load_table()
    return _table
