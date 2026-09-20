// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { triangulateFace } from "../../src/triangulation/face.ts";
import { signedArea, triangulatePolygon } from "../../src/triangulation/polygon.ts";

function area(coords: number[], idx: number[]): number {
  let a = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const [p, q, r] = [idx[i]!, idx[i + 1]!, idx[i + 2]!];
    a += ((coords[q * 2]! - coords[p * 2]!) * (coords[r * 2 + 1]! - coords[p * 2 + 1]!) - (coords[q * 2 + 1]! - coords[p * 2 + 1]!) * (coords[r * 2]! - coords[p * 2]!)) / 2;
  }
  return a;
}

function allCcw(coords: number[], idx: number[]): boolean {
  for (let i = 0; i < idx.length; i += 3) if (area(coords, idx.slice(i, i + 3)) < -1e-12) return false;
  return true;
}

describe("polygon triangulation", () => {
  it("triangulates convex polygons with a fan", () => {
    const sq = [0, 0, 2, 0, 2, 2, 0, 2];
    const r = triangulatePolygon(sq);
    assert.equal(r.indices.length, 6);
    assert.equal(area(sq, r.indices), 4);
    assert.equal(r.forced, 0);
  });

  it("handles clockwise input by normalising orientation", () => {
    const cw = [0, 0, 0, 10, 2, 10, 2, 2, 10, 2, 10, 0];
    const r = triangulatePolygon(cw);
    assert.equal(area(cw, r.indices), 36);
    assert.ok(allCcw(cw, r.indices));
  });

  it("bridges multiple holes", () => {
    const c = [0, 0, 10, 0, 10, 10, 0, 10, 2, 2, 2, 4, 4, 4, 4, 2, 6, 6, 6, 8, 8, 8, 8, 6, 6, 2, 8, 2, 8, 4];
    const r = triangulatePolygon(c, [4, 8, 12]);
    assert.ok(Math.abs(area(c, r.indices) - (100 - 4 - 4 - 2)) < 1e-9);
    assert.equal(r.forced, 0);
    assert.ok(allCcw(c, r.indices));
  });

  it("handles a hole touching the outer boundary", () => {
    const c = [0, 0, 10, 0, 10, 10, 0, 10, 5, 5, 10, 5, 5, 7];
    const r = triangulatePolygon(c, [4]);
    assert.ok(Math.abs(area(c, r.indices) - 95) < 1e-9);
  });

  it("triangulates a comb-shaped concave polygon exactly", () => {
    const c: number[] = [0, 0];
    for (let i = 0; i < 30; i++) c.push(i * 2 + 0.5, 10, i * 2 + 1.5, 1);
    c.push(60, 0);
    const r = triangulatePolygon(c);
    assert.ok(Math.abs(area(c, r.indices) - Math.abs(signedArea(c, 0, c.length / 2))) < 1e-6);
    assert.equal(r.forced, 0);
  });

  it("removes duplicate and collinear vertices", () => {
    const c = [0, 0, 1, 0, 1, 0, 2, 0, 2, 2, 0, 2, 0, 0];
    const r = triangulatePolygon(c);
    assert.ok(Math.abs(area(c, r.indices) - 4) < 1e-12);
  });

  it("terminates on self-intersecting input and reports forced ears", () => {
    const star: number[] = [];
    for (let i = 0; i < 5; i++) {
      const a = ((i * 2) / 5) * Math.PI * 2;
      star.push(Math.cos(a), Math.sin(a));
    }
    const r = triangulatePolygon(star);
    assert.ok(r.indices.length > 0);
    assert.ok(r.indices.length % 3 === 0);
    assert.ok(r.indices.every((i) => i >= 0 && i < 5));
    // a bow tie has zero net area and is rejected as degenerate
    assert.equal(triangulatePolygon([0, 0, 2, 2, 2, 0, 0, 2]).ok, false);
  });

  it("rejects degenerate and non-finite input", () => {
    assert.equal(triangulatePolygon([0, 0, 1, 1, 2, 2]).ok, false);
    assert.equal(triangulatePolygon([0, 0, NaN, 1, 2, 2]).ok, false);
    assert.equal(triangulatePolygon([0, 0, 1, 0]).ok, false);
  });

  it("scales to large polygons with many holes", () => {
    const c: number[] = [];
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      c.push(100 * Math.cos(a), 100 * Math.sin(a));
    }
    const holes: number[] = [];
    for (let h = 0; h < 100; h++) {
      holes.push(c.length / 2);
      const cx = -60 + (h % 10) * 13, cy = -60 + Math.floor(h / 10) * 13;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        c.push(cx + 3 * Math.cos(a), cy + 3 * Math.sin(a));
      }
    }
    const t0 = performance.now();
    const r = triangulatePolygon(c, holes);
    assert.ok(performance.now() - t0 < 5000);
    const expected = Math.abs(signedArea(c, 0, N)) - 100 * Math.abs(signedArea(c, N, N + 8));
    assert.ok(Math.abs(area(c, r.indices) - expected) < 1e-6);
  });

  it("never loses area on random star-shaped polygons (fuzz)", () => {
    let seed = 3;
    const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let n = 0; n < 200; n++) {
      const k = 3 + Math.floor(rnd() * 40);
      const c: number[] = [];
      for (let i = 0; i < k; i++) {
        const a = (i / k) * Math.PI * 2;
        const r = 1 + rnd() * 9;
        c.push(r * Math.cos(a), r * Math.sin(a));
      }
      const res = triangulatePolygon(c);
      assert.equal(res.forced, 0, `polygon ${n}`);
      assert.ok(Math.abs(area(c, res.indices) - Math.abs(signedArea(c, 0, k))) < 1e-9);
    }
  });
});

describe("planar face triangulation", () => {
  it("projects vertical faces and keeps the face orientation", () => {
    // square in the XZ plane, loop orientation gives normal -Y
    const p = [0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 0, 0];
    const r = triangulateFace(p, [0, 1, 2, 3]);
    assert.equal(r.indices.length, 6);
    for (let i = 0; i < r.indices.length; i += 3) {
      const [a, b, c] = [r.indices[i]! * 3, r.indices[i + 1]! * 3, r.indices[i + 2]! * 3];
      const ux = p[b]! - p[a]!, uz = p[b + 2]! - p[a + 2]!, vx = p[c]! - p[a]!, vz = p[c + 2]! - p[a + 2]!;
      const ny = uz * vx - ux * vz;
      assert.ok(ny * r.normal[1] > 0, "triangle normal follows the face normal");
    }
  });

  it("triangulates 3D faces with holes", () => {
    const p = [0, 0, 5, 4, 0, 5, 4, 4, 5, 0, 4, 5, 1, 1, 5, 1, 3, 5, 3, 3, 5, 3, 1, 5];
    const r = triangulateFace(p, [0, 1, 2, 3], [[4, 5, 6, 7]]);
    assert.equal(r.indices.length / 3, 8);
  });
});
