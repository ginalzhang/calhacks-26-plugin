/**
 * Local command grammar (§6), generated from src/actions.ts. Pure; shared by voice transcripts
 * and the typed-command box.
 *
 * Rules:
 * - normalise (lowercase, strip punctuation), tokenise;
 * - segment longest-phrase-first; at each position: exact phrase → stoplist word (skipped,
 *   never matches) → number (tolerated leftover) → fuzzy phrase → otherwise the WHOLE utterance
 *   is a no-match;
 * - fuzzy only for phrases ≥ 5 chars (Levenshtein ≤ 1 for 5–7 chars, ≤ 2 for longer), never
 *   for `fuzzyAllowed: false` or `modeChanging` rows, never while a dialog is open; a fuzzy tie
 *   between two actions is a no-match;
 * - ≤ 2 commands per utterance (consecutive "undo that"/"redo" coalesce into one with
 *   arg = count, executed serially by the caller);
 * - `arg: "number"` actions take digits or number words ("twenty", "fifty five");
 * - voice mode matches voice phrases; typed mode also matches `typed` forms;
 * - rows whose phase is later than opts.phase (default BUILD_PHASE) are excluded;
 * - user aliases (P2b) match exactly as { action: "alias", variant: presetName };
 * - `use_profile` / `save_profile` take a multi-word name: the rest of the utterance goes in
 *   `variant` ("use profile shaky day" → "shaky day"); such a command never chains;
 * - an action with phraseVariants matched by its typed form takes a following variant word
 *   ("app krita" → app_profile/krita);
 * - `arg: "word"` (name_brush: "call this brush fluffy", typed "alias fluffy") puts the word in
 *   `variant`; a word refused by validateAlias returns a no-match with `refused` (isAliasRefusal).
 */
import { ACTIONS, BUILD_PHASE, EXTRA_KEYTERMS, phaseAtMost, STOPLIST, type Action, type Phase } from "../actions";
import type { ParsedCommand, ParseOptions, ParseResult } from "./types";

export const MAX_COMMANDS = 2;
export const KEYTERM_MAX_ENTRIES = 100;
export const KEYTERM_MAX_CHARS = 1200;
/** Action id returned for a user alias match (variant = stored preset name). */
export const ALIAS_ACTION = "alias";

const COALESCE = new Set(["undo", "redo"]);
/** `arg: "word"` actions whose argument may be several words (the rest of the utterance). */
export const MULTI_WORD_ARG = new Set(["use_profile", "save_profile"]);

