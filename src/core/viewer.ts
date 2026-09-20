// SPDX-License-Identifier: Apache-2.0
/**
 * IfcViewer: the renderer-level public API. Owns one WebGL2 renderer, one
 * model worker and the selection / visibility / clipping state of one model.
 * Independent instances share nothing.
 */

import { AbortError, type IfcDiagnostic, type ResourceLimitDetail } from "../diagnostics.ts";
import type { EntitySummary } from "../ifc/model.ts";
import type { PropertyGroup } from "../ifc/properties.ts";
import type { IfcSchemaFamily } from "../ifc/schema.ts";
import { boundsCenter, boundsDiagonal, boundsFromArray, emptyBounds, isEmptyBounds, unionBounds, type Bounds3 } from "../math/bounds.ts";
import { transformPoint, type Vec3 } from "../math/mat4.ts";
import type {
  GeometryBatch,
  LoadPhase,
  LoadSourceDescriptor,
  LoadStats,
  MainToWorker,
  ModelMetadata,
  TreeNodeWire,
  WorkerLimits,
  WorkerToMain,
} from "../protocol/messages.ts";
import type { CameraState } from "../renderer/camera.ts";
import { NavigationControls } from "../renderer/controls.ts";
import { FLAG_HIDDEN, FLAG_SELECTED, Renderer } from "../renderer/renderer.ts";

export type IfcSource = string | URL | Blob | File | ArrayBuffer | Uint8Array;

export interface LoadOptions extends WorkerLimits {
  signal?: AbortSignal;
  credentials?: RequestCredentials;
  /** Frame the model when loading completes (default true). */
  fit?: boolean;
}

export interface ViewerOptions {
  canvas: HTMLCanvasElement;
  /** Module worker script; defaults to the worker shipped next to this module. */
  workerUrl?: URL | string;
  antialias?: boolean;
  /** GPU upload budget per animation frame (ms). */
  uploadBudgetMs?: number;
  /** Terminate the worker when it sends nothing for this long during a load (ms). */
  workerTimeoutMs?: number;
  /** Respect prefers-reduced-motion (default: query the media feature). */
  reducedMotion?: boolean;
}

export interface ModelHandle {
  readonly sessionId: string;
  readonly schema: IfcSchemaFamily;
  readonly entityCount: number;
  readonly productCount: number;
}

export interface SelectOptions {
  mode?: "replace" | "add" | "toggle";
  fit?: boolean;
}

export interface FitOptions {
  padding?: number;
  animate?: boolean;
  durationMs?: number;
}

export interface ClipPlane {
  normal: readonly [number, number, number];
  /** Points with dot(normal, p) > distance (model coordinates, metres) are clipped. */
  distance: number;
}

export interface IfcViewerEventMap {
  "ifc-load-start": CustomEvent<{ source: string }>;
  "ifc-progress": CustomEvent<{ phase: LoadPhase; completed: number; total?: number }>;
  "ifc-model-ready": CustomEvent<ModelHandle>;
  "ifc-geometry-progress": CustomEvent<{ productsReady: number; totalProducts: number; trianglesReady: number }>;
  "ifc-load": CustomEvent<ModelHandle & { stats: LoadStats }>;
  "ifc-selection-change": CustomEvent<{ selectedIds: readonly number[] }>;
  "ifc-visibility-change": CustomEvent<{ visibleProducts: number }>;
  "ifc-diagnostic": CustomEvent<IfcDiagnostic>;
  "ifc-resource-limit": CustomEvent<ResourceLimitDetail>;
  "ifc-error": CustomEvent<{ fatal: boolean; error: Error; productId?: number }>;
  "ifc-unload": CustomEvent<Record<string, never>>;
  "ifc-camera-change": CustomEvent<CameraState>;
}

interface PendingLoad {
  requestId: number;
  resolve: (h: ModelHandle) => void;
  reject: (e: Error) => void;
  handle?: ModelHandle;
  stats?: LoadStats;
  fit: boolean;
  fittedOnce: boolean;
  userMoved: boolean;
  lastMessage: number;
}

