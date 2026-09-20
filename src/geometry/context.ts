// SPDX-License-Identifier: Apache-2.0
/**
 * Shared state for geometry construction: the model, tolerances, resource
 * limits, caches and recursion guards. Everything is expressed in file length
 * units; conversion to metres happens once, in the final product transform.
 */

import {
  DiagnosticLog,
  IfcCycleError,
  IfcDecodeError,
  IfcResourceLimitError,
  type DiagnosticCode,
  type ResourceKind,
} from "../diagnostics.ts";
import type { IfcModel } from "../ifc/model.ts";
import { StyleResolver } from "../ifc/styles.ts";
import type { Mat4 } from "../math/mat4.ts";
import type { CsgBackend } from "../csg/backend.ts";

export interface GeometryLimits {
  /** Total triangle budget for the whole model. */
  maxTriangles: number;
  /** Largest single product mesh (vertices). */
  maxVerticesPerProduct: number;
  /** Total bytes of geometry buffers produced. */
  maxGeometryBytes: number;
  maxBooleanDepth: number;
  maxMappedItemDepth: number;
  maxPlacementDepth: number;
  maxReferenceDepth: number;
  /** Segment budget of one tessellated curve. */
  maxCurveSegments: number;
  /** Wall-clock budget for one product's geometry (ms); booleans are skipped past it. */
  maxProductMillis: number;
  /** Boolean operand size above which CSG is skipped (triangles). */
  maxBooleanTriangles: number;
}

export const DEFAULT_GEOMETRY_LIMITS: GeometryLimits = {
  maxTriangles: 50_000_000,
  maxVerticesPerProduct: 5_000_000,
  maxGeometryBytes: 2 * 1024 * 1024 * 1024,
  maxBooleanDepth: 64,
  maxMappedItemDepth: 16,
  maxPlacementDepth: 256,
  maxReferenceDepth: 128,
  maxCurveSegments: 20_000,
  maxProductMillis: 8000,
  maxBooleanTriangles: 400_000,
};

export interface TessellationQuality {
  /** Maximum chord deviation in metres. */
  chordTolerance: number;
  /** Minimum segments on a full circle. */
  minCircleSegments: number;
  /** Maximum segments on a full circle. */
  maxCircleSegments: number;
}

export const DEFAULT_QUALITY: TessellationQuality = {
  chordTolerance: 0.002,
  minCircleSegments: 12,
  maxCircleSegments: 96,
};

/** Guard against cycles and runaway recursion over reference chains. */
export class TraversalGuard {
  private readonly active = new Set<number>();
  private readonly maxDepth: number;
  private readonly resource: ResourceKind;

  constructor(maxDepth: number, resource: ResourceKind) {
    this.maxDepth = maxDepth;
    this.resource = resource;
  }

  get depth(): number {
    return this.active.size;
  }

  enter(id: number): void {
    if (this.active.size >= this.maxDepth) {
      throw new IfcResourceLimitError({ resource: this.resource, actual: this.active.size + 1, limit: this.maxDepth });
    }
    if (this.active.has(id)) throw new IfcCycleError(id);
    this.active.add(id);
  }

  leave(id: number): void {
    this.active.delete(id);
  }

  run<T>(id: number, fn: () => T): T {
    this.enter(id);
    try {
      return fn();
    } finally {
      this.leave(id);
    }
  }
}

export class GeometryContext {
  readonly model: IfcModel;
  readonly limits: GeometryLimits;
  readonly quality: TessellationQuality;
  readonly diagnostics: DiagnosticLog;
  readonly styles: StyleResolver;
  readonly csg: CsgBackend;
  /** Length unit scale (file units → metres). */
  readonly unitScale: number;
  /** Plane angle scale (file angle units → radians). */
  readonly angleScale: number;
  /** Geometric tolerance in file units. */
  readonly epsilon: number;

  readonly placementCache = new Map<number, Mat4>();
  readonly placementGuard: TraversalGuard;
  readonly mappedGuard: TraversalGuard;
  readonly itemGuard: TraversalGuard;
  readonly curveGuard: TraversalGuard;
  booleanDepth = 0;

  /** Product currently being processed (for diagnostics). */
  productId: number | undefined;
  /** Deadline (performance.now()) for the current product, or Infinity. */
  deadline = Infinity;

  constructor(
    model: IfcModel,
    csg: CsgBackend,
    options: { limits?: Partial<GeometryLimits>; quality?: Partial<TessellationQuality>; diagnostics?: DiagnosticLog } = {},
  ) {
    this.model = model;
    this.csg = csg;
    this.limits = { ...DEFAULT_GEOMETRY_LIMITS, ...options.limits };
    this.quality = { ...DEFAULT_QUALITY, ...options.quality };
    this.diagnostics = options.diagnostics ?? model.diagnostics;
    this.styles = new StyleResolver(model);
    this.unitScale = model.units.lengthToMetres;
    this.angleScale = model.units.angleToRadians;
    this.epsilon = this.resolveEpsilon();
    this.placementGuard = new TraversalGuard(this.limits.maxPlacementDepth, "placement-depth");
    this.mappedGuard = new TraversalGuard(this.limits.maxMappedItemDepth, "mapped-item-depth");
    this.itemGuard = new TraversalGuard(this.limits.maxReferenceDepth, "reference-depth");
    this.curveGuard = new TraversalGuard(this.limits.maxReferenceDepth, "reference-depth");
  }

  private resolveEpsilon(): number {
    const m = this.model;
    let precision = Number.NaN;
    for (const id of m.idsOfType("IFCGEOMETRICREPRESENTATIONCONTEXT")) {
      const p = m.num(id, 3);
      if (Number.isFinite(p) && p > 0) {
        precision = p;
        break;
      }
    }
    // Clamp the declared precision into a sane range (1e-9 m .. 1e-4 m).
    const metres = Number.isFinite(precision) ? precision * this.unitScale : 1e-6;
    const clamped = Math.min(1e-4, Math.max(1e-9, metres));
    return clamped / this.unitScale;
  }

  /** Number of segments for an arc of `radius` (file units) spanning `sweep` radians. */
  arcSegments(radius: number, sweep: number): number {
    const q = this.quality;
    const r = Math.abs(radius) * this.unitScale;
    const full = Math.PI * 2;
    let theta = full / q.minCircleSegments;
    if (r > q.chordTolerance) {
      theta = Math.min(theta, 2 * Math.acos(1 - q.chordTolerance / r));
    }
    theta = Math.max(theta, full / q.maxCircleSegments);
    const n = Math.ceil(Math.abs(sweep) / theta - 1e-9);
    const limited = Math.min(Math.max(n, 1), this.limits.maxCurveSegments);
    return limited;
  }

  /** Reports a diagnostic attributed to the current product. */
  report(code: DiagnosticCode, message: string, entityId?: number, severity: "info" | "warning" | "error" = "warning"): void {
    this.diagnostics.add({
      code,
      severity,
      message,
      ...(entityId !== undefined ? { entityId } : {}),
      ...(this.productId !== undefined ? { productId: this.productId } : {}),
    });
  }

  /** Throws a decode error for an entity. */
  fail(message: string, entityId: number, code: DiagnosticCode = "GEOMETRY_INVALID"): never {
    throw new IfcDecodeError(message, entityId, code);
  }

  checkDeadline(): boolean {
    return performance.now() > this.deadline;
  }
}
