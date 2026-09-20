// SPDX-License-Identifier: Apache-2.0
/**
 * Splits one triangle by a set of constraint segments lying in its plane.
 *
 * The triangle boundary and the segments form a planar arrangement: edges are
 * split at every mutual intersection and at points lying on them, dangling
 * edges are pruned, faces are traced with a half-edge walk, isolated
 * components are assigned as holes to the smallest face containing them and
 * every face is triangulated. Output triangles keep the input orientation and
 * every arrangement edge that came from a constraint is reported so callers
 * can stop region growing at intersection curves.
 */

import { triangulatePolygon } from "../triangulation/polygon.ts";

export interface SplitResult {
  /** 3D points: the three input corners first, then inserted points. */
  points: number[];
  /** Triangles as local point index triplets. */
  triangles: number[];
  /** Constraint edges as local point index pairs. */
  constraintEdges: number[];
}

interface Edge {
  a: number;
  b: number;
  constraint: boolean;
}

export function splitTriangle(
  corners: readonly number[],
  segments: readonly number[],
  eps: number,
  extraPoints: readonly number[] = [],
): SplitResult {
  // projection axis: drop the dominant normal component
  const ax = corners[0]!, ay = corners[1]!, az = corners[2]!;
  const ux = corners[3]! - ax, uy = corners[4]! - ay, uz = corners[5]! - az;
  const vx = corners[6]! - ax, vy = corners[7]! - ay, vz = corners[8]! - az;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const anx = Math.abs(nx), any = Math.abs(ny), anz = Math.abs(nz);
  let iu = 0, iv = 1, sign = nz;
  if (anx >= any && anx >= anz) {
    iu = 1; iv = 2; sign = nx;
  } else if (any >= anz) {
    iu = 2; iv = 0; sign = ny;
  }
  const flip = sign < 0 ? -1 : 1;

  const P: number[] = []; // 3D
  const U: number[] = []; // 2D
  const eps2 = eps * eps;
  const addPoint = (x: number, y: number, z: number): number => {
    const p = [x, y, z];
    const u = p[iu]! * flip, v = p[iv]!;
    const n = U.length >> 1;
    for (let i = 0; i < n; i++) {
      const du = U[i * 2]! - u, dv = U[i * 2 + 1]! - v;
      if (du * du + dv * dv <= eps2) return i;
    }
    P.push(x, y, z);
    U.push(u, v);
    return n;
  };
  for (let i = 0; i < 3; i++) addPoint(corners[i * 3]!, corners[i * 3 + 1]!, corners[i * 3 + 2]!);
  const edges: Edge[] = [
    { a: 0, b: 1, constraint: false },
    { a: 1, b: 2, constraint: false },
    { a: 2, b: 0, constraint: false },
  ];
  for (let s = 0; s < segments.length; s += 6) {
    const a = addPoint(segments[s]!, segments[s + 1]!, segments[s + 2]!);
    const b = addPoint(segments[s + 3]!, segments[s + 4]!, segments[s + 5]!);
    if (a !== b) edges.push({ a, b, constraint: true });
  }
  // Points that must appear on the boundary (shared-edge T-junction repair).
  for (let s = 0; s < extraPoints.length; s += 3) addPoint(extraPoints[s]!, extraPoints[s + 1]!, extraPoints[s + 2]!);

  // --- split edges at points lying on them and at crossings ---
  const lerp3 = (i: number, j: number, t: number): [number, number, number] => [
    P[i * 3]! + (P[j * 3]! - P[i * 3]!) * t,
    P[i * 3 + 1]! + (P[j * 3 + 1]! - P[i * 3 + 1]!) * t,
    P[i * 3 + 2]! + (P[j * 3 + 2]! - P[i * 3 + 2]!) * t,
  ];
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 64) {
    changed = false;
    // crossings
    for (let i = 0; i < edges.length && !changed; i++) {
      for (let j = i + 1; j < edges.length && !changed; j++) {
        const e = edges[i]!, f = edges[j]!;
        if (e.a === f.a || e.a === f.b || e.b === f.a || e.b === f.b) continue;
        const x1 = U[e.a * 2]!, y1 = U[e.a * 2 + 1]!, x2 = U[e.b * 2]!, y2 = U[e.b * 2 + 1]!;
        const x3 = U[f.a * 2]!, y3 = U[f.a * 2 + 1]!, x4 = U[f.b * 2]!, y4 = U[f.b * 2 + 1]!;
        const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
        if (Math.abs(d) < 1e-300) continue;
        const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
        const s = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
        const le = Math.hypot(x2 - x1, y2 - y1), lf = Math.hypot(x4 - x3, y4 - y3);
        const te = eps / Math.max(le, 1e-300), tf = eps / Math.max(lf, 1e-300);
        if (t > te && t < 1 - te && s > tf && s < 1 - tf) {
          const p = lerp3(e.a, e.b, t);
          const k = addPoint(p[0], p[1], p[2]);
          if (k === e.a || k === e.b || k === f.a || k === f.b) continue;
          edges.splice(j, 1, { a: f.a, b: k, constraint: f.constraint }, { a: k, b: f.b, constraint: f.constraint });
          edges.splice(i, 1, { a: e.a, b: k, constraint: e.constraint }, { a: k, b: e.b, constraint: e.constraint });
          changed = true;
        }
      }
    }
    // points on edges
    const pointCount = U.length >> 1;
    for (let i = 0; i < edges.length && !changed; i++) {
      const e = edges[i]!;
      const x1 = U[e.a * 2]!, y1 = U[e.a * 2 + 1]!, x2 = U[e.b * 2]!, y2 = U[e.b * 2 + 1]!;
      const dx = x2 - x1, dy = y2 - y1;
      const l2 = dx * dx + dy * dy;
      if (l2 <= eps2) continue;
      for (let p = 0; p < pointCount; p++) {
        if (p === e.a || p === e.b) continue;
        const px = U[p * 2]! - x1, py = U[p * 2 + 1]! - y1;
        const t = (px * dx + py * dy) / l2;
        if (t <= 0 || t >= 1) continue;
        const cx = px - t * dx, cy = py - t * dy;
        if (cx * cx + cy * cy <= eps2) {
          edges.splice(i, 1, { a: e.a, b: p, constraint: e.constraint }, { a: p, b: e.b, constraint: e.constraint });
          changed = true;
          break;
        }
      }
    }
  }

  // --- deduplicate edges ---
  const n = U.length >> 1;
  const edgeMap = new Map<number, Edge>();
  for (const e of edges) {
    if (e.a === e.b) continue;
    const key = e.a < e.b ? e.a * n + e.b : e.b * n + e.a;
    const prev = edgeMap.get(key);
    if (prev) prev.constraint ||= e.constraint;
    else edgeMap.set(key, { a: Math.min(e.a, e.b), b: Math.max(e.a, e.b), constraint: e.constraint });
  }

  // --- prune dangling edges (degree 1 vertices), except the triangle corners ---
  const adjacency = (): Map<number, number[]> => {
    const adj = new Map<number, number[]>();
    for (const e of edgeMap.values()) {
      (adj.get(e.a) ?? adj.set(e.a, []).get(e.a)!).push(e.b);
      (adj.get(e.b) ?? adj.set(e.b, []).get(e.b)!).push(e.a);
    }
    return adj;
  };
  let adj = adjacency();
  let pruned = true;
  while (pruned) {
    pruned = false;
    for (const [v, list] of adj) {
      if (list.length === 1) {
        const w = list[0]!;
        edgeMap.delete(v < w ? v * n + w : w * n + v);
        pruned = true;
      }
    }
    if (pruned) adj = adjacency();
  }

  // --- trace faces ---
  const angleSorted = new Map<number, number[]>();
  for (const [v, list] of adj) {
    const vx0 = U[v * 2]!, vy0 = U[v * 2 + 1]!;
    const sorted = [...new Set(list)].sort(
      (p, q) => Math.atan2(U[p * 2 + 1]! - vy0, U[p * 2]! - vx0) - Math.atan2(U[q * 2 + 1]! - vy0, U[q * 2]! - vx0),
    );
    angleSorted.set(v, sorted);
  }
  const used = new Set<number>();
  const cycles: number[][] = [];
  for (const e of edgeMap.values()) {
    for (const [s, t] of [[e.a, e.b], [e.b, e.a]] as const) {
      if (used.has(s * n + t)) continue;
      const cycle: number[] = [];
      let u = s, v = t;
      let steps = 0;
      while (!used.has(u * n + v) && steps++ < 4 * n + 16) {
        used.add(u * n + v);
        cycle.push(u);
        const around = angleSorted.get(v)!;
        const idx = around.indexOf(u);
        const w = around[(idx - 1 + around.length) % around.length]!;
        u = v;
        v = w;
      }
      if (cycle.length >= 3) cycles.push(cycle);
    }
  }
  const area2 = (c: number[]): number => {
    let a = 0;
    for (let i = 0, j = c.length - 1; i < c.length; j = i++) a += U[c[j]! * 2]! * U[c[i]! * 2 + 1]! - U[c[i]! * 2]! * U[c[j]! * 2 + 1]!;
    return a / 2;
  };
  const inside = (x: number, y: number, c: number[]): boolean => {
    let r = false;
    for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
      const xi = U[c[i]! * 2]!, yi = U[c[i]! * 2 + 1]!, xj = U[c[j]! * 2]!, yj = U[c[j]! * 2 + 1]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) r = !r;
    }
    return r;
  };
  const faces: { outer: number[]; holes: number[][]; area: number }[] = [];
  const negatives: number[][] = [];
  for (const c of cycles) {
    const a = area2(c);
    if (a > eps2) faces.push({ outer: c, holes: [], area: a });
    else if (a < -eps2) negatives.push(c);
  }
  // A negative cycle is either the outer triangle boundary or the boundary of
  // an isolated component: attach the latter to the smallest containing face.
  for (const neg of negatives) {
    if (neg.includes(0) && neg.includes(1) && neg.includes(2)) continue;
    let best: (typeof faces)[number] | undefined;
    // representative point: midpoint of the first edge nudged inward is fragile; use vertex centroid of the cycle
    let sx = 0, sy = 0;
    for (const v of neg) {
      sx += U[v * 2]!;
      sy += U[v * 2 + 1]!;
    }
    const probeX = U[neg[0]! * 2]!, probeY = U[neg[0]! * 2 + 1]!;
    for (const f of faces) {
      if (f.outer.some((v) => neg.includes(v))) continue;
      if (inside(probeX, probeY, f.outer) || inside(sx / neg.length, sy / neg.length, f.outer)) {
        if (!best || f.area < best.area) best = f;
      }
    }
    if (best) best.holes.push(neg);
  }

  // --- triangulate faces ---
  const triangles: number[] = [];
  for (const f of faces) {
    if (f.holes.length === 0 && f.outer.length === 3) {
      triangles.push(f.outer[0]!, f.outer[1]!, f.outer[2]!);
      continue;
    }
    const coords: number[] = [];
    const map: number[] = [];
    const holeStarts: number[] = [];
    for (const v of f.outer) {
      coords.push(U[v * 2]!, U[v * 2 + 1]!);
      map.push(v);
    }
    for (const h of f.holes) {
      holeStarts.push(map.length);
      for (const v of h) {
        coords.push(U[v * 2]!, U[v * 2 + 1]!);
        map.push(v);
      }
    }
    const tri = triangulatePolygon(coords, holeStarts);
    for (const i of tri.indices) triangles.push(map[i]!);
  }

  const constraintEdges: number[] = [];
  for (const e of edgeMap.values()) if (e.constraint) constraintEdges.push(e.a, e.b);
  return { points: P, triangles, constraintEdges };
}
