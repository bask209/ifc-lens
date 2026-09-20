// SPDX-License-Identifier: Apache-2.0
/** Copies static runtime assets (iframe page) into dist/ after tsc. */
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(root, "dist", "iframe"), { recursive: true });
cpSync(join(root, "assets", "iframe"), join(root, "dist", "iframe"), { recursive: true });
cpSync(join(root, "LICENSE"), join(root, "dist", "LICENSE"));
cpSync(join(root, "NOTICE"), join(root, "dist", "NOTICE"));
console.log("assets copied to dist/");
