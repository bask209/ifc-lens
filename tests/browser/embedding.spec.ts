// SPDX-License-Identifier: Apache-2.0
/** Demo page, examples and the cross-origin iframe bridge. */
import { expect, test } from "@playwright/test";

test("the demo page opens the bundled model and logs viewer events", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/demo/");
  const viewer = page.locator("ifc-viewer");
  await expect(viewer.locator(".status .text")).toContainText("elements shown", { timeout: 30_000 });
  await expect(page.locator("#log")).toContainText("load");
  await expect(page.locator("#log")).toContainText("model-ready");
  expect(errors).toEqual([]);
});

test("the minimal example renders the model", async ({ page }) => {
  await page.goto("/examples/minimal/");
  await expect(page.locator("ifc-viewer").locator(".status .text")).toContainText("28 of 37 elements shown", { timeout: 30_000 });
});

test("the programmatic example selects and fits through the API", async ({ page }) => {
  await page.goto("/examples/programmatic/");
  await expect(page.locator("#out")).toContainText("Pitched roof", { timeout: 30_000 });
});

test("the iframe bridge drives a cross-origin viewer", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/examples/iframe/");
  await page.waitForFunction(() => (window as unknown as { bridgeLoaded?: boolean }).bridgeLoaded === true, undefined, { timeout: 30_000 });
  const frame = page.frameLocator("#frame");
  const canvas = frame.locator("ifc-viewer").locator("canvas");
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(() => ((window as unknown as { bridgeSelection?: number[] }).bridgeSelection ?? []).length === 1);
  await page.getByRole("button", { name: "Hide selection" }).click();
  await expect(page.locator("#status")).toContainText("Selected #");
  const props = await page.evaluate(async () => {
    const w = window as unknown as { bridge: { call(t: string, p?: unknown): Promise<unknown> }; bridgeSelection: number[] };
    return w.bridge.call("getProperties", { id: w.bridgeSelection[0] });
  });
  expect(JSON.stringify(props)).toContain("GlobalId");
  // commands with invalid payloads are rejected by the frame
  const rejected = await page.evaluate(async () => {
    const w = window as unknown as { bridge: { call(t: string, p?: unknown): Promise<unknown> } };
    try {
      await w.bridge.call("select", { ids: ["<script>"] });
      return "accepted";
    } catch (e) {
      return (e as Error).message;
    }
  });
  expect(rejected).toContain("invalid command");
  expect(errors).toEqual([]);
});
