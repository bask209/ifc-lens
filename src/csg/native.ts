// SPDX-License-Identifier: Apache-2.0
/**
 * Project-owned mesh Boolean engine (Apache-2.0, no third-party code).
 *
 * Algorithm:
 *  A. weld and clean both operands, normalise coordinates around a common origin
 *  B. BVH over the second operand, enumerate overlapping triangle pairs
 *  C. exact triangle/triangle intersection segments (plus coplanar overlaps)
 *  D. split every intersected triangle into conforming fragments
 *  E. weld fragments; grow regions across edges that are not intersection edges
 *  F. classify each region against the other solid with the generalised
 *     winding number; coplanar regions compare normals
 *  G. select fragments for union / intersection / difference (reversing the
 *     retained fragments of B for A − B), weld and drop degenerate triangles
 *
 * The generalised winding number keeps classification meaningful for
 * slightly open IFC shells, where parity ray casting would fail.
 */

import { AbortError } from "../diagnostics.ts";
import { TriangleBvh } from "./bvh.ts";
import type { CsgBackend, CsgOperation, CsgSolid, TriangleMesh64 } from "./backend.ts";
import { splitTriangle } from "./split.ts";

const BACKEND = Symbol("ifc-lens-native-csg");

export class CsgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsgError";
  }
}

interface Mesh {
  p: Float64Array;
  t: Uint32Array;
}

export interface NativeCsgOptions {
  /** Relative tolerance (fraction of the operands' bounding diagonal). */
  relativeTolerance?: number;
  /** Abort when more than this many triangle pairs intersect. */
  maxIntersectingPairs?: number;
  /** Abort when a single triangle receives more constraint segments. */
  maxSegmentsPerTriangle?: number;
}

// ---------------------------------------------------------------- helpers

function bounds(m: Mesh): [number, number, number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < m.t.length; i++) {
    const v = m.t[i]! * 3;
    const x = m.p[v]!, y = m.p[v + 1]!, z = m.p[v + 2]!;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return [x0, y0, z0, x1, y1, z1];
}

/** Grid-hash welding; drops degenerate triangles. */
function weld(p: ArrayLike<number>, t: ArrayLike<number>, tol: number): Mesh {
  const n = p.length / 3;
  const inv = 1 / tol;
  const cells = new Map<string, number[]>();
  const remap = new Uint32Array(n);
  const out: number[] = [];
  const tol2 = tol * tol;
  for (let i = 0; i < n; i++) {
    const x = p[i * 3]!, y = p[i * 3 + 1]!, z = p[i * 3 + 2]!;
    const cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++) {
      for (let dy = -1; dy <= 1 && found < 0; dy++) {
        for (let dz = -1; dz <= 1 && found < 0; dz++) {
          const list = cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!list) continue;
          for (const j of list) {
            const ex = out[j * 3]! - x, ey = out[j * 3 + 1]! - y, ez = out[j * 3 + 2]! - z;
            if (ex * ex + ey * ey + ez * ez <= tol2) {
              found = j;
              break;
            }
          }
        }
      }
    }
    if (found < 0) {
      found = out.length / 3;
      out.push(x, y, z);
      const key = `${cx},${cy},${cz}`;
      const list = cells.get(key);
      if (list) list.push(found);
      else cells.set(key, [found]);
    }
    remap[i] = found;
  }
  const tri: number[] = [];
  for (let i = 0; i < t.length; i += 3) {
    const a = remap[t[i]!]!, b = remap[t[i + 1]!]!, c = remap[t[i + 2]!]!;
    if (a === b || b === c || a === c) continue;
    // drop zero-area (collinear) triangles
    const ux = out[b * 3]! - out[a * 3]!, uy = out[b * 3 + 1]! - out[a * 3 + 1]!, uz = out[b * 3 + 2]! - out[a * 3 + 2]!;
    const vx = out[c * 3]! - out[a * 3]!, vy = out[c * 3 + 1]! - out[a * 3 + 1]!, vz = out[c * 3 + 2]! - out[a * 3 + 2]!;
    const cxp = uy * vz - uz * vy, cyp = uz * vx - ux * vz, czp = ux * vy - uy * vx;
    if (cxp * cxp + cyp * cyp + czp * czp <= tol2 * tol2) continue;
    tri.push(a, b, c);
  }
  return { p: Float64Array.from(out), t: Uint32Array.from(tri) };
}

function triNormal(m: Mesh, tri: number): [number, number, number] {
  const a = m.t[tri * 3]! * 3, b = m.t[tri * 3 + 1]! * 3, c = m.t[tri * 3 + 2]! * 3;
  const ux = m.p[b]! - m.p[a]!, uy = m.p[b + 1]! - m.p[a + 1]!, uz = m.p[b + 2]! - m.p[a + 2]!;
  const vx = m.p[c]! - m.p[a]!, vy = m.p[c + 1]! - m.p[a + 1]!, vz = m.p[c + 2]! - m.p[a + 2]!;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz);
  return l > 0 ? [nx / l, ny / l, nz / l] : [0, 0, 0];
}

