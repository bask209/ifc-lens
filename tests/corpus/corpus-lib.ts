// SPDX-License-Identifier: Apache-2.0
/** Shared corpus discovery and per-file evaluation (Node and browser suites). */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const RESULTS_PATH = join(dirname(fileURLToPath(import.meta.url)), "results.json");

export interface CorpusRecord {
  path: string;
  sha256: string;
  bytes: number;
  schema: string;
  entities: number;
  products: number;
  geometryProducts: number;
  productsWithGeometry: number;
  triangles: number;
  errorDiagnostics: number;
  warningDiagnostics: number;
  diagnosticCodes: Record<string, number>;
}

export interface CorpusResults {
  repository: string;
  commit: string;
  generatedBy: string;
  files: CorpusRecord[];
}

/** Every IFC file (.ifc, .ifczip, any case) below `dir`, excluding .git. */
export function discoverCorpus(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      if (name === ".git") continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ifc|ifczip)$/i.test(name)) out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

export function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function loadResults(): CorpusResults {
  return JSON.parse(readFileSync(RESULTS_PATH, "utf8")) as CorpusResults;
}

/** URL path under the test server's /corpus/ mount. */
export function corpusUrl(path: string): string {
  return "/corpus/" + path.split("/").map(encodeURIComponent).join("/");
}
