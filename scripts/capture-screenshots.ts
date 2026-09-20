// SPDX-License-Identifier: Apache-2.0
/**
 * Captures the screenshots used by README.md into docs/images/.
 *
 *   node scripts/capture-screenshots.ts [--only hero,tour] [--port 8129]
 *
 * Requires a build (`npm run build`) and, for the compatibility tiles, the
 * certification corpus (`npm run corpus:fetch`). IFC_LENS_ANGLE selects
 * Chromium's ANGLE backend, as it does for the browser suites.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { ensureCorpus } from "./fetch-corpus.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "docs", "images");
const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const port = Number(opt("port") ?? 8129);
const only = opt("only")?.split(",");
const base = `http://127.0.0.1:${port}`;
const DEMO = "/demo/models/harbour-pavilion.ifc";
const corpus = (schema: string, file: string): string => `/corpus/${schema}/Simple-Scene/${file}.ifc`;
const IFC2X3 = "IFC 2.3.0.1 (IFC 2x3 TC1)";
const IFC4 = "IFC 4.0.2.1 (IFC 4 ADD2 TC1)";
const IFC43 = "IFC 4.3.2.0 (IFC 4.3 ADD2)";

interface Options {
  ui?: string;
  theme?: string;
  width?: number;
  height?: number;
  scale?: number;
}

/** Opens the harness with one <ifc-viewer> sized to the viewport. */
async function view(browser: Browser, o: Options = {}): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: o.width ?? 1280, height: o.height ?? 760 },
    deviceScaleFactor: o.scale ?? 1.5,
  });
  const page = await context.newPage();
  const q = new URLSearchParams({ ui: o.ui ?? "full", theme: o.theme ?? "light" });
  await page.goto(`${base}/tests/browser/pages/harness.html?${q}`);
  await page.waitForFunction(() => (window as unknown as { harnessReady?: boolean }).harnessReady === true);
  return page;
}

async function load(page: Page, url: string): Promise<void> {
  await page.evaluate(async (u) => {
    const v = document.getElementById("viewer0") as HTMLElement & { load(u: string): Promise<void> };
    const done = new Promise<void>((resolve, reject) => {
      v.addEventListener("ifc-load", () => resolve(), { once: true });
      v.addEventListener("ifc-error", (e) => {
        if ((e as CustomEvent).detail.fatal) reject(new Error((e as CustomEvent).detail.error.message));
      });
    });
    await v.load(u);
    await done;
  }, url);
  await settle(page);
}

/**
 * Frames the main cluster of a model, looking across its principal horizontal
 * axis so long infrastructure fills the frame. Several certification files
 * park a tiny marker far from the scene, which a whole-model fit has to
 * include; the cluster filter drops it.
 */
async function frameCluster(page: Page, o: { elevation: number; along?: number; swing?: number }, reach = 1.2): Promise<void> {
  const { elevation } = o;
  await page.evaluate(async ({ elevation, along, swing, reach }) => {
    const v = document.getElementById("viewer0") as HTMLElement & { viewer: Viewer };
    const viewer = v.viewer;
    const centre = (b: Bounds): [number, number, number] => [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2];
    const span = (b: Bounds): number => Math.hypot(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ);
    const items = [...viewer.model!.geometryProducts]
      .map((id) => ({ id, bounds: viewer.productBounds(id) }))
      .filter((p): p is { id: number; bounds: Bounds } => p.bounds !== undefined);
    if (items.length === 0) return;
    const seed = items.reduce((a, b) => (span(a.bounds) >= span(b.bounds) ? a : b));
    const [sx, sy, sz] = centre(seed.bounds);
    const limit = Math.max(span(seed.bounds) * reach, 1);
    const keep = items.filter(({ bounds }) => {
      const [x, y, z] = centre(bounds);
      return Math.hypot(x - sx, y - sy, z - sz) <= limit;
    });
    // principal horizontal axis of the kept centres, then look across it
    const centres = keep.map((k) => centre(k.bounds));
    const mx = centres.reduce((a, c) => a + c[0], 0) / centres.length;
    const my = centres.reduce((a, c) => a + c[1], 0) / centres.length;
    let cxx = 0, cxy = 0, cyy = 0;
    for (const [x, y] of centres) {
      cxx += (x - mx) ** 2;
      cxy += (x - mx) * (y - my);
      cyy += (y - my) ** 2;
    }
    const theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    const axis: [number, number] = [Math.cos(theta), Math.sin(theta)];
    const across: [number, number] = [-axis[1], axis[0]];
    const side = across[1] > 0 ? -1 : 1;
    // Long models are framed on their near section and swung towards the
    // axis, so the rest of the alignment recedes into the distance.
    const phi = ((swing ?? 0) * Math.PI) / 180;
    const direction: [number, number, number] = [
      across[0] * side * Math.cos(phi) - axis[0] * Math.sin(phi),
      across[1] * side * Math.cos(phi) - axis[1] * Math.sin(phi),
      elevation,
    ];
    const projection = centres.map(([x, y]) => (x - mx) * axis[0] + (y - my) * axis[1]);
    const lo = Math.min(...projection);
    const cut = lo + (Math.max(...projection) - lo) * (along ?? 1);
    const framed = keep.filter((_, i) => projection[i]! <= cut);
    await viewer.viewFrom(direction);
    await viewer.fit((framed.length > 0 ? framed : keep).map((k) => k.id));
    const c = viewer.getCamera();
    viewer.setCamera({ ...c, eye: [0, 1, 2].map((i) => c.target[i]! + (c.eye[i]! - c.target[i]!) * 0.76) as [number, number, number] });
  }, { elevation, along: o.along, swing: o.swing, reach });
  await settle(page);
}

