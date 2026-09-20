// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { booleanMeshes, type TriangleMesh64 } from "../../src/csg/backend.ts";
import { NativeCsgBackend, meshBoolean } from "../../src/csg/native.ts";
import { analyzeEdges, meshVolume } from "../../src/geometry/mesh.ts";
import { rotation, translation, multiply } from "../../src/math/mat4.ts";
import { $, en, real, ref, refs, bool, singleItemModel } from "../helpers/ifc-builder.ts";
import { approx, buildAll, worldMesh } from "../helpers/model.ts";

function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): TriangleMesh64 {
  const p = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const q = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const t: number[] = [];
  for (const [a, b, c, d] of q) t.push(a!, b!, c!, a!, c!, d!);
  return { positions: Float64Array.from(p), indices: Uint32Array.from(t) };
}

function cylinder(r: number, h: number, n = 32, z0 = 0): TriangleMesh64 {
  const p: number[] = [0, 0, z0, 0, 0, z0 + h];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    p.push(r * Math.cos(a), r * Math.sin(a), z0, r * Math.cos(a), r * Math.sin(a), z0 + h);
  }
  const t: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const b0 = 2 + i * 2, b1 = 2 + j * 2;
    t.push(0, b1, b0, 1, b0 + 1, b1 + 1, b0, b1, b1 + 1, b0, b1 + 1, b0 + 1);
  }
  return { positions: Float64Array.from(p), indices: Uint32Array.from(t) };
}

function transform(m: TriangleMesh64, t: Float64Array): TriangleMesh64 {
  const p = new Float64Array(m.positions.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = m.positions[i]!, y = m.positions[i + 1]!, z = m.positions[i + 2]!;
    p[i] = t[0]! * x + t[4]! * y + t[8]! * z + t[12]!;
    p[i + 1] = t[1]! * x + t[5]! * y + t[9]! * z + t[13]!;
    p[i + 2] = t[2]! * x + t[6]! * y + t[10]! * z + t[14]!;
  }
  return { positions: p, indices: m.indices };
}

function solidOk(m: TriangleMesh64): void {
  const e = analyzeEdges(m);
  assert.deepEqual(e, { boundaryEdges: 0, nonManifoldEdges: 0, inconsistentEdges: 0 });
}

const V = (m: TriangleMesh64): number => meshVolume(m);

