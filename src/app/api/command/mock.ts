/**
 * Mock interpreter used when ANTHROPIC_API_KEY is missing (docs/API.md: "Mock mode (no key) uses a
 * small keyword matcher and returns mock: true"). Deterministic; mirrors the SYSTEM_BLOCK rules
 * closely enough for the demo ("make it thinner and a bit softer" → smaller + airbrush).
 * Returns null when nothing matched: the route then answers {kind:"error", reason:"key_missing"}.
 */
import type { ActionsOutput } from "./schema";
import { CLAUDE_ACTION_IDS } from "./schema";

const RULES: Array<[RegExp, string]> = [
  [/\b(thinner|finer|narrower|tinier|smaller|thin|skinnier)\b/, "smaller"],
  [/\b(thicker|fatter|wider|larger|bigger|chunkier)\b/, "bigger"],
  [/\b(softer|soft|fuzzier|fuzzy|blurr(y|ier)|gentler|misty|airbrush)\b/, "airbrush"],
  [/\b(see[- ]through|fainter|faint|ghostly|transparent)\b/, "fade"],
  [/\b(opaque|solid)\b/, "solid"],
  [/\b(rub (it|that) out|erase|eraser|rubber)\b/, "eraser"],
  [/\b(pencil|sketchy)\b/, "pencil"],
  [/\b(inky|crisp|sharp line|ink pen)\b/, "ink"],
  [/\b(back to (painting|the brush|brush)|normal brush|paintbrush)\b/, "brush"],
  [/\b(oops|go back|take (that|it) back|undo)\b/, "undo"],
  [/\b(do (it|that) again|redo|put (it|that) back)\b/, "redo"],
  [/\b(closer|magnify|enlarge the view|zoom in)\b/, "zoom_in"],
  [/\b(further away|farther|see more|zoom out)\b/, "zoom_out"],
  [/\b(whole (thing|picture|image|canvas)|fit)\b/, "fit"],
  [/\b(fresh layer|another layer|new layer|blank layer)\b/, "new_layer"],
  [/\b(wobbl\w*|shak\w*|smoother|steadier|jitter\w*)\b/, "steadier"],
  [/\b(lagg?ing|too slow|more responsive|looser)\b/, "looser"],
  [/\b(tilt|rotate|turn)\b.*\bleft\b/, "turn_left"],
  [/\b(tilt|rotate|turn)\b.*\bright\b/, "turn_right"],
  [/\b(flip|mirror)\b/, "mirror"],
  [/\b(save|keep (it|this))\b/, "save"],
  [/\b(navy|sky|teal|blue)\b/, "colour_blue"],
  [/\b(crimson|scarlet|red)\b/, "colour_red"],
  [/\b(gr[ae]y|silver)\b/, "colour_grey"],
  [/\b(violet|purple)\b/, "colour_purple"],
  [/\b(tan|brown)\b/, "colour_brown"],
  [/\b(lime|green)\b/, "colour_green"],
  [/\b(gold|yellow)\b/, "colour_yellow"],
  [/\b(orange)\b/, "colour_orange"],
  [/\b(black)\b/, "colour_black"],
  [/\b(white)\b/, "colour_white"],
  [/\b(deeper|richer|darker)\b/, "darker"],
];

const AMBIGUOUS: Array<[RegExp, string[]]> = [
  [/^(make (it|this) )?(a bit |a little )?(lighter|paler)$/, ["lighter", "fade"]],
  [/^(something|make (it|this)) softer$/, ["airbrush", "fade"]],
];

const FILLER = /^(\W|um+|uh+|hmm+|erm|okay|ok|yeah|cough|\*cough\*|thanks|thank you)*$/;

const NUMBER_WORDS: Record<string, number> = {
  five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};

function findNumber(t: string): number | null {
  const d = t.match(/\b(\d{1,4})\b/);
  if (d) return Number(d[1]);
  for (const [w, n] of Object.entries(NUMBER_WORDS)) if (new RegExp(`\\b${w}\\b`).test(t)) return n;
  if (/\bhalf\b/.test(t)) return 50;
  return null;
}

export function mockInterpret(text: string): ActionsOutput | null {
  const t = text.toLowerCase().replace(/[^\w\s*'-]/g, " ").replace(/\s+/g, " ").trim();
  if (!t || FILLER.test(t.replace(/\s/g, ""))) return { kind: "noop" };
  for (const [re, options] of AMBIGUOUS) if (re.test(t)) return { kind: "clarify", options };

  const n = findNumber(t);
  if (n !== null && /\b(size|brush|pen|width)\b/.test(t)) return { kind: "actions", first: "size", second: null, arg: n };
  if (n !== null && /\b(opacity|see[- ]through|transparen\w*)\b/.test(t)) {
    return { kind: "actions", first: "opacity", second: null, arg: n };
  }

  const hits: Array<{ at: number; id: string }> = [];
  for (const [re, id] of RULES) {
    if (!CLAUDE_ACTION_IDS.includes(id)) continue;
    const m = re.exec(t);
    if (m && !hits.some((h) => h.id === id)) hits.push({ at: m.index, id });
  }
  hits.sort((a, b) => a.at - b.at);
  if (hits.length === 0) return null;
  return { kind: "actions", first: hits[0].id, second: hits[1]?.id ?? null, arg: null };
}
