import { describe, expect, it } from "vitest";
import { ACTIONS, STOPLIST } from "../actions";
import {
  closestActions,
  fuzzyEligible,
  fuzzyPick,
  isAliasRefusal,
  fuzzyThreshold,
  keyterms,
  levenshtein,
  normalize,
  parseCommand,
  parseNumberAt,
  validateAlias,
} from "./grammar";
import type { ParseOptions } from "./types";

const V: ParseOptions = { mode: "voice", phase: "P2a" };
const T: ParseOptions = { mode: "typed", phase: "P2a" };
const ids = (text: string, o: ParseOptions = V) => {
  const r = parseCommand(text, o);
  return r.kind === "match" ? r.commands.map((c) => c.action) : null;
};

describe("grammar (§6)", () => {
  it("@P2a exact single commands, case and punctuation insensitive", () => {
    expect(ids("Blue.")).toEqual(["colour_blue"]);
    expect(ids("undo that!")).toEqual(["undo"]);
    expect(ids("new layer")).toEqual(["new_layer"]);
    expect(ids("steadier")).toEqual(["steadier"]);
  });

  it("@P2a longest-phrase-first segmentation", () => {
    expect(ids("zoom in")).toEqual(["zoom_in"]);
    // P3: "ink mode" (smoothing) beats "ink" (preset) when both are in the grammar.
    expect(ids("ink mode", { mode: "voice", phase: "P3" })).toEqual(["smoothing_ink"]);
    expect(ids("ink", { mode: "voice", phase: "P3" })).toEqual(["ink"]);
    expect(ids("save skin")).toEqual(["save_skin"]);
    expect(ids("save")).toEqual(["save"]);
  });

  it("@P2a two-command chaining executes in order; three is a no-match", () => {
    expect(ids("blue bigger")).toEqual(["colour_blue", "bigger"]);
    expect(ids("bigger blue")).toEqual(["bigger", "colour_blue"]);
    expect(ids("blue bigger fade")).toBeNull();
  });

  it("@P2a repeated 'undo that' coalesces into one command with a count", () => {
    const r = parseCommand("undo that undo that undo that", V);
    expect(r).toEqual({ kind: "match", commands: [{ action: "undo", arg: 3 }], fuzzy: false });
  });

  it("@P2a a leftover non-number token is a no-match for the whole utterance", () => {
    expect(ids("blue banana")).toBeNull();
    expect(ids("paint the room")).toBeNull();
    const r = parseCommand("make it bigger please", V);
    expect(r.kind).toBe("nomatch");
    if (r.kind === "nomatch") expect(r.closest.length).toBeLessThanOrEqual(2);
    // A leftover number is tolerated.
    expect(ids("blue 5")).toEqual(["colour_blue"]);
  });

  it("@P2a stoplist words never match and are skipped as fillers", () => {
    for (const w of STOPLIST) expect(ids(w)).toBeNull();
    expect(ids("um blue")).toEqual(["colour_blue"]);
    expect(ids("uh the eraser")).toEqual(["eraser"]);
    // "in" is never fuzzy-matched to "ink"; "full" never to "fill"/"fit".
    expect(ids("in")).toBeNull();
    expect(ids("full")).toBeNull();
  });

  it("@P2a number args: digits and number words", () => {
    expect(parseCommand("size 20", T)).toMatchObject({ kind: "match", commands: [{ action: "size", arg: 20 }] });
    expect(parseCommand("size twenty", V)).toMatchObject({ commands: [{ action: "size", arg: 20 }] });
    expect(parseCommand("opacity fifty five", V)).toMatchObject({ commands: [{ action: "opacity", arg: 55 }] });
    expect(parseCommand("opacity one hundred", V)).toMatchObject({ commands: [{ action: "opacity", arg: 100 }] });
    expect(parseCommand("size seventy blue", V)).toMatchObject({
      commands: [{ action: "size", arg: 70 }, { action: "colour_blue" }],
    });
    expect(parseCommand("size", V)).toMatchObject({ commands: [{ action: "size", arg: null }] });
    expect(parseNumberAt(["ninety", "nine"], 0)).toEqual({ value: 99, used: 2 });
    expect(parseNumberAt(["seventeen"], 0)).toEqual({ value: 17, used: 1 });
  });

  it("@P2a exact then fuzzy: Levenshtein ≤ 1 for 5–7 chars, ≤ 2 for longer", () => {
    expect(parseCommand("biger", V)).toEqual({ kind: "match", commands: [{ action: "bigger" }], fuzzy: true });
    expect(ids("smallr")).toEqual(["smaller"]);
    expect(ids("steadeir")).toEqual(["steadier"]); // 8 chars, distance 2
    expect(ids("bgr")).toBeNull();
    expect(ids("bigggerr")).toBeNull(); // distance 2 from a 6-char phrase
    expect(ids("airbursh")).toEqual(["airbrush"]);
  });

  it("@P2a no fuzzy under 5 characters", () => {
    expect(ids("bleu")).toBeNull(); // "blue" is 4 chars
    expect(ids("ret")).toBeNull();
    expect(ids("sav")).toBeNull();
  });

  it("@P2a no fuzzy on mode-changing actions (latch, pause, resume, save skin…)", () => {
    expect(ids("latch")).toEqual(["latch"]);
    expect(ids("latsh")).toBeNull();
    expect(ids("pausr")).toBeNull();
    expect(ids("resumee")).toBeNull();
    expect(ids("save skim")).toBeNull();
    expect(ids("recalibrat")).toBeNull();
  });

  it("@P2a a fuzzy tie between two actions is no match", () => {
    // The shipped table has no real tie (see the next test), so check the rule directly.
    const cands = [
      { phrase: "darker", id: "darker" },
      { phrase: "danker", id: "other" },
    ];
    expect(fuzzyPick("dacker", cands)).toBe("tie");
    expect(fuzzyPick("darkr", cands)).toEqual(cands[0]);
    expect(fuzzyPick("darker", [cands[0], { phrase: "darker", id: "darker" }])).toEqual(cands[0]); // same action: not a tie
    expect(fuzzyPick("xyzzy", cands)).toBeNull();
    expect(ids("zoom on")).toEqual(["zoom_in"]);
  });

  it("@P2a no two phrases are within each other's fuzzy threshold (fuzzy-eligible pairs)", () => {
    const all = ACTIONS.flatMap((a) =>
      [...a.voicePhrases, ...(a.typed ? [a.typed] : [])].map((p) => ({ p: normalize(p), a })),
    );
    const clashes: string[] = [];
    for (const x of all) {
      if (!fuzzyEligible(x.a) || x.p.length < 5) continue;
      for (const y of all) {
        if (x.a.id === y.a.id) continue;
        if (levenshtein(x.p, y.p) <= fuzzyThreshold(x.p)) clashes.push(`${x.p} ~ ${y.p}`);
      }
    }
    expect(clashes).toEqual([]);
  });

  it("@P2a while a dialog is open only exact matches count", () => {
    expect(ids("yes", { ...V, dialogOpen: true })).toEqual(["yes"]);
    expect(ids("biger", { ...V, dialogOpen: true })).toBeNull();
    expect(ids("yess", { ...V, dialogOpen: true })).toBeNull();
  });

  it("@P2a typed mode also matches typed forms; voice mode does not", () => {
    expect(ids("undo", T)).toEqual(["undo"]);
    expect(ids("undo", V)).toBeNull(); // bare "undo" is not a voice phrase
    expect(ids("1", T)).toEqual(["choice_one"]);
    expect(ids("down", V)).toEqual(["pen_down"]);
  });

  it("@P2a phrase variants: pause / stop → pause, resume → resume", () => {
    expect(parseCommand("stop", V)).toMatchObject({ commands: [{ action: "pause", variant: "pause" }] });
    expect(parseCommand("pause", V)).toMatchObject({ commands: [{ action: "pause", variant: "pause" }] });
    expect(parseCommand("resume", V)).toMatchObject({ commands: [{ action: "pause", variant: "resume" }] });
  });

  it("@P2a rows whose phase is later than opts.phase are excluded", () => {
    expect(ids("hatch", V)).toBeNull(); // P2b
    expect(ids("hatch", { mode: "voice", phase: "P2b" })).toEqual(["hatch"]);
    expect(ids("hatch left to right", { mode: "voice", phase: "P2b" })).toEqual(["hatch_lr"]);
    expect(ids("blue", { mode: "voice", phase: "P1" })).toBeNull();
  });

  it("@P2a never 'pen' (collides with 'ten')", () => {
    expect(ids("pen")).toBeNull();
  });

  it("@P2a closestActions returns up to n ids", () => {
    const c = closestActions("make it bigger", 2, { phase: "P2a" });
    expect(c).toHaveLength(2);
    expect(c[0]).toBe("bigger");
  });

  it("@P2a keyterm list ≤ 100 entries and ≤ 1200 characters, includes 'layer', excludes aliases", () => {
    const k = keyterms();
    expect(k.length).toBeLessThanOrEqual(100);
    expect(k.join("").length).toBeLessThanOrEqual(1200);
    expect(k).toContain("layer");
    expect(k).toContain("later");
    expect(k).toContain("undo that");
    expect(new Set(k).size).toBe(k.length);
    // Every voice phrase in the table is a keyterm (nothing was dropped by the caps).
    for (const a of ACTIONS) for (const p of a.voicePhrases) expect(k).toContain(p);
  });

  it("@P2a alias collision refused: equal or within a phrase's fuzzy threshold", () => {
    expect(validateAlias("blue")).toBe("taken");
    expect(validateAlias("bigge")).toBe("taken");
    expect(validateAlias("steadie")).toBe("taken");
    expect(validateAlias("the")).toBe("taken");
    expect(validateAlias("fluffy")).toBe("ok");
    expect(validateAlias("scratchy")).toBe("ok");
  });

  it("@P2a aliases match exactly as the alias action", () => {
    const r = parseCommand("fluffy bigger", { ...V, aliases: { fluffy: "Soft Fluffy Brush" } });
    expect(r).toMatchObject({
      kind: "match",
      commands: [{ action: "alias", variant: "Soft Fluffy Brush" }, { action: "bigger" }],
    });
  });
});