/** Generalised winding number of a closed or nearly closed mesh at point q. */
function windingNumber(m: Mesh, qx: number, qy: number, qz: number): number {
  let sum = 0;
  const p = m.p, t = m.t;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i]! * 3, b = t[i + 1]! * 3, c = t[i + 2]! * 3;
    const ax = p[a]! - qx, ay = p[a + 1]! - qy, az = p[a + 2]! - qz;
    const bx = p[b]! - qx, by = p[b + 1]! - qy, bz = p[b + 2]! - qz;
    const cx = p[c]! - qx, cy = p[c + 1]! - qy, cz = p[c + 2]! - qz;
    const la = Math.hypot(ax, ay, az), lb = Math.hypot(bx, by, bz), lc = Math.hypot(cx, cy, cz);
    const det = ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    const den = la * lb * lc + (ax * bx + ay * by + az * bz) * lc + (ax * cx + ay * cy + az * cz) * lb + (bx * cx + by * cy + bz * cz) * la;
    sum += Math.atan2(det, den);
  }
  return sum / (2 * Math.PI);
}

/** Squared distance from point to triangle (Ericson's closest-point routine). */
function pointTriangleDistance2(m: Mesh, tri: number, px: number, py: number, pz: number): number {
  const ia = m.t[tri * 3]! * 3, ib = m.t[tri * 3 + 1]! * 3, ic = m.t[tri * 3 + 2]! * 3;
  const ax = m.p[ia]!, ay = m.p[ia + 1]!, az = m.p[ia + 2]!;
  const bx = m.p[ib]!, by = m.p[ib + 1]!, bz = m.p[ib + 2]!;
  const cx = m.p[ic]!, cy = m.p[ic + 1]!, cz = m.p[ic + 2]!;
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  const dist = (qx: number, qy: number, qz: number): number => (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2;
  if (d1 <= 0 && d2 <= 0) return dist(ax, ay, az);
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return dist(bx, by, bz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return dist(ax + abx * v, ay + aby * v, az + abz * v);
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return dist(cx, cy, cz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return dist(ax + acx * w, ay + acy * w, az + acz * w);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return dist(bx + (cx - bx) * w, by + (cy - by) * w, bz + (cz - bz) * w);
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  return dist(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}

// ------------------------------------------------- triangle intersections

interface PlanePoints {
  pts: number[];
}

/**
 * Points of triangle `tri` of mesh `m` lying on the plane (n, d): vertices on
 * the plane and edge crossings. Distances below eps snap to zero.
 */
function planeSection(m: Mesh, tri: number, n: [number, number, number], d: number, eps: number, dist: Float64Array): PlanePoints {
  const out: number[] = [];
  const idx = [m.t[tri * 3]!, m.t[tri * 3 + 1]!, m.t[tri * 3 + 2]!];
  for (let k = 0; k < 3; k++) {
    const v = idx[k]! * 3;
    let s = n[0] * m.p[v]! + n[1] * m.p[v + 1]! + n[2] * m.p[v + 2]! - d;
    if (Math.abs(s) < eps) s = 0;
    dist[k] = s;
  }
  for (let k = 0; k < 3; k++) {
    const v = idx[k]! * 3;
    if (dist[k] === 0) out.push(m.p[v]!, m.p[v + 1]!, m.p[v + 2]!);
  }
  for (let k = 0; k < 3; k++) {
    const k2 = (k + 1) % 3;
    const s0 = dist[k]!, s1 = dist[k2]!;
    if ((s0 < 0 && s1 > 0) || (s0 > 0 && s1 < 0)) {
      // canonical orientation (lower vertex index first) for bitwise-stable points
      let i0 = idx[k]!, i1 = idx[k2]!, a = s0, b = s1;
      if (i0 > i1) {
        [i0, i1] = [i1, i0];
        [a, b] = [b, a];
      }
      const t = a / (a - b);
      const p0 = i0 * 3, p1 = i1 * 3;
      out.push(
        m.p[p0]! + (m.p[p1]! - m.p[p0]!) * t,
        m.p[p0 + 1]! + (m.p[p1 + 1]! - m.p[p0 + 1]!) * t,
        m.p[p0 + 2]! + (m.p[p1 + 2]! - m.p[p0 + 2]!) * t,
      );
    }
  }
  return { pts: out };
}

/** Clips segment (p, q) to the interior of triangle `tri` (coplanar case). */
function clipSegmentToTriangle(m: Mesh, tri: number, n: [number, number, number], p: number[], q: number[], eps: number): number[] | undefined {
  let t0 = 0, t1 = 1;
  const dx = q[0]! - p[0]!, dy = q[1]! - p[1]!, dz = q[2]! - p[2]!;
  for (let k = 0; k < 3; k++) {
    const a = m.t[tri * 3 + k]! * 3, b = m.t[tri * 3 + ((k + 1) % 3)]! * 3;
    const ex = m.p[b]! - m.p[a]!, ey = m.p[b + 1]! - m.p[a + 1]!, ez = m.p[b + 2]! - m.p[a + 2]!;
    // inward edge normal = n × e
    const ix = n[1] * ez - n[2] * ey, iy = n[2] * ex - n[0] * ez, iz = n[0] * ey - n[1] * ex;
    const il = Math.hypot(ix, iy, iz) || 1;
    const f0 = ((p[0]! - m.p[a]!) * ix + (p[1]! - m.p[a + 1]!) * iy + (p[2]! - m.p[a + 2]!) * iz) / il;
    const fd = (dx * ix + dy * iy + dz * iz) / il;
    if (Math.abs(fd) < 1e-300) {
      if (f0 < -eps) return undefined;
      continue;
    }
    const t = (-f0) / fd;
    if (fd > 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return undefined;
  }
  const len = Math.hypot(dx, dy, dz);
  if ((t1 - t0) * len <= eps) return undefined;
  return [p[0]! + dx * t0, p[1]! + dy * t0, p[2]! + dz * t0, p[0]! + dx * t1, p[1]! + dy * t1, p[2]! + dz * t1];
}

interface Split {
  /** Constraint segments per triangle (packed 6 numbers each). */
  segments: Map<number, number[]>;
}

function computeIntersections(A: Mesh, B: Mesh, eps: number, maxPairs: number): { a: Split; b: Split } {
  const bvh = new TriangleBvh(B.p, B.t);
  const sa: Split = { segments: new Map() };
  const sb: Split = { segments: new Map() };
  const push = (s: Split, tri: number, seg: number[]): void => {
    const list = s.segments.get(tri);
    if (list) list.push(...seg);
    else s.segments.set(tri, [...seg]);
  };
  const distA = new Float64Array(3), distB = new Float64Array(3);
  const bNormals = new Float64Array((B.t.length / 3) * 4);
  for (let tb = 0; tb < B.t.length / 3; tb++) {
    const n = triNormal(B, tb);
    const v = B.t[tb * 3]! * 3;
    bNormals.set([n[0], n[1], n[2], n[0] * B.p[v]! + n[1] * B.p[v + 1]! + n[2] * B.p[v + 2]!], tb * 4);
  }
  let pairs = 0;
  for (let ta = 0; ta < A.t.length / 3; ta++) {
    const ia = A.t[ta * 3]! * 3, ib = A.t[ta * 3 + 1]! * 3, ic = A.t[ta * 3 + 2]! * 3;
    const x0 = Math.min(A.p[ia]!, A.p[ib]!, A.p[ic]!) - eps, x1 = Math.max(A.p[ia]!, A.p[ib]!, A.p[ic]!) + eps;
    const y0 = Math.min(A.p[ia + 1]!, A.p[ib + 1]!, A.p[ic + 1]!) - eps, y1 = Math.max(A.p[ia + 1]!, A.p[ib + 1]!, A.p[ic + 1]!) + eps;
    const z0 = Math.min(A.p[ia + 2]!, A.p[ib + 2]!, A.p[ic + 2]!) - eps, z1 = Math.max(A.p[ia + 2]!, A.p[ib + 2]!, A.p[ic + 2]!) + eps;
    const na = triNormal(A, ta);
    const da = na[0] * A.p[ia]! + na[1] * A.p[ia + 1]! + na[2] * A.p[ia + 2]!;
    bvh.query(x0, y0, z0, x1, y1, z1, (tb) => {
      const nb: [number, number, number] = [bNormals[tb * 4]!, bNormals[tb * 4 + 1]!, bNormals[tb * 4 + 2]!];
      const db = bNormals[tb * 4 + 3]!;
      const secA = planeSection(A, ta, nb, db, eps, distA);
      if (distA[0]! > 0 && distA[1]! > 0 && distA[2]! > 0) return;
      if (distA[0]! < 0 && distA[1]! < 0 && distA[2]! < 0) return;
      const coplanar = distA[0] === 0 && distA[1] === 0 && distA[2] === 0;
      if (coplanar) {
        // Coplanar overlap: each triangle's edges clipped to the other triangle.
        for (let k = 0; k < 3; k++) {
          const p0 = B.t[tb * 3 + k]! * 3, p1 = B.t[tb * 3 + ((k + 1) % 3)]! * 3;
          const seg = clipSegmentToTriangle(A, ta, na, [B.p[p0]!, B.p[p0 + 1]!, B.p[p0 + 2]!], [B.p[p1]!, B.p[p1 + 1]!, B.p[p1 + 2]!], eps);
          if (seg) push(sa, ta, seg);
          const q0 = A.t[ta * 3 + k]! * 3, q1 = A.t[ta * 3 + ((k + 1) % 3)]! * 3;
          const seg2 = clipSegmentToTriangle(B, tb, nb, [A.p[q0]!, A.p[q0 + 1]!, A.p[q0 + 2]!], [A.p[q1]!, A.p[q1 + 1]!, A.p[q1 + 2]!], eps);
          if (seg2) push(sb, tb, seg2);
        }
        pairs++;
        return;
      }
      const secB = planeSection(B, tb, na, da, eps, distB);
      if (distB[0]! > 0 && distB[1]! > 0 && distB[2]! > 0) return;
      if (distB[0]! < 0 && distB[1]! < 0 && distB[2]! < 0) return;
      if (secA.pts.length < 6 || secB.pts.length < 6) return; // touching at a single point
      // common line direction
      const Dx = na[1] * nb[2] - na[2] * nb[1], Dy = na[2] * nb[0] - na[0] * nb[2], Dz = na[0] * nb[1] - na[1] * nb[0];
      const param = (pts: number[], k: number): number => pts[k * 3]! * Dx + pts[k * 3 + 1]! * Dy + pts[k * 3 + 2]! * Dz;
      const range = (pts: number[]): [number, number, number, number] => {
        let lo = Infinity, hi = -Infinity, ilo = 0, ihi = 0;
        for (let k = 0; k < pts.length / 3; k++) {
          const t = param(pts, k);
          if (t < lo) { lo = t; ilo = k; }
          if (t > hi) { hi = t; ihi = k; }
        }
        return [lo, hi, ilo, ihi];
      };
      const [aLo, aHi, aiLo, aiHi] = range(secA.pts);
      const [bLo, bHi, biLo, biHi] = range(secB.pts);
      const lo = Math.max(aLo, bLo), hi = Math.min(aHi, bHi);
      const dl = Math.hypot(Dx, Dy, Dz);
      if (!(dl > 0) || (hi - lo) / dl <= eps) return;
      const pLo = aLo >= bLo ? secA.pts.slice(aiLo * 3, aiLo * 3 + 3) : secB.pts.slice(biLo * 3, biLo * 3 + 3);
      const pHi = aHi <= bHi ? secA.pts.slice(aiHi * 3, aiHi * 3 + 3) : secB.pts.slice(biHi * 3, biHi * 3 + 3);
      const seg = [...pLo, ...pHi];
      push(sa, ta, seg);
      push(sb, tb, seg);
      pairs++;
      if (pairs > maxPairs) throw new CsgError(`too many intersecting triangle pairs (> ${maxPairs})`);
    });
  }
  return { a: sa, b: sb };
}

interface Fragments {
  positions: number[];
  triangles: number[];
  /** Source triangle per fragment (for coplanar lookups). */
  source: number[];
  /** Constraint edges (global vertex indices, pairs). */
  constraints: number[];
}

function fragment(m: Mesh, split: Split, eps: number, maxSegments: number): Fragments {
  const out: Fragments = { positions: Array.from(m.p), triangles: [], source: [], constraints: [] };
  const vcount = m.p.length / 3;
  // Constraint endpoints lying on an original edge must split every triangle
  // sharing that edge, otherwise the result contains T-junctions.
  const edgePoints = new Map<number, number[]>();
  const eps2 = eps * eps;
  for (const [tri, segs] of split.segments) {
    for (let k = 0; k < 3; k++) {
      const i0 = m.t[tri * 3 + k]!, i1 = m.t[tri * 3 + ((k + 1) % 3)]!;
      const ax = m.p[i0 * 3]!, ay = m.p[i0 * 3 + 1]!, az = m.p[i0 * 3 + 2]!;
      const dx = m.p[i1 * 3]! - ax, dy = m.p[i1 * 3 + 1]! - ay, dz = m.p[i1 * 3 + 2]! - az;
      const l2 = dx * dx + dy * dy + dz * dz;
      if (!(l2 > 0)) continue;
      for (let s = 0; s < segs.length; s += 3) {
        const px = segs[s]! - ax, py = segs[s + 1]! - ay, pz = segs[s + 2]! - az;
        const t = (px * dx + py * dy + pz * dz) / l2;
        if (t <= 0 || t >= 1) continue;
        const cx = px - t * dx, cy = py - t * dy, cz = pz - t * dz;
        if (cx * cx + cy * cy + cz * cz > eps2) continue;
        const key = i0 < i1 ? i0 * vcount + i1 : i1 * vcount + i0;
        const list = edgePoints.get(key);
        if (list) list.push(segs[s]!, segs[s + 1]!, segs[s + 2]!);
        else edgePoints.set(key, [segs[s]!, segs[s + 1]!, segs[s + 2]!]);
      }
    }
  }
  for (let tri = 0; tri < m.t.length / 3; tri++) {
    const segs = split.segments.get(tri);
    const ia = m.t[tri * 3]!, ib = m.t[tri * 3 + 1]!, ic = m.t[tri * 3 + 2]!;
    let extra: number[] | undefined;
    for (const [u, v] of [[ia, ib], [ib, ic], [ic, ia]] as const) {
      const pts = edgePoints.get(u < v ? u * vcount + v : v * vcount + u);
      if (pts) (extra ??= []).push(...pts);
    }
    if ((!segs || segs.length === 0) && !extra) {
      out.triangles.push(ia, ib, ic);
      out.source.push(tri);
      continue;
    }
    if ((segs?.length ?? 0) / 6 > maxSegments) throw new CsgError(`triangle receives more than ${maxSegments} intersection segments`);
    const corners = [
      m.p[ia * 3]!, m.p[ia * 3 + 1]!, m.p[ia * 3 + 2]!,
      m.p[ib * 3]!, m.p[ib * 3 + 1]!, m.p[ib * 3 + 2]!,
      m.p[ic * 3]!, m.p[ic * 3 + 1]!, m.p[ic * 3 + 2]!,
    ];
    const r = splitTriangle(corners, segs ?? [], eps, extra);
    const local: number[] = [ia, ib, ic];
    for (let k = 3; k < r.points.length / 3; k++) {
      local.push(out.positions.length / 3);
      out.positions.push(r.points[k * 3]!, r.points[k * 3 + 1]!, r.points[k * 3 + 2]!);
    }
    for (let k = 0; k < r.triangles.length; k += 3) {
      out.triangles.push(local[r.triangles[k]!]!, local[r.triangles[k + 1]!]!, local[r.triangles[k + 2]!]!);
      out.source.push(tri);
    }
    for (let k = 0; k < r.constraintEdges.length; k++) out.constraints.push(local[r.constraintEdges[k]!]!);
  }
  return out;
}

const OUTSIDE = 0, INSIDE = 1, SAME = 2, OPPOSITE = 3;

/**
 * Welds fragments, groups them into regions bounded by constraint edges and
 * classifies each region relative to `other`.
 */
function classify(frag: Fragments, other: Mesh, otherBvh: TriangleBvh, eps: number, signal?: AbortSignal): { mesh: Mesh; cls: Uint8Array } {
  const welded = weldKeepingTriangles(frag.positions, frag.triangles, eps);
  const mesh = welded.mesh;
  const triCount = mesh.t.length / 3;
  const vcount = mesh.p.length / 3;
  const constraintKeys = new Set<number>();
  for (let i = 0; i < frag.constraints.length; i += 2) {
    const a = welded.remap[frag.constraints[i]!]!, b = welded.remap[frag.constraints[i + 1]!]!;
    if (a !== b) constraintKeys.add(a < b ? a * vcount + b : b * vcount + a);
  }
  // edge → triangles
  const edgeTris = new Map<number, number[]>();
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const a = mesh.t[t * 3 + k]!, b = mesh.t[t * 3 + ((k + 1) % 3)]!;
      const key = a < b ? a * vcount + b : b * vcount + a;
      const list = edgeTris.get(key);
      if (list) list.push(t);
      else edgeTris.set(key, [t]);
    }
  }
  const region = new Int32Array(triCount).fill(-1);
  const regions: number[][] = [];
  for (let seed = 0; seed < triCount; seed++) {
    if (region[seed]! >= 0) continue;
    const id = regions.length;
    const members: number[] = [];
    const stack = [seed];
    region[seed] = id;
    while (stack.length > 0) {
      const t = stack.pop()!;
      members.push(t);
      for (let k = 0; k < 3; k++) {
        const a = mesh.t[t * 3 + k]!, b = mesh.t[t * 3 + ((k + 1) % 3)]!;
        const key = a < b ? a * vcount + b : b * vcount + a;
        if (constraintKeys.has(key)) continue;
        const list = edgeTris.get(key)!;
        if (list.length !== 2) continue; // do not grow across boundary / non-manifold edges
        for (const u of list) {
          if (region[u]! < 0) {
            region[u] = id;
            stack.push(u);
          }
        }
      }
    }
    regions.push(members);
  }
  const cls = new Uint8Array(triCount);
  const coplanarEps2 = (eps * 8) ** 2;
  for (const members of regions) {
    if (signal?.aborted) throw new AbortError();
    // representative: largest-area triangle
    let best = members[0]!;
    let bestArea = -1;
    for (const t of members) {
      const n = triNormalRaw(mesh, t);
      const a = Math.hypot(n[0], n[1], n[2]);
      if (a > bestArea) {
        bestArea = a;
        best = t;
      }
    }
    const i0 = mesh.t[best * 3]! * 3, i1 = mesh.t[best * 3 + 1]! * 3, i2 = mesh.t[best * 3 + 2]! * 3;
    const cx = (mesh.p[i0]! + mesh.p[i1]! + mesh.p[i2]!) / 3;
    const cy = (mesh.p[i0 + 1]! + mesh.p[i1 + 1]! + mesh.p[i2 + 1]!) / 3;
    const cz = (mesh.p[i0 + 2]! + mesh.p[i1 + 2]! + mesh.p[i2 + 2]!) / 3;
    // coplanar test: centroid lying on a triangle of the other mesh with parallel normal
    let c = -1;
    const nf = triNormal(mesh, best);
    const r = eps * 8;
    otherBvh.query(cx - r, cy - r, cz - r, cx + r, cy + r, cz + r, (tb) => {
      if (c >= 0) return;
      const nb = triNormal(other, tb);
      const dot = nf[0] * nb[0] + nf[1] * nb[1] + nf[2] * nb[2];
      if (Math.abs(dot) < 0.999999) return;
      if (pointTriangleDistance2(other, tb, cx, cy, cz) <= coplanarEps2) c = dot > 0 ? SAME : OPPOSITE;
    });
    if (c < 0) c = windingNumber(other, cx, cy, cz) > 0.5 ? INSIDE : OUTSIDE;
    for (const t of members) cls[t] = c;
  }
  return { mesh, cls };
}

function triNormalRaw(m: Mesh, tri: number): [number, number, number] {
  const a = m.t[tri * 3]! * 3, b = m.t[tri * 3 + 1]! * 3, c = m.t[tri * 3 + 2]! * 3;
  const ux = m.p[b]! - m.p[a]!, uy = m.p[b + 1]! - m.p[a + 1]!, uz = m.p[b + 2]! - m.p[a + 2]!;
  const vx = m.p[c]! - m.p[a]!, vy = m.p[c + 1]! - m.p[a + 1]!, vz = m.p[c + 2]! - m.p[a + 2]!;
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

/** Welding variant that keeps triangle order and exposes the vertex remap. */
function weldKeepingTriangles(p: number[], t: number[], tol: number): { mesh: Mesh; remap: Uint32Array } {
  const n = p.length / 3;
  const inv = 1 / tol;
  const cells = new Map<string, number[]>();
  const remap = new Uint32Array(n);
  const out: number[] = [];
  const tol2 = tol * tol;
  for (let i = 0; i < n; i++) {
    const x = p[i * 3]!, y = p[i * 3 + 1]!, z = p[i * 3 + 2]!;
    const cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++) {
      for (let dy = -1; dy <= 1 && found < 0; dy++) {
        for (let dz = -1; dz <= 1 && found < 0; dz++) {
          const list = cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!list) continue;
          for (const j of list) {
            const ex = out[j * 3]! - x, ey = out[j * 3 + 1]! - y, ez = out[j * 3 + 2]! - z;
            if (ex * ex + ey * ey + ez * ez <= tol2) {
              found = j;
              break;
            }
          }
        }
      }
    }
    if (found < 0) {
      found = out.length / 3;
      out.push(x, y, z);
      const key = `${cx},${cy},${cz}`;
      const list = cells.get(key);
      if (list) list.push(found);
      else cells.set(key, [found]);
    }
    remap[i] = found;
  }
  const tri: number[] = [];
  for (let i = 0; i < t.length; i += 3) {
    const a = remap[t[i]!]!, b = remap[t[i + 1]!]!, c = remap[t[i + 2]!]!;
    if (a === b || b === c || a === c) continue;
    tri.push(a, b, c);
  }
  return { mesh: { p: Float64Array.from(out), t: Uint32Array.from(tri) }, remap };
}

/** Core Boolean on two meshes; exported for tests. */
export function meshBoolean(op: CsgOperation, a: TriangleMesh64, b: TriangleMesh64, options: NativeCsgOptions = {}, signal?: AbortSignal): TriangleMesh64 {
  const relTol = options.relativeTolerance ?? 1e-9;
  // Common origin for numerical stability.
  const ba = bounds({ p: a.positions, t: a.indices });
  const bb = bounds({ p: b.positions, t: b.indices });
  const emptyA = !(ba[0] <= ba[3]);
  const emptyB = !(bb[0] <= bb[3]);
  if (emptyA || emptyB) {
    const empty = { positions: new Float64Array(0), indices: new Uint32Array(0) };
    if (op === "union") return concat(emptyA ? empty : a, emptyB ? empty : b);
    if (op === "intersection") return empty;
    return emptyA ? empty : { positions: a.positions.slice(), indices: a.indices.slice() };
  }
  const x0 = Math.min(ba[0], bb[0]), y0 = Math.min(ba[1], bb[1]), z0 = Math.min(ba[2], bb[2]);
  const x1 = Math.max(ba[3], bb[3]), y1 = Math.max(ba[4], bb[4]), z1 = Math.max(ba[5], bb[5]);
  const diag = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
  const eps = Math.max(diag * relTol, 1e-12);
  const disjoint = ba[0] > bb[3] + eps || bb[0] > ba[3] + eps || ba[1] > bb[4] + eps || bb[1] > ba[4] + eps || ba[2] > bb[5] + eps || bb[2] > ba[5] + eps;
  if (disjoint) {
    if (op === "union") return concat(a, b);
    if (op === "intersection") return { positions: new Float64Array(0), indices: new Uint32Array(0) };
    return { positions: a.positions.slice(), indices: a.indices.slice() };
  }
  const ox = (x0 + x1) / 2, oy = (y0 + y1) / 2, oz = (z0 + z1) / 2;
  const shift = (m: TriangleMesh64): Float64Array => {
    const p = new Float64Array(m.positions.length);
    for (let i = 0; i < p.length; i += 3) {
      p[i] = m.positions[i]! - ox;
      p[i + 1] = m.positions[i + 1]! - oy;
      p[i + 2] = m.positions[i + 2]! - oz;
    }
    return p;
  };
  for (const m of [a, b]) {
    for (let i = 0; i < m.positions.length; i++) if (!Number.isFinite(m.positions[i]!)) throw new CsgError("non-finite coordinates in Boolean operand");
  }
  const A = weld(shift(a), a.indices, eps);
  const B = weld(shift(b), b.indices, eps);
  const { a: sa, b: sb } = computeIntersections(A, B, eps, options.maxIntersectingPairs ?? 2_000_000);
  const maxSeg = options.maxSegmentsPerTriangle ?? 2000;
  const fa = fragment(A, sa, eps, maxSeg);
  const fb = fragment(B, sb, eps, maxSeg);
  const bvhA = new TriangleBvh(A.p, A.t);
  const bvhB = new TriangleBvh(B.p, B.t);
  const ca = classify(fa, B, bvhB, eps, signal);
  const cb = classify(fb, A, bvhA, eps, signal);

  const outP: number[] = [];
  const outT: number[] = [];
  const emit = (mesh: Mesh, cls: Uint8Array, keep: (c: number) => boolean, reverse: boolean): void => {
    const base = outP.length / 3;
    for (let i = 0; i < mesh.p.length; i++) outP.push(mesh.p[i]!);
    for (let t = 0; t < mesh.t.length / 3; t++) {
      if (!keep(cls[t]!)) continue;
      const i0 = mesh.t[t * 3]! + base, i1 = mesh.t[t * 3 + 1]! + base, i2 = mesh.t[t * 3 + 2]! + base;
      if (reverse) outT.push(i0, i2, i1);
      else outT.push(i0, i1, i2);
    }
  };
  switch (op) {
    case "union":
      emit(ca.mesh, ca.cls, (c) => c === OUTSIDE || c === SAME, false);
      emit(cb.mesh, cb.cls, (c) => c === OUTSIDE, false);
      break;
    case "intersection":
      emit(ca.mesh, ca.cls, (c) => c === INSIDE || c === SAME, false);
      emit(cb.mesh, cb.cls, (c) => c === INSIDE, false);
      break;
    case "difference":
      emit(ca.mesh, ca.cls, (c) => c === OUTSIDE || c === OPPOSITE, false);
      emit(cb.mesh, cb.cls, (c) => c === INSIDE, true);
      break;
  }
  const result = stitchTJunctions(weld(outP, outT, eps), eps);
  // restore coordinates
  for (let i = 0; i < result.p.length; i += 3) {
    result.p[i]! += ox;
    result.p[i + 1]! += oy;
    result.p[i + 2]! += oz;
  }
  return compact(result);
}

/**
 * Removes T-junctions: every edge used by a single triangle is checked for
 * vertices lying on it; the owning triangle is split at those vertices.
 * Fragments of the two operands meet along intersection curves that can be
 * subdivided differently on each side (notably with coplanar faces); this
 * pass makes the result watertight again.
 */
function stitchTJunctions(m: Mesh, eps: number): Mesh {
  const vcount = m.p.length / 3;
  if (vcount === 0) return m;
  let tris = Array.from(m.t);
  const [bx0, by0, bz0, bx1, by1, bz1] = bounds(m);
  const extent = Math.max(bx1 - bx0, by1 - by0, bz1 - bz0);
  const cell = Math.max(eps * 64, extent / 128, 1e-12);
  const grid = new Map<string, number[]>();
  for (let v = 0; v < vcount; v++) {
    const key = `${Math.floor(m.p[v * 3]! / cell)},${Math.floor(m.p[v * 3 + 1]! / cell)},${Math.floor(m.p[v * 3 + 2]! / cell)}`;
    const list = grid.get(key);
    if (list) list.push(v);
    else grid.set(key, [v]);
  }
  const eps2 = (eps * 4) ** 2;
  for (let pass = 0; pass < 8; pass++) {
    const count = new Map<number, number>();
    for (let i = 0; i < tris.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const a = tris[i + k]!, b = tris[i + ((k + 1) % 3)]!;
        const key = a < b ? a * vcount + b : b * vcount + a;
        count.set(key, (count.get(key) ?? 0) + 1);
      }
    }
    let changed = false;
    const out: number[] = [];
    for (let i = 0; i < tris.length; i += 3) {
      let split = false;
      for (let k = 0; k < 3 && !split; k++) {
        const a = tris[i + k]!, b = tris[i + ((k + 1) % 3)]!, c = tris[i + ((k + 2) % 3)]!;
        const key = a < b ? a * vcount + b : b * vcount + a;
        if (count.get(key) !== 1) continue;
        const ax = m.p[a * 3]!, ay = m.p[a * 3 + 1]!, az = m.p[a * 3 + 2]!;
        const dx = m.p[b * 3]! - ax, dy = m.p[b * 3 + 1]! - ay, dz = m.p[b * 3 + 2]! - az;
        const l2 = dx * dx + dy * dy + dz * dz;
        if (!(l2 > eps2)) continue;
        // candidate vertices from grid cells overlapping the edge's box
        const on: { v: number; t: number }[] = [];
        const x0 = Math.floor(Math.min(ax, ax + dx) / cell), x1 = Math.floor(Math.max(ax, ax + dx) / cell);
        const y0 = Math.floor(Math.min(ay, ay + dy) / cell), y1 = Math.floor(Math.max(ay, ay + dy) / cell);
        const z0 = Math.floor(Math.min(az, az + dz) / cell), z1 = Math.floor(Math.max(az, az + dz) / cell);
        const test = (v: number): void => {
          if (v === a || v === b || v === c) return;
          const px = m.p[v * 3]! - ax, py = m.p[v * 3 + 1]! - ay, pz = m.p[v * 3 + 2]! - az;
          const t = (px * dx + py * dy + pz * dz) / l2;
          if (t <= 1e-9 || t >= 1 - 1e-9) return;
          const qx = px - t * dx, qy = py - t * dy, qz = pz - t * dz;
          if (qx * qx + qy * qy + qz * qz <= eps2) on.push({ v, t });
        };
        if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) <= 8192) {
          for (let gx = x0; gx <= x1; gx++) {
            for (let gy = y0; gy <= y1; gy++) {
              for (let gz = z0; gz <= z1; gz++) {
                for (const v of grid.get(`${gx},${gy},${gz}`) ?? []) test(v);
              }
            }
          }
        } else if (vcount <= 100_000) {
          for (let v = 0; v < vcount; v++) test(v);
        }
        if (on.length === 0) continue;
        on.sort((p, q) => p.t - q.t);
        // fan from the opposite vertex c across a → v1 → … → b
        let prev = a;
        for (const { v } of on) {
          out.push(prev, v, c);
          prev = v;
        }
        out.push(prev, b, c);
        split = true;
        changed = true;
      }
      if (!split) out.push(tris[i]!, tris[i + 1]!, tris[i + 2]!);
    }
    tris = out;
    if (!changed) break;
  }
  return { p: m.p, t: Uint32Array.from(tris) };
}

