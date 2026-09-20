// SPDX-License-Identifier: Apache-2.0
/**
 * Converts renderer-neutral product geometry into GPU-ready batches:
 *  - unique geometry is baked into per-colour chunks (Float32 positions
 *    relative to a chunk origin, Int8 normals, per-vertex object indices);
 *  - repeated mapped definitions become instanced definitions plus
 *    per-instance matrices relative to the session render origin.
 * All construction happens in Float64; conversion to Float32 happens after
 * subtracting a local origin so georeferenced coordinates keep precision.
 */

import { colorFromKey } from "../ifc/styles.ts";
import { boundsCenter, emptyBounds, isEmptyBounds, unionBounds } from "../math/bounds.ts";
import { multiply, translation, type Mat4 } from "../math/mat4.ts";
import type { GeometryEngine, ProductGeometry, ResolvedPart } from "../geometry/engine.ts";
import { computeCreaseNormals, meshBounds, transformLines, transformMesh } from "../geometry/mesh.ts";
import type { GeometryBatch, WireDefinition, WireInstances, WireLines, WireMesh } from "../protocol/messages.ts";

const MAX_CHUNK_VERTICES = 1 << 18;

class Chunk {
  readonly origin: [number, number, number];
  positions: number[] = [];
  normals: number[] = [];
  objects: number[] = [];
  indices: number[] = [];

  constructor(origin: [number, number, number]) {
    this.origin = origin;
  }

  get vertexCount(): number {
    return this.positions.length / 3;
  }
}

function rgba(key: string): [number, number, number, number] {
  const c = colorFromKey(key);
  return [c.r, c.g, c.b, c.a];
}

function quantizeNormals(n: Float32Array): Int8Array {
  const out = new Int8Array(n.length);
  for (let i = 0; i < n.length; i++) out[i] = Math.max(-127, Math.min(127, Math.round(n[i]! * 127)));
  return out;
}

export class GeometryPacker {
  private readonly engine: GeometryEngine;
  private readonly objectIndex: Map<number, number>;
  origin: [number, number, number] | undefined;
  private meshChunks = new Map<string, Chunk>();
  private lineChunks = new Map<string, Chunk>();
  private readyMeshes: WireMesh[] = [];
  private readyLines: WireLines[] = [];
  private readonly sentDefinitions = new Set<string>();
  private pendingDefinitions: WireDefinition[] = [];
  private readonly definitionCenters = new Map<string, [number, number, number]>();
  private pendingInstances = new Map<string, { matrices: number[]; objects: number[] }>();
  private productIds: number[] = [];
  private productBounds: number[] = [];
  bytes = 0;
  productsReady = 0;
  trianglesReady = 0;

  constructor(engine: GeometryEngine, objectIndex: Map<number, number>) {
    this.engine = engine;
    this.objectIndex = objectIndex;
  }

  get pendingBytes(): number {
    let s = 0;
    for (const c of this.meshChunks.values()) s += c.positions.length * 4 + c.indices.length * 4;
    for (const m of this.readyMeshes) s += m.positions.byteLength + m.indices.byteLength;
    return s;
  }

  add(g: ProductGeometry): void {
    const objectIndex = this.objectIndex.get(g.productId);
    if (objectIndex === undefined) return;
    this.origin ??= boundsCenter(g.bounds);
    for (const part of g.parts) this.addPart(part, g.world, objectIndex, g.bounds);
    for (const inst of g.instances) this.addInstance(inst.key, inst.transform, objectIndex);
    this.productIds.push(g.productId);
    this.productBounds.push(g.bounds.minX, g.bounds.minY, g.bounds.minZ, g.bounds.maxX, g.bounds.maxY, g.bounds.maxZ);
    this.productsReady++;
    this.trianglesReady += g.triangles;
  }

  private chunkFor(map: Map<string, Chunk>, key: string, center: [number, number, number], ready: (c: Chunk, key: string) => void): Chunk {
    let c = map.get(key);
    if (c && c.vertexCount > MAX_CHUNK_VERTICES) {
      ready(c, key);
      c = undefined;
    }
    if (!c) {
      c = new Chunk(center);
      map.set(key, c);
    }
    return c;
  }

  private addPart(part: ResolvedPart, world: Mat4, objectIndex: number, productBounds: ProductGeometry["bounds"]): void {
    const center = boundsCenter(productBounds);
    if (part.mesh) {
      const worldMesh = transformMesh(part.mesh, world);
      const shaded = computeCreaseNormals(worldMesh);
      const c = this.chunkFor(this.meshChunks, part.colorKey, center, (ch, k) => this.finishMesh(ch, k));
      const base = c.vertexCount;
      const p = shaded.positions;
      for (let i = 0; i < p.length; i += 3) {
        c.positions.push(p[i]! - c.origin[0], p[i + 1]! - c.origin[1], p[i + 2]! - c.origin[2]);
        c.objects.push(objectIndex);
      }
      for (let i = 0; i < shaded.normals.length; i++) c.normals.push(shaded.normals[i]!);
      for (let i = 0; i < shaded.indices.length; i++) c.indices.push(shaded.indices[i]! + base);
      this.bytes += p.length * 4 + shaded.indices.length * 4 + (p.length / 3) * 7;
    } else if (part.lines) {
      const worldLines = transformLines(part.lines, world);
      const c = this.chunkFor(this.lineChunks, part.colorKey, center, (ch, k) => this.finishLines(ch, k));
      const base = c.vertexCount;
      const p = worldLines.positions;
      for (let i = 0; i < p.length; i += 3) {
        c.positions.push(p[i]! - c.origin[0], p[i + 1]! - c.origin[1], p[i + 2]! - c.origin[2]);
        c.objects.push(objectIndex);
      }
      for (let i = 0; i < worldLines.indices.length; i++) c.indices.push(worldLines.indices[i]! + base);
      this.bytes += p.length * 4 + worldLines.indices.length * 4;
    }
  }

