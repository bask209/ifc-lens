// SPDX-License-Identifier: Apache-2.0
/**
 * Writes sbom.cdx.json (CycloneDX 1.5): the shipped package with per-file
 * hashes of dist/, and every development package as an excluded component.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string; version: string; description: string };
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const dist = join(root, "dist");
if (!existsSync(dist)) throw new Error("run npm run build first");

const files = walk(dist).sort().map((f) => ({
  type: "file",
  name: `dist/${relative(dist, f).split("\\").join("/")}`,
  hashes: [{ alg: "SHA-256", content: createHash("sha256").update(readFileSync(f)).digest("hex") }],
  licenses: [{ license: { id: "Apache-2.0" } }],
}));

const dev: object[] = [];
const visit = (dir: string): void => {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (entry.startsWith("@")) { visit(p); continue; }
    const pj = join(p, "package.json");
    if (!existsSync(pj)) continue;
    const m = JSON.parse(readFileSync(pj, "utf8")) as { name: string; version: string; license?: string };
    dev.push({ type: "library", name: m.name, version: m.version, scope: "excluded", purl: `pkg:npm/${m.name.replace("@", "%40")}@${m.version}`, licenses: [{ license: { id: m.license ?? "NOASSERTION" } }] });
    if (existsSync(join(p, "node_modules"))) visit(join(p, "node_modules"));
  }
};
visit(join(root, "node_modules"));

/**
 * The document is deterministic: the serial number is derived from the
 * inventory itself and the timestamp from the commit being described, so
 * regenerating an unchanged tree reproduces the file byte for byte.
 */
const inventory = JSON.stringify([...files, ...dev]);
const digest = createHash("sha256").update(inventory).digest("hex");
const serial = [digest.slice(0, 8), digest.slice(8, 12), `5${digest.slice(13, 16)}`, ((parseInt(digest.slice(16, 18), 16) & 0x3f) | 0x80).toString(16) + digest.slice(18, 20), digest.slice(20, 32)].join("-");
const commitDate = (): string => {
  try {
    return new Date(execFileSync("git", ["log", "-1", "--format=%cI"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()).toISOString();
  } catch {
    return new Date().toISOString(); // no commit yet: the working tree is the subject
  }
};

const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${serial}`,
  version: 1,
  metadata: {
    timestamp: commitDate(),
    component: { type: "library", name: pkg.name, version: pkg.version, description: pkg.description, licenses: [{ license: { id: "Apache-2.0" } }], purl: `pkg:npm/${pkg.name}@${pkg.version}` },
  },
  components: [...files, ...dev],
};
writeFileSync(join(root, "sbom.cdx.json"), JSON.stringify(bom, null, 2) + "\n");
console.log(`sbom.cdx.json: ${files.length} shipped files, ${dev.length} development packages (scope: excluded)`);
