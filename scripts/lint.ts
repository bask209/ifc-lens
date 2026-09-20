// SPDX-License-Identifier: Apache-2.0
/**
 * Repository hygiene checks: SPDX headers, no placeholders, no breakpoint statements or
 * stray console output in the runtime, no tabs/trailing whitespace, final newline.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const problems: string[] = [];
// Patterns are assembled so this file does not match itself.
const PLACEHOLDER = new RegExp(`\\b(${["TO", "DO"].join("")}|${["FIX", "ME"].join("")}|${"X".repeat(3)})\\b`);
const DEBUGGER = new RegExp(`\\b${["debug", "ger"].join("")}\\b`);
const files = ["src", "tests", "scripts"].flatMap((d) => walk(join(root, d))).filter((f) => /\.(ts|js|html|css)$/.test(f) && !f.includes("fixtures"));
for (const f of files) {
  const rel = relative(root, f);
  const text = readFileSync(f, "utf8");
  if (!/SPDX-License-Identifier: Apache-2\.0/.test(text.slice(0, 200)) && !rel.endsWith("blank.html")) problems.push(`${rel}: missing SPDX header`);
  if (PLACEHOLDER.test(text)) problems.push(`${rel}: placeholder marker`);
  if (DEBUGGER.test(text)) problems.push(`${rel}: breakpoint statement`);
  if (rel.startsWith("src/") && /console\.(log|debug|info)\(/.test(text)) problems.push(`${rel}: console output in runtime code`);
  if (/\t/.test(text)) problems.push(`${rel}: tab character`);
  if (/[ \t]+$/m.test(text)) problems.push(`${rel}: trailing whitespace`);
  if (!text.endsWith("\n")) problems.push(`${rel}: missing final newline`);
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`lint passed (${files.length} files)`);
