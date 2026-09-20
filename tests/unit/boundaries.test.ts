// SPDX-License-Identifier: Apache-2.0
/**
 * Architectural boundary checks over the real import graph:
 * step ← ifc ← geometry ← worker; renderer knows no IFC; the core viewer never
 * imports the custom element; nothing imports third-party packages at runtime.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const graph = new Map<string, string[]>();
for (const f of files(SRC)) {
  const src = readFileSync(f, "utf8");
  const deps: string[] = [];
  for (const m of src.matchAll(/(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)) deps.push(m[1]!);
  for (const m of src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) deps.push(m[1]!);
  graph.set(relative(SRC, f), deps.map((d) => (d.startsWith(".") ? relative(SRC, resolve(dirname(f), d)) : `bare:${d}`)));
}

function layer(path: string): string {
  return path.includes("/") ? path.split("/")[0]! : path.replace(/\.ts$/, "");
}

const ALLOWED: Record<string, string[]> = {
  diagnostics: [],
  step: ["diagnostics"],
  math: [],
  triangulation: [],
  ifc: ["diagnostics", "step"],
  csg: ["diagnostics", "triangulation"],
  geometry: ["diagnostics", "step", "ifc", "math", "triangulation", "csg"],
  protocol: ["diagnostics", "ifc"],
  worker: ["diagnostics", "step", "ifc", "math", "geometry", "protocol"],
  renderer: ["math", "protocol"],
  core: ["diagnostics", "step", "ifc", "math", "triangulation", "csg", "geometry", "protocol", "renderer", "worker"],
  element: ["diagnostics", "ifc", "math", "core", "protocol"],
  iframe: ["ifc-viewer"],
  "ifc-viewer": ["element", "core"],
  index: ["ifc-viewer", "core"],
};

describe("module boundaries", () => {
  it("has no bare (third-party) runtime imports", () => {
    for (const [file, deps] of graph) for (const d of deps) assert.ok(!d.startsWith("bare:"), `${file} imports ${d}`);
  });

  it("respects the layer dependency rules", () => {
    for (const [file, deps] of graph) {
      const from = layer(file);
      const allowed = ALLOWED[from];
      assert.ok(allowed, `unknown layer for ${file}`);
      for (const d of deps) {
        const to = layer(d);
        if (to === from) continue;
        assert.ok(allowed.includes(to), `${file} (${from}) must not import ${d} (${to})`);
      }
    }
  });

  it("keeps the WebGL renderer free of IFC and STEP knowledge", () => {
    for (const [file, deps] of graph) {
      if (!file.startsWith("renderer/")) continue;
      assert.ok(!deps.some((d) => /^(ifc|step|geometry)\//.test(d)), file);
    }
  });

  it("never lets the core viewer depend on the custom element", () => {
    for (const [file, deps] of graph) if (file.startsWith("core/")) assert.ok(!deps.some((d) => d.startsWith("element/")), file);
  });

  it("never uses eval-like constructs or HTML injection of model data", () => {
    for (const f of files(SRC)) {
      const src = readFileSync(f, "utf8");
      assert.ok(!/\beval\s*\(|new Function\s*\(/.test(src), `${f} uses eval`);
      for (const m of src.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)) {
        assert.match(m[1]!, /^(ICONS\.[a-zA-Z]+|visible \? ICONS\.eye : ICONS\.eyeOff|TEMPLATE|`<style>\$\{VIEWER_CSS\}<\/style>\$\{TEMPLATE\}`)$/, `${f}: innerHTML assignment from ${m[1]}`);
      }
    }
  });

  it("carries an SPDX Apache-2.0 header in every source file", () => {
    for (const f of files(SRC)) assert.ok(readFileSync(f, "utf8").startsWith("// SPDX-License-Identifier: Apache-2.0"), f);
  });
});
