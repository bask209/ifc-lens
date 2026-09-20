// SPDX-License-Identifier: Apache-2.0
/**
 * One model load: stream → STEP parse → IFC index → metadata → scheduled
 * geometry in time-sliced batches. Runs in the model worker, and unchanged in
 * Node for the corpus and integration suites.
 */

import {
  AbortError,
  DiagnosticLog,
  IfcResourceLimitError,
  throwIfAborted,
  type IfcDiagnostic,
  type ResourceLimitDetail,
} from "../diagnostics.ts";
import { GeometryEngine } from "../geometry/engine.ts";
import { IfcModel } from "../ifc/model.ts";
import { getPropertyGroups, type PropertyGroup } from "../ifc/properties.ts";
import { prettyTypeName } from "../ifc/schema.ts";
import { parseStepStream } from "../step/parser.ts";
import { serializeValue } from "../step/writer.ts";
import type {
  GeometryBatch,
  LoadPhase,
  LoadSourceDescriptor,
  LoadStats,
  ModelMetadata,
  TreeNodeWire,
  WorkerLimits,
} from "../protocol/messages.ts";
import type { EntitySummary } from "../ifc/model.ts";
import { GeometryPacker } from "./packer.ts";
import { openSource } from "./source.ts";

export interface SessionCallbacks {
  progress(phase: LoadPhase, completed: number, total?: number): void;
  metadata(metadata: ModelMetadata): void;
  geometry(batch: GeometryBatch): void;
  diagnostic(diagnostic: IfcDiagnostic): void;
  resourceLimit(detail: ResourceLimitDetail): void;
}

export const DEFAULT_WORKER_LIMITS: Required<WorkerLimits> = {
  maxFileBytes: 1024 * 1024 * 1024,
  maxEntities: 20_000_000,
  maxStringBytes: 16 * 1024 * 1024,
  maxAggregateDepth: 64,
  maxTriangles: 50_000_000,
  maxGeometryBytes: 2 * 1024 * 1024 * 1024,
  maxReferenceDepth: 128,
  maxBooleanDepth: 64,
  maxMappedItemDepth: 16,
  maxPlacementDepth: 256,
  maxCurveSegments: 20_000,
  maxProductMillis: 8000,
  maxBooleanTriangles: 400_000,
  maxVerticesPerProduct: 5_000_000,
};

