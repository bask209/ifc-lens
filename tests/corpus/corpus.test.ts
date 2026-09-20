// SPDX-License-Identifier: Apache-2.0
/**
 * Mandatory compatibility suite: every IFC file of the buildingSMART
 * Certification-datasets repository (pinned commit) is loaded through the
 * complete pipeline. No file may be skipped or marked as an expected failure.
 * Per-file results are recorded in results.json and regression-checked;
 * set UPDATE_CORPUS_RESULTS=1 to re-record after an intentional change.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { LoadSession } from "../../src/worker/session.ts";
import { CORPUS_COMMIT, CORPUS_REPOSITORY, ensureCorpus } from "../../scripts/fetch-corpus.ts";
import { RESULTS_PATH, discoverCorpus, loadResults, sha256, type CorpusRecord } from "./corpus-lib.ts";

const update = process.env.UPDATE_CORPUS_RESULTS === "1";
const dir = ensureCorpus();
const files = discoverCorpus(dir);
const previous = update ? undefined : loadResults();
const recorded: CorpusRecord[] = [];
const PER_FILE_TIMEOUT_MS = 120_000;

describe(`Certification-datasets @ ${CORPUS_COMMIT.slice(0, 10)}`, () => {
  it("discovers the complete corpus and matches the recorded file list", () => {
    assert.ok(files.length > 0, "corpus is empty");
    if (previous) {
      assert.equal(previous.commit, CORPUS_COMMIT);
      assert.deepEqual(files, previous.files.map((f) => f.path), "discovered files differ from tests/corpus/results.json");
    }
  });

  for (const path of files) {
    it(path, { timeout: PER_FILE_TIMEOUT_MS }, async () => {
      const full = join(dir, path);
      const bytes = readFileSync(full);
      let geometryProducts = 0;
      const codes: Record<string, number> = {};
      let errors = 0;
      let warnings = 0;
      let batches = 0;
      const session = new LoadSession({
        progress() {},
        metadata(m) {
          geometryProducts = m.geometryProducts.length;
        },
        geometry(b) {
          batches++;
          for (const mesh of b.meshes) {
            assert.equal(mesh.positions.length / 3, mesh.objects.length);
            for (let i = 0; i < mesh.positions.length; i++) assert.ok(Number.isFinite(mesh.positions[i]!), "finite positions");
            for (let i = 0; i < mesh.indices.length; i++) assert.ok(mesh.indices[i]! < mesh.positions.length / 3, "indices in range");
          }
        },
        diagnostic(d) {
          codes[d.code] = (codes[d.code] ?? 0) + 1;
          if (d.severity === "error") errors++;
          else if (d.severity === "warning") warnings++;
        },
        resourceLimit(d) {
          assert.fail(`resource limit hit: ${d.resource}`);
        },
      });
      const stats = await session.run({ kind: "buffer", buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, name: path });
      const record: CorpusRecord = {
        path,
        sha256: sha256(full),
        bytes: stats.bytes,
        schema: session.model!.schema,
        entities: stats.entities,
        products: stats.products,
        geometryProducts,
        productsWithGeometry: stats.productsWithGeometry,
        triangles: stats.triangles,
        errorDiagnostics: errors,
        warningDiagnostics: warnings,
        diagnosticCodes: codes,
      };
      recorded.push(record);
      // A usable model/view: it has products, geometry, and every product with a
      // renderable representation produced geometry.
      assert.ok(stats.products > 0, "model has products");
      assert.ok(geometryProducts > 0, "model has products with representations");
      assert.equal(stats.productsWithGeometry, geometryProducts, "every product with a representation produced geometry");
      assert.ok(stats.triangles > 0 && batches > 0, "geometry was produced and packed");
      assert.equal(errors, 0, `error diagnostics: ${JSON.stringify(codes)}`);
      if (previous) {
        const prev = previous.files.find((f) => f.path === path);
        assert.ok(prev, "file is recorded in results.json");
        assert.equal(record.sha256, prev.sha256, "corpus file content changed");
        assert.equal(record.schema, prev.schema);
        assert.equal(record.entities, prev.entities);
        assert.equal(record.products, prev.products);
        assert.equal(record.geometryProducts, prev.geometryProducts);
        assert.ok(record.productsWithGeometry >= prev.productsWithGeometry, "no product lost its geometry");
        assert.ok(Math.abs(record.triangles - prev.triangles) <= Math.max(16, prev.triangles * 0.05), `triangle count drifted: ${record.triangles} vs ${prev.triangles}`);
        assert.ok(record.warningDiagnostics <= prev.warningDiagnostics, `new warnings: ${JSON.stringify(codes)}`);
      }
    });
  }

  after(() => {
    if (!update) return;
    recorded.sort((a, b) => a.path.localeCompare(b.path));
    writeFileSync(
      RESULTS_PATH,
      JSON.stringify({ repository: CORPUS_REPOSITORY, commit: CORPUS_COMMIT, generatedBy: "UPDATE_CORPUS_RESULTS=1 npm run test:corpus", files: recorded }, null, 2) + "\n",
    );
    console.log(`recorded ${recorded.length} files in ${RESULTS_PATH}`);
    void readFileSync;
  });
});
