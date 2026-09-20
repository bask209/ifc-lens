// SPDX-License-Identifier: Apache-2.0
/**
 * Packs the npm tarball, unpacks it into a clean directory and re-runs the
 * artifact license audit on exactly what consumers receive.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "ifc-lens-pack-"));
try {
  // `npm pack` runs the prepack build, so its lifecycle output precedes the JSON report.
  const out = execFileSync("npm", ["pack", "--json", "--pack-destination", work], { cwd: root, encoding: "utf8" });
  const start = out.indexOf("[");
  if (start < 0) throw new Error(`npm pack produced no JSON report:\n${out}`);
  const [{ filename, files }] = JSON.parse(out.slice(start)) as { filename: string; files: { path: string }[] }[];
  execFileSync("tar", ["xzf", join(work, filename), "-C", work]);
  const pkgDir = join(work, "package");
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { dependencies?: object };
  if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) throw new Error("packed package has runtime dependencies");
  const paths = files.map((f) => f.path);
  // The provenance report is written by the license audit after the build; a
  // pack that skips it would ship an artifact nobody can trace.
  if (!paths.includes("dist/build-provenance.json")) throw new Error("tarball is missing dist/build-provenance.json");
  const unexpected = paths.filter((p) => !/^(dist\/|LICENSE$|NOTICE$|README\.md$|package\.json$|COMPLIANCE\.json$|sbom\.cdx\.json$)/.test(p));
  if (unexpected.length) throw new Error(`unexpected files in tarball: ${unexpected.join(", ")}`);
  execFileSync(process.execPath, [join(root, "scripts", "audit-licenses.ts"), "--dist", join(pkgDir, "dist"), "--no-write"], { stdio: "inherit" });
  console.log(`package verified: ${filename} (${files.length} files)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