let sessionCounter = 0;

function describeSource(source: IfcSource): string {
  if (typeof source === "string") return source;
  if (source instanceof URL) return source.href;
  if (typeof File !== "undefined" && source instanceof File) return "local";
  return "local";
}

export class IfcViewer extends EventTarget {
  readonly renderer: Renderer;
  private readonly controls: NavigationControls;
  private readonly workerUrl: URL | string;
  private readonly workerTimeoutMs: number;
  private readonly reducedMotion: boolean;
  private worker: Worker | undefined;
  private nextRequest = 1;
  private pending: PendingLoad | undefined;
  private readonly requests = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private metadata: ModelMetadata | undefined;
  private handle: ModelHandle | undefined;
  private readonly objectIndexById = new Map<number, number>();
  private productIdByIndex: Uint32Array = new Uint32Array(0);
  private readonly bounds = new Map<number, Bounds3>();
  private readonly children = new Map<number, number[]>();
  private origin: Vec3 = [0, 0, 0];
  private originSet = false;
  private selected = new Set<number>();
  private hidden = new Set<number>();
  private clipPlanes: ClipPlane[] = [];
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private resizeObserver: ResizeObserver | undefined;
  private disposed = false;
  private animation = 0;
  private lastSource: { source: IfcSource; options: LoadOptions } | undefined;

