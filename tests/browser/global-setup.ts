// SPDX-License-Identifier: Apache-2.0
/** Verifies the build exists and regenerates deterministic fixtures before browser tests. */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export default function globalSetup(): void {
  if (!existsSync("dist/ifc-viewer.js") || !existsSync("dist/worker/model-worker.js")) {
    throw new Error("dist/ is missing: run `npm run build` before the browser tests");
  }
  execFileSync(process.execPath, ["scripts/generate-fixtures.ts"], { stdio: "inherit" });
}