  private addInstance(key: string, transform: Mat4, objectIndex: number): void {
    if (!this.sentDefinitions.has(key)) this.packDefinition(key);
    const center = this.definitionCenters.get(key);
    if (!center) return;
    const origin = this.origin!;
    // T(-origin) × transform × T(center), computed in doubles
    const m = multiply(translation(-origin[0], -origin[1], -origin[2]), multiply(transform, translation(center[0], center[1], center[2])));
    let pending = this.pendingInstances.get(key);
    if (!pending) {
      pending = { matrices: [], objects: [] };
      this.pendingInstances.set(key, pending);
    }
    for (let i = 0; i < 16; i++) pending.matrices.push(m[i]!);
    pending.objects.push(objectIndex);
    this.bytes += 68;
  }

  private packDefinition(key: string): void {
    this.sentDefinitions.add(key);
    const def = this.engine.definition(key);
    if (!def) return;
    let b = emptyBounds();
    for (const p of def.parts) b = unionBounds(b, meshBounds(p.mesh ?? p.lines!));
    if (isEmptyBounds(b)) return;
    const c = boundsCenter(b);
    this.definitionCenters.set(key, c);
    const wire: WireDefinition = { key, parts: [] };
    for (const p of def.parts) {
      if (p.mesh) {
        const shaded = computeCreaseNormals(p.mesh);
        const pos = new Float32Array(shaded.positions.length);
        for (let i = 0; i < pos.length; i += 3) {
          pos[i] = shaded.positions[i]! - c[0];
          pos[i + 1] = shaded.positions[i + 1]! - c[1];
          pos[i + 2] = shaded.positions[i + 2]! - c[2];
        }
        wire.parts.push({ kind: "mesh", color: rgba(p.colorKey), positions: pos, normals: quantizeNormals(shaded.normals), indices: shaded.indices });
        this.bytes += pos.byteLength + shaded.indices.byteLength;
      } else if (p.lines) {
        const pos = new Float32Array(p.lines.positions.length);
        for (let i = 0; i < pos.length; i += 3) {
          pos[i] = p.lines.positions[i]! - c[0];
          pos[i + 1] = p.lines.positions[i + 1]! - c[1];
          pos[i + 2] = p.lines.positions[i + 2]! - c[2];
        }
        wire.parts.push({ kind: "lines", color: rgba(p.colorKey), positions: pos, normals: new Int8Array(0), indices: Uint32Array.from(p.lines.indices) });
      }
    }
    this.pendingDefinitions.push(wire);
  }

  private chunkOffset(c: Chunk): [number, number, number] {
    const o = this.origin ?? [0, 0, 0];
    return [c.origin[0] - o[0], c.origin[1] - o[1], c.origin[2] - o[2]];
  }

  private finishMesh(c: Chunk, key: string): void {
    if (c.indices.length === 0) return;
    this.readyMeshes.push({
      color: rgba(key),
      offset: this.chunkOffset(c),
      positions: Float32Array.from(c.positions),
      normals: quantizeNormals(Float32Array.from(c.normals)),
      objects: Uint32Array.from(c.objects),
      indices: Uint32Array.from(c.indices),
    });
  }

  private finishLines(c: Chunk, key: string): void {
    if (c.indices.length === 0) return;
    this.readyLines.push({
      color: rgba(key),
      offset: this.chunkOffset(c),
      positions: Float32Array.from(c.positions),
      objects: Uint32Array.from(c.objects),
      indices: Uint32Array.from(c.indices),
    });
  }

  /** Emits everything accumulated so far (null when there is nothing new). */
  flush(totalProducts: number): GeometryBatch | null {
    for (const [k, c] of this.meshChunks) this.finishMesh(c, k);
    for (const [k, c] of this.lineChunks) this.finishLines(c, k);
    this.meshChunks = new Map();
    this.lineChunks = new Map();
    const instances: WireInstances[] = [];
    for (const [key, p] of this.pendingInstances) {
      instances.push({ key, matrices: Float32Array.from(p.matrices), objects: Uint32Array.from(p.objects) });
    }
    this.pendingInstances = new Map();
    if (this.readyMeshes.length === 0 && this.readyLines.length === 0 && instances.length === 0 && this.pendingDefinitions.length === 0 && this.productIds.length === 0) {
      return null;
    }
    const batch: GeometryBatch = {
      origin: this.origin ?? [0, 0, 0],
      meshes: this.readyMeshes,
      lines: this.readyLines,
      definitions: this.pendingDefinitions,
      instances,
      productIds: Uint32Array.from(this.productIds),
      productBounds: Float64Array.from(this.productBounds),
      productsReady: this.productsReady,
      totalProducts,
      trianglesReady: this.trianglesReady,
    };
    this.readyMeshes = [];
    this.readyLines = [];
    this.pendingDefinitions = [];
    this.productIds = [];
    this.productBounds = [];
    return batch;
  }
}
