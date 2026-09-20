// SPDX-License-Identifier: Apache-2.0
/**
 * Double-precision triangle/line meshes and the operations the geometry
 * pipeline needs: building, transforming (with winding correction for
 * mirroring transforms), merging, welding, validation and crease normals.
 */

import { emptyBounds, expandPoint, type Bounds3 } from "../math/bounds.ts";
import { determinant3, type Mat4 } from "../math/mat4.ts";

/** Indexed triangle mesh; positions are packed xyz doubles. */
export interface MeshData {
  positions: Float64Array;
  indices: Uint32Array;
}

/** Indexed line segments (pairs of indices). */
export interface LineData {
  positions: Float64Array;
  indices: Uint32Array;
}

export class MeshBuilder {
  positions: number[] = [];
  indices: number[] = [];

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  get triangleCount(): number {
    return this.indices.length / 3;
  }

  addVertex(x: number, y: number, z: number): number {
    this.positions.push(x, y, z);
    return this.positions.length / 3 - 1;
  }

  addTriangle(a: number, b: number, c: number): void {
    if (a === b || b === c || a === c) return;
    this.indices.push(a, b, c);
  }

  /** Adds quad a-b-c-d (counter-clockwise) as two triangles. */
  addQuad(a: number, b: number, c: number, d: number): void {
    this.addTriangle(a, b, c);
    this.addTriangle(a, c, d);
  }

  append(mesh: MeshData, transform?: Mat4): void {
    const base = this.vertexCount;
    const p = mesh.positions;
    if (transform) {
      const m = transform;
      for (let i = 0; i < p.length; i += 3) {
        const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!;
        this.positions.push(
          m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
          m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
          m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
        );
      }
    } else {
      for (let i = 0; i < p.length; i++) this.positions.push(p[i]!);
    }
    const flip = transform !== undefined && determinant3(transform) < 0;
    const ix = mesh.indices;
    for (let i = 0; i < ix.length; i += 3) {
      if (flip) this.indices.push(base + ix[i]!, base + ix[i + 2]!, base + ix[i + 1]!);
      else this.indices.push(base + ix[i]!, base + ix[i + 1]!, base + ix[i + 2]!);
    }
  }

  build(): MeshData {
    return { positions: Float64Array.from(this.positions), indices: Uint32Array.from(this.indices) };
  }
}

export function emptyMesh(): MeshData {
  return { positions: new Float64Array(0), indices: new Uint32Array(0) };
}

export function isEmptyMesh(m: MeshData): boolean {
  return m.indices.length === 0;
}

export function meshBounds(m: { positions: Float64Array }): Bounds3 {
  const b = emptyBounds();
  const p = m.positions;
  for (let i = 0; i < p.length; i += 3) expandPoint(b, p[i]!, p[i + 1]!, p[i + 2]!);
  return b;
}

/** Returns a transformed copy; triangle winding is reversed for mirroring transforms. */
export function transformMesh(mesh: MeshData, t: Mat4): MeshData {
  const p = new Float64Array(mesh.positions.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = mesh.positions[i]!, y = mesh.positions[i + 1]!, z = mesh.positions[i + 2]!;
    p[i] = t[0]! * x + t[4]! * y + t[8]! * z + t[12]!;
    p[i + 1] = t[1]! * x + t[5]! * y + t[9]! * z + t[13]!;
    p[i + 2] = t[2]! * x + t[6]! * y + t[10]! * z + t[14]!;
  }
  const ix = Uint32Array.from(mesh.indices);
  if (determinant3(t) < 0) {
    for (let i = 0; i < ix.length; i += 3) {
      const tmp = ix[i + 1]!;
      ix[i + 1] = ix[i + 2]!;
      ix[i + 2] = tmp;
    }
  }
  return { positions: p, indices: ix };
}

export function transformLines(l: LineData, t: Mat4): LineData {
  const p = new Float64Array(l.positions.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = l.positions[i]!, y = l.positions[i + 1]!, z = l.positions[i + 2]!;
    p[i] = t[0]! * x + t[4]! * y + t[8]! * z + t[12]!;
    p[i + 1] = t[1]! * x + t[5]! * y + t[9]! * z + t[13]!;
    p[i + 2] = t[2]! * x + t[6]! * y + t[10]! * z + t[14]!;
  }
  return { positions: p, indices: l.indices.slice() };
}