async function settle(page: Page, ms = 500): Promise<void> {
  await page.waitForTimeout(ms);
}

/** Points the camera, frames the given ids (or the model), then closes in. */
async function compose(page: Page, direction: [number, number, number], o: { ids?: number[]; zoom?: number } = {}): Promise<void> {
  await page.evaluate(async ({ direction, ids, zoom }) => {
    const v = (document.getElementById("viewer0") as HTMLElement & { viewer: Viewer }).viewer;
    await v.viewFrom(direction);
    await v.fit(ids);
    const c = v.getCamera();
    const f = zoom ?? 0.82;
    v.setCamera({ ...c, eye: [0, 1, 2].map((i) => c.target[i]! + (c.eye[i]! - c.target[i]!) * f) as [number, number, number] });
  }, { direction, ids: o.ids, zoom: o.zoom });
  await settle(page);
}

/** Keeps the tree scrolled to the project row after a programmatic selection. */
async function treeToTop(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = document.getElementById("viewer0") as HTMLElement;
    host.shadowRoot!.querySelector(".tree")!.closest(".scroll")!.scrollTop = 0;
  });
}

/** Product id of the first element whose tree label matches. */
async function findProduct(page: Page, name: string): Promise<number> {
  return page.evaluate((needle) => {
    const v = document.getElementById("viewer0") as HTMLElement & { viewer: Viewer };
    const walk = (nodes: TreeNode[]): TreeNode | undefined => {
      for (const n of nodes) {
        if (n.name?.toLowerCase().includes(needle.toLowerCase())) return n;
        const hit = walk(n.children ?? []);
        if (hit) return hit;
      }
      return undefined;
    };
    const hit = walk(v.viewer.model!.tree);
    if (!hit) throw new Error(`no tree node matching ${needle}`);
    return hit.id;
  }, name);
}

/** Numbered callouts over the live UI, anchored to shadow-DOM selectors. */
async function callouts(page: Page, marks: [string, string, string?][]): Promise<void> {
  await page.evaluate((items) => {
    const host = document.getElementById("viewer0") as HTMLElement;
    const layer = document.createElement("div");
    layer.style.cssText = "position:fixed;inset:0;z-index:9999;pointer-events:none;font:600 15px ui-sans-serif,system-ui,sans-serif";
    for (const [selector, label, where] of items) {
      const target = host.shadowRoot!.querySelector(selector);
      if (!target) throw new Error(`callout target ${selector} not found`);
      const r = target.getBoundingClientRect();
      const badge = document.createElement("div");
      const left = where === "left" || where === "topLeft";
      const x = left ? r.left - 36 : where === "below" ? r.left + r.width / 2 - 14 : where === "aboveStart" ? r.left + 8 : r.right + 8;
      const y = where === "below" ? r.bottom + 8 : where === "aboveStart" ? r.top - 36 : where === "topLeft" ? r.top + 6 : r.top + r.height / 2 - 14;
      badge.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:#f2c12e;color:#1d2731;box-shadow:0 2px 6px rgba(0,0,0,.35)`;
      badge.textContent = label;
      layer.append(badge);
    }
    document.body.append(layer);
  }, marks);
}

interface Bounds { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }
interface TreeNode { id: number; name?: string; children?: TreeNode[] }
interface Viewer {
  model?: { geometryProducts: Iterable<number>; tree: TreeNode[] };
  productBounds(id: number): Bounds | undefined;
  viewFrom(d: [number, number, number], o?: Record<string, unknown>): Promise<void>;
  fit(ids?: number[]): Promise<void>;
  select(id: number, o?: Record<string, unknown>): void;
  getCamera(): { eye: [number, number, number]; target: [number, number, number]; fov: number };
  setCamera(state: { eye: [number, number, number]; target: [number, number, number]; fov: number }): void;
  isolate(ids: number[]): void;
  setClipPlane(p: { normal: [number, number, number]; distance: number } | null): void;
}

