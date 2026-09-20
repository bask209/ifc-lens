// SPDX-License-Identifier: Apache-2.0
/** Writes docs/ifc-support.md from src/ifc/support.ts. */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SUPPORT_MATRIX } from "../src/ifc/support.ts";
import { renderSupportMarkdown } from "./support-doc.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
writeFileSync(join(root, "docs", "ifc-support.md"), renderSupportMarkdown(SUPPORT_MATRIX));
console.log("docs/ifc-support.md updated");
