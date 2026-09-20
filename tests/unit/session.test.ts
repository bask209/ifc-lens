// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deflateRawSync } from "node:zlib";
import type { GeometryBatch, ModelMetadata } from "../../src/protocol/messages.ts";
import { batchTransferables } from "../../src/protocol/messages.ts";
import { LoadSession, serializeError } from "../../src/worker/session.ts";
import { openZipMember, validateSourceUrl } from "../../src/worker/source.ts";
import { IfcBuilder } from "../helpers/ifc-builder.ts";

function demoModel(count = 6): Uint8Array {
  const b = new IfcBuilder();
  const h = b.hierarchy();
  const ids: number[] = [];
  for (let i = 0; i < count; i++) ids.push(b.element("IFCWALL", `Wall ${i}`, b.localPlacement(h.storeyPlacement, [i * 2, 0, 0]), b.shape(h.body, [b.box(1, 0.2, 3)]), h));
  b.contain(h, h.storey, ids);
  return b.bytes();
}

interface Collected {
  metadata?: ModelMetadata;
  batches: GeometryBatch[];
  phases: string[];
  diagnostics: string[];
  limits: string[];
}

function collector(): { session: (limits?: ConstructorParameters<typeof LoadSession>[1]) => LoadSession; out: Collected } {
  const out: Collected = { batches: [], phases: [], diagnostics: [], limits: [] };
  return {
    out,
    session: (limits = {}) =>
      new LoadSession(
        {
          progress: (phase) => out.phases.push(phase),
          metadata: (m) => (out.metadata = m),
          geometry: (b) => out.batches.push(b),
          diagnostic: (d) => out.diagnostics.push(d.code),
          resourceLimit: (d) => out.limits.push(d.resource),
        },
        limits,
      ),
  };
}

function zip(name: string, data: Uint8Array, deflate: boolean): Uint8Array {
  const enc = new TextEncoder();
  const nameBytes = enc.encode(name);
  const payload = deflate ? new Uint8Array(deflateRawSync(data)) : data;
  const local = new Uint8Array(30 + nameBytes.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(8, deflate ? 8 : 0, true);
  lv.setUint32(18, payload.length, true);
  lv.setUint32(22, data.length, true);
  lv.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  const central = new Uint8Array(46 + nameBytes.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(10, deflate ? 8 : 0, true);
  cv.setUint32(20, payload.length, true);
  cv.setUint32(24, data.length, true);
  cv.setUint16(28, nameBytes.length, true);
  cv.setUint32(42, 0, true);
  central.set(nameBytes, 46);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length + payload.length, true);
  const out = new Uint8Array(local.length + payload.length + central.length + eocd.length);
  out.set(local, 0);
  out.set(payload, local.length);
  out.set(central, local.length + payload.length);
  out.set(eocd, local.length + payload.length + central.length);
  return out;
}

describe("load session", () => {
  it("streams a buffer through parse, index and geometry", async () => {
    const { session, out } = collector();
    const bytes = demoModel();
    const stats = await session().run({ kind: "buffer", buffer: bytes.buffer as ArrayBuffer, name: "demo.ifc" });
    assert.equal(stats.products, 9); // site, building, storey + 6 walls
    assert.equal(stats.productsWithGeometry, 6);
    assert.equal(stats.triangles, 6 * 12);
    assert.equal(out.metadata!.geometryProducts.length, 6);
    assert.equal(out.metadata!.schema, "IFC4");
    assert.ok(out.metadata!.tree.some((n) => n.type === "IfcBuildingStorey"));
    const productIds = out.batches.flatMap((b) => [...b.productIds]);
    assert.equal(productIds.length, 6);
    for (const phase of ["fetch", "parse", "index", "geometry"]) assert.ok(out.phases.includes(phase), phase);
    const mesh = out.batches[0]!.meshes[0]!;
    assert.equal(mesh.positions.length / 3, mesh.objects.length);
    assert.equal(mesh.normals.length, mesh.positions.length);
    assert.ok(mesh.objects.every((o) => o >= 1 && o <= 6));
    // transfer list contains every buffer exactly once
    const transfer = batchTransferables(out.batches[0]!);
    assert.equal(new Set(transfer).size, transfer.length);
  });

  it("loads Blob sources", async () => {
    const { session } = collector();
    const stats = await session().run({ kind: "blob", blob: new Blob([demoModel(2) as BlobPart]), name: "b.ifc" });
    assert.equal(stats.productsWithGeometry, 2);
  });

  it("loads stored and deflated ifcZIP archives", async () => {
    for (const deflate of [false, true]) {
      const { session } = collector();
      const archive = zip("model/demo.ifc", demoModel(3), deflate);
      const stats = await session().run({ kind: "buffer", buffer: archive.buffer as ArrayBuffer, name: "demo.ifczip" });
      assert.equal(stats.productsWithGeometry, 3, deflate ? "deflate" : "stored");
    }
    assert.throws(() => openZipMember(zip("readme.txt", new Uint8Array([1, 2, 3]), false), 1e9), /no \.ifc file/);
  });

  it("cancels promptly", async () => {
    const { session } = collector();
    const s = session();
    const run = s.run({ kind: "buffer", buffer: demoModel(200).buffer as ArrayBuffer, name: "big.ifc" });
    s.cancel();
    await assert.rejects(run, (e: Error) => e.name === "AbortError");
  });

  it("fails safely on resource limits and non-STEP input", async () => {
    const { session, out } = collector();
    await assert.rejects(session({ maxFileBytes: 100 }).run({ kind: "buffer", buffer: demoModel().buffer as ArrayBuffer, name: "x.ifc" }), (e: Error) => serializeError(e).resource?.resource === "file-bytes");
    await assert.rejects(session().run({ kind: "buffer", buffer: new TextEncoder().encode("<html>nope</html>").buffer as ArrayBuffer, name: "x.ifc" }), /ISO 10303-21/);
    await assert.rejects(session({ maxEntities: 10 }).run({ kind: "buffer", buffer: demoModel().buffer as ArrayBuffer, name: "x.ifc" }), (e: Error) => serializeError(e).resource?.resource === "entities");
    void out;
  });

  it("reports geometry budget exhaustion as a resource limit and still completes", async () => {
    const { session, out } = collector();
    const stats = await session({ maxGeometryBytes: 2000 }).run({ kind: "buffer", buffer: demoModel(20).buffer as ArrayBuffer, name: "x.ifc" });
    assert.ok(out.limits.includes("geometry-bytes"));
    assert.ok(stats.productsWithGeometry < 20);
  });

  it("answers property and entity queries after loading", async () => {
    const { session, out } = collector();
    const s = session();
    await s.run({ kind: "buffer", buffer: demoModel(1).buffer as ArrayBuffer, name: "x.ifc" });
    const wall = out.metadata!.geometryProducts[0]!;
    const groups = s.properties(wall);
    assert.equal(groups[0]!.name, "Attributes");
    const entity = s.entity(wall);
    assert.equal(entity.summary!.name, "Wall 0");
    assert.ok(entity.attributes[0]!.startsWith("'"));
  });

  it("validates source URLs", () => {
    assert.throws(() => validateSourceUrl("javascript:alert(1)"), /scheme/);
    assert.throws(() => validateSourceUrl("data:text/plain,abc"), /scheme/);
    assert.throws(() => validateSourceUrl("file:///etc/passwd"), /scheme/);
    assert.equal(validateSourceUrl("https://example.com/a.ifc").protocol, "https:");
  });
});
