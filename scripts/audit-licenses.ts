// SPDX-License-Identifier: Apache-2.0
/**
 * Release license gate. The shipped artifact, not package metadata, is the
 * unit of audit:
 *  1. package.json declares no runtime/peer/optional dependencies;
 *  2. every file in dist/ is an expected artifact type;
 *  3. every emitted JavaScript file has a source map whose sources are all
 *     project files under src/ (provenance), and the map points at an
 *     existing source carrying an Apache-2.0 SPDX header;
 *  4. dist/ contains no bare-module imports and no third-party license
 *     markers (secondary alarm);
 *  5. every installed development package is inventoried with its license;
 *     non-Apache development packages must be on the documented allowlist.
 * Writes dist/build-provenance.json and COMPLIANCE.json.
 *
 *   node scripts/audit-licenses.ts [--dist <dir>] [--no-write]
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const distArg = args.indexOf("--dist");
const dist = resolve(distArg >= 0 ? args[distArg + 1]! : join(root, "dist"));
const write = !args.includes("--no-write");
const packageRoot = resolve(dist, "..");

/** Development-only packages whose license is not Apache-2.0 (never shipped). */
export const DEV_LICENSE_EXCEPTIONS: Record<string, string> = {
  "@types/node": "MIT — TypeScript type declarations used only to type-check tests and scripts",
  "undici-types": "MIT — dependency of @types/node (type declarations only)",
};

const FORBIDDEN_MARKERS = [
  /meshoptimizer/i,
  /MIT License/,
  /Permission is hereby granted, free of charge/,
  /ISC License/,
  /Mozilla Public License/,
  /GNU (Lesser )?General Public License/,
  /\bLGPL\b|\bAGPL\b/,
  /Redistribution and use in source and binary forms/,
  /tslib/,
  /THIS SOFTWARE IS PROVIDED "AS IS"/,
  /Copyright \(c\) Microsoft/,
  // third-party package names (case-sensitive: IFCOPENSHELL is an IFC entity name)
  /@babylonjs|manifold-3d|web-ifc|xeokit|ifcopenshell|IfcOpenShell/,
];

const ALLOWED_EXTENSIONS = [".js", ".js.map", ".d.ts", ".html", ".css"];
const ALLOWED_NAMES = new Set(["LICENSE", "NOTICE", "build-provenance.json"]);

const failures: string[] = [];
const fail = (m: string): void => {
  failures.push(m);
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

// 1. runtime dependency declarations
const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as Record<string, unknown>;
for (const field of ["dependencies", "peerDependencies", "optionalDependencies", "bundleDependencies", "bundledDependencies"]) {
  const v = pkg[field];
  if (v && typeof v === "object" && Object.keys(v).length > 0) fail(`package.json ${field} must be empty, found ${JSON.stringify(v)}`);
}
if (pkg.license !== "Apache-2.0") fail(`package.json license must be Apache-2.0, found ${String(pkg.license)}`);

// 2–4. artifact provenance
if (!existsSync(dist)) {
  fail(`${dist} does not exist; run npm run build`);
} else {
  const files = walk(dist);
  const provenance: Record<string, { sha256: string; sources: string[] }> = {};
  const srcRoot = join(packageRoot, "src");
  const haveSources = existsSync(srcRoot);
  for (const file of files) {
    const rel = relative(dist, file);
    const name = rel.split(sep).pop()!;
    if (!ALLOWED_NAMES.has(name) && !ALLOWED_EXTENSIONS.some((e) => name.endsWith(e))) fail(`unexpected artifact type: ${rel}`);
    if (rel.split(sep).includes("node_modules")) fail(`node_modules content in dist: ${rel}`);
    const text = readFileSync(file, "utf8");
    if (!["LICENSE", "NOTICE"].includes(name)) {
      for (const marker of FORBIDDEN_MARKERS) if (marker.test(text)) fail(`forbidden marker ${marker} in ${rel}`);
    }
    if (name.endsWith(".js")) {
      for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s*["']([^"']+)["']/g)) {
        if (!m[1]!.startsWith(".") && !m[1]!.startsWith("/")) fail(`bare module import "${m[1]}" in ${rel}`);
      }
      for (const m of text.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) {
        if (!m[1]!.startsWith(".") && !m[1]!.startsWith("/")) fail(`bare dynamic import "${m[1]}" in ${rel}`);
      }
      const mapFile = `${file}.map`;
      if (!existsSync(mapFile)) {
        fail(`missing source map for ${rel}`);
        continue;
      }
      const map = JSON.parse(readFileSync(mapFile, "utf8")) as { sources: string[] };
      const sources: string[] = [];
      for (const s of map.sources) {
        const abs = resolve(dirname(mapFile), s);
        const fromSrc = relative(srcRoot, abs);
        if (fromSrc.startsWith("..") || fromSrc.split(sep).includes("node_modules")) {
          fail(`${rel} contains code from outside src/: ${s}`);
          continue;
        }
        if (haveSources) {
          if (!existsSync(abs)) fail(`${rel}: mapped source missing: ${s}`);
          else if (!readFileSync(abs, "utf8").startsWith("// SPDX-License-Identifier: Apache-2.0")) fail(`${fromSrc} lacks the Apache-2.0 SPDX header`);
        }
        sources.push(`src/${fromSrc.split(sep).join("/")}`);
      }
      provenance[rel.split(sep).join("/")] = { sha256: sha256(readFileSync(file)), sources };
    }
  }
  if (write && failures.length === 0) {
    let commit = "unknown";
    try {
      commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      commit = "uncommitted";
    }
    const tsc = JSON.parse(readFileSync(join(root, "node_modules", "typescript", "package.json"), "utf8")) as { version: string };
    writeFileSync(
      join(dist, "build-provenance.json"),
      JSON.stringify(
        {
          package: `${String(pkg.name)}@${String(pkg.version)}`,
          viewerCommit: commit,
          compiler: { name: "typescript", version: tsc.version, license: "Apache-2.0", emitsHelpers: false },
          runtimeComponents: [{ name: String(pkg.name), license: "Apache-2.0", origin: "src/" }],
          thirdPartyRuntimeComponents: [],
          files: provenance,
        },
        null,
        2,
      ) + "\n",
    );
  }
}