const FLUSH_INTERVAL_MS = 120;
const FLUSH_BYTES = 8 * 1024 * 1024;
const YIELD_INTERVAL_MS = 24;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export class LoadSession {
  readonly limits: Required<WorkerLimits>;
  readonly diagnostics: DiagnosticLog;
  model: IfcModel | undefined;
  engine: GeometryEngine | undefined;
  private readonly callbacks: SessionCallbacks;
  private readonly controller = new AbortController();

  constructor(callbacks: SessionCallbacks, limits: WorkerLimits = {}) {
    this.callbacks = callbacks;
    const defined = Object.fromEntries(Object.entries(limits).filter(([, v]) => typeof v === "number" && Number.isFinite(v) && v > 0));
    this.limits = { ...DEFAULT_WORKER_LIMITS, ...defined };
    this.diagnostics = new DiagnosticLog(2000, (d) => {
      callbacks.diagnostic(d);
    });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  cancel(): void {
    this.controller.abort();
  }

  async run(source: LoadSourceDescriptor): Promise<LoadStats> {
    const signal = this.controller.signal;
    const limits = this.limits;
    const cb = this.callbacks;
    const t0 = performance.now();
    cb.progress("fetch", 0);
    const opened = await openSource(source, limits.maxFileBytes, signal);
    throwIfAborted(signal);
    let lastProgress = 0;
    const parser = await parseStepStream(opened.stream, {
      signal,
      diagnostics: this.diagnostics,
      limits: {
        maxFileBytes: limits.maxFileBytes,
        maxEntities: limits.maxEntities,
        maxStringBytes: limits.maxStringBytes,
        maxAggregateDepth: limits.maxAggregateDepth,
      },
      onProgress: (bytes) => {
        const now = performance.now();
        if (now - lastProgress > 50) {
          lastProgress = now;
          cb.progress("parse", bytes, opened.total);
        }
      },
    });
    cb.progress("parse", parser.bytesRead, parser.bytesRead);
    const t1 = performance.now();
    cb.progress("index", 0, 1);
    const model = new IfcModel(parser.store, this.diagnostics);
    this.model = model;
    const engine = new GeometryEngine(model, {
      diagnostics: this.diagnostics,
      signal,
      limits: {
        maxTriangles: limits.maxTriangles,
        maxGeometryBytes: limits.maxGeometryBytes,
        maxReferenceDepth: limits.maxReferenceDepth,
        maxBooleanDepth: limits.maxBooleanDepth,
        maxMappedItemDepth: limits.maxMappedItemDepth,
        maxPlacementDepth: limits.maxPlacementDepth,
        maxCurveSegments: limits.maxCurveSegments,
        maxProductMillis: limits.maxProductMillis,
        maxBooleanTriangles: limits.maxBooleanTriangles,
        maxVerticesPerProduct: limits.maxVerticesPerProduct,
      },
    });
    this.engine = engine;
    const order = engine.prepare();
    const objectIndex = new Map<number, number>();
    order.forEach((id, i) => objectIndex.set(id, i + 1));
    const tree: TreeNodeWire[] = model.spatialTree().map((n) => ({
      id: n.id,
      type: n.type ? prettyTypeName(n.type) : "",
      name: n.name,
      kind: n.kind,
      children: n.children,
      geometry: objectIndex.has(n.id),
    }));
    const lengthUnit = model.units.symbols.get("LENGTHUNIT") ?? "m";
    cb.progress("index", 1, 1);
    const t2 = performance.now();
    cb.metadata({
      schema: model.schema,
      schemaIdentifiers: model.header.schemaIdentifiers,
      fileName: model.header.fileName || opened.name,
      originatingSystem: model.header.originatingSystem,
      preprocessorVersion: model.header.preprocessorVersion,
      timeStamp: model.header.timeStamp,
      entityCount: model.entityCount,
      productCount: model.products.length,
      geometryProducts: Uint32Array.from(order),
      tree,
      lengthUnit,
      diagnosticsSoFar: this.diagnostics.count(),
    });

    const packer = new GeometryPacker(engine, objectIndex);
    let lastFlush = performance.now();
    let lastYield = performance.now();
    let withGeometry = 0;
    for (let i = 0; i < order.length; i++) {
      throwIfAborted(signal);
      const g = engine.buildProduct(order[i]!);
      if (g) {
        packer.add(g);
        withGeometry++;
      }
      if (packer.bytes > limits.maxGeometryBytes) {
        const detail: ResourceLimitDetail = { resource: "geometry-bytes", actual: packer.bytes, limit: limits.maxGeometryBytes };
        cb.resourceLimit(detail);
        this.diagnostics.add({ code: "RESOURCE_LIMIT", severity: "error", message: `geometry byte budget exhausted after ${i + 1} of ${order.length} products` });
        break;
      }
      const now = performance.now();
      if (now - lastFlush > FLUSH_INTERVAL_MS || packer.pendingBytes > FLUSH_BYTES) {
        const batch = packer.flush(order.length);
        if (batch) cb.geometry(batch);
        cb.progress("geometry", i + 1, order.length);
        lastFlush = performance.now();
      }
      if (now - lastYield > YIELD_INTERVAL_MS) {
        await yieldToEventLoop();
        lastYield = performance.now();
      }
    }
    throwIfAborted(signal);
    const batch = packer.flush(order.length);
    if (batch) cb.geometry(batch);
    cb.progress("geometry", order.length, order.length);
    const t3 = performance.now();
    return {
      bytes: parser.bytesRead,
      entities: model.entityCount,
      products: model.products.length,
      productsWithGeometry: withGeometry,
      triangles: engine.trianglesTotal,
      diagnostics: this.diagnostics.count(),
      parseMs: t1 - t0,
      indexMs: t2 - t1,
      geometryMs: t3 - t2,
    };
  }

  properties(id: number): PropertyGroup[] {
    if (!this.model) return [];
    return getPropertyGroups(this.model, id);
  }

  entity(id: number): { summary: EntitySummary | null; attributes: string[] } {
    if (!this.model) return { summary: null, attributes: [] };
    const summary = this.model.summary(id);
    const attributes = this.model.values(id).map((v) => {
      const s = serializeValue(v);
      return s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
    });
    return { summary, attributes };
  }
}

/** Serialises an error for postMessage. */
export function serializeError(e: unknown): { name: string; message: string; resource?: ResourceLimitDetail } {
  if (e instanceof IfcResourceLimitError) return { name: e.name, message: e.message, resource: e.detail };
  if (e instanceof AbortError) return { name: "AbortError", message: e.message };
  if (e instanceof Error) return { name: e.name, message: e.message };
  return { name: "Error", message: String(e) };
}