  constructor(options: ViewerOptions) {
    super();
    this.workerUrl = options.workerUrl ?? new URL("../worker/model-worker.js", import.meta.url);
    this.workerTimeoutMs = options.workerTimeoutMs ?? 120_000;
    this.reducedMotion =
      options.reducedMotion ?? (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
    this.renderer = new Renderer(options.canvas, {
      ...(options.antialias !== undefined ? { antialias: options.antialias } : {}),
      ...(options.uploadBudgetMs !== undefined ? { uploadBudgetMs: options.uploadBudgetMs } : {}),
      onContextLost: () => this.emit("ifc-error", { fatal: false, error: new Error("WebGL context lost; the model will be reloaded when the context is restored") }),
      onContextRestored: () => {
        if (this.lastSource) void this.load(this.lastSource.source, this.lastSource.options).catch(() => undefined);
      },
    });
    this.renderer.onUploadsIdle = () => this.maybeFinishLoad();
    this.controls = new NavigationControls(this.renderer, {
      onClick: (objectIndex, mode) => {
        const id = objectIndex > 0 ? this.productIdByIndex[objectIndex - 1] : undefined;
        if (id === undefined) {
          if (mode === "replace") this.clearSelection();
        } else {
          this.select(id, { mode });
        }
      },
      onDoubleClick: (objectIndex) => {
        const id = objectIndex > 0 ? this.productIdByIndex[objectIndex - 1] : undefined;
        void this.fit(id !== undefined ? [id] : undefined);
      },
      onPivot: (point) => {
        this.onOrbitPivot?.(point ? ([point[0] + this.origin[0], point[1] + this.origin[1], point[2] + this.origin[2]] as Vec3) : null);
      },
      onInteraction: () => {
        if (this.pending) this.pending.userMoved = true;
        this.cancelAnimation();
        this.emit("ifc-camera-change", this.renderer.camera.state());
      },
    });
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.renderer.resize()) this.renderer.render();
      });
      this.resizeObserver.observe(options.canvas);
    }
    this.renderer.requestRender();
  }

  // --------------------------------------------------------------- events

  private emit<K extends keyof IfcViewerEventMap>(type: K, detail: IfcViewerEventMap[K]["detail"]): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  override addEventListener<K extends keyof IfcViewerEventMap>(type: K, listener: (e: IfcViewerEventMap[K]) => void, options?: boolean | AddEventListenerOptions): void;
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void;
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | ((e: never) => void) | null, options?: boolean | AddEventListenerOptions): void {
    super.addEventListener(type, listener as EventListenerOrEventListenerObject | null, options);
  }

  // ---------------------------------------------------------------- state

  get model(): ModelMetadata | undefined {
    return this.metadata;
  }

  get modelHandle(): ModelHandle | undefined {
    return this.handle;
  }

  get productCount(): number {
    return this.metadata?.productCount ?? 0;
  }

  /** Number of products with uploaded geometry. */
  get geometryProductCount(): number {
    return this.bounds.size;
  }

  get selection(): number[] {
    return [...this.selected];
  }

  get hiddenIds(): number[] {
    return [...this.hidden];
  }

  get tree(): readonly TreeNodeWire[] {
    return this.metadata?.tree ?? [];
  }

  get renderOrigin(): Vec3 {
    return [...this.origin];
  }

  /** World (model) bounds of a product in metres, when it has geometry. */
  productBounds(id: number): Bounds3 | undefined {
    const b = this.bounds.get(id);
    return b ? { ...b } : undefined;
  }

  /** World bounds of all loaded geometry. */
  modelBounds(): Bounds3 {
    let b = emptyBounds();
    for (const pb of this.bounds.values()) b = unionBounds(b, pb);
    return b;
  }

  hasGeometry(id: number): boolean {
    return this.objectIndexById.has(id);
  }

  isVisible(id: number): boolean {
    return !this.hidden.has(id);
  }

  // ----------------------------------------------------------------- load

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(this.workerUrl, { type: "module", name: "ifc-lens-model" });
    w.addEventListener("message", (e: MessageEvent<WorkerToMain>) => this.onWorkerMessage(e.data));
    w.addEventListener("error", (e: ErrorEvent) => {
      e.preventDefault?.();
      this.failWorker(new Error(`Model worker failed: ${e.message || "script error (check workerUrl and CSP worker-src)"}`));
    });
    w.addEventListener("messageerror", () => this.failWorker(new Error("Model worker sent an unreadable message")));
    this.worker = w;
    return w;
  }

  private failWorker(error: Error): void {
    this.worker?.terminate();
    this.worker = undefined;
    for (const r of this.requests.values()) r.reject(error);
    this.requests.clear();
    if (this.pending) {
      const p = this.pending;
      this.pending = undefined;
      this.stopWatchdog();
      p.reject(error);
      this.emit("ifc-error", { fatal: true, error });
    }
  }

  private post(message: MainToWorker, transfer: Transferable[] = []): void {
    this.ensureWorker().postMessage(message, transfer);
  }

  private resolveSource(source: IfcSource, options: LoadOptions): { descriptor: LoadSourceDescriptor; transfer: Transferable[] } {
    if (typeof source === "string" || source instanceof URL) {
      const base = typeof document !== "undefined" ? document.baseURI : undefined;
      let url: URL;
      try {
        url = source instanceof URL ? source : new URL(source, base);
      } catch {
        throw new TypeError(`Invalid IFC URL: ${String(source)}`);
      }
      if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "blob:") {
        throw new TypeError(`Unsupported IFC URL scheme: ${url.protocol}`);
      }
      return { descriptor: { kind: "url", url: url.href, credentials: options.credentials ?? "same-origin" }, transfer: [] };
    }
    if (typeof Blob !== "undefined" && source instanceof Blob) {
      const name = typeof File !== "undefined" && source instanceof File ? source.name : "model.ifc";
      return { descriptor: { kind: "blob", blob: source, name }, transfer: [] };
    }
    if (source instanceof ArrayBuffer) {
      return { descriptor: { kind: "buffer", buffer: source, name: "model.ifc" }, transfer: [source] };
    }
    if (source instanceof Uint8Array) {
      const copy = source.slice().buffer;
      return { descriptor: { kind: "buffer", buffer: copy, name: "model.ifc" }, transfer: [copy] };
    }
    throw new TypeError("Unsupported IFC source: expected URL string, URL, Blob/File, ArrayBuffer or Uint8Array");
  }

  /** Loads a model, replacing the current one. Resolves once geometry is uploaded. */
  load(source: IfcSource, options: LoadOptions = {}): Promise<ModelHandle> {
    if (this.disposed) return Promise.reject(new Error("IfcViewer has been disposed"));
    let resolved: { descriptor: LoadSourceDescriptor; transfer: Transferable[] };
    try {
      resolved = this.resolveSource(source, options);
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      this.emit("ifc-error", { fatal: true, error });
      return Promise.reject(error);
    }
    if (!(source instanceof ArrayBuffer)) this.lastSource = { source, options };
    this.abortPending();
    this.resetModel();
    const requestId = this.nextRequest++;
    const limits: WorkerLimits = {};
    for (const key of Object.keys(options) as (keyof LoadOptions)[]) {
      const v = options[key];
      if (typeof v === "number") (limits as Record<string, number>)[key] = v;
    }
    const promise = new Promise<ModelHandle>((resolve, reject) => {
      this.pending = { requestId, resolve, reject, fit: options.fit !== false, fittedOnce: false, userMoved: false, lastMessage: performance.now() };
    });
    const signal = options.signal;
    if (signal) {
      if (signal.aborted) {
        this.abortPending();
      } else {
        signal.addEventListener("abort", () => {
          if (this.pending?.requestId === requestId) this.abortPending();
        }, { once: true });
      }
    }
    if (this.pending?.requestId === requestId) {
      this.emit("ifc-load-start", { source: describeSource(source) });
      this.post({ type: "load", requestId, source: resolved.descriptor, limits }, resolved.transfer);
      this.startWatchdog();
    }
    return promise;
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdog = setInterval(() => {
      const p = this.pending;
      if (!p) return this.stopWatchdog();
      if (performance.now() - p.lastMessage > this.workerTimeoutMs) {
        this.failWorker(new Error(`Model worker did not respond for ${Math.round(this.workerTimeoutMs / 1000)} s and was terminated`));
      }
    }, 1000);
  }

  private stopWatchdog(): void {
    if (this.watchdog !== undefined) clearInterval(this.watchdog);
    this.watchdog = undefined;
  }

  private abortPending(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = undefined;
    this.stopWatchdog();
    if (this.worker) this.post({ type: "cancel", requestId: p.requestId });
    this.renderer.clearGeometry();
    p.reject(new AbortError("IFC load was cancelled"));
  }

  private resetModel(): void {
    this.metadata = undefined;
    this.handle = undefined;
    this.objectIndexById.clear();
    this.productIdByIndex = new Uint32Array(0);
    this.bounds.clear();
    this.children.clear();
    this.selected.clear();
    this.hidden.clear();
    this.originSet = false;
    this.origin = [0, 0, 0];
    this.renderer.clearGeometry();
  }

  private onWorkerMessage(m: WorkerToMain): void {
    if (this.disposed) return;
    if (m.type === "properties" || m.type === "entity") {
      const r = this.requests.get(m.requestId);
      if (r) {
        this.requests.delete(m.requestId);
        r.resolve(m.type === "properties" ? m.groups : { summary: m.summary, attributes: m.attributes });
      }
      return;
    }
    if (m.type === "error" && this.requests.has(m.requestId)) {
      const r = this.requests.get(m.requestId)!;
      this.requests.delete(m.requestId);
      r.reject(Object.assign(new Error(m.error.message), { name: m.error.name }));
      return;
    }
    const p = this.pending;
    if (!p || m.requestId !== p.requestId) return;
    p.lastMessage = performance.now();
    switch (m.type) {
      case "progress":
        this.emit("ifc-progress", { phase: m.phase, completed: m.completed, ...(m.total !== undefined ? { total: m.total } : {}) });
        break;
      case "metadata":
        this.onMetadata(m.metadata, p);
        break;
      case "geometry":
        this.onGeometry(m.batch, p);
        break;
      case "diagnostic":
        this.emit("ifc-diagnostic", m.diagnostic);
        break;
      case "resource-limit":
        this.emit("ifc-resource-limit", m.detail);
        break;
      case "complete":
        p.stats = m.stats;
        this.maybeFinishLoad();
        break;
      case "error": {
        this.pending = undefined;
        this.stopWatchdog();
        const error = Object.assign(new Error(m.error.message), { name: m.error.name });
        if (m.error.name !== "AbortError") this.emit("ifc-error", { fatal: true, error });
        p.reject(error);
        break;
      }
    }
  }

  private onMetadata(md: ModelMetadata, p: PendingLoad): void {
    this.metadata = md;
    this.productIdByIndex = md.geometryProducts;
    md.geometryProducts.forEach((id, i) => this.objectIndexById.set(id, i + 1));
    for (const n of md.tree) this.children.set(n.id, n.children);
    this.renderer.setObjectCount(md.geometryProducts.length);
    const handle: ModelHandle = {
      sessionId: `ifc-${++sessionCounter}`,
      schema: md.schema,
      entityCount: md.entityCount,
      productCount: md.productCount,
    };
    this.handle = handle;
    p.handle = handle;
    this.emit("ifc-model-ready", handle);
  }

  private onGeometry(batch: GeometryBatch, p: PendingLoad): void {
    if (!this.originSet) {
      this.origin = [...batch.origin];
      this.originSet = true;
    }
    for (let i = 0; i < batch.productIds.length; i++) this.bounds.set(batch.productIds[i]!, boundsFromArray(batch.productBounds, i * 6));
    this.renderer.addBatch(batch);
    this.emit("ifc-geometry-progress", { productsReady: batch.productsReady, totalProducts: batch.totalProducts, trianglesReady: batch.trianglesReady });
    if (p.fit && !p.fittedOnce && !p.userMoved) {
      p.fittedOnce = true;
      this.fitImmediate(this.modelBounds());
    }
  }

  private maybeFinishLoad(): void {
    const p = this.pending;
    if (!p || !p.stats || this.renderer.pendingUploads > 0) return;
    this.pending = undefined;
    this.stopWatchdog();
    if (p.fit && !p.userMoved) this.fitImmediate(this.modelBounds());
    const handle = p.handle ?? { sessionId: `ifc-${++sessionCounter}`, schema: "UNKNOWN" as IfcSchemaFamily, entityCount: 0, productCount: 0 };
    this.emit("ifc-load", { ...handle, stats: p.stats });
    this.emit("ifc-visibility-change", { visibleProducts: this.visibleProductCount() });
    p.resolve(handle);
  }

  /** Cancels an in-flight load and removes the current model. */
  async unload(): Promise<void> {
    this.abortPending();
    const had = this.metadata !== undefined;
    this.resetModel();
    this.lastSource = undefined;
    if (had) {
      this.emit("ifc-selection-change", { selectedIds: [] });
      this.emit("ifc-unload", {});
    }
  }

  // ------------------------------------------------- selection/visibility

  /** Product ids with geometry at or below the given ids in the spatial tree. */
  private expand(ids: Iterable<number>): Set<number> {
    const out = new Set<number>();
    const stack = [...ids];
    const seen = new Set<number>();
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (this.objectIndexById.has(id)) out.add(id);
      const c = this.children.get(id);
      if (c) stack.push(...c);
    }
    return out;
  }

  private applySelectionFlags(): void {
    const highlighted = this.expand(this.selected);
    const indices = new Set<number>();
    for (const id of highlighted) indices.add(this.objectIndexById.get(id)!);
    this.renderer.setFlagWhere(FLAG_SELECTED, (i) => indices.has(i));
  }

  private applyVisibilityFlags(): void {
    const indices = new Set<number>();
    for (const id of this.hidden) {
      const i = this.objectIndexById.get(id);
      if (i !== undefined) indices.add(i);
    }
    this.renderer.setFlagWhere(FLAG_HIDDEN, (i) => indices.has(i));
    this.emit("ifc-visibility-change", { visibleProducts: this.visibleProductCount() });
  }

  private visibleProductCount(): number {
    let n = 0;
    for (const id of this.objectIndexById.keys()) if (!this.hidden.has(id)) n++;
    return n;
  }

  select(ids: number | Iterable<number>, options: SelectOptions = {}): void {
    const list = typeof ids === "number" ? [ids] : [...ids];
    const valid = list.filter((id) => Number.isInteger(id) && (this.objectIndexById.has(id) || this.children.has(id)));
    const mode = options.mode ?? "replace";
    const before = [...this.selected].join(",");
    if (mode === "replace") this.selected = new Set(valid);
    else if (mode === "add") for (const id of valid) this.selected.add(id);
    else for (const id of valid) (this.selected.has(id) ? this.selected.delete(id) : this.selected.add(id));
    this.applySelectionFlags();
    if ([...this.selected].join(",") !== before) this.emit("ifc-selection-change", { selectedIds: [...this.selected] });
    if (options.fit && this.selected.size > 0) void this.fit(this.selected);
  }

  clearSelection(): void {
    if (this.selected.size === 0) return;
    this.selected.clear();
    this.applySelectionFlags();
    this.emit("ifc-selection-change", { selectedIds: [] });
  }

  hide(ids: Iterable<number>): void {
    for (const id of this.expand(ids)) this.hidden.add(id);
    this.applyVisibilityFlags();
  }

  show(ids: Iterable<number>): void {
    for (const id of this.expand(ids)) this.hidden.delete(id);
    this.applyVisibilityFlags();
  }

  isolate(ids: Iterable<number>): void {
    const keep = this.expand(ids);
    this.hidden = new Set([...this.objectIndexById.keys()].filter((id) => !keep.has(id)));
    this.applyVisibilityFlags();
  }

  showAll(): void {
    this.hidden.clear();
    this.applyVisibilityFlags();
  }

  // ---------------------------------------------------------------- camera

  private toRender(b: Bounds3): Bounds3 {
    const o = this.origin;
    return { minX: b.minX - o[0], minY: b.minY - o[1], minZ: b.minZ - o[2], maxX: b.maxX - o[0], maxY: b.maxY - o[1], maxZ: b.maxZ - o[2] };
  }

  private fitImmediate(worldBounds: Bounds3): void {
    if (isEmptyBounds(worldBounds)) return;
    this.renderer.resize();
    this.renderer.camera.setState(this.renderer.camera.fitState(this.toRender(worldBounds), this.renderer.aspect));
    this.renderer.requestRender();
  }

  private cancelAnimation(): void {
    if (this.animation) cancelAnimationFrame(this.animation);
    this.animation = 0;
  }

  private animateTo(target: CameraState, durationMs: number): Promise<void> {
    this.cancelAnimation();
    const cam = this.renderer.camera;
    if (durationMs <= 0 || this.reducedMotion) {
      cam.setState(target);
      this.renderer.requestRender();
      this.emit("ifc-camera-change", cam.state());
      return Promise.resolve();
    }
    const from = cam.state();
    const t0 = performance.now();
    return new Promise((resolve) => {
      const step = (): void => {
        const t = Math.min(1, (performance.now() - t0) / durationMs);
        const k = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
        const mix = (a: Vec3, b: Vec3): Vec3 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
        cam.setState({ eye: mix(from.eye, target.eye), target: mix(from.target, target.target), fov: target.fov });
        this.renderer.requestRender();
        if (t < 1) {
          this.animation = requestAnimationFrame(step);
        } else {
          this.animation = 0;
          this.emit("ifc-camera-change", cam.state());
          resolve();
        }
      };
      this.animation = requestAnimationFrame(step);
    });
  }

  /** Frames the given products (or everything visible). */
  fit(ids?: Iterable<number>, options: FitOptions = {}): Promise<void> {
    let b = emptyBounds();
    const targets = ids ? this.expand(ids) : new Set([...this.bounds.keys()].filter((id) => !this.hidden.has(id)));
    for (const id of targets) {
      const pb = this.bounds.get(id);
      if (pb) b = unionBounds(b, pb);
    }
    if (isEmptyBounds(b)) b = this.modelBounds();
    if (isEmptyBounds(b)) return Promise.resolve();
    this.renderer.resize();
    const state = this.renderer.camera.fitState(this.toRender(b), this.renderer.aspect, options.padding ?? 1.15);
    return this.animateTo(state, options.animate === false ? 0 : (options.durationMs ?? 350));
  }

  /**
   * Looks at the current pivot from `direction` (model space, Z up), keeping
   * the distance. This is what the orientation cube uses: the camera swings
   * around the model instead of jumping somewhere else.
   */
  viewFrom(direction: readonly [number, number, number], options: FitOptions & { fit?: boolean } = {}): Promise<void> {
    const cam = this.renderer.camera;
    const l = Math.hypot(direction[0], direction[1], direction[2]);
    if (!(l > 0) || !direction.every(Number.isFinite)) return Promise.resolve();
    const d: Vec3 = [direction[0] / l, direction[1] / l, direction[2] / l];
    const bounds = this.modelBounds();
    const duration = options.animate === false ? 0 : (options.durationMs ?? 350);
    const fitRequested = options.fit === true && !isEmptyBounds(bounds);
    const render = isEmptyBounds(bounds) ? undefined : this.toRender(bounds);
    const distance = cam.distance > 1e-6 ? cam.distance : Math.max(1, render ? boundsDiagonal(render) : 10);
    const target: Vec3 = fitRequested && render ? boundsCenter(render) : [...cam.target];
    const oriented: CameraState = {
      eye: [target[0] + d[0] * distance, target[1] + d[1] * distance, target[2] + d[2] * distance],
      target,
      fov: cam.fov,
    };
    if (!fitRequested || !render) return this.animateTo(oriented, duration);
    // Frame the model from the new direction without disturbing the live camera.
    const saved = cam.state();
    this.renderer.resize();
    cam.setState(oriented);
    const fitted = cam.fitState(render, this.renderer.aspect, options.padding ?? 1.15);
    cam.setState(saved);
    return this.animateTo(fitted, duration);
  }

  /** Standard views: top, front, side, iso. */
  viewPreset(name: "top" | "front" | "side" | "iso"): Promise<void> {
    const b = this.modelBounds();
    if (isEmptyBounds(b)) return Promise.resolve();
    this.renderer.resize();
    return this.animateTo(this.renderer.camera.presetState(name, this.toRender(b), this.renderer.aspect), 350);
  }

  getCamera(): CameraState {
    const s = this.renderer.camera.state();
    const o = this.origin;
    return { eye: [s.eye[0] + o[0], s.eye[1] + o[1], s.eye[2] + o[2]], target: [s.target[0] + o[0], s.target[1] + o[1], s.target[2] + o[2]], fov: s.fov };
  }

  setCamera(state: CameraState): void {
    const o = this.origin;
    this.renderer.camera.setState({ eye: [state.eye[0] - o[0], state.eye[1] - o[1], state.eye[2] - o[2]], target: [state.target[0] - o[0], state.target[1] - o[1], state.target[2] - o[2]], fov: state.fov });
    this.renderer.requestRender();
  }

  /**
   * Called when the orbit anchor changes: the model-space point the camera
   * turns around while the user drags, and null when the drag ends.
   */
  onOrbitPivot: ((point: Vec3 | null) => void) | undefined;

  /** The current orbit anchor in model space, or null when not orbiting. */
  get orbitPivot(): Vec3 | null {
    const p = this.controls.pivot;
    return p ? [p[0] + this.origin[0], p[1] + this.origin[1], p[2] + this.origin[2]] : null;
  }

  /**
   * Project a model-space point onto the canvas. Returns CSS pixels relative
   * to the canvas top-left, or null when the point is behind the camera.
   */
  project(point: Vec3): { x: number; y: number } | null {
    const o = this.origin;
    const [x, y, z] = [point[0] - o[0], point[1] - o[1], point[2] - o[2]];
    const vp = this.renderer.camera.viewProjection(this.renderer.aspect);
    const w = vp[3]! * x + vp[7]! * y + vp[11]! * z + vp[15]!;
    if (!(w > 1e-9)) return null;
    const c = transformPoint(vp, x, y, z);
    const canvas = this.renderer.canvas;
    return { x: (c[0] / w * 0.5 + 0.5) * canvas.clientWidth, y: (0.5 - c[1] / w * 0.5) * canvas.clientHeight };
  }

  // -------------------------------------------------------------- clipping

  setClipPlane(plane: ClipPlane | null): void {
    this.setClipPlanes(plane ? [plane] : []);
  }

  setClipPlanes(planes: readonly ClipPlane[]): void {
    for (const p of planes) {
      if (!p.normal.every(Number.isFinite) || !Number.isFinite(p.distance)) throw new TypeError("clip plane must be finite");
    }
    this.clipPlanes = planes.map((p) => ({ normal: [...p.normal] as [number, number, number], distance: p.distance }));
    const o = this.origin;
    this.renderer.setClipPlanes(
      this.clipPlanes.map((p) => {
        const l = Math.hypot(p.normal[0], p.normal[1], p.normal[2]) || 1;
        const n: Vec3 = [p.normal[0] / l, p.normal[1] / l, p.normal[2] / l];
        return { normal: n, distance: p.distance / l - (n[0] * o[0] + n[1] * o[1] + n[2] * o[2]) };
      }),
    );
  }

  get clipping(): readonly ClipPlane[] {
    return this.clipPlanes;
  }

  // ---------------------------------------------------------------- queries

  private request<T>(message: MainToWorker & { requestId: number }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.worker || !this.metadata) {
        resolve((message.type === "properties" ? [] : { summary: null, attributes: [] }) as T);
        return;
      }
      this.requests.set(message.requestId, { resolve: resolve as (v: unknown) => void, reject });
      this.post(message);
    });
  }

  getProperties(id: number): Promise<PropertyGroup[]> {
    return this.request<PropertyGroup[]>({ type: "properties", requestId: this.nextRequest++, id });
  }

  async getEntity(id: number): Promise<EntitySummary | null> {
    const r = await this.request<{ summary: EntitySummary | null; attributes: string[] }>({ type: "entity", requestId: this.nextRequest++, id });
    return r.summary;
  }

  /** Raw STEP attributes of an entity (for inspection). */
  async getAttributes(id: number): Promise<string[]> {
    const r = await this.request<{ summary: EntitySummary | null; attributes: string[] }>({ type: "entity", requestId: this.nextRequest++, id });
    return r.attributes;
  }

  /** Product id under a canvas CSS position, or null. */
  pickAt(x: number, y: number): number | null {
    const hit = this.renderer.pick(x, y);
    return hit.objectIndex > 0 ? (this.productIdByIndex[hit.objectIndex - 1] ?? null) : null;
  }

  /** Captures the current frame as RGBA pixels. */
  snapshot(): { width: number; height: number; data: Uint8Array } {
    return this.renderer.readPixels();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.abortPending();
    this.disposed = true;
    this.cancelAnimation();
    this.stopWatchdog();
    this.resizeObserver?.disconnect();
    this.controls.dispose();
    for (const r of this.requests.values()) r.reject(new Error("IfcViewer disposed"));
    this.requests.clear();
    if (this.worker) {
      this.worker.postMessage({ type: "dispose" } satisfies MainToWorker);
      this.worker.terminate();
      this.worker = undefined;
    }
    this.renderer.dispose();
  }
}
