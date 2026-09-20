// SPDX-License-Identifier: Apache-2.0
/**
 * Browser integration suites. The viewer is served from dist/ by the
 * project's static server; a second server on another port (with CORS) is
 * used for cross-origin tests.
 *
 * IFC_LENS_ANGLE selects Chromium's ANGLE backend (e.g. "gl-egl" on hosts
 * where the bundled SwiftShader cannot rasterise); CI runners use the default.
 */
import { defineConfig, devices } from "@playwright/test";

const angle = process.env.IFC_LENS_ANGLE;
const chromiumArgs = angle ? [`--use-angle=${angle}`] : [];

export default defineConfig({
  testDir: "tests/browser",
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: process.env.CI ? 2 : 3,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  globalSetup: "./tests/browser/global-setup.ts",
  use: {
    baseURL: "http://127.0.0.1:8123",
    viewport: { width: 1200, height: 800 },
    deviceScaleFactor: 1,
    trace: "retain-on-failure",
  },
  webServer: [
    { command: "node scripts/serve.ts --port 8123", url: "http://127.0.0.1:8123/package.json", reuseExistingServer: !process.env.CI },
    { command: "node scripts/serve.ts --port 8124 --cors", url: "http://127.0.0.1:8124/package.json", reuseExistingServer: !process.env.CI },
    { command: "node scripts/serve.ts --port 8125", url: "http://127.0.0.1:8125/package.json", reuseExistingServer: !process.env.CI },
  ],
  projects: [
    {
      name: "chromium",
      testIgnore: /corpus\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1200, height: 800 }, launchOptions: { args: chromiumArgs } },
    },
    {
      name: "firefox",
      testIgnore: /corpus\.spec\.ts/,
      use: { ...devices["Desktop Firefox"], viewport: { width: 1200, height: 800 }, launchOptions: { firefoxUserPrefs: { "webgl.force-enabled": true } } },
    },
    {
      name: "webkit",
      testIgnore: /corpus\.spec\.ts/,
      use: { ...devices["Desktop Safari"], viewport: { width: 1200, height: 800 } },
    },
    {
      name: "corpus",
      testMatch: /corpus\.spec\.ts/,
      timeout: 180_000,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1200, height: 800 }, launchOptions: { args: chromiumArgs } },
    },
  ],
});
