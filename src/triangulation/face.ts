// SPDX-License-Identifier: Apache-2.0
/**
 * Triangulation of planar 3D faces (polygonal face sets, BRep faces): Newell
 * normal, projection onto the dominant plane, 2D triangulation and mapping
 * back to the original vertex indices with winding that follows the face
 * orientation.
 */

import { triangulatePolygon, type TriangulationResult } from "./polygon.ts";

export type Vec3Tuple = [number, number, number];

/** Newell normal (unnormalised) of a closed loop of packed xyz points given by indices. */
export function newellNormal(positions: ArrayLike<number>, loop: ArrayLike<number>): Vec3Tuple {
  let nx = 0, ny = 0, nz = 0;
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const a = loop[i]! * 3;
    const b = loop[(i + 1) % n]! * 3;
    const ax = positions[a]!, ay = positions[a + 1]!, az = positions[a + 2]!;
    const bx = positions[b]!, by = positions[b + 1]!, bz = positions[b + 2]!;
    nx += (ay - by) * (az + bz);
    ny += (az - bz) * (ax + bx);
    nz += (ax - bx) * (ay + by);
  }
  return [nx, ny, nz];
}

export interface FaceTriangulation extends TriangulationResult {
  /** Face normal (unit) used for orientation, or [0,0,0] when degenerate. */
  normal: Vec3Tuple;
}

/**
 * Triangulates a planar face with an outer loop and optional inner loops.
 * Loops are arrays of vertex indices into `positions` (packed xyz). The
 * returned triangles are counter-clockwise when viewed against `normal`
 * (defaults to the outer loop's Newell normal).
 */
export function triangulateFace(
  positions: ArrayLike<number>,
  outer: ArrayLike<number>,
  holes: readonly ArrayLike<number>[] = [],
  normalHint?: Vec3Tuple,
): FaceTriangulation {
  const normal = normalHint ?? newellNormal(positions, outer);
  const len = Math.hypot(normal[0], normal[1], normal[2]);
  const empty: FaceTriangulation = { indices: [], forced: 0, ok: false, normal: [0, 0, 0] };
  if (!(len > 0) || !Number.isFinite(len)) return empty;
  const n: Vec3Tuple = [normal[0] / len, normal[1] / len, normal[2] / len];

  if (holes.length === 0 && outer.length === 3) {
    return { indices: [outer[0]!, outer[1]!, outer[2]!], forced: 0, ok: true, normal: n };
  }

  // Drop the dominant axis; flip one projected axis if the normal points to -axis
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  let u = 0, v = 1, sign = n[2];
  if (ax >= ay && ax >= az) {
    u = 1; v = 2; sign = n[0];
  } else if (ay >= az) {
    u = 2; v = 0; sign = n[1];
  }
  const flip = sign < 0;

  const loops = [outer, ...holes];
  let total = 0;
  for (const l of loops) total += l.length;
  const coords = new Float64Array(total * 2);
  const map = new Int32Array(total);
  const holeStarts: number[] = [];
  let k = 0;
  for (let li = 0; li < loops.length; li++) {
    const l = loops[li]!;
    if (li > 0) holeStarts.push(k);
    for (let i = 0; i < l.length; i++) {
      const p = l[i]! * 3;
      coords[k * 2] = flip ? -positions[p + u]! : positions[p + u]!;
      coords[k * 2 + 1] = positions[p + v]!;
      map[k] = l[i]!;
      k++;
    }
  }
  const tri = triangulatePolygon(coords, holeStarts);
  const indices = new Array<number>(tri.indices.length);
  for (let i = 0; i < tri.indices.length; i++) indices[i] = map[tri.indices[i]!]!;
  return { indices, forced: tri.forced, ok: tri.ok, normal: n };
}
