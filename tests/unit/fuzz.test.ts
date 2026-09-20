// SPDX-License-Identifier: Apache-2.0
/**
 * Mutation fuzzing of a rich, valid IFC model through the complete Node
 * pipeline (stream parse → model → geometry → packing). Every outcome must be
 * a completed load or a structured, expected error; anything else (TypeError,
 * RangeError, hangs) is a bug.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IfcResourceLimitError, StepFormatError } from "../../src/diagnostics.ts";
import { LoadSession } from "../../src/worker/session.ts";
import { buildDemoBuilding } from "../helpers/demo-building.ts";

const base = buildDemoBuilding().text;

function rng(seed: number): () => number {
  let s = seed;
  return () => ((s = (s * 48271) % 2147483647) / 2147483647);
}

function mutate(text: string, r: () => number): string {
  let t = text;
  const edits = 1 + Math.floor(r() * 6);
  for (let e = 0; e < edits; e++) {
    const at = Math.floor(r() * t.length);
    switch (Math.floor(r() * 9)) {
      case 0: t = t.slice(0, at) + t.slice(at + 1 + Math.floor(r() * 40)); break; // delete run
      case 1: t = t.slice(0, at) + "(".repeat(1 + Math.floor(r() * 200)) + t.slice(at); break; // nesting bomb
      case 2: t = t.slice(0, at) + String.fromCharCode(Math.floor(r() * 256)) + t.slice(at + 1); break; // byte flip
      case 3: t = t.slice(0, at); break; // truncate
      case 4: t = t.replace(/#(\d+)/, () => `#${Math.floor(r() * 1e9)}`); break; // dangling ref
      case 5: t = t.slice(0, at) + "1E308" + t.slice(at); break; // huge number
      case 6: t = t.slice(0, at) + "'\\X2\\00" + t.slice(at); break; // broken escape
      case 7: t = t.replace(/\(\((\d+),(\d+),(\d+)\)/, "((2147483647,-5,0)"); break; // hostile indices
      default: {
        // swap two entity ids to create reference cycles / type confusion
        const ids = [...t.matchAll(/#(\d+)=/g)].map((m) => m[1]!);
        if (ids.length > 2) {
          const a = ids[Math.floor(r() * ids.length)]!, b = ids[Math.floor(r() * ids.length)]!;
          t = t.replaceAll(`#${a},`, `#${b},`);
        }
      }
    }
  }
  return t;
}

async function run(text: string): Promise<"ok" | "rejected"> {
  const session = new LoadSession({ progress() {}, metadata() {}, geometry() {}, diagnostic() {}, resourceLimit() {} }, { maxProductMillis: 2000 });
  try {
    await session.run({ kind: "buffer", buffer: new TextEncoder().encode(text).buffer as ArrayBuffer, name: "fuzz.ifc" });
    return "ok";
  } catch (e) {
    if (e instanceof StepFormatError || e instanceof IfcResourceLimitError) return "rejected";
    throw e;
  }
}

describe("pipeline fuzzing", () => {
  it("survives 150 mutated models without unexpected errors", async () => {
    const r = rng(20260919);
    let ok = 0;
    for (let i = 0; i < 150; i++) {
      const t0 = performance.now();
      const outcome = await run(mutate(base, r));
      if (outcome === "ok") ok++;
      assert.ok(performance.now() - t0 < 30_000, `case ${i} took too long`);
    }
    assert.ok(ok > 50, `most mutations still load (${ok})`);
  });

  it("survives random byte streams", async () => {
    const r = rng(7);
    for (let i = 0; i < 40; i++) {
      const bytes = Array.from({ length: 2000 }, () => String.fromCharCode(Math.floor(r() * 128))).join("");
      await run(`ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;${bytes}`);
    }
  });
});
