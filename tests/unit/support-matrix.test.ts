// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { SUPPORTED_ITEM_TYPES } from "../../src/geometry/items.ts";
import { SUPPORT_MATRIX } from "../../src/ifc/support.ts";
import { renderSupportMarkdown } from "../../scripts/support-doc.ts";

const ITEM_CATEGORIES = new Set(["solid", "tessellation", "brep", "boolean", "surface", "curve"]);

describe("support matrix", () => {
  it("claims support only for item types the geometry dispatcher handles", () => {
    for (const entry of SUPPORT_MATRIX) {
      if (!ITEM_CATEGORIES.has(entry.category)) continue;
      const supported = [entry.ifc2x3, entry.ifc4, entry.ifc4x3].some((s) => s === "full" || s === "partial");
      const names = entry.entity.split("/").map((n) => n.trim().split(/[\s(]/)[0]!.toUpperCase()).filter((n) => n.startsWith("IFC"));
      for (const n of names) {
        if (n === "IFCRELVOIDSELEMENT") continue;
        if (supported) assert.ok(SUPPORTED_ITEM_TYPES.has(n), `${entry.entity}: ${n} is listed as supported but not dispatched`);
        else assert.ok(!SUPPORTED_ITEM_TYPES.has(n), `${n} is dispatched but listed as unsupported`);
      }
    }
  });

  it("keeps docs/ifc-support.md in sync with the table", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
    const doc = readFileSync(join(root, "docs", "ifc-support.md"), "utf8");
    assert.equal(doc, renderSupportMarkdown(SUPPORT_MATRIX), "run `npm run docs:support`");
  });
});