describe("native mesh Booleans", () => {
  const A = box(0, 0, 0, 2, 2, 2);
  const B = box(1, 1, 1, 3, 3, 3);

  it("computes union / intersection / difference of overlapping cubes", () => {
    const u = meshBoolean("union", A, B), i = meshBoolean("intersection", A, B), d = meshBoolean("difference", A, B);
    approx(V(u), 15, 1e-9);
    approx(V(i), 1, 1e-9);
    approx(V(d), 7, 1e-9);
    [u, i, d].forEach(solidOk);
  });

  it("is order sensitive for difference", () => {
    const ab = meshBoolean("difference", A, box(1, 0, 0, 5, 2, 2));
    const ba = meshBoolean("difference", box(1, 0, 0, 5, 2, 2), A);
    approx(V(ab), 8 - 4, 1e-9);
    approx(V(ba), 16 - 4, 1e-9);
  });

  it("handles disjoint operands", () => {
    const far = box(10, 10, 10, 11, 11, 11);
    approx(V(meshBoolean("union", A, far)), 9, 1e-9);
    assert.equal(meshBoolean("intersection", A, far).indices.length, 0);
    approx(V(meshBoolean("difference", A, far)), 8, 1e-9);
  });

  it("hollows a cube with a contained cube", () => {
    const r = meshBoolean("difference", box(0, 0, 0, 4, 4, 4), box(1, 1, 1, 2, 2, 2));
    approx(V(r), 63, 1e-9);
    solidOk(r);
  });

  it("handles touching faces and edges", () => {
    const faces = meshBoolean("union", box(0, 0, 0, 1, 1, 1), box(1, 0, 0, 2, 1, 1));
    approx(V(faces), 2, 1e-9);
    solidOk(faces);
    const edges = meshBoolean("union", box(0, 0, 0, 1, 1, 1), box(1, 1, 0, 2, 2, 1));
    approx(V(edges), 2, 1e-9);
  });

  it("handles coplanar (flush) openings", () => {
    const r = meshBoolean("difference", box(0, 0, 0, 5, 0.3, 3), box(1, 0, 1, 2, 0.3, 2));
    approx(V(r), 4.5 - 0.3, 1e-9);
    solidOk(r);
  });

  it("handles nearly coplanar faces", () => {
    const r = meshBoolean("difference", box(0, 0, 0, 5, 0.3, 3), box(1, 1e-11, 1, 2, 0.3 - 1e-11, 2));
    assert.ok(Math.abs(V(r) - 4.2) < 1e-6);
  });

  it("subtracts curved solids and rotated operands", () => {
    const wall = box(-2, -2, 0, 2, 2, 1);
    const hole = cylinder(1, 3, 48, -1);
    const r = meshBoolean("difference", wall, hole);
    const cylArea = 0.5 * 48 * Math.sin((2 * Math.PI) / 48);
    approx(V(r), 16 - cylArea, 1e-9);
    solidOk(r);
    const rotated = transform(box(-0.5, -0.5, -5, 0.5, 0.5, 5), multiply(translation(0, 0, 0.5), rotation([1, 0, 0], Math.PI / 2)));
    const r2 = meshBoolean("difference", wall, rotated);
    approx(V(r2), 16 - 1 * 1 * 4, 1e-9);
    solidOk(r2);
  });

  it("chains Booleans on its own output (nested trees)", () => {
    let current: TriangleMesh64 = box(0, 0, 0, 10, 1, 3);
    for (let i = 0; i < 5; i++) current = meshBoolean("difference", current, box(0.5 + i * 2, -1, 1, 1.5 + i * 2, 2, 2));
    approx(V(current), 30 - 5, 1e-9);
    solidOk(current);
  });

  it("owns and releases backend handles deterministically", () => {
    const backend = new NativeCsgBackend();
    const r = booleanMeshes(backend, "difference", A, B);
    approx(V(r), 7, 1e-9);
    assert.equal(backend.liveCount, 0);
    const s = backend.create(A);
    const moved = backend.transform(s, translation(5, 0, 0));
    approx(V(backend.exportMesh(moved)), 8, 1e-9);
    backend.dispose(s);
    backend.dispose(moved);
    assert.equal(backend.liveCount, 0);
    assert.throws(() => backend.exportMesh(moved), /disposed/);
  });

  it("rejects non-finite operands", () => {
    const bad = box(0, 0, 0, 1, 1, 1);
    bad.positions[0] = Number.NaN;
    assert.throws(() => meshBoolean("union", bad, B), /non-finite/);
  });

  it("reverses winding of mirrored transforms", () => {
    const backend = new NativeCsgBackend();
    const s = backend.create(A);
    const m = backend.transform(s, new Float64Array([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
    approx(V(backend.exportMesh(m)), 8, 1e-9);
    backend.disposeAll();
  });
});

describe("IFC Boolean results", () => {
  it("evaluates IfcBooleanResult DIFFERENCE and swapped operands", () => {
    const run = (swap: boolean): number => {
      const { text, productId } = singleItemModel((b) => {
        const a = b.box(4, 4, 1), c = b.box(1, 1, 3, [1, 1, -1]);
        return [b.add("IFCBOOLEANRESULT", en("DIFFERENCE"), ref(swap ? c : a), ref(swap ? a : c))];
      });
      return meshVolume(worldMesh(buildAll(text), productId));
    };
    approx(run(false), 15, 1e-9);
    approx(run(true), 2, 1e-9);
  });

  it("clips with half-spaces respecting AgreementFlag", () => {
    const run = (agreement: boolean): number => {
      const { text, productId } = singleItemModel((b) => {
        const plane = b.add("IFCPLANE", ref(b.axis3([0, 0, 2])));
        const half = b.add("IFCHALFSPACESOLID", ref(plane), bool(agreement));
        return [b.add("IFCBOOLEANCLIPPINGRESULT", en("DIFFERENCE"), ref(b.box(1, 1, 3)), ref(half))];
      });
      return meshVolume(worldMesh(buildAll(text), productId));
    };
    // AgreementFlag TRUE: material below the plane is removed from the box
    approx(run(true), 1, 1e-9);
    approx(run(false), 2, 1e-9);
  });

  it("clips with polygonal bounded half-spaces", () => {
    const { text, productId } = singleItemModel((b) => {
      const plane = b.add("IFCPLANE", ref(b.axis3([0, 0, 1])));
      const boundary = b.polyline2([[0, 0], [2, 0], [2, 2], [0, 2]]);
      const half = b.add("IFCPOLYGONALBOUNDEDHALFSPACE", ref(plane), bool(false), ref(b.axis3()), ref(boundary));
      return [b.add("IFCBOOLEANCLIPPINGRESULT", en("DIFFERENCE"), ref(b.box(4, 4, 2)), ref(half))];
    });
    approx(meshVolume(worldMesh(buildAll(text), productId)), 32 / 2 * 1 + 16 * 1 - 4, 1e-9);
  });

  it("evaluates CSG solids and nested Boolean trees", () => {
    const { text, productId } = singleItemModel((b) => {
      const u = b.add("IFCBOOLEANRESULT", en("UNION"), ref(b.box(1, 1, 1)), ref(b.box(1, 1, 1, [1, 0, 0])));
      const d = b.add("IFCBOOLEANRESULT", en("DIFFERENCE"), ref(u), ref(b.box(0.5, 0.5, 5, [0.75, 0.25, -1])));
      return [b.add("IFCCSGSOLID", ref(d))];
    });
    approx(meshVolume(worldMesh(buildAll(text), productId)), 2 - 0.25, 1e-9);
  });

  it("stops at the Boolean depth limit with a diagnostic", () => {
    const { text, productId } = singleItemModel((b) => {
      let cur = b.box(10, 1, 1);
      for (let i = 0; i < 12; i++) cur = b.add("IFCBOOLEANRESULT", en("DIFFERENCE"), ref(cur), ref(b.box(0.1, 3, 3, [i * 0.5, -1, -1])));
      return [cur, b.box(1, 1, 1, [0, 5, 0])];
    });
    const built = buildAll(text, { limits: { maxBooleanDepth: 5 } });
    assert.ok(built.model.diagnostics.items.some((d) => d.code === "RESOURCE_LIMIT" && /boolean-depth/.test(d.message)));
    approx(meshVolume(worldMesh(built, productId)), 1, 1e-9); // the second item still renders
    void refs;
    void $;
    void real;
  });
});