export function mergeMeshes(meshes: readonly MeshData[]): MeshData {
  if (meshes.length === 1) return meshes[0]!;
  let vc = 0, ic = 0;
  for (const m of meshes) {
    vc += m.positions.length;
    ic += m.indices.length;
  }
  const positions = new Float64Array(vc);
  const indices = new Uint32Array(ic);
  let vo = 0, io = 0;
  for (const m of meshes) {
    positions.set(m.positions, vo);
    const base = vo / 3;
    for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i]! + base;
    vo += m.positions.length;
    io += m.indices.length;
  }
  return { positions, indices };
}

export function mergeLines(lines: readonly LineData[]): LineData {
  return mergeMeshes(lines as MeshData[]);
}

export function reverseWinding(m: MeshData): MeshData {
  const ix = new Uint32Array(m.indices.length);
  for (let i = 0; i < ix.length; i += 3) {
    ix[i] = m.indices[i]!;
    ix[i + 1] = m.indices[i + 2]!;
    ix[i + 2] = m.indices[i + 1]!;
  }
  return { positions: m.positions, indices: ix };
}

export function isFiniteMesh(m: { positions: Float64Array }): boolean {
  const p = m.positions;
  for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i]!)) return false;
  return true;
}

/**
 * Merges vertices closer than `tolerance` (grid hashing with neighbour-cell
 * lookup) and drops triangles that become degenerate.
 */
export function weldMesh(m: MeshData, tolerance: number): MeshData {
  const p = m.positions;
  const n = p.length / 3;
  const inv = 1 / Math.max(tolerance, 1e-300);
  const cells = new Map<string, number[]>();
  const remap = new Uint32Array(n);
  const out: number[] = [];
  const tol2 = tolerance * tolerance;
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
            const ddx = out[j * 3]! - x, ddy = out[j * 3 + 1]! - y, ddz = out[j * 3 + 2]! - z;
            if (ddx * ddx + ddy * ddy + ddz * ddz <= tol2) {
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
  const idx: number[] = [];
  for (let i = 0; i < m.indices.length; i += 3) {
    const a = remap[m.indices[i]!]!, b = remap[m.indices[i + 1]!]!, c = remap[m.indices[i + 2]!]!;
    if (a !== b && b !== c && a !== c) idx.push(a, b, c);
  }
  return { positions: Float64Array.from(out), indices: Uint32Array.from(idx) };
}

/** Removes triangles whose area is below `minArea` (after welding). */
export function removeDegenerate(m: MeshData, minArea: number): MeshData {
  const p = m.positions;
  const idx: number[] = [];
  for (let i = 0; i < m.indices.length; i += 3) {
    const a = m.indices[i]! * 3, b = m.indices[i + 1]! * 3, c = m.indices[i + 2]! * 3;
    const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!;
    const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (Math.hypot(cx, cy, cz) * 0.5 > minArea) idx.push(m.indices[i]!, m.indices[i + 1]!, m.indices[i + 2]!);
  }
  return { positions: m.positions, indices: Uint32Array.from(idx) };
}

/** Signed volume (positive for outward-oriented closed meshes). */
export function meshVolume(m: MeshData): number {
  const p = m.positions;
  let v = 0;
  for (let i = 0; i < m.indices.length; i += 3) {
    const a = m.indices[i]! * 3, b = m.indices[i + 1]! * 3, c = m.indices[i + 2]! * 3;
    v +=
      p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) -
      p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) +
      p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!);
  }
  return v / 6;
}