describe("name_brush (aliases)", () => {
  const V2: ParseOptions = { mode: "voice", phase: "P2b" };
  const T2: ParseOptions = { mode: "typed", phase: "P2b" };
  it("@P2b 'call this brush fluffy' and typed 'alias fluffy' → name_brush with the word in variant", () => {
    expect(parseCommand("Call this brush fluffy.", V2)).toEqual({
      kind: "match",
      commands: [{ action: "name_brush", variant: "fluffy" }],
      fuzzy: false,
    });
    expect(parseCommand("alias fluffy", T2)).toMatchObject({ kind: "match", commands: [{ action: "name_brush", variant: "fluffy" }] });
    expect(parseCommand("alias fluffy", V2).kind).toBe("nomatch"); // "alias" is the typed form only
    // Not the "brush" preset: longest-first.
    expect(parseCommand("call this brush scratchy bigger", V2)).toMatchObject({
      commands: [{ action: "name_brush", variant: "scratchy" }, { action: "bigger" }],
    });
  });

  it("@P2b a taken word is refused with a reason (never stored, never sent to Claude)", () => {
    for (const w of ["blue", "bigge", "the", "twenty"]) {
      const r = parseCommand(`call this brush ${w} please`.replace(" please", ""), V2);
      if (w === "the") {
        // filler skipped; no word left → opens the text field
        expect(r).toMatchObject({ kind: "match", commands: [{ action: "name_brush", arg: null }] });
        continue;
      }
      expect(r.kind).toBe("nomatch");
      expect(isAliasRefusal(r)).toBe(true);
      if (isAliasRefusal(r)) expect(r.refused).toEqual({ reason: "alias_taken", word: w });
    }
    expect(isAliasRefusal(parseCommand("banana", V2))).toBe(false);
  });

  it("@P2b without a word, name_brush returns arg null (the caller opens the text field)", () => {
    expect(parseCommand("call this brush", V2)).toMatchObject({ kind: "match", commands: [{ action: "name_brush", arg: null }] });
  });

  it("@P2b name_brush is excluded before P2b", () => {
    expect(parseCommand("call this brush fluffy", { mode: "voice", phase: "P2a" }).kind).toBe("nomatch");
  });
});