function concat(a: TriangleMesh64, b: TriangleMesh64): TriangleMesh64 {
  const positions = new Float64Array(a.positions.length + b.positions.length);
  positions.set(a.positions);
  positions.set(b.positions, a.positions.length);
  const indices = new Uint32Array(a.indices.length + b.indices.length);
  indices.set(a.indices);
  const base = a.positions.length / 3;
  for (let i = 0; i < b.indices.length; i++) indices[a.indices.length + i] = b.indices[i]! + base;
  return { positions, indices };
}

/** Drops unreferenced vertices. */
function compact(m: Mesh): TriangleMesh64 {
  const n = m.p.length / 3;
  const remap = new Int32Array(n).fill(-1);
  const p: number[] = [];
  const t = new Uint32Array(m.t.length);
  for (let i = 0; i < m.t.length; i++) {
    const v = m.t[i]!;
    if (remap[v]! < 0) {
      remap[v] = p.length / 3;
      p.push(m.p[v * 3]!, m.p[v * 3 + 1]!, m.p[v * 3 + 2]!);
    }
    t[i] = remap[v]!;
  }
  return { positions: Float64Array.from(p), indices: t };
}

/** CsgBackend implementation backed by `meshBoolean`. */
export class NativeCsgBackend implements CsgBackend {
  readonly name = "ifc-lens-native";
  private readonly solids = new Map<number, TriangleMesh64>();
  private nextHandle = 1;
  private readonly options: NativeCsgOptions;
  signal: AbortSignal | undefined;

