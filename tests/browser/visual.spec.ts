// SPDX-License-Identifier: Apache-2.0
/**
 * Visual regression per geometry behaviour. Frames are reduced to a 32×24
 * grid of block-averaged colours and compared with stored goldens, which is
 * robust to rasteriser/antialiasing differences between GPU backends while
 * still catching wrong geometry, colours or placement. Geometric assertions
 * live in the unit suites. Re-record with UPDATE_GOLDEN=1.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { load, openHarness } from "./helpers.ts";

const GW = 32, GH = 24;
const update = process.env.UPDATE_GOLDEN === "1";

async function signature(page: Page): Promise<number[]> {
  return page.evaluate(({ GW, GH }) => {
    const v = document.getElementById("viewer0") as HTMLElement & { viewer: { snapshot(): { width: number; height: number; data: Uint8Array } } };
    const s = v.viewer.snapshot();
    const out: number[] = [];
    for (let gy = 0; gy < GH; gy++) {
      for (let gx = 0; gx < GW; gx++) {
        const x0 = Math.floor((gx * s.width) / GW), x1 = Math.floor(((gx + 1) * s.width) / GW);
        const y0 = Math.floor((gy * s.height) / GH), y1 = Math.floor(((gy + 1) * s.height) / GH);
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          const o = (y * s.width + x) * 4;
          r += s.data[o]!; g += s.data[o + 1]!; b += s.data[o + 2]!; n++;
        }
        out.push(Math.round(r / n), Math.round(g / n), Math.round(b / n));
      }
    }
    return out;
  }, { GW, GH });
}

async function show(page: Page, names: string[], options: { select?: boolean; clip?: boolean } = {}): Promise<void> {
  await page.evaluate(async ({ names, options }) => {
    const v = document.getElementById("viewer0") as HTMLElement & {
      isolate(ids: number[]): void; select(ids: number[]): void; clearSelection(): void; setClipPlane(p: unknown): void;
      fit(ids?: number[], o?: unknown): Promise<void>;
      viewer: { model: { tree: { id: number; name: string }[] }; setCamera(c: unknown): void; productBounds(id: number): { minZ: number; maxZ: number } };
    };
    const ids = v.viewer.model.tree.filter((n) => names.some((name) => n.name.startsWith(name))).map((n) => n.id);
    v.isolate(ids);
    v.clearSelection();
    v.setClipPlane(null);
    v.viewer.setCamera({ eye: [30, -45, 27], target: [0, 0, 0], fov: Math.PI / 4 });
    await v.fit(ids, { animate: false });
    if (options.select) v.select([ids[0]!]);
    if (options.clip) {
      const b = v.viewer.productBounds(ids[0]!);
      v.setClipPlane({ normal: [0, 0, 1], distance: (b.minZ + b.maxZ) / 2 });
    }
  }, { names, options });
}

function compare(name: string, actual: number[]): void {
  const file = `tests/browser/golden/${name}.json`;
  if (update || !existsSync(file)) {
    writeFileSync(file, JSON.stringify({ grid: [GW, GH], rgb: actual }) + "\n");
    if (!update) throw new Error(`golden ${file} was missing and has been recorded; re-run to compare`);
    return;
  }
  const golden = JSON.parse(readFileSync(file, "utf8")) as { rgb: number[] };
  let sum = 0, worst = 0;
  for (let i = 0; i < actual.length; i++) {
    const d = Math.abs(actual[i]! - golden.rgb[i]!);
    sum += d;
    worst = Math.max(worst, d);
  }
  const mean = sum / actual.length;
  expect(mean, `${name}: mean channel difference`).toBeLessThan(4);
  expect(worst, `${name}: worst block difference`).toBeLessThan(70);
}

const CASES: { name: string; file: string; names: string[]; select?: boolean; clip?: boolean }[] = [
  { name: "extrusion-hole", file: "demo", names: ["Ground slab"] },
  { name: "boolean-difference", file: "demo", names: ["South facade"] },
  { name: "boolean-clipping", file: "demo", names: ["Pitched roof"] },
  { name: "mapped-instances", file: "demo", names: ["Column"] },
  { name: "mapped-rotation-mirror", file: "visual-mapped", names: ["L "] },
  { name: "polygonal-holes", file: "visual-mapped", names: ["Perforated plate"] },
  { name: "triangulated-colour-map", file: "demo", names: ["Bench"] },
  { name: "faceted-brep", file: "demo", names: ["Stair to terrace"] },
  { name: "swept-disk-miter", file: "demo", names: ["Supply pipe", "Stair handrail"] },
  { name: "revolved", file: "demo", names: ["Round table"] },
  { name: "i-beams", file: "demo", names: ["Beam"] },
  { name: "selection", file: "demo", names: ["South facade"], select: true },
  { name: "clip-plane", file: "demo", names: ["Pitched roof"], clip: true },
];

test.describe("visual regression", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
  });
  for (const c of CASES) {
    test(c.name, async ({ page }) => {
      await openHarness(page, { ui: "none" });
      await load(page, `/tests/fixtures/generated/${c.file}.ifc`);
      await show(page, c.names, c);
      compare(c.name, await signature(page));
    });
  }
});
