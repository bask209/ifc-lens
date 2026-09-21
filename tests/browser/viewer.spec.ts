// SPDX-License-Identifier: Apache-2.0
/** Integration tests through the public <ifc-viewer> interface. */
import { expect, test } from "@playwright/test";
import { canvasBox, coverage, events, load, openHarness, pixelAt, waitForEvent, type Recorded } from "./helpers.ts";

const FIX = "/tests/fixtures/generated";

type ViewerEl = HTMLElement & {
  load(src: unknown, o?: unknown): Promise<{ schema: string; productCount: number; entityCount: number }>;
  unload(): Promise<void>;
  select(ids: number | number[], o?: unknown): void;
  clearSelection(): void;
  hide(ids: number[]): void;
  show(ids: number[]): void;
  isolate(ids: number[]): void;
  showAll(): void;
  fit(ids?: number[], o?: unknown): Promise<void>;
  setClipPlane(p: unknown): void;
  getProperties(id: number): Promise<{ name: string; properties: { name: string; value: unknown }[] }[]>;
  dispose(): Promise<void>;
  selection: number[];
  viewer: {
    model: { geometryProducts: Uint32Array; tree: { id: number; type: string; name: string }[] };
    productCount: number;
    geometryProductCount: number;
    hiddenIds: number[];
    getCamera(): { eye: number[]; target: number[] };
    renderer: { canvas: HTMLCanvasElement; contextLost: boolean };
  };
};

test.describe("loading", () => {
  test("declarative src attribute loads and renders the model", async ({ page }) => {
    await openHarness(page, { src: `${FIX}/demo.ifc` });
    const loaded = await waitForEvent(page, "ifc-load");
    const stats = (loaded.detail as { stats: { productsWithGeometry: number; products: number } }).stats;
    expect(stats.productsWithGeometry).toBe(28);
    expect(await coverage(page)).toBeGreaterThan(0.05);
    const types = (await events(page)).map((e) => e.type);
    // deterministic event order
    expect(types.indexOf("ifc-load-start")).toBeLessThan(types.indexOf("ifc-model-ready"));
    expect(types.indexOf("ifc-model-ready")).toBeLessThan(types.indexOf("ifc-geometry-progress"));
    expect(types.indexOf("ifc-geometry-progress")).toBeLessThan(types.indexOf("ifc-load"));
    await expect(page.locator("#viewer0").locator(".status .text")).toContainText("28 of 37 elements shown");
    await expect(page.locator("#viewer0").getByRole("treeitem", { name: /Harbour pavilion/ })).toBeVisible();
  });

  test("programmatic URL load resolves a model handle", async ({ page }) => {
    await openHarness(page);
    const handle = await page.evaluate(async (u) => {
      const v = document.getElementById("viewer0") as ViewerEl;
      const h = await v.load(u);
      return { schema: h.schema, productCount: h.productCount, entityCount: h.entityCount };
    }, `${FIX}/ifc2x3-basic.ifc`);
    expect(handle.schema).toBe("IFC2X3");
    expect(handle.productCount).toBe(6);
    expect(await coverage(page)).toBeGreaterThan(0.02);
  });

  test("loads File (through the Open button), Blob and ArrayBuffer sources", async ({ page }) => {
    await openHarness(page);
    await page.locator("#viewer0").locator("input.file").setInputFiles("tests/fixtures/generated/box.ifc");
    await waitForEvent(page, "ifc-load");
    await expect(page.locator("#viewer0").locator(".status .text")).toContainText("box.ifc");
    const counts = await page.evaluate(async (base) => {
      const v = document.getElementById("viewer0") as ViewerEl;
      const bytes = await (await fetch(`${base}/grid.ifc`)).arrayBuffer();
      const fromBlob = await v.load(new Blob([bytes]));
      const fromBuffer = await v.load(bytes.slice(0));
      return [fromBlob.productCount, fromBuffer.productCount];
    }, FIX);
    expect(counts).toEqual([903, 903]);
  });

  test("unload clears the model and a reload works", async ({ page }) => {
    await openHarness(page);
    await load(page, `${FIX}/box.ifc`);
    await page.evaluate(() => (document.getElementById("viewer0") as ViewerEl).unload());
    expect(await coverage(page)).toBe(0);
    await expect(page.locator("#viewer0").locator(".overlay.empty")).toBeVisible();
    const stats = await load(page, `${FIX}/box.ifc`);
    expect(stats.productsWithGeometry).toBe(1);
  });

  test("cancelling during parse rejects with AbortError and leaves the viewer usable", async ({ page }) => {
    await openHarness(page);
    const result = await page.evaluate(async (base) => {
      const v = document.getElementById("viewer0") as ViewerEl;
      const ac = new AbortController();
      const p = v.load(`${base}/grid.ifc`, { signal: ac.signal });
      ac.abort();
      try {
        await p;
        return "resolved";
      } catch (e) {
        return (e as Error).name;
      }
    }, FIX);
    expect(result).toBe("AbortError");
    const stats = await load(page, `${FIX}/box.ifc`);
    expect(stats.productsWithGeometry).toBe(1);
  });

  test("a newer load supersedes one in progress", async ({ page }) => {
    await openHarness(page);
    const r = await page.evaluate(async (base) => {
      const v = document.getElementById("viewer0") as ViewerEl;
      const first = v.load(`${base}/grid.ifc`).then(() => "ok", (e: Error) => e.name);
      const second = await v.load(`${base}/box.ifc`);
      return [await first, second.productCount];
    }, FIX);
    expect(r).toEqual(["AbortError", 4]);
  });
});