const shots: Record<string, (browser: Browser) => Promise<void>> = {
  /** Full UI: model, spatial tree, selection and its properties. */
  async hero(browser) {
    const page = await view(browser, { width: 1280, height: 720 });
    await load(page, DEMO);
    const window2 = await findProduct(page, "South facade window 2");
    await page.evaluate((i) => (document.getElementById("viewer0") as HTMLElement & { viewer: Viewer }).viewer.select(i), window2);
    await compose(page, [0.78, -1, 0.44], { zoom: 0.74 });
    await treeToTop(page);
    await page.screenshot({ path: join(outDir, "hero.png") });
    await page.context().close();
  },

  /** The same view with numbered callouts for the README's tour. */
  async tour(browser) {
    const page = await view(browser, { width: 1280, height: 720 });
    await load(page, DEMO);
    const window2 = await findProduct(page, "South facade window 2");
    await page.evaluate((i) => (document.getElementById("viewer0") as HTMLElement & { viewer: Viewer }).viewer.select(i), window2);
    await compose(page, [0.78, -1, 0.44], { zoom: 0.74 });
    await treeToTop(page);
    await callouts(page, [
      [".toolbar", "1"],
      [".cube-scene", "2", "left"],
      ['[part="tree"]', "3", "left"],
      ['[part="properties"]', "4", "left"],
      [".help-button", "5", "left"],
      [".status", "6", "aboveStart"],
    ]);
    await page.screenshot({ path: join(outDir, "tour.png") });
    await page.context().close();
  },

  /** Selection highlight plus the property inspector. */
  async select(browser) {
    const page = await view(browser, { width: 1280, height: 720 });
    await load(page, DEMO);
    const window2 = await findProduct(page, "South facade window 2");
    const facade = await findProduct(page, "South facade");
    await page.evaluate((i) => (document.getElementById("viewer0") as HTMLElement & { viewer: Viewer }).viewer.select(i), window2);
    await compose(page, [0.3, -1, 0.42], { ids: [facade], zoom: 0.92 });
    await treeToTop(page);
    await page.screenshot({ path: join(outDir, "select.png") });
    await page.context().close();
  },

  /** A section plane through the building, with the tool open. */
  async section(browser) {
    const page = await view(browser, { width: 1280, height: 720 });
    await load(page, DEMO);
    const storey = await findProduct(page, "Ground floor");
    await compose(page, [0.62, -1, 0.5], { ids: [storey], zoom: 0.9 });
    await page.locator("#viewer0").getByRole("button", { name: /Section plane/ }).click();
    await page.locator("#viewer0").getByRole("slider", { name: "Section position" }).fill("560");
    await settle(page);
    await page.screenshot({ path: join(outDir, "section.png") });
    await page.context().close();
  },

  /** Orbit anchor and orientation cube, caught mid-drag, dark theme. */
  async navigate(browser) {
    const page = await view(browser, { width: 1280, height: 720, theme: "dark", ui: "minimal" });
    await load(page, DEMO);
    await compose(page, [0.8, -1, 0.45], { zoom: 0.66 });
    const box = (await page.locator("#viewer0").locator("canvas").boundingBox())!;
    const [x, y] = [box.x + box.width * 0.5, box.y + box.height * 0.45];
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 60, y + 18, { steps: 12 });
    await settle(page, 300);
    await page.screenshot({ path: join(outDir, "navigate.png") });
    await page.mouse.up();
    await page.context().close();
  },

  /** The built-in help panel. */
  async help(browser) {
    const page = await view(browser, { width: 1280, height: 720 });
    await load(page, DEMO);
    await compose(page, [0.78, -1, 0.44], { zoom: 0.74 });
    await page.locator("#viewer0").getByRole("button", { name: "Help", exact: true }).click();
    await settle(page);
    await page.screenshot({ path: join(outDir, "help.png") });
    await page.context().close();
  },

  /** Certification-dataset tiles: one per discipline, IFC 4.3. */
  async corpus(browser) {
    ensureCorpus();
    const tiles: [string, string, { elevation: number; along?: number; swing?: number }][] = [
      ["corpus-bridge", corpus(IFC43, "Infra-Bridge"), { elevation: 0.34, swing: 32 }],
      ["corpus-rail", corpus(IFC43, "Infra-Rail"), { elevation: 0.2, swing: 62, along: 0.4 }],
      ["corpus-structural", corpus(IFC4, "Building-Structural"), { elevation: 0.4, swing: 25 }],
      ["corpus-architecture", corpus(IFC2X3, "Building-Architecture"), { elevation: 0.45, swing: 30 }],
    ];
    for (const [name, url, framing] of tiles) {
      const page = await view(browser, { width: 640, height: 420, ui: "none", scale: 2 });
      await load(page, url);
      await frameCluster(page, framing);
      await page.screenshot({ path: join(outDir, `${name}.png`) });
      await page.context().close();
    }
  },
};

if (!existsSync(join(root, "dist", "ifc-viewer.js"))) {
  console.error("dist/ is missing: run npm run build first");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const server = spawn(process.execPath, [join(root, "scripts", "serve.ts"), "--port", String(port)], { stdio: "ignore" });
const stop = (): void => void server.kill();
process.on("exit", stop);

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/package.json`);
      if (r.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`static server did not start on ${base}`);
}

await waitForServer();
const angle = process.env.IFC_LENS_ANGLE;
const browser = await chromium.launch({ args: angle ? [`--use-angle=${angle}`] : [] });
for (const [name, run] of Object.entries(shots)) {
  if (only && !only.includes(name)) continue;
  await run(browser);
  console.log(`captured ${name}`);
}
await browser.close();
stop();