export function meshArea(m: MeshData): number {
  const p = m.positions;
  let s = 0;
  for (let i = 0; i < m.indices.length; i += 3) {
    const a = m.indices[i]! * 3, b = m.indices[i + 1]! * 3, c = m.indices[i + 2]! * 3;
    const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!;
    const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
    s += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return s;
}

export interface EdgeReport {
  /** Undirected edges used by exactly one triangle. */
  boundaryEdges: number;
  /** Undirected edges used by more than two triangles. */
  nonManifoldEdges: number;
  /** Edges whose two triangles traverse them in the same direction. */
  inconsistentEdges: number;
}

/** Edge-incidence analysis of a welded mesh. */
export function analyzeEdges(m: MeshData): EdgeReport {
  const counts = new Map<number, number>();
  const directed = new Map<number, number>();
  const n = m.positions.length / 3;
  const key = (a: number, b: number): number => a * n + b;
  for (let i = 0; i < m.indices.length; i += 3) {
    for (let e = 0; e < 3; e++) {
      const a = m.indices[i + e]!, b = m.indices[i + ((e + 1) % 3)]!;
      const k = a < b ? key(a, b) : key(b, a);
      counts.set(k, (counts.get(k) ?? 0) + 1);
      directed.set(key(a, b), (directed.get(key(a, b)) ?? 0) + 1);
    }
  }
  let boundaryEdges = 0, nonManifoldEdges = 0, inconsistentEdges = 0;
  for (const [k, c] of counts) {
    if (c === 1) boundaryEdges++;
    else if (c > 2) nonManifoldEdges++;
    else {
      const a = Math.floor(k / n), b = k % n;
      if ((directed.get(key(a, b)) ?? 0) !== 1) inconsistentEdges++;
    }
  }
  return { boundaryEdges, nonManifoldEdges, inconsistentEdges };
}

export function isClosedManifold(m: MeshData): boolean {
  const r = analyzeEdges(m);
  return r.boundaryEdges === 0 && r.nonManifoldEdges === 0 && r.inconsistentEdges === 0;
}

export interface ShadedMesh {
  positions: Float64Array;
  normals: Float32Array;
  indices: Uint32Array;
}

/**
 * Computes vertex normals, splitting vertices whose incident faces differ by
 * more than `creaseAngle` radians. Triangles are area-weighted.
 */
export function computeCreaseNormals(m: MeshData, creaseAngle = (35 * Math.PI) / 180): ShadedMesh {
  const p = m.positions;
  const ix = m.indices;
  const triCount = ix.length / 3;
  const fn = new Float64Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const a = ix[t * 3]! * 3, b = ix[t * 3 + 1]! * 3, c = ix[t * 3 + 2]! * 3;
    const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!;
    const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
    fn[t * 3] = uy * vz - uz * vy;
    fn[t * 3 + 1] = uz * vx - ux * vz;
    fn[t * 3 + 2] = ux * vy - uy * vx;
  }
  const vertexCount = p.length / 3;
  // incident triangles per vertex (CSR)
  const start = new Uint32Array(vertexCount + 1);
  for (let i = 0; i < ix.length; i++) start[ix[i]! + 1]!++;
  for (let v = 0; v < vertexCount; v++) start[v + 1]! += start[v]!;
  const cursor = start.slice(0, vertexCount);
  const incident = new Uint32Array(ix.length);
  for (let i = 0; i < ix.length; i++) incident[cursor[ix[i]!]!++] = i;

  const cosCrease = Math.cos(creaseAngle);
  const outPos: number[] = [];
  const outNrm: number[] = [];
  const outIdx = new Uint32Array(ix.length);
  const unit = (t: number): [number, number, number] => {
    const x = fn[t * 3]!, y = fn[t * 3 + 1]!, z = fn[t * 3 + 2]!;
    const l = Math.hypot(x, y, z);
    return l > 0 ? [x / l, y / l, z / l] : [0, 0, 0];
  };
  for (let v = 0; v < vertexCount; v++) {
    const s = start[v]!, e = start[v + 1]!;
    // cluster incident corners by normal similarity
    const clusterOf = new Int32Array(e - s).fill(-1);
    for (let i = s; i < e; i++) {
      if (clusterOf[i - s]! >= 0) continue;
      const ti = Math.floor(incident[i]! / 3);
      const ni = unit(ti);
      let sx = 0, sy = 0, sz = 0;
      const members: number[] = [];
      for (let j = i; j < e; j++) {
        if (clusterOf[j - s]! >= 0) continue;
        const tj = Math.floor(incident[j]! / 3);
        const nj = unit(tj);
        if (j === i || ni[0] * nj[0] + ni[1] * nj[1] + ni[2] * nj[2] >= cosCrease) {
          clusterOf[j - s] = 1;
          members.push(j);
          sx += fn[tj * 3]!;
          sy += fn[tj * 3 + 1]!;
          sz += fn[tj * 3 + 2]!;
        }
      }
      let l = Math.hypot(sx, sy, sz);
      if (!(l > 0)) {
        [sx, sy, sz] = ni;
        l = Math.hypot(sx, sy, sz) || 1;
        if (sx === 0 && sy === 0 && sz === 0) {
          sz = 1;
          l = 1;
        }
      }
      const newIndex = outPos.length / 3;
      outPos.push(p[v * 3]!, p[v * 3 + 1]!, p[v * 3 + 2]!);
      outNrm.push(sx / l, sy / l, sz / l);
      for (const j of members) outIdx[incident[j]!] = newIndex;
    }
  }
  return { positions: Float64Array.from(outPos), normals: Float32Array.from(outNrm), indices: outIdx };
}