test.describe("errors, limits and security", () => {
  test("non-STEP input produces a fatal, explained error", async ({ page }) => {
    await openHarness(page, { src: `${FIX}/not-ifc.ifc` });
    const err = await waitForEvent(page, "ifc-error");
    expect(err.detail).toMatchObject({ fatal: true });
    await expect(page.locator("#viewer0").getByRole("alert")).toContainText("Not an ISO 10303-21 file");
  });

  test("HTTP errors are reported with the status", async ({ page }) => {
    await openHarness(page, { src: "/does/not/exist.ifc" });
    const err = await waitForEvent(page, "ifc-error");
    expect((err.detail as { message: string }).message).toContain("HTTP 404");
  });

  test("cross-origin loads need CORS and report a meaningful error otherwise", async ({ page }) => {
    await openHarness(page);
    const blocked = await page.evaluate(async () => {
      const v = document.getElementById("viewer0") as ViewerEl;
      try {
        await v.load("http://127.0.0.1:8125/tests/fixtures/generated/box.ifc");
        return "loaded";
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(blocked).toContain("CORS");
    const allowed = await load(page, "http://127.0.0.1:8124/tests/fixtures/generated/box.ifc");
    expect(allowed.productsWithGeometry).toBe(1);
  });

  test("unsupported geometry is diagnosed per item without failing the model", async ({ page }) => {
    await openHarness(page);
    const stats = await load(page, `${FIX}/unsupported.ifc`);
    expect(stats.productsWithGeometry).toBe(1);
    const diags = (await events(page)).filter((e) => e.type === "ifc-diagnostic").map((e) => (e.detail as { code: string }).code);
    expect(diags).toContain("GEOMETRY_UNSUPPORTED");
  });

  test("malformed files load what is valid", async ({ page }) => {
    await openHarness(page);
    const stats = await load(page, `${FIX}/malformed.ifc`);
    expect(stats.productsWithGeometry).toBe(1);
    const codes = (await events(page)).filter((e) => e.type === "ifc-diagnostic").map((e) => (e.detail as { code: string }).code);
    expect(codes).toContain("STEP_SYNTAX");
    expect(codes).toContain("IFC_REFERENCE_MISSING");
  });

  test("resource limits stop the load with structured detail", async ({ page }) => {
    await openHarness(page);
    const message = await page.evaluate(async (base) => {
      const v = document.getElementById("viewer0") as ViewerEl;
      try {
        await v.load(`${base}/grid.ifc`, { maxFileBytes: 1000 });
        return "loaded";
      } catch (e) {
        return (e as Error).message;
      }
    }, FIX);
    expect(message).toContain("file-bytes");
    const limit = await waitForEvent(page, "ifc-resource-limit");
    expect(limit.detail).toMatchObject({ resource: "file-bytes", limit: 1000 });
  });

  test("javascript: and data: sources are rejected", async ({ page }) => {
    await openHarness(page);
    const r = await page.evaluate(async () => {
      const v = document.getElementById("viewer0") as ViewerEl;
      const out: string[] = [];
      for (const src of ["javascript:alert(1)", "data:text/plain,ISO-10303-21;"]) {
        try {
          await v.load(src);
          out.push("loaded");
        } catch (e) {
          out.push((e as Error).message);
        }
      }
      return out;
    });
    expect(r[0]).toContain("Unsupported IFC URL scheme: javascript:");
    expect(r[1]).toContain("Unsupported IFC URL scheme: data:");
  });

  test("hostile names render as text, never as markup", async ({ page }) => {
    await openHarness(page);
    await load(page, `${FIX}/box.ifc`);
    const v = page.locator("#viewer0");
    await v.getByRole("searchbox", { name: "Search elements" }).fill("onerror");
    await expect(v.locator(".tree")).toContainText("<img src=x onerror=alert(1)>");
    await v.getByRole("treeitem").first().click();
    await expect(v.locator(".props")).toContainText("<img src=x onerror=alert(1)>");
    expect(await v.locator("img").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { xss?: boolean }).xss)).toBeUndefined();
  });

  test("a hanging worker is terminated by the watchdog", async ({ page }) => {
    await page.goto("/tests/browser/pages/blank.html");
    const message = await page.evaluate(async () => {
      const entry = "/dist/ifc-viewer.js";
      const { IfcViewer } = (await import(entry)) as { IfcViewer: new (o: object) => { load(s: string): Promise<unknown>; dispose(): Promise<void> } };
      const canvas = document.createElement("canvas");
      document.body.append(canvas);
      const worker = URL.createObjectURL(new Blob(["self.onmessage = () => {};"], { type: "text/javascript" }));
      const v = new IfcViewer({ canvas, workerUrl: worker, workerTimeoutMs: 1500 });
      try {
        await v.load("/tests/fixtures/generated/box.ifc");
        return "loaded";
      } catch (e) {
        return (e as Error).message;
      } finally {
        await v.dispose();
      }
    });
    expect(message).toContain("did not respond");
  });

  test("a crashing worker is reported and a new worker is used for the next load", async ({ page }) => {
    await page.goto("/tests/browser/pages/blank.html");
    const r = await page.evaluate(async () => {
      const entry = "/dist/ifc-viewer.js";
      const { IfcViewer } = (await import(entry)) as { IfcViewer: new (o: object) => { load(s: string): Promise<unknown>; dispose(): Promise<void> } };
      const canvas = document.createElement("canvas");
      document.body.append(canvas);
      // Crashes on the first message of each worker instance; the viewer must
      // surface the failure instead of hanging.
      const worker = URL.createObjectURL(new Blob(["self.onmessage = () => { throw new Error('boom'); };"], { type: "text/javascript" }));
      const v = new IfcViewer({ canvas, workerUrl: worker, workerTimeoutMs: 10_000 });
      const out: string[] = [];
      for (let i = 0; i < 2; i++) {
        try {
          await v.load("/tests/fixtures/generated/box.ifc");
          out.push("loaded");
        } catch (e) {
          out.push((e as Error).message);
        }
      }
      await v.dispose();
      return out;
    });
    expect(r[0]).toContain("Model worker failed");
    expect(r[1]).toContain("Model worker failed");
  });
});

test.describe("interaction", () => {
  test("clicking selects, updates the tree and shows properties; Escape clears", async ({ page }) => {
    await openHarness(page);
    await load(page, `${FIX}/box.ifc`);
    const box = await canvasBox(page);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const sel = await waitForEvent(page, "ifc-selection-change");
    const ids = (sel.detail as { selectedIds: number[] }).selectedIds;
    expect(ids).toHaveLength(1);
    const v = page.locator("#viewer0");
    await expect(v.getByRole("treeitem", { selected: true })).toContainText("<img src=x");
    await expect(v.locator(".props")).toContainText("GlobalId");
    await expect(v.locator(".props")).toContainText("IfcWall");
    // selection highlight changes the centre colour
    const before = await pixelAt(page, box.width / 2, box.height / 2);
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await events(page)).filter((e) => e.type === "ifc-selection-change").length).toBe(2);
    const after = await pixelAt(page, box.width / 2, box.height / 2);
    expect(before).not.toEqual(after);
    // clicking empty space clears the selection
    await page.mouse.click(box.x + 5, box.y + 5);
    expect(await page.evaluate(() => (document.getElementById("viewer0") as ViewerEl).selection)).toEqual([]);
  });

  test("selection API supports add/toggle modes and fit", async ({ page }) => {
    await openHarness(page);
    await load(page, `${FIX}/grid.ifc`);
    const r = await page.evaluate(async () => {
      const v = document.getElementById("viewer0") as ViewerEl;
      const ids = Array.from(v.viewer.model.geometryProducts.slice(0, 3));
      v.select(ids[0]!);
      v.select(ids[1]!, { mode: "add" });
      v.select([ids[0]!, ids[2]!], { mode: "toggle" });
      const sel = v.selection;
      const camBefore = v.viewer.getCamera();
      v.select(ids[1]!, { fit: true });
      await new Promise((r) => setTimeout(r, 600));
      const camAfter = v.viewer.getCamera();
      return { sel, ids, moved: camBefore.eye.some((x, i) => Math.abs(x - camAfter.eye[i]!) > 1e-6) };
    });
    expect(r.sel.sort()).toEqual([r.ids[1], r.ids[2]].sort());
    expect(r.moved).toBe(true);
  });

  test("hide, isolate, show and showAll change what is drawn", async ({ page }) => {
    await openHarness(page);
    await load(page, `${FIX}/demo.ifc`);
    const full = await coverage(page);
    const counts = await page.evaluate(() => {
      const v = document.getElementById("viewer0") as ViewerEl;
      const terrain = v.viewer.model.tree.find((n) => n.name === "Terrain")!.id;
      const roof = v.viewer.model.tree.find((n) => n.name === "Pitched roof")!.id;
      v.hide([terrain]);
      const afterHide = v.viewer.hiddenIds.length;
      v.isolate([roof]);
      const afterIsolate = v.viewer.hiddenIds.length;
      return { terrain, roof, afterHide, afterIsolate };
    });
    expect(counts.afterHide).toBe(1);
    expect(counts.afterIsolate).toBe(27);
    const isolated = await coverage(page);
    expect(isolated).toBeLessThan(full);
    await page.evaluate(() => (document.getElementById("viewer0") as ViewerEl).showAll());
    expect(Math.abs((await coverage(page)) - full)).toBeLessThan(0.01);
    const vis = (await events(page)).filter((e) => e.type === "ifc-visibility-change").map((e) => (e.detail as { visibleProducts: number }).visibleProducts);
    expect(vis.slice(-3)).toEqual([27, 1, 28]);
  });

  test("hiding a storey from the tree hides everything it contains", async ({ page }) => {
    await openHarness(page);
    await load(page, `${FIX}/demo.ifc`);
    const storey = page.locator("#viewer0").getByRole("treeitem", { name: /Ground floor/ });
    await storey.locator(":scope > .row .eye").click();
    const hidden = await page.evaluate(() => (document.getElementById("viewer0") as ViewerEl).viewer.hiddenIds.length);
    expect(hidden).toBe(27); // everything but the terrain (contained in the site)
    await expect(storey.locator(":scope > .row")).toHaveAttribute("data-hidden", "true");
  });

  test("keyboard shortcuts act only while the canvas has focus", async ({ page }) => {
    await openHarness(page);
    await load(page, `${FIX}/grid.ifc`);
    await page.evaluate(() => {
      const v = document.getElementById("viewer0") as ViewerEl;
      v.select(v.viewer.model.geometryProducts[0]!);
    });
    const search = page.locator("#viewer0").getByRole("searchbox", { name: "Search elements" });
    await search.fill("hhh");
    expect(await page.evaluate(() => (document.getElementById("viewer0") as ViewerEl).viewer.hiddenIds.length)).toBe(0);
    await search.fill("");
    await page.locator("#viewer0").locator("canvas").focus();
    await page.keyboard.press("h");
    expect(await page.evaluate(() => (document.getElementById("viewer0") as ViewerEl).viewer.hiddenIds.length)).toBe(1);
    await page.keyboard.press("a");
    expect(await page.evaluate(() => (document.getElementById("viewer0") as ViewerEl).viewer.hiddenIds.length)).toBe(0);
  });

  test("orbit, pan and zoom move the camera", async ({ page }) => {
    await openHarness(page);
    await load(page, `${FIX}/box.ifc`);
    const box = await canvasBox(page);
    const cam = () => page.evaluate(() => (document.getElementById("viewer0") as ViewerEl).viewer.getCamera());
    const c0 = await cam();
    await page.mouse.move(box.x + 300, box.y + 300);
    await page.mouse.down();
    await page.mouse.move(box.x + 420, box.y + 330, { steps: 6 });
    await page.mouse.up();
    const c1 = await cam();
    expect(c1.eye).not.toEqual(c0.eye);
    await page.mouse.move(box.x + 300, box.y + 300);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(box.x + 340, box.y + 300, { steps: 4 });
    await page.mouse.up({ button: "right" });
    const c2 = await cam();
    expect(c2.target).not.toEqual(c1.target);
    const dist = (c: { eye: number[]; target: number[] }) => Math.hypot(c.eye[0]! - c.target[0]!, c.eye[1]! - c.target[1]!, c.eye[2]! - c.target[2]!);
    await page.mouse.wheel(0, -400);
    const c3 = await cam();
    expect(dist(c3)).toBeLessThan(dist(c2));
    // double click fits the product under the cursor
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  });

  test("the orientation cube swings the camera to faces, edges and corners", async ({ page }) => {
    await openHarness(page);
    await load(page, `${FIX}/demo.ifc`);
    const v = page.locator("#viewer0");
    const cube = v.locator(".cube-scene");
    await expect(cube).toBeVisible();
    const cam = () => page.evaluate(() => (document.getElementById("viewer0") as ViewerEl).viewer.getCamera());
    const distance = (c: { eye: number[]; target: number[] }) => Math.hypot(c.eye[0]! - c.target[0]!, c.eye[1]! - c.target[1]!, c.eye[2]! - c.target[2]!);
    const before = await cam();
    await v.getByRole("button", { name: "View from top", exact: true }).click();
    // The swing is animated, and the direction reaches the target a frame or
    // two before the eased motion settles: wait for both.
    await expect.poll(async () => {
      const c = await cam();
      const d = distance(c);
      const overhead = Math.abs(c.eye[0]! - c.target[0]!) < d * 0.02 && Math.abs(c.eye[1]! - c.target[1]!) < d * 0.02 && c.eye[2]! > c.target[2]!;
      return overhead && Math.abs(d - distance(before)) < 1e-6;
    }).toBe(true);
    const top = await cam();
    // the pivot and the zoom are preserved: only the direction changes
    expect(top.target).toEqual(before.target);
    expect(Math.abs(distance(top) - distance(before))).toBeLessThan(1e-6);
    // a corner region gives a three-axis direction
    await v.getByRole("button", { name: "View from top front right" }).first().click();
    await expect.poll(async () => {
      const c = await cam();
      const d = [c.eye[0]! - c.target[0]!, c.eye[1]! - c.target[1]!, c.eye[2]! - c.target[2]!];
      const l = Math.hypot(...d);
      return d.map((x) => Math.round((x / l) * 100) / 100).join(",");
    }).toBe([0.58, -0.58, 0.58].join(","));
    // the cube follows the camera when the user orbits
    const transform = () => page.evaluate(() => (document.getElementById("viewer0") as HTMLElement).shadowRoot!.querySelector<HTMLElement>(".cube")!.style.transform);
    const t0 = await transform();
    const box = await canvasBox(page);
    await page.mouse.move(box.x + 300, box.y + 300);
    await page.mouse.down();
    await page.mouse.move(box.x + 420, box.y + 340, { steps: 6 });
    await page.mouse.up();
    await expect.poll(transform).not.toBe(t0);
    // faces turned away are out of the accessibility tree and the tab order
    const hidden = await page.evaluate(() => {
      const root = (document.getElementById("viewer0") as HTMLElement).shadowRoot!;
      return [...root.querySelectorAll<HTMLElement>(".cube-face")].map((f) => f.getAttribute("aria-hidden"));
    });
    expect(hidden.filter((h) => h === "true").length).toBeGreaterThanOrEqual(3);
  });

  test("the help panel explains the controls and closes again", async ({ page }) => {
    await openHarness(page);
    const v = page.locator("#viewer0");
    const panel = v.getByRole("dialog", { name: "How to use this viewer" });
    const button = v.getByRole("button", { name: "Help", exact: true });
    await expect(panel).toBeHidden();
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await button.click();
    await expect(panel).toBeVisible();
    await expect(button).toHaveAttribute("aria-expanded", "true");
    await expect(panel).toContainText("Orbit around the marked point under the cursor");
    await expect(panel).toContainText("Zoom towards the cursor");
    await expect(panel).toContainText("Isolate");
    // it sits in the bottom-right corner of the viewport, clear of the cube
    const [box, cube, canvas] = [await panel.boundingBox(), await v.locator(".cube-scene").boundingBox(), await canvasBox(page)];
    expect(box!.x + box!.width).toBeLessThanOrEqual(canvas.x + canvas.width + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(canvas.y + canvas.height + 1);
    expect(box!.x + box!.width).toBeGreaterThan(canvas.x + canvas.width / 2);
    expect(box!.y).toBeGreaterThan(cube!.y + cube!.height);
    // escape closes it and hands focus back to the button
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(button).toBeFocused();
    // "?" toggles it from the canvas, and clicking the view dismisses it
    await v.locator("canvas").focus();
    await page.keyboard.press("?");
    await expect(panel).toBeVisible();
    await page.mouse.click(canvas.x + 20, canvas.y + canvas.height - 20);
    await expect(panel).toBeHidden();
  });

  test("ui=none leaves no chrome over the canvas", async ({ page }) => {
    await openHarness(page, { ui: "none" });
    const v = page.locator("#viewer0");
    await expect(v.getByRole("button", { name: "Help", exact: true })).toBeHidden();
    await expect(v.locator(".cube-scene")).toBeHidden();
    await expect(v.locator(".toolbar")).toBeHidden();
  });

  test("the orbit anchor is marked while the user drags", async ({ page }) => {
    await openHarness(page);
    await load(page, `${FIX}/demo.ifc`);
    const marker = page.locator("#viewer0").locator(".pivot");
    const state = () => page.evaluate(() => {
      const el = (document.getElementById("viewer0") as HTMLElement).shadowRoot!.querySelector<HTMLElement>(".pivot")!;
      return { active: el.dataset.active, left: parseFloat(el.style.left || "NaN"), top: parseFloat(el.style.top || "NaN") };
    });
    expect((await state()).active).toBe("false");
    const box = await canvasBox(page);
    const [sx, sy] = [box.width / 2, box.height / 2];
    await page.mouse.move(box.x + sx, box.y + sy);
    await page.mouse.down();
    await page.mouse.move(box.x + sx + 90, box.y + sy + 30, { steps: 6 });
    await expect.poll(async () => (await state()).active).toBe("true");
    await expect(marker).toBeVisible();
    const during = await state();
    // the anchor is the point picked where the drag started: it stays put on
    // screen (within a couple of pixels) while the camera swings around it
    expect(Math.hypot(during.left - sx, during.top - sy)).toBeLessThan(3);
    await page.mouse.move(box.x + sx + 140, box.y + sy - 40, { steps: 6 });
    const later = await state();
    expect(Math.hypot(later.left - sx, later.top - sy)).toBeLessThan(3);
    await page.mouse.up();
    await expect.poll(async () => (await state()).active).toBe("false");
  });

  test("the section tool clips the model", async ({ page }) => {
    await openHarness(page);
    await load(page, `${FIX}/demo.ifc`);
    const full = await coverage(page);
    const v = page.locator("#viewer0");
    await v.getByRole("button", { name: /Section plane/ }).click();
    await expect(v.getByRole("group", { name: "Section plane" })).toBeVisible();
    await v.getByRole("slider", { name: "Section position" }).fill("150");
    const clipped = await coverage(page);
    expect(clipped).toBeLessThan(full * 0.9);
    await v.getByRole("button", { name: /Section plane/ }).click();
    expect(Math.abs((await coverage(page)) - full)).toBeLessThan(0.01);
    // programmatic clip plane in model coordinates
    await page.evaluate(() => (document.getElementById("viewer0") as ViewerEl).setClipPlane({ normal: [0, 0, 1], distance: 1 }));
    expect(await coverage(page)).toBeLessThan(full);
  });

  test("the spatial tree is keyboard navigable", async ({ page }) => {
    await openHarness(page);
    await load(page, `${FIX}/demo.ifc`);
    const v = page.locator("#viewer0");
    const project = v.getByRole("treeitem", { name: /Harbour pavilion/ });
    await project.focus();
    await page.keyboard.press("ArrowDown");
    await expect(v.getByRole("treeitem", { name: /^Site/ })).toBeFocused();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await events(page)).filter((e) => e.type === "ifc-selection-change").length).toBe(1);
    await page.keyboard.press("Home");
    await expect(project).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(project).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("ArrowRight");
    await expect(project).toHaveAttribute("aria-expanded", "true");
  });

  test("search filters the tree", async ({ page }) => {
    await openHarness(page);
    await load(page, `${FIX}/demo.ifc`);
    const v = page.locator("#viewer0");
    await v.getByRole("searchbox", { name: "Search elements" }).fill("column");
    await expect(v.getByRole("treeitem")).toHaveCount(4);
    await v.getByRole("searchbox", { name: "Search elements" }).fill("no-such-thing");
    await expect(v.locator(".tree")).toContainText("No elements match this search.");
  });

  test("property queries return grouped values with units", async ({ page }) => {
    await openHarness(page);
    await load(page, `${FIX}/demo.ifc`);
    const groups = await page.evaluate(async () => {
      const v = document.getElementById("viewer0") as ViewerEl;
      const wall = v.viewer.model.tree.find((n) => n.name === "South facade")!.id;
      return v.getProperties(wall);
    });
    const names = groups.map((g) => g.name);
    expect(names).toEqual(expect.arrayContaining(["Attributes", "Relations", "Pset_WallCommon", "Qto_WallBaseQuantities", "Materials", "Classification"]));
    const pset = groups.find((g) => g.name === "Pset_WallCommon")!;
    expect(pset.properties).toContainEqual({ name: "FireRating", value: "REI 60" });
  });

  test("the canvas follows element resizes", async ({ page }) => {
    await openHarness(page);
    await load(page, `${FIX}/box.ifc`);
    const size = () => page.evaluate(() => {
      const c = (document.getElementById("viewer0") as ViewerEl).viewer.renderer.canvas;
      return [c.width, c.height];
    });
    const before = await size();
    await page.setViewportSize({ width: 800, height: 600 });
    await expect.poll(size).not.toEqual(before);
  });
});

