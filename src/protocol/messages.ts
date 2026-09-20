// SPDX-License-Identifier: Apache-2.0
/**
 * Main thread ⇄ model worker protocol. All geometry travels as typed arrays
 * whose buffers are transferred (not copied); the worker keeps no reference
 * to a buffer after posting it.
 */

import type { IfcDiagnostic, ResourceLimitDetail } from "../diagnostics.ts";
import type { PropertyGroup } from "../ifc/properties.ts";
import type { EntitySummary } from "../ifc/model.ts";
import type { IfcSchemaFamily } from "../ifc/schema.ts";

export type LoadPhase = "fetch" | "parse" | "index" | "geometry" | "upload";

export type LoadSourceDescriptor =
  | { kind: "url"; url: string; credentials: RequestCredentials }
  | { kind: "blob"; blob: Blob; name: string }
  | { kind: "buffer"; buffer: ArrayBuffer; name: string };

/** Budgets applied inside the worker (all optional; defaults are policy). */
export interface WorkerLimits {
  maxFileBytes?: number;
  maxEntities?: number;
  maxStringBytes?: number;
  maxAggregateDepth?: number;
  maxTriangles?: number;
  maxGeometryBytes?: number;
  maxReferenceDepth?: number;
  maxBooleanDepth?: number;
  maxMappedItemDepth?: number;
  maxPlacementDepth?: number;
  maxCurveSegments?: number;
  maxProductMillis?: number;
  maxBooleanTriangles?: number;
  maxVerticesPerProduct?: number;
}

export interface TreeNodeWire {
  id: number;
  /** Readable type name (IfcWall). */
  type: string;
  name: string;
  kind: "spatial" | "element" | "unassigned";
  children: number[];
  /** True when the product carries renderable geometry. */
  geometry: boolean;
}

export interface ModelMetadata {
  schema: IfcSchemaFamily;
  schemaIdentifiers: string[];
  fileName: string;
  originatingSystem: string;
  preprocessorVersion: string;
  timeStamp: string;
  entityCount: number;
  productCount: number;
  /** Products scheduled for geometry; object index = position + 1. */
  geometryProducts: Uint32Array;
  tree: TreeNodeWire[];
  lengthUnit: string;
  diagnosticsSoFar: number;
}

export interface WireMesh {
  color: [number, number, number, number];
  /** Chunk origin relative to the render origin (metres). */
  offset: [number, number, number];
  positions: Float32Array;
  /** Signed-normalised xyz normals. */
  normals: Int8Array;
  /** Object index (product position + 1) per vertex. */
  objects: Uint32Array;
  indices: Uint32Array;
}

export interface WireLines {
  color: [number, number, number, number];
  offset: [number, number, number];
  positions: Float32Array;
  objects: Uint32Array;
  indices: Uint32Array;
}

export interface WireDefinitionPart {
  kind: "mesh" | "lines";
  color: [number, number, number, number];
  positions: Float32Array;
  normals: Int8Array;
  indices: Uint32Array;
}

export interface WireDefinition {
  key: string;
  parts: WireDefinitionPart[];
}

export interface WireInstances {
  key: string;
  /** 16 floats per instance, column-major, relative to the render origin. */
  matrices: Float32Array;
  objects: Uint32Array;
}

export interface GeometryBatch {
  /** Render origin (world metres); constant for a session. */
  origin: [number, number, number];
  meshes: WireMesh[];
  lines: WireLines[];
  definitions: WireDefinition[];
  instances: WireInstances[];
  /** Product ids and world-space bounds (6 per product, metres). */
  productIds: Uint32Array;
  productBounds: Float64Array;
  productsReady: number;
  totalProducts: number;
  trianglesReady: number;
}

export interface LoadStats {
  bytes: number;
  entities: number;
  products: number;
  productsWithGeometry: number;
  triangles: number;
  diagnostics: number;
  parseMs: number;
  indexMs: number;
  geometryMs: number;
}

export interface SerializedError {
  name: string;
  message: string;
  resource?: ResourceLimitDetail;
}

export type MainToWorker =
  | { type: "load"; requestId: number; source: LoadSourceDescriptor; limits: WorkerLimits }
  | { type: "cancel"; requestId: number }
  | { type: "properties"; requestId: number; id: number }
  | { type: "entity"; requestId: number; id: number }
  | { type: "dispose" };

export type WorkerToMain =
  | { type: "progress"; requestId: number; phase: LoadPhase; completed: number; total?: number }
  | { type: "metadata"; requestId: number; metadata: ModelMetadata }
  | { type: "geometry"; requestId: number; batch: GeometryBatch }
  | { type: "diagnostic"; requestId: number; diagnostic: IfcDiagnostic }
  | { type: "resource-limit"; requestId: number; detail: ResourceLimitDetail }
  | { type: "complete"; requestId: number; stats: LoadStats }
  | { type: "error"; requestId: number; error: SerializedError }
  | { type: "properties"; requestId: number; groups: PropertyGroup[] }
  | { type: "entity"; requestId: number; summary: EntitySummary | null; attributes: string[] };

/** Every transferable buffer of a batch (for postMessage). */
export function batchTransferables(batch: GeometryBatch): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const add = (a: ArrayBufferView): void => {
    if (a.buffer instanceof ArrayBuffer && a.buffer.byteLength > 0) out.add(a.buffer);
  };
  for (const m of batch.meshes) [m.positions, m.normals, m.objects, m.indices].forEach(add);
  for (const l of batch.lines) [l.positions, l.objects, l.indices].forEach(add);
  for (const d of batch.definitions) for (const p of d.parts) [p.positions, p.normals, p.indices].forEach(add);
  for (const i of batch.instances) [i.matrices, i.objects].forEach(add);
  add(batch.productIds);
  add(batch.productBounds);
  return [...out];
}