  constructor(options: NativeCsgOptions = {}) {
    this.options = options;
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    this.signal = signal;
  }

  get liveCount(): number {
    return this.solids.size;
  }

  private wrap(mesh: TriangleMesh64): CsgSolid {
    const handle = this.nextHandle++;
    this.solids.set(handle, mesh);
    return { backend: BACKEND, handle };
  }

  private get(solid: CsgSolid): TriangleMesh64 {
    if (solid.backend !== BACKEND) throw new CsgError("solid belongs to another CSG backend");
    const m = this.solids.get(solid.handle);
    if (!m) throw new CsgError(`CSG solid ${solid.handle} was already disposed`);
    return m;
  }

  create(mesh: TriangleMesh64): CsgSolid {
    return this.wrap({ positions: Float64Array.from(mesh.positions), indices: Uint32Array.from(mesh.indices) });
  }

  apply(operation: CsgOperation, first: CsgSolid, second: CsgSolid): CsgSolid {
    return this.wrap(meshBoolean(operation, this.get(first), this.get(second), this.options, this.signal));
  }

  transform(solid: CsgSolid, m: Float64Array): CsgSolid {
    const src = this.get(solid);
    const p = new Float64Array(src.positions.length);
    for (let i = 0; i < p.length; i += 3) {
      const x = src.positions[i]!, y = src.positions[i + 1]!, z = src.positions[i + 2]!;
      p[i] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
      p[i + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
      p[i + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
    }
    const det =
      m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!) - m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!) + m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!);
    const t = Uint32Array.from(src.indices);
    if (det < 0) {
      for (let i = 0; i < t.length; i += 3) {
        const x = t[i + 1]!;
        t[i + 1] = t[i + 2]!;
        t[i + 2] = x;
      }
    }
    return this.wrap({ positions: p, indices: t });
  }

  exportMesh(solid: CsgSolid): TriangleMesh64 {
    const m = this.get(solid);
    return { positions: m.positions.slice(), indices: m.indices.slice() };
  }

  dispose(solid: CsgSolid): void {
    if (solid.backend === BACKEND) this.solids.delete(solid.handle);
  }

  disposeAll(): void {
    this.solids.clear();
  }
}
