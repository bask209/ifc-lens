// SPDX-License-Identifier: Apache-2.0
/**
 * The `prepare` lifecycle hook: builds `dist/` when it is not there.
 *
 * npm runs `prepare` for a dependency installed straight from the repository,
 * where `dist/` is not in the tree — without it, `npm install github:…` would
 * deliver a package with no code. npm also runs it during `npm pack`, but
 * *after* `prepack` has already built and audited `dist/`; rebuilding at that
 * point would delete the provenance report the audit just wrote, so an
 * existing build is kept as it is.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

if (existsSync(join(root, "dist", "ifc-viewer.js"))) {
  console.log("prepare: dist/ is already built, keeping it");
} else {
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
}