test.describe("embedding", () => {
  test("multiple instances are independent", async ({ page }) => {
    await openHarness(page, { count: 2 });
    await load(page, `${FIX}/box.ifc`, 0);
    await load(page, `${FIX}/grid.ifc`, 1);
    const r = await page.evaluate(async () => {
      const a = document.getElementById("viewer0") as ViewerEl;
      const b = document.getElementById("viewer1") as ViewerEl;
      b.select(b.viewer.model.geometryProducts[0]!);
      const result = { a: a.selection.length, b: b.selection.length, aCount: a.viewer.productCount, bCount: b.viewer.productCount };
      await a.dispose();
      return result;
    });
    expect(r).toEqual({ a: 0, b: 1, aCount: 4, bCount: 903 });
    expect(await coverage(page, 1)).toBeGreaterThan(0.01);
  });

  test("removing the element disposes the viewer and its WebGL context", async ({ page }) => {
    await openHarness(page);
    await load(page, `${FIX}/box.ifc`);
    const lost = await page.evaluate(async () => {
      const v = document.getElementById("viewer0") as ViewerEl;
      const r = v.viewer.renderer;
      v.remove();
      await new Promise((res) => setTimeout(res, 50));
      return r.contextLost || (r.canvas.getContext("webgl2") as WebGL2RenderingContext).isContextLost();
    });
    expect(lost).toBe(true);
  });

  test("moving the element in the DOM keeps the model", async ({ page }) => {
    await openHarness(page);
    await load(page, `${FIX}/box.ifc`);
    const count = await page.evaluate(async () => {
      const v = document.getElementById("viewer0") as ViewerEl;
      const host = document.createElement("div");
      host.style.height = "400px";
      document.body.append(host);
      host.append(v);
      await new Promise((res) => setTimeout(res, 50));
      return v.viewer.geometryProductCount;
    });
    expect(count).toBe(1);
  });

  test("minimal and none UI modes hide chrome", async ({ page }) => {
    await openHarness(page, { ui: "none" });
    await load(page, `${FIX}/box.ifc`);
    await expect(page.locator("#viewer0").locator(".toolbar")).toBeHidden();
    await expect(page.locator("#viewer0").locator(".sidebar")).toBeHidden();
  });

  test("injects no global styles and defines only the custom element", async ({ page }) => {
    await openHarness(page);
    const r = await page.evaluate(() => ({ sheets: document.styleSheets.length, styles: document.querySelectorAll("style").length }));
    expect(r.styles).toBe(1); // the harness page's own style element
    expect(r.sheets).toBe(1);
  });

  test("toolbar controls have accessible names and the status is announced", async ({ page }) => {
    await openHarness(page);
    await load(page, `${FIX}/box.ifc`);
    const v = page.locator("#viewer0");
    const names = await v.locator(".toolbar button").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
    expect(names.every((n) => n.length > 0)).toBe(true);
    await expect(v.getByRole("status")).toContainText("elements shown");
    await expect(v.locator("canvas")).toHaveAttribute("tabindex", "0");
  });
});