interface PhraseEntry {
  phrase: string;
  words: number;
  action: Action;
  variant?: string;
  fuzzy: boolean;
}

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9%\s-]/g, " ")
    .replace(/-/g, " ")
    .replace(/%/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Fuzzy threshold for a phrase: 0 under 5 chars, 1 for 5–7, 2 for 8+. */
export function fuzzyThreshold(phrase: string): number {
  const n = phrase.length;
  if (n < 5) return 0;
  return n <= 7 ? 1 : 2;
}

/** Whether a row may ever be fuzzy-matched. */
export function fuzzyEligible(a: Action): boolean {
  return a.fuzzyAllowed && !a.modeChanging;
}

function entries(mode: "voice" | "typed", phase: Phase): PhraseEntry[] {
  const out: PhraseEntry[] = [];
  const seen = new Set<string>();
  for (const a of ACTIONS) {
    if (!phaseAtMost(a.phase, phase)) continue;
    const phrases = [...a.voicePhrases];
    if (mode === "typed" && a.typed) phrases.push(a.typed);
    for (const raw of phrases) {
      const phrase = normalize(raw);
      if (!phrase || seen.has(phrase)) continue;
      seen.add(phrase);
      out.push({
        phrase,
        words: phrase.split(" ").length,
        action: a,
        variant: a.phraseVariants?.[raw] ?? a.phraseVariants?.[phrase],
        fuzzy: fuzzyEligible(a) && phrase.length >= 5,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- numbers

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

export function isNumberToken(tok: string): boolean {
  return /^\d+(\.\d+)?$/.test(tok) || tok in UNITS || tok in TENS || tok === "hundred";
}

/** Parse a number at tokens[i…]; returns value and tokens consumed, or null. */
export function parseNumberAt(tokens: string[], i: number): { value: number; used: number } | null {
  const t0 = tokens[i];
  if (t0 === undefined) return null;
  if (/^\d+(\.\d+)?$/.test(t0)) return { value: Number(t0), used: 1 };
  let value = 0;
  let used = 0;
  let j = i;
  // [unit] hundred [and]
  if (tokens[j] in UNITS && tokens[j + 1] === "hundred") {
    value = UNITS[tokens[j]] * 100;
    j += 2;
    used += 2;
    if (tokens[j] === "and") {
      j++;
      used++;
    }
  } else if (tokens[j] === "hundred") {
    value = 100;
    j++;
    used++;
  }
  if (tokens[j] in TENS) {
    value += TENS[tokens[j]];
    j++;
    used++;
    if (tokens[j] in UNITS && UNITS[tokens[j]] > 0 && UNITS[tokens[j]] < 10) {
      value += UNITS[tokens[j]];
      j++;
      used++;
    }
  } else if (tokens[j] in UNITS) {
    value += UNITS[tokens[j]];
    j++;
    used++;
  }
  if (used === 0 || (used > 0 && tokens[i + used - 1] === "and")) return used ? { value, used: used - 1 } : null;
  return { value, used };
}

// ---------------------------------------------------------------- matching

/**
 * A `name_brush` command whose word is taken ("call this brush blue") is a no-match that also
 * carries `refused`, so the caller says "That word is taken" instead of asking Claude.
 * `ParseResult` is unchanged; narrow with `isAliasRefusal(r)`.
 */
export type AliasRefusal = Extract<ParseResult, { kind: "nomatch" }> & {
  refused: { reason: "alias_taken"; word: string };
};

export function isAliasRefusal(r: ParseResult): r is AliasRefusal {
  return r.kind === "nomatch" && "refused" in r && (r as AliasRefusal).refused?.reason === "alias_taken";
}

interface Segment {
  cmd: ParsedCommand;
  fuzzy: boolean;
}

/**
 * Fuzzy pick of one window among candidate phrases: the closest phrase within its threshold;
 * two different actions at the same best distance = "tie" (no match).
 */
export function fuzzyPick<E extends { phrase: string; id: string }>(window: string, candidates: E[]): E | "tie" | null {
  let best = Infinity;
  let hits: E[] = [];
  for (const e of candidates) {
    const d = levenshtein(window, e.phrase);
    if (d > fuzzyThreshold(e.phrase)) continue;
    if (d < best) {
      best = d;
      hits = [e];
    } else if (d === best) hits.push(e);
  }
  if (hits.length === 0) return null;
  return new Set(hits.map((h) => h.id)).size > 1 ? "tie" : hits[0];
}

function fuzzyAt(tokens: string[], i: number, table: PhraseEntry[], maxWords: number): { entry: PhraseEntry; k: number } | "tie" | null {
  const cands = table.filter((e) => e.fuzzy).map((e) => ({ phrase: e.phrase, id: e.action.id, e }));
  for (let k = Math.min(maxWords, tokens.length - i); k >= 1; k--) {
    const window = tokens.slice(i, i + k).join(" ");
    if (window.length < 3) continue;
    const r = fuzzyPick(window, cands);
    if (r === "tie") return "tie";
    if (r) return { entry: r.e, k };
  }
  return null;
}

/**
 * Whole-utterance soundalikes for very short commands that speech recognisers often split or bend (real-Mac
 * report 18:55 Sat: "undo" sometimes needed repeating). Voice mode only, and only when the ENTIRE transcript is
 * the soundalike, so normal speech containing these words is never turned into a command.
 */
export const VOICE_SOUNDALIKES: Record<string, string> = {
  "un do": "undo",
  "and do": "undo",
  "on do": "undo",
  "in do": "undo",
  "undue": "undo",
  "undoo": "undo",
  "undo it": "undo",
  "undo undo": "undo that undo that",
  "re do": "redo",
  "redo it": "redo",
};

export function parseCommand(text: string, opts: ParseOptions): ParseResult {
  if (opts.mode === "voice" && !opts.dialogOpen) {
    const sub = VOICE_SOUNDALIKES[normalize(text)];
    if (sub) text = sub;
  }
  const phase = opts.phase ?? BUILD_PHASE;
  const table = entries(opts.mode, phase);
  const byPhrase = new Map(table.map((e) => [e.phrase, e]));
  const maxWords = Math.max(1, ...table.map((e) => e.words));
  const aliases = new Map(Object.entries(opts.aliases ?? {}).map(([w, p]) => [normalize(w), p]));
  const stop = new Set(STOPLIST);
  const tokens = normalize(text).split(" ").filter(Boolean);
  const nomatch = (): ParseResult => ({ kind: "nomatch", closest: closestActions(text, 2, { mode: opts.mode, phase }) });
  if (tokens.length === 0) return nomatch();

  const segs: Segment[] = [];
  let i = 0;
  while (i < tokens.length) {
    // 1. exact, longest first
    let matched: { entry: PhraseEntry; k: number } | null = null;
    for (let k = Math.min(maxWords, tokens.length - i); k >= 1 && !matched; k--) {
      const e = byPhrase.get(tokens.slice(i, i + k).join(" "));
      if (e) matched = { entry: e, k };
    }
    let fuzzy = false;
    if (!matched) {
      // 1b. user aliases (exact only)
      const alias = aliases.get(tokens[i]);
      if (alias !== undefined) {
        segs.push({ cmd: { action: ALIAS_ACTION, variant: alias }, fuzzy: false });
        i++;
        continue;
      }
      // 2. stoplist words never match anything
      if (stop.has(tokens[i])) {
        i++;
        continue;
      }
      // 3. a leftover number is tolerated
      if (isNumberToken(tokens[i])) {
        const n = parseNumberAt(tokens, i);
        i += Math.max(1, n?.used ?? 1);
        continue;
      }
      // 4. fuzzy (never in dialogs)
      if (!opts.dialogOpen) {
        const f = fuzzyAt(tokens, i, table, maxWords);
        if (f === "tie") return nomatch();
        if (f) {
          matched = f;
          fuzzy = true;
        }
      }
    }
    if (!matched) return nomatch();
    const { entry, k } = matched;
    i += k;
    const cmd: ParsedCommand = { action: entry.action.id };
    if (entry.variant) cmd.variant = entry.variant;
    else if (entry.action.phraseVariants) {
      // Typed form + variant word, e.g. "app krita" / "app photoshop".
      const values = new Set(Object.values(entry.action.phraseVariants));
      if (i < tokens.length && values.has(tokens[i])) {
        cmd.variant = tokens[i];
        i++;
      }
    }
    if (entry.action.arg === "word" && MULTI_WORD_ARG.has(entry.action.id)) {
      // Profile names may be several words ("use profile shaky day"): the rest of the utterance
      // is the name (leading fillers dropped), so a profile command never chains.
      while (i < tokens.length && stop.has(tokens[i])) i++;
      const name = tokens.slice(i).join(" ");
      i = tokens.length;
      if (name) cmd.variant = name;
      else cmd.arg = null;
    } else if (entry.action.arg === "word") {
      // "call this brush fluffy" / "alias fluffy": the next non-filler token is the word.
      while (i < tokens.length && stop.has(tokens[i])) i++;
      const word = tokens[i];
      if (word === undefined) {
        cmd.arg = null; // no word: the caller opens the "Name this brush" text field
      } else {
        i++;
        if (validateAlias(word) === "taken") {
          const r: AliasRefusal = { kind: "nomatch", closest: [entry.action.id], refused: { reason: "alias_taken", word } };
          return r;
        }
        cmd.variant = word;
      }
    } else if (entry.action.arg === "number") {
      const n = parseNumberAt(tokens, i);
      if (n) {
        cmd.arg = n.value;
        i += n.used;
      } else {
        cmd.arg = null;
      }
    }
    segs.push({ cmd, fuzzy });
  }
  if (segs.length === 0) return nomatch();

  // Coalesce repeated undo/redo into a count.
  const cmds: Segment[] = [];
  for (const s of segs) {
    const prev = cmds[cmds.length - 1];
    if (prev && COALESCE.has(s.cmd.action) && prev.cmd.action === s.cmd.action) {
      prev.cmd.arg = (prev.cmd.arg ?? 1) + 1;
      prev.fuzzy = prev.fuzzy || s.fuzzy;
      continue;
    }
    cmds.push({ cmd: { ...s.cmd }, fuzzy: s.fuzzy });
  }
  if (cmds.length > MAX_COMMANDS) return nomatch();
  return { kind: "match", commands: cmds.map((s) => s.cmd), fuzzy: cmds.some((s) => s.fuzzy) };
}

/** Up to n action ids whose phrases are closest to the text (normalised edit distance). */
export function closestActions(text: string, n: number, opts: { mode?: "voice" | "typed"; phase?: Phase } = {}): string[] {
  const table = entries(opts.mode ?? "typed", opts.phase ?? BUILD_PHASE);
  const tokens = normalize(text).split(" ").filter((t) => t && !STOPLIST.includes(t));
  if (tokens.length === 0) return [];
  const score = new Map<string, number>();
  for (const e of table) {
    if (e.action.id.startsWith("choice_") || e.action.page === "dialog") continue;
    let best = Infinity;
    for (let k = 1; k <= Math.min(e.words + 1, tokens.length); k++) {
      for (let i = 0; i + k <= tokens.length; i++) {
        const w = tokens.slice(i, i + k).join(" ");
        best = Math.min(best, levenshtein(w, e.phrase) / Math.max(w.length, e.phrase.length));
      }
    }
    const prev = score.get(e.action.id);
    if (prev === undefined || best < prev) score.set(e.action.id, best);
  }
  return [...score.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([id]) => id);
}

/**
 * Cartesia keyterms: every voice phrase of rows up to `phase` (default: all) plus EXTRA_KEYTERMS
 * ("layer"), unique, exact casing. Aliases are excluded. ≤ 100 entries and ≤ 1200 chars.
 */
export function keyterms(phase: Phase = "P4"): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of ACTIONS) {
    if (!phaseAtMost(a.phase, phase)) continue;
    // Demo-page controls (Simulate tremor, Next judge) are matched by the grammar but not biased in STT:
    // the keyterm budget (≤ 100) goes to painting commands.
    if (a.page === "demo") continue;
    for (const p of a.voicePhrases) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  }
  for (const p of EXTRA_KEYTERMS) {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  // Enforce the caps (drop the latest-phase phrases first if the table ever grows too big).
  while (out.length > KEYTERM_MAX_ENTRIES || out.join("").length > KEYTERM_MAX_CHARS) out.pop();
  return out;
}

/** A user alias that equals an existing phrase or falls within its fuzzy threshold is refused. */
export function validateAlias(word: string): "ok" | "taken" {
  const w = normalize(word);
  if (!w || w.includes(" ")) return "taken";
  if (STOPLIST.includes(w) || isNumberToken(w) || EXTRA_KEYTERMS.includes(w)) return "taken";
  for (const a of ACTIONS) {
    for (const raw of [...a.voicePhrases, ...(a.typed ? [a.typed] : [])]) {
      const p = normalize(raw);
      if (p === w) return "taken";
      const thr = Math.max(fuzzyThreshold(p), fuzzyThreshold(w));
      if (levenshtein(p, w) <= thr) return "taken";
    }
  }
  return "ok";
}
