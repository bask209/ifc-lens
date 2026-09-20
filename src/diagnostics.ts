// SPDX-License-Identifier: Apache-2.0
/**
 * Structured diagnostics shared by every pipeline stage. Diagnostics are data,
 * never exceptions: a malformed entity or an unsupported geometry item is
 * reported and the rest of the model keeps loading.
 */

export type DiagnosticCode =
  | "STEP_SYNTAX"
  | "STEP_UNSUPPORTED_ENCODING"
  | "STEP_DUPLICATE_ID"
  | "IFC_SCHEMA_UNKNOWN"
  | "IFC_REFERENCE_MISSING"
  | "IFC_REFERENCE_CYCLE"
  | "IFC_INVALID_ATTRIBUTE"
  | "PLACEMENT_INVALID"
  | "PROFILE_INVALID"
  | "CURVE_INVALID"
  | "TRIANGULATION_FAILED"
  | "BREP_NOT_CLOSED"
  | "BOOLEAN_NON_MANIFOLD"
  | "BOOLEAN_FAILED"
  | "SWEEP_INVALID"
  | "GEOMETRY_UNSUPPORTED"
  | "GEOMETRY_INVALID"
  | "RESOURCE_LIMIT";

export type DiagnosticSeverity = "info" | "warning" | "error";

export interface IfcDiagnostic {
  readonly code: DiagnosticCode;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  /** STEP instance name (#id) of the entity the diagnostic refers to. */
  readonly entityId?: number;
  /** Product whose geometry was affected. */
  readonly productId?: number;
  /** Byte offset in the source file (parser diagnostics). */
  readonly offset?: number;
}

export type ResourceKind =
  | "file-bytes"
  | "entities"
  | "tokens"
  | "string-bytes"
  | "nesting"
  | "products"
  | "triangles"
  | "vertices"
  | "geometry-bytes"
  | "boolean-depth"
  | "mapped-item-depth"
  | "placement-depth"
  | "reference-depth"
  | "curve-segments"
  | "time";

export interface ResourceLimitDetail {
  readonly resource: ResourceKind;
  readonly actual: number;
  readonly limit: number;
  readonly productId?: number;
}

/** Thrown when a configured budget is exceeded. Carries structured detail. */
export class IfcResourceLimitError extends Error {
  readonly detail: ResourceLimitDetail;
  constructor(detail: ResourceLimitDetail) {
    super(`Resource limit exceeded: ${detail.resource} (${detail.actual} > ${detail.limit})`);
    this.name = "IfcResourceLimitError";
    this.detail = detail;
  }
}

/** Thrown for unrecoverable STEP structure problems (e.g. not a STEP file). */
export class StepFormatError extends Error {
  readonly offset: number | undefined;
  constructor(message: string, offset?: number) {
    super(offset === undefined ? message : `${message} (at byte ${offset})`);
    this.name = "StepFormatError";
    this.offset = offset;
  }
}

/** Thrown by semantic decoders when an entity cannot be interpreted. */
export class IfcDecodeError extends Error {
  readonly entityId: number | undefined;
  readonly code: DiagnosticCode;
  constructor(message: string, entityId?: number, code: DiagnosticCode = "IFC_INVALID_ATTRIBUTE") {
    super(message);
    this.name = "IfcDecodeError";
    this.entityId = entityId;
    this.code = code;
  }
}

/** Thrown when a reference chain loops back onto itself. */
export class IfcCycleError extends IfcDecodeError {
  constructor(entityId: number) {
    super(`Reference cycle detected at #${entityId}`, entityId, "IFC_REFERENCE_CYCLE");
    this.name = "IfcCycleError";
  }
}

/** Thrown when an operation is cancelled through an AbortSignal. */
export class AbortError extends Error {
  constructor(message = "The operation was aborted") {
    super(message);
    this.name = "AbortError";
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AbortError();
}

/**
 * Bounded diagnostic collector. Malformed input can produce millions of
 * identical problems; only the first `maxStored` are retained verbatim while
 * per-code counts stay exact.
 */
export class DiagnosticLog {
  readonly items: IfcDiagnostic[] = [];
  readonly counts = new Map<DiagnosticCode, number>();
  private readonly maxStored: number;
  private listener: ((d: IfcDiagnostic) => void) | undefined;
  dropped = 0;

  constructor(maxStored = 2000, listener?: (d: IfcDiagnostic) => void) {
    this.maxStored = maxStored;
    this.listener = listener;
  }

  setListener(listener: ((d: IfcDiagnostic) => void) | undefined): void {
    this.listener = listener;
  }

  add(d: IfcDiagnostic): void {
    this.counts.set(d.code, (this.counts.get(d.code) ?? 0) + 1);
    if (this.items.length < this.maxStored) {
      this.items.push(d);
      this.listener?.(d);
    } else {
      this.dropped++;
    }
  }

  count(code?: DiagnosticCode): number {
    if (code === undefined) {
      let total = 0;
      for (const n of this.counts.values()) total += n;
      return total;
    }
    return this.counts.get(code) ?? 0;
  }
}
