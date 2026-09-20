// SPDX-License-Identifier: Apache-2.0
/**
 * Browser compatibility suite: every file of the buildingSMART
 * Certification-datasets corpus is opened in the real <ifc-viewer> (worker,
 * WebGL renderer, UI). A file passes when it loads without a fatal error or
 * hang, every product with a representation is displayed (matching the Node
 * suite's recorded results) and the canvas shows the model.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { ensureCorpus } from "../../scripts/fetch-corpus.ts";
import { corpusUrl, discoverCorpus, loadResults } from "../corpus/corpus-lib.ts";
import { coverage, events, openHarness } from "./helpers.ts";

const dir = ensureCorpus();
const files = discoverCorpus(dir);
const expected = loadResults();
const report: Record<string, unknown>[] = [];

test.describe.configure({ mode: "serial" });

test("the browser suite covers exactly the recorded corpus", () => {
  expect(files).toEqual(expected.files.map((f) => f.path));
});

for (const path of files) {
  test(path, async ({ page }) => {
    const record = expected.files.find((f) => f.path === path)!;
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await openHarness(page);
    const t0 = Date.now();
    const stats = await page.evaluate(async (url) => {
      const v = document.getElementById("viewer0") as HTMLElement & { load(u: string): Promise<unknown> };
      const loaded = new Promise<{ productsWithGeometry: number; triangles: number; products: number }>((resolve, reject) => {
        v.addEventListener("ifc-load", (e) => resolve((e as CustomEvent).detail.stats), { once: true });
        v.addEventListener("ifc-error", (e) => {
          if ((e as CustomEvent).detail.fatal) reject(new Error((e as CustomEvent).detail.error.message));
        });
      });
      await v.load(url);
      return loaded;
    }, corpusUrl(path));
    const ms = Date.now() - t0;
    const cov = await coverage(page);
    const fatal = (await events(page)).filter((e) => e.type === "ifc-error" && (e.detail as { fatal?: boolean }).fatal);
    const tree = await page.locator("#viewer0").getByRole("treeitem").count();
    // Usable view: every product, isolated and framed on its own, draws pixels.
    const invisible = await page.evaluate(async () => {
      type V = HTMLElement & {
        isolate(ids: number[]): void;
        showAll(): void;
        fit(ids?: number[], o?: unknown): Promise<void>;
        viewer: { model: { geometryProducts: Uint32Array }; snapshot(): { data: Uint8Array } };
      };
      const v = document.getElementById("viewer0") as V;
      const missing: number[] = [];
      for (const id of Array.from(v.viewer.model.geometryProducts)) {
        v.isolate([id]);
        await v.fit([id], { animate: false });
        const s = v.viewer.snapshot();
        let n = 0;
        for (let k = 0; k < s.data.length; k += 4) {
          if (Math.abs(s.data[k]! - s.data[0]!) + Math.abs(s.data[k + 1]! - s.data[1]!) + Math.abs(s.data[k + 2]! - s.data[2]!) > 18) n++;
        }
        if (n < 20) missing.push(id);
      }
      v.showAll();
      await v.fit(undefined, { animate: false });
      return missing;
    });
    report.push({ path, ms, coverage: cov, productsWithGeometry: stats.productsWithGeometry, triangles: stats.triangles, treeItems: tree, invisibleProducts: invisible });
    expect(fatal).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(stats.products).toBe(record.products);
    expect(stats.productsWithGeometry).toBe(record.geometryProducts);
    expect(stats.triangles).toBe(record.triangles);
    expect(cov, "the fitted model is visible on the canvas").toBeGreaterThan(0.0005);
    expect(invisible, "products that draw no pixels when isolated").toEqual([]);
    expect(tree).toBeGreaterThan(0);
  });
}

test.afterAll(() => {
  mkdirSync("test-results", { recursive: true });
  writeFileSync("test-results/corpus-browser.json", JSON.stringify({ commit: expected.commit, files: report }, null, 2));
});
