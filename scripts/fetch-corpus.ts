// SPDX-License-Identifier: Apache-2.0
/**
 * Fetches the buildingSMART Certification-datasets repository at a pinned
 * commit into a cache directory (default ~/.cache/ifc-lens/certification-datasets,
 * override with IFC_CORPUS_DIR). The dataset is CC BY 4.0 © buildingSMART
 * International Ltd.; it is downloaded for testing and never vendored into
 * this repository or its packages.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CORPUS_REPOSITORY = "https://github.com/buildingSMART/Certification-datasets";
export const CORPUS_COMMIT = "80d976a9b193a26a8e928c3e79bff67af1de68a8";
export const corpusDir = (): string => process.env.IFC_CORPUS_DIR ?? join(homedir(), ".cache", "ifc-lens", "certification-datasets");

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function ensureCorpus(): string {
  const dir = corpusDir();
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(dir, { recursive: true });
    git(["init", "-q"], dir);
    git(["remote", "add", "origin", CORPUS_REPOSITORY], dir);
  }
  let head = "";
  try {
    head = git(["rev-parse", "HEAD"], dir);
  } catch {
    head = "";
  }
  if (head !== CORPUS_COMMIT) {
    git(["fetch", "--depth", "1", "origin", CORPUS_COMMIT], dir);
    git(["checkout", "-q", "--force", "FETCH_HEAD"], dir);
  }
  const verified = git(["rev-parse", "HEAD"], dir);
  if (verified !== CORPUS_COMMIT) throw new Error(`corpus checkout is at ${verified}, expected ${CORPUS_COMMIT}`);
  const status = git(["status", "--porcelain"], dir);
  if (status) throw new Error(`corpus checkout has local modifications:\n${status}`);
  return dir;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = ensureCorpus();
  console.log(`Certification-datasets @ ${CORPUS_COMMIT} ready in ${dir}`);
}
