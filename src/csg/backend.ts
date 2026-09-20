// SPDX-License-Identifier: Apache-2.0
/**
 * Renderer- and IFC-independent Boolean (CSG) backend contract. Solids are
 * opaque handles with explicit ownership: every handle returned by `create`,
 * `apply` or `transform` must be released with `dispose`. The project ships
 * one implementation (the native TypeScript mesh-boolean engine); the
 * interface keeps alternative backends pluggable without touching IFC code.
 */

export type CsgOperation = "union" | "intersection" | "difference";

export interface TriangleMesh64 {
  /** Packed xyz positions. */
  positions: Float64Array;
  /** Triangle vertex index triplets. */
  indices: Uint32Array;
}

export interface CsgSolid {
  readonly backend: symbol;
  readonly handle: number;
}

export interface CsgBackend {
  readonly name: string;
  initialize(signal?: AbortSignal): Promise<void>;
  create(mesh: TriangleMesh64): CsgSolid;
  apply(operation: CsgOperation, first: CsgSolid, second: CsgSolid): CsgSolid;
  transform(solid: CsgSolid, matrix: Float64Array): CsgSolid;
  exportMesh(solid: CsgSolid): TriangleMesh64;
  dispose(solid: CsgSolid): void;
  disposeAll(): void;
  /** Number of live handles (leak detection in tests). */
  readonly liveCount: number;
}

/**
 * Runs `op` over two meshes with deterministic handle ownership.
 */
export function booleanMeshes(backend: CsgBackend, operation: CsgOperation, a: TriangleMesh64, b: TriangleMesh64): TriangleMesh64 {
  const sa = backend.create(a);
  let sb: CsgSolid | undefined;
  let result: CsgSolid | undefined;
  try {
    sb = backend.create(b);
    result = backend.apply(operation, sa, sb);
    return backend.exportMesh(result);
  } finally {
    if (result) backend.dispose(result);
    if (sb) backend.dispose(sb);
    backend.dispose(sa);
  }
}
