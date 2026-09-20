// SPDX-License-Identifier: Apache-2.0
import { expect, type Page } from "@playwright/test";

export interface HarnessOptions {
  src?: string;
  ui?: string;
  count?: number;
  theme?: string;
  autofit?: string;
  workerUrl?: string;
}

export async function openHarness(page: Page, o: HarnessOptions = {}): Promise<void> {
  const q = new URLSearchParams();
  if (o.src) q.set("src", o.src);
  if (o.ui) q.set("ui", o.ui);
  if (o.count) q.set("count", String(o.count));
  if (o.theme) q.set("theme", o.theme);
  if (o.autofit) q.set("autofit", o.autofit);
  if (o.workerUrl) q.set("worker-url", o.workerUrl);
  await page.goto(`/tests/browser/pages/harness.html?${q}`);
  await page.waitForFunction(() => (window as unknown as { harnessReady?: boolean }).harnessReady === true);
}

export type Recorded = { type: string; detail: Record<string, unknown> | null };

export async function events(page: Page, index = 0): Promise<Recorded[]> {
  return page.evaluate((i) => (window as unknown as { events: Recorded[][] }).events[i]!, index);
}

export async function waitForEvent(page: Page, type: string, index = 0): Promise<Recorded> {
  await expect.poll(async () => (await events(page, index)).some((e) => e.type === type), { timeout: 60_000 }).toBe(true);
  return (await events(page, index)).find((e) => e.type === type)!;
}

/** Loads a URL through the element API and returns the ifc-load stats. */
export async function load(page: Page, url: string, index = 0): Promise<{ productsWithGeometry: number; products: number; triangles: number }> {
  return page.evaluate(async ({ url, index }) => {
    const v = document.getElementById(`viewer${index}`) as HTMLElement & { load(u: string): Promise<unknown> };
    const done = new Promise<{ productsWithGeometry: number; products: number; triangles: number }>((resolve, reject) => {
      v.addEventListener("ifc-load", (e) => resolve((e as CustomEvent).detail.stats), { once: true });
      v.addEventListener("ifc-error", (e) => { if ((e as CustomEvent).detail.fatal) reject(new Error((e as CustomEvent).detail.error.message)); }, { once: true });
    });
    await v.load(url);
    return done;
  }, { url, index });
}

/** Fraction of canvas pixels that differ from the background colour. */
export async function coverage(page: Page, index = 0): Promise<number> {
  return page.evaluate((i) => {
    const v = document.getElementById(`viewer${i}`) as HTMLElement & { viewer: { snapshot(): { width: number; height: number; data: Uint8Array } } };
    const s = v.viewer.snapshot();
    const [r, g, b] = [s.data[0]!, s.data[1]!, s.data[2]!];
    let n = 0;
    for (let k = 0; k < s.data.length; k += 4) if (Math.abs(s.data[k]! - r) + Math.abs(s.data[k + 1]! - g) + Math.abs(s.data[k + 2]! - b) > 18) n++;
    return n / (s.width * s.height);
  }, index);
}

/** Canvas pixel colour at CSS coordinates relative to the canvas. */
export async function pixelAt(page: Page, x: number, y: number, index = 0): Promise<[number, number, number]> {
  return page.evaluate(({ x, y, i }) => {
    const v = document.getElementById(`viewer${i}`) as HTMLElement & { viewer: { snapshot(): { width: number; height: number; data: Uint8Array } } };
    const canvas = v.shadowRoot!.querySelector("canvas")!;
    const s = v.viewer.snapshot();
    const px = Math.floor((x / canvas.clientWidth) * s.width);
    const py = s.height - 1 - Math.floor((y / canvas.clientHeight) * s.height);
    const o = (py * s.width + px) * 4;
    return [s.data[o]!, s.data[o + 1]!, s.data[o + 2]!] as [number, number, number];
  }, { x, y, i: index });
}

export async function canvasBox(page: Page, index = 0): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator(`#viewer${index}`).locator("canvas").boundingBox();
  if (!box) throw new Error("canvas not visible");
  return box;
}