test.describe("rendering", () => {
  test("renders every geometry family of the demo model", async ({ page }) => {
    await openHarness(page);
    const stats = await load(page, `${FIX}/demo.ifc`);
    expect(stats.triangles).toBeGreaterThan(3000);
    expect(await coverage(page)).toBeGreaterThan(0.1);
    // isolate each product: every one draws pixels
    const empty = await page.evaluate(async () => {
      const v = document.getElementById("viewer0") as ViewerEl & { viewer: { snapshot(): { data: Uint8Array } } };
      const out: string[] = [];
      for (const id of Array.from(v.viewer.model.geometryProducts)) {
        v.isolate([id]);
        await v.fit([id], { animate: false });
        const s = v.viewer.snapshot();
        let n = 0;
        for (let k = 0; k < s.data.length; k += 4) if (Math.abs(s.data[k]! - s.data[0]!) + Math.abs(s.data[k + 1]! - s.data[1]!) + Math.abs(s.data[k + 2]! - s.data[2]!) > 18) n++;
        if (n < 50) out.push(v.viewer.model.tree.find((t) => t.id === id)?.name ?? String(id));
      }
      return out;
    });
    expect(empty).toEqual([]);
  });

  test("repeated load/unload cycles release GPU memory", async ({ page }) => {
    await openHarness(page);
    const samples = await page.evaluate(async (url) => {
      const v = document.getElementById("viewer0") as ViewerEl & { viewer: { renderer: { gpuBytes: number } } };
      const out: number[] = [];
      for (let i = 0; i < 6; i++) {
        await v.load(url);
        v.isolate([v.viewer.model.geometryProducts[0]!]);
        await v.unload();
        out.push(v.viewer.renderer.gpuBytes);
      }
      await v.load(url);
      out.push(v.viewer.renderer.gpuBytes);
      return out;
    }, `${FIX}/demo.ifc`);
    expect(samples.slice(0, 6)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(samples[6]).toBeGreaterThan(0);
  });

  test("reloads the model after the WebGL context is lost and restored", async ({ page }) => {
    await openHarness(page);
    await load(page, `${FIX}/box.ifc`);
    await page.evaluate(async () => {
      const v = document.getElementById("viewer0") as ViewerEl;
      const gl = v.viewer.renderer.canvas.getContext("webgl2")!;
      const ext = gl.getExtension("WEBGL_lose_context")!;
      ext.loseContext();
      await new Promise((r) => setTimeout(r, 100));
      ext.restoreContext();
    });
    await expect.poll(async () => (await events(page)).filter((e) => e.type === "ifc-load").length, { timeout: 30_000 }).toBe(2);
    const nonFatal = (await events(page)).filter((e) => e.type === "ifc-error").map((e) => e.detail as { fatal: boolean; message: string });
    expect(nonFatal[0]).toMatchObject({ fatal: false });
    expect(await coverage(page)).toBeGreaterThan(0.01);
  });

  test("dark theme feeds the renderer background", async ({ page }) => {
    await openHarness(page, { theme: "dark" });
    await load(page, `${FIX}/box.ifc`);
    const [r, g, b] = await pixelAt(page, 3, 3);
    expect(r + g + b).toBeLessThan(150);
  });
});

void ({} as Recorded);

test("explains a missing WebGL2 instead of failing silently", async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      if (type === "webgl2") return null;
      return (original as (...a: unknown[]) => RenderingContext | null).call(this, type, ...rest);
    } as typeof original;
  });
  await openHarness(page);
  const v = page.locator("#viewer0");
  await expect(v.getByRole("alert")).toContainText("WebGL2 is not available");
  const err = await waitForEvent(page, "ifc-error");
  expect(err.detail).toMatchObject({ fatal: true });
  const rejected = await page.evaluate(async () => {
    try {
      await (document.getElementById("viewer0") as HTMLElement & { load(s: string): Promise<unknown> }).load("/tests/fixtures/generated/box.ifc");
      return "loaded";
    } catch (e) {
      return (e as Error).message;
    }
  });
  expect(rejected).toContain("WebGL2");
});