// 5. development dependency inventory
interface DevPackage {
  name: string;
  version: string;
  license: string;
}
const devPackages: DevPackage[] = [];
const nodeModules = join(root, "node_modules");
if (existsSync(nodeModules)) {
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".")) continue;
      const p = join(dir, entry);
      if (entry.startsWith("@")) {
        visit(p);
        continue;
      }
      const pj = join(p, "package.json");
      if (!existsSync(pj)) continue;
      const meta = JSON.parse(readFileSync(pj, "utf8")) as { name: string; version: string; license?: string };
      devPackages.push({ name: meta.name, version: meta.version, license: meta.license ?? "UNKNOWN" });
      if (existsSync(join(p, "node_modules"))) visit(join(p, "node_modules"));
    }
  };
  visit(nodeModules);
  for (const d of devPackages) {
    if (d.license !== "Apache-2.0" && !DEV_LICENSE_EXCEPTIONS[d.name]) fail(`development package ${d.name}@${d.version} is ${d.license} and not on the documented exception list`);
  }
}

if (write && failures.length === 0 && resolve(dist) === resolve(root, "dist")) {
  writeFileSync(
    join(root, "COMPLIANCE.json"),
    JSON.stringify(
      {
        runtimePolicy: "Apache-2.0-or-browser-native",
        ordinaryRuntimeDependencies: [],
        components: [
          { name: String(pkg.name), license: "Apache-2.0", scope: "runtime", note: "all shipped JavaScript is compiled from src/ (verified via source maps)" },
          { name: "WebGL2, Web Workers, Custom Elements, Streams, DecompressionStream", license: "browser-native", scope: "runtime" },
        ],
        renderer: { name: "project WebGL2 renderer", license: "Apache-2.0", note: "Babylon.js not used: its ESM closure includes a 0BSD tslib copy and its NOTICE lists MIT meshoptimizer" },
        csgBackend: { name: "project-native mesh Boolean engine", license: "Apache-2.0", note: "Manifold not used: its browser build embeds MIT/NCSA Emscripten runtime code" },
        developmentDependencies: devPackages.sort((a, b) => a.name.localeCompare(b.name)).map((d) => ({ ...d, exception: DEV_LICENSE_EXCEPTIONS[d.name] })),
        testData: { name: "buildingSMART Certification-datasets", license: "CC-BY-4.0", distribution: "fetched for tests at a pinned commit; not redistributed" },
      },
      null,
      2,
    ) + "\n",
  );
}

if (failures.length > 0) {
  console.error(`License audit FAILED (${failures.length}):\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log(`License audit passed: ${dist} contains only project Apache-2.0 code; ${devPackages.length} development packages inventoried.`);
