import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HelperToWorkerSchema,
  KritaCommandSchema,
  PluginReplySchema,
  PluginRequestSchema,
  WorkerToHelperSchema,
  parseHelperToWorker,
  parseWorkerToHelper,
} from "./protocol";

type Examples = Record<"worker_to_helper" | "helper_to_worker" | "plugin_request" | "plugin_reply", Record<string, unknown>>;
const EX = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../docs/protocol-examples.json"), "utf8"),
) as Examples;

/** Parse, re-serialise, parse again: the wire form must be stable and lose nothing. */
function roundTrip(schema: { parse: (v: unknown) => unknown }, ex: unknown) {
  const first = schema.parse(ex);
  const wire = JSON.parse(JSON.stringify(first));
  const second = schema.parse(wire);
  expect(second).toEqual(first);
  expect(wire).toEqual(ex);
}

describe("protocol-examples.json round-trips through protocol.ts", () => {
  for (const [name, ex] of Object.entries(EX.worker_to_helper)) {
    it(`@P1 worker→helper ${name}`, () => {
      roundTrip(WorkerToHelperSchema, ex);
      expect(parseWorkerToHelper(ex)).not.toBeNull();
    });
  }
  for (const [name, ex] of Object.entries(EX.helper_to_worker)) {
    it(`@P1 helper→worker ${name}`, () => {
      roundTrip(HelperToWorkerSchema, ex);
      expect(parseHelperToWorker(ex)).not.toBeNull();
    });
  }
  for (const [name, ex] of Object.entries(EX.plugin_request)) {
    it(`@P1 plugin request ${name}`, () => {
      roundTrip(PluginRequestSchema, ex);
      const { id: _id, ...cmd } = ex as { id: string };
      expect(KritaCommandSchema.safeParse(cmd).success).toBe(true);
    });
  }
  for (const [name, ex] of Object.entries(EX.plugin_reply)) {
    it(`@P1 plugin reply ${name}`, () => roundTrip(PluginReplySchema, ex));
  }

  it("@P1 every message type and krita cmd has an example", () => {
    const wt = new Set(Object.values(EX.worker_to_helper).map((m) => (m as { t: string }).t));
    expect([...wt].sort()).toEqual(
      ["chrome_rect", "click", "down", "keys", "krita", "middle_down", "middle_up", "move", "pause", "ping", "resume", "ring", "up"].sort(),
    );
    const ht = new Set(Object.values(EX.helper_to_worker).map((m) => (m as { t: string }).t));
    expect([...ht].sort()).toEqual(["ack", "error", "hello", "hotkey", "krita_reply", "krita_state", "krita_window_rect", "pong", "warning"].sort());
    const cmds = new Set(Object.values(EX.plugin_request).map((m) => (m as { cmd: string }).cmd));
    const schemaCmds = KritaCommandSchema.options.map((o) => o.shape.cmd.value);
    expect([...cmds].sort()).toEqual([...schemaCmds].sort());
  });

  it("@P1 malformed messages are rejected", () => {
    expect(parseWorkerToHelper({ t: "move", id: "a", x: "1", y: 2 })).toBeNull();
    expect(parseWorkerToHelper({ t: "krita", id: "a", cmd: "nope" })).toBeNull();
    expect(parseWorkerToHelper({ t: "move", x: 1, y: 2 })).toBeNull();
    expect(parseHelperToWorker({ t: "hotkey", id: "a", key: "f8" })).toBeNull();
    expect(parseHelperToWorker({ t: "error", id: "a", code: "nope" })).toBeNull();
  });
});
