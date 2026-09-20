// SPDX-License-Identifier: Apache-2.0
/**
 * WebGL2 renderer: budgeted GPU uploads, merged chunks and instanced mapped
 * definitions, per-object state texture (visibility / selection), clipping
 * planes, frustum culling, transparency ordering and GPU ID-buffer picking.
 * Knows nothing about IFC or STEP: it consumes geometry batches only.
 */

import { emptyBounds, expandPoint, isEmptyBounds, unionBounds, type Bounds3 } from "../math/bounds.ts";
import { translation, type Mat4, type Vec3 } from "../math/mat4.ts";
import type { GeometryBatch, WireDefinitionPart } from "../protocol/messages.ts";
import { OrbitCamera } from "./camera.ts";
import { MAX_CLIP_PLANES, MESH_FRAGMENT, MESH_VERTEX, PICK_FRAGMENT } from "./shaders.ts";

export const FLAG_HIDDEN = 1;
export const FLAG_SELECTED = 2;

export interface RendererOptions {
  antialias?: boolean;
  /** Maximum device pixel ratio used for the drawing buffer. */
  maxPixelRatio?: number;
  /** Per-frame GPU upload budget in milliseconds. */
  uploadBudgetMs?: number;
  onContextLost?: () => void;
  onContextRestored?: () => void;
}

export interface PickResult {
  /** Object index (product position + 1), 0 when nothing was hit. */
  objectIndex: number;
  /** Hit point in render-origin space. */
  point?: Vec3;
}

/** Plane in render space: points with dot(normal, p) > distance are clipped. */
export interface RenderClipPlane {
  normal: Vec3;
  distance: number;
}

interface DrawItem {
  vao: WebGLVertexArrayObject;
  buffers: WebGLBuffer[];
  mode: number;
  count: number;
  instances: number;
  color: [number, number, number, number];
  transparent: boolean;
  bounds: Bounds3;
  instanceBuffer?: WebGLBuffer;
  objectBuffer?: WebGLBuffer;
  bytes: number;
}

interface DefinitionState {
  parts: WireDefinitionPart[];
  partBounds: Bounds3[];
  matrices: Float32Array;
  objects: Uint32Array;
  count: number;
  items: DrawItem[];
}

type UploadTask = () => void;

const STATE_WIDTH = 1024;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const s = gl.createShader(type);
  if (!s) throw new Error("WebGL: createShader failed");
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(`WebGL shader compilation failed: ${log}`);
  }
  return s;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram();
  if (!p) throw new Error("WebGL: createProgram failed");
  const v = compile(gl, gl.VERTEX_SHADER, vs);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`WebGL program link failed: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

interface ProgramInfo {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

function programInfo(gl: WebGL2RenderingContext, vs: string, fs: string, names: string[]): ProgramInfo {
  const program = link(gl, vs, fs);
  const uniforms: Record<string, WebGLUniformLocation | null> = {};
  for (const n of names) uniforms[n] = gl.getUniformLocation(program, n);
  return { program, uniforms };
}

function toF32(m: Mat4): Float32Array {
  return Float32Array.from(m);
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly camera = new OrbitCamera();
  private gl: WebGL2RenderingContext;
  private readonly options: Required<Omit<RendererOptions, "onContextLost" | "onContextRestored">> & RendererOptions;
  private meshProgram!: ProgramInfo;
  private pickProgram!: ProgramInfo;
  private stateTexture: WebGLTexture | null = null;
  private stateData = new Uint8Array(STATE_WIDTH);
  private stateDirty = true;
  private objectCapacity = 0;
  private opaque: DrawItem[] = [];
  private transparent: DrawItem[] = [];
  private lines: DrawItem[] = [];
  private readonly definitions = new Map<string, DefinitionState>();
  private readonly uploads: UploadTask[] = [];
  private clipPlanes: RenderClipPlane[] = [];
  private background: [number, number, number, number] = [0.93, 0.94, 0.95, 1];
  private highlight: [number, number, number, number] = [0.1, 0.45, 1.0, 0.6];
  private frame = 0;
  private dirty = true;
  private disposed = false;
  private lost = false;
  private pickFbo: WebGLFramebuffer | null = null;
  private pickTargets: (WebGLTexture | WebGLRenderbuffer)[] = [];
  private pickSize: [number, number] = [0, 0];
  /** Render-space bounds of everything uploaded. */
  sceneBounds: Bounds3 = emptyBounds();
  gpuBytes = 0;
  drawCalls = 0;
  trianglesDrawn = 0;
  /** Called after every rendered frame. */
  onRender: (() => void) | undefined;
  /** Called when uploads drain. */
  onUploadsIdle: (() => void) | undefined;
  private readonly onLost: (e: Event) => void;
  private readonly onRestored: () => void;

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    this.canvas = canvas;
    this.options = { antialias: true, maxPixelRatio: 2, uploadBudgetMs: 6, ...options };
    const gl = canvas.getContext("webgl2", {
      antialias: this.options.antialias,
      alpha: false,
      depth: true,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("WebGL2 is not available in this browser");
    this.gl = gl;
    this.initResources();
    this.onLost = (e: Event) => {
      e.preventDefault();
      this.lost = true;
      this.options.onContextLost?.();
    };
    this.onRestored = () => {
      this.lost = false;
      this.dropGpuState();
      this.initResources();
      this.options.onContextRestored?.();
    };
    canvas.addEventListener("webglcontextlost", this.onLost);
    canvas.addEventListener("webglcontextrestored", this.onRestored);
  }

  private initResources(): void {
    const gl = this.gl;
    const names = ["uViewProj", "uState", "uStateWidth", "uColor", "uHighlight", "uEye", "uClip", "uClipCount", "uUnlit"];
    this.meshProgram = programInfo(gl, MESH_VERTEX, MESH_FRAGMENT, names);
    this.pickProgram = programInfo(gl, MESH_VERTEX, PICK_FRAGMENT, names);
    this.stateTexture = gl.createTexture();
    this.stateDirty = true;
    this.pickFbo = null;
    this.pickTargets = [];
    this.pickSize = [0, 0];
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  private dropGpuState(): void {
    this.opaque = [];
    this.transparent = [];
    this.lines = [];
    this.definitions.clear();
    this.uploads.length = 0;
    this.gpuBytes = 0;
    this.sceneBounds = emptyBounds();
  }

  get contextLost(): boolean {
    return this.lost;
  }

  get pendingUploads(): number {
    return this.uploads.length;
  }

  // ------------------------------------------------------------- state

  /** Ensures the state texture can address `count` objects (index 0 unused). */
  setObjectCount(count: number): void {
    const needed = Math.max(1, Math.ceil((count + 1) / STATE_WIDTH)) * STATE_WIDTH;
    if (needed > this.stateData.length) {
      const next = new Uint8Array(needed);
      next.set(this.stateData);
      this.stateData = next;
    }
    this.objectCapacity = count;
    this.stateDirty = true;
    this.requestRender();
  }

  setFlag(objectIndex: number, flag: number, on: boolean): void {
    if (objectIndex <= 0 || objectIndex > this.objectCapacity) return;
    const v = this.stateData[objectIndex]!;
    const nv = on ? v | flag : v & ~flag;
    if (nv !== v) {
      this.stateData[objectIndex] = nv;
      this.stateDirty = true;
      this.requestRender();
    }
  }

  getFlags(objectIndex: number): number {
    return this.stateData[objectIndex] ?? 0;
  }

  /** Applies `flag` to every object for which `predicate` is true, clears it otherwise. */
  setFlagWhere(flag: number, predicate: (objectIndex: number) => boolean): void {
    for (let i = 1; i <= this.objectCapacity; i++) {
      const v = this.stateData[i]!;
      this.stateData[i] = predicate(i) ? v | flag : v & ~flag;
    }
    this.stateDirty = true;
    this.requestRender();
  }

  setBackground(rgba: [number, number, number, number]): void {
    this.background = rgba;
    this.requestRender();
  }

  setHighlight(rgba: [number, number, number, number]): void {
    this.highlight = rgba;
    this.requestRender();
  }

  setClipPlanes(planes: RenderClipPlane[]): void {
    this.clipPlanes = planes.slice(0, MAX_CLIP_PLANES);
    this.requestRender();
  }

  // ----------------------------------------------------------- uploads

  /** Queues the GPU upload of a geometry batch. */
  addBatch(batch: GeometryBatch): void {
    for (const m of batch.meshes) {
      this.uploads.push(() => {
        const item = this.createItem(m.positions, m.normals, m.indices, this.gl.TRIANGLES, m.color, m.objects, false, [translation(m.offset[0], m.offset[1], m.offset[2])]);
        this.register(item, false);
      });
    }
    for (const l of batch.lines) {
      this.uploads.push(() => {
        const item = this.createItem(l.positions, null, l.indices, this.gl.LINES, l.color, l.objects, false, [translation(l.offset[0], l.offset[1], l.offset[2])]);
        this.register(item, true);
      });
    }
    for (const d of batch.definitions) {
      this.uploads.push(() => {
        this.definitions.set(d.key, {
          parts: d.parts,
          partBounds: d.parts.map((p) => {
            const b = emptyBounds();
            for (let i = 0; i < p.positions.length; i += 3) expandPoint(b, p.positions[i]!, p.positions[i + 1]!, p.positions[i + 2]!);
            return b;
          }),
          matrices: new Float32Array(0),
          objects: new Uint32Array(0),
          count: 0,
          items: [],
        });
      });
    }
    for (const inst of batch.instances) {
      this.uploads.push(() => this.addInstances(inst.key, inst.matrices, inst.objects));
    }
    this.requestRender();
  }

  private register(item: DrawItem, isLine: boolean): void {
    if (isLine) this.lines.push(item);
    else if (item.transparent) this.transparent.push(item);
    else this.opaque.push(item);
    this.sceneBounds = unionBounds(this.sceneBounds, item.bounds);
    this.camera.sceneBounds = this.sceneBounds;
  }

  private createItem(
    positions: Float32Array,
    normals: Int8Array | null,
    indices: Uint32Array,
    mode: number,
    color: [number, number, number, number],
    objects: Uint32Array,
    perInstanceObjects: boolean,
    matrices: Mat4[] | Float32Array,
  ): DrawItem {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buffers: WebGLBuffer[] = [];
    let bytes = 0;
    const buf = (target: number, data: ArrayBufferView): WebGLBuffer => {
      const b = gl.createBuffer()!;
      gl.bindBuffer(target, b);
      gl.bufferData(target, data, gl.STATIC_DRAW);
      buffers.push(b);
      bytes += data.byteLength;
      return b;
    };
    buf(gl.ARRAY_BUFFER, positions);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    if (normals && normals.length > 0) {
      buf(gl.ARRAY_BUFFER, normals);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.BYTE, true, 0, 0);
    } else {
      gl.disableVertexAttribArray(1);
      gl.vertexAttrib3f(1, 0, 0, 0);
    }
    const objectBuffer = buf(gl.ARRAY_BUFFER, objects);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, 0, 0);
    gl.vertexAttribDivisor(2, perInstanceObjects ? 1 : 0);
    const matrixData = matrices instanceof Float32Array ? matrices : (() => {
      const out = new Float32Array(matrices.length * 16);
      matrices.forEach((m, i) => out.set(toF32(m), i * 16));
      return out;
    })();
    const instanceBuffer = buf(gl.ARRAY_BUFFER, matrixData);
    for (let k = 0; k < 4; k++) {
      gl.enableVertexAttribArray(3 + k);
      gl.vertexAttribPointer(3 + k, 4, gl.FLOAT, false, 64, k * 16);
      gl.vertexAttribDivisor(3 + k, 1);
    }
    buf(gl.ELEMENT_ARRAY_BUFFER, indices);
    gl.bindVertexArray(null);
    // bounds in render space
    const local = emptyBounds();
    for (let i = 0; i < positions.length; i += 3) expandPoint(local, positions[i]!, positions[i + 1]!, positions[i + 2]!);
    const bounds = boundsOfInstances(local, matrixData);
    this.gpuBytes += bytes;
    return {
      vao,
      buffers,
      mode,
      count: indices.length,
      instances: matrixData.length / 16,
      color,
      transparent: color[3] < 0.999,
      bounds,
      instanceBuffer,
      objectBuffer,
      bytes,
    };
  }

  private addInstances(key: string, matrices: Float32Array, objects: Uint32Array): void {
    const def = this.definitions.get(key);
    if (!def) return;
    const gl = this.gl;
    const m = new Float32Array(def.matrices.length + matrices.length);
    m.set(def.matrices);
    m.set(matrices, def.matrices.length);
    const o = new Uint32Array(def.objects.length + objects.length);
    o.set(def.objects);
    o.set(objects, def.objects.length);
    def.matrices = m;
    def.objects = o;
    def.count = o.length;
    if (def.items.length === 0) {
      def.parts.forEach((p) => {
        const item = this.createItem(p.positions, p.normals, p.indices, p.kind === "lines" ? gl.LINES : gl.TRIANGLES, p.color, def.objects, true, def.matrices);
        def.items.push(item);
        this.register(item, p.kind === "lines");
      });
    } else {
      def.items.forEach((item, i) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, item.instanceBuffer!);
        gl.bufferData(gl.ARRAY_BUFFER, def.matrices, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, item.objectBuffer!);
        gl.bufferData(gl.ARRAY_BUFFER, def.objects, gl.DYNAMIC_DRAW);
        this.gpuBytes += matrices.byteLength + objects.byteLength;
        item.instances = def.count;
        item.bounds = boundsOfInstances(def.partBounds[i]!, def.matrices);
        this.sceneBounds = unionBounds(this.sceneBounds, item.bounds);
      });
      this.camera.sceneBounds = this.sceneBounds;
    }
  }

  /** Performs queued uploads within the time budget; returns true when work remains. */
  processUploads(budgetMs = this.options.uploadBudgetMs): boolean {
    if (this.lost) return false;
    const deadline = performance.now() + budgetMs;
    let did = false;
    while (this.uploads.length > 0 && (performance.now() < deadline || !did)) {
      this.uploads.shift()!();
      did = true;
    }
    if (did) this.dirty = true;
    if (did && this.uploads.length === 0) this.onUploadsIdle?.();
    return this.uploads.length > 0;
  }

  /** Removes all geometry (keeps the context). */
  clearGeometry(): void {
    const gl = this.gl;
    const release = (item: DrawItem): void => {
      gl.deleteVertexArray(item.vao);
      for (const b of item.buffers) gl.deleteBuffer(b);
    };
    for (const item of [...this.opaque, ...this.transparent, ...this.lines]) release(item);
    this.opaque = [];
    this.transparent = [];
    this.lines = [];
    this.definitions.clear();
    this.uploads.length = 0;
    this.gpuBytes = 0;
    this.sceneBounds = emptyBounds();
    this.camera.sceneBounds = undefined;
    this.stateData.fill(0);
    this.stateDirty = true;
    this.requestRender();
  }

  // ------------------------------------------------------------- frame

  requestRender(): void {
    this.dirty = true;
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const more = this.processUploads();
      if (this.dirty) this.render();
      if (more) this.requestRender();
    });
  }

  /** Resizes the drawing buffer to the canvas' CSS size. */
  resize(): boolean {
    const dpr = Math.min(this.options.maxPixelRatio, globalThis.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.requestRender();
      return true;
    }
    return false;
  }

  get aspect(): number {
    return this.canvas.width / Math.max(1, this.canvas.height);
  }

  private uploadState(): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.stateTexture);
    if (this.stateDirty) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, STATE_WIDTH, this.stateData.length / STATE_WIDTH, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, this.stateData);
      this.stateDirty = false;
    }
  }

  private setCommonUniforms(p: ProgramInfo, viewProj: Mat4): void {
    const gl = this.gl;
    gl.useProgram(p.program);
    gl.uniformMatrix4fv(p.uniforms.uViewProj!, false, toF32(viewProj));
    gl.uniform1i(p.uniforms.uState!, 0);
    gl.uniform1i(p.uniforms.uStateWidth!, STATE_WIDTH);
    const clip = new Float32Array(MAX_CLIP_PLANES * 4);
    this.clipPlanes.forEach((c, i) => clip.set([c.normal[0], c.normal[1], c.normal[2], c.distance], i * 4));
    gl.uniform4fv(p.uniforms.uClip!, clip);
    gl.uniform1i(p.uniforms.uClipCount!, this.clipPlanes.length);
  }

  private frustum(viewProj: Mat4): Float64Array {
    // rows of the column-major matrix
    const m = viewProj;
    const r = (i: number): [number, number, number, number] => [m[i]!, m[4 + i]!, m[8 + i]!, m[12 + i]!];
    const r0 = r(0), r1 = r(1), r2 = r(2), r3 = r(3);
    const planes = new Float64Array(24);
    const combos = [
      [1, r0], [-1, r0], [1, r1], [-1, r1], [1, r2], [-1, r2],
    ] as const;
    combos.forEach(([s, row], k) => {
      planes[k * 4] = r3[0] + s * row[0];
      planes[k * 4 + 1] = r3[1] + s * row[1];
      planes[k * 4 + 2] = r3[2] + s * row[2];
      planes[k * 4 + 3] = r3[3] + s * row[3];
    });
    return planes;
  }

  private visible(b: Bounds3, planes: Float64Array): boolean {
    if (isEmptyBounds(b)) return false;
    for (let k = 0; k < 6; k++) {
      const a = planes[k * 4]!, bb = planes[k * 4 + 1]!, c = planes[k * 4 + 2]!, d = planes[k * 4 + 3]!;
      const x = a >= 0 ? b.maxX : b.minX;
      const y = bb >= 0 ? b.maxY : b.minY;
      const z = c >= 0 ? b.maxZ : b.minZ;
      if (a * x + bb * y + c * z + d < 0) return false;
    }
    return true;
  }

  render(): void {
    if (this.disposed || this.lost) return;
    const gl = this.gl;
    this.dirty = false;
    this.resize();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const [br, bg, bb] = this.background;
    gl.clearColor(br, bg, bb, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const viewProj = this.camera.viewProjection(this.aspect);
    const planes = this.frustum(viewProj);
    this.uploadState();
    const p = this.meshProgram;
    this.setCommonUniforms(p, viewProj);
    gl.uniform4fv(p.uniforms.uHighlight!, this.highlight);
    gl.uniform3f(p.uniforms.uEye!, this.camera.eye[0], this.camera.eye[1], this.camera.eye[2]);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    this.drawCalls = 0;
    this.trianglesDrawn = 0;
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1, 1);
    gl.uniform1i(p.uniforms.uUnlit!, 0);
    for (const item of this.opaque) this.draw(item, planes);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.uniform1i(p.uniforms.uUnlit!, 1);
    for (const item of this.lines) this.draw(item, planes);
    gl.uniform1i(p.uniforms.uUnlit!, 0);
    if (this.transparent.length > 0) {
      const eye = this.camera.eye;
      const dist = (b: Bounds3): number => (eye[0] - (b.minX + b.maxX) / 2) ** 2 + (eye[1] - (b.minY + b.maxY) / 2) ** 2 + (eye[2] - (b.minZ + b.maxZ) / 2) ** 2;
      const sorted = [...this.transparent].sort((a, b) => dist(b.bounds) - dist(a.bounds));
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      for (const item of sorted) this.draw(item, planes);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
    gl.bindVertexArray(null);
    this.onRender?.();
  }

  private draw(item: DrawItem, planes: Float64Array): void {
    if (item.instances === 0 || !this.visible(item.bounds, planes)) return;
    const gl = this.gl;
    gl.uniform4fv(this.meshProgram.uniforms.uColor!, item.color);
    gl.bindVertexArray(item.vao);
    gl.drawElementsInstanced(item.mode, item.count, gl.UNSIGNED_INT, 0, item.instances);
    this.drawCalls++;
    if (item.mode === gl.TRIANGLES) this.trianglesDrawn += (item.count / 3) * item.instances;
  }

  // ------------------------------------------------------------ picking

  private ensurePickTargets(): void {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    if (this.pickFbo && this.pickSize[0] === w && this.pickSize[1] === h) return;
    for (const t of this.pickTargets) {
      if (t instanceof WebGLTexture) gl.deleteTexture(t);
      else gl.deleteRenderbuffer(t);
    }
    if (this.pickFbo) gl.deleteFramebuffer(this.pickFbo);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    const targets: (WebGLTexture | WebGLRenderbuffer)[] = [];
    for (let i = 0; i < 2; i++) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32UI, w, h);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tex, 0);
      targets.push(tex);
    }
    const depth = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    targets.push(depth);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.pickFbo = fbo;
    this.pickTargets = targets;
    this.pickSize = [w, h];
  }

  /** Picks the object under a canvas CSS pixel position. */
  pick(cssX: number, cssY: number): PickResult {
    if (this.lost || this.disposed) return { objectIndex: 0 };
    const gl = this.gl;
    this.resize();
    this.ensurePickTargets();
    const sx = this.canvas.width / Math.max(1, this.canvas.clientWidth);
    const sy = this.canvas.height / Math.max(1, this.canvas.clientHeight);
    const x = Math.floor(cssX * sx);
    const y = Math.floor(this.canvas.height - 1 - cssY * sy);
    if (x < 0 || y < 0 || x >= this.canvas.width || y >= this.canvas.height) return { objectIndex: 0 };
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x, y, 1, 1);
    gl.clearBufferuiv(gl.COLOR, 0, new Uint32Array([0, 0, 0, 0]));
    gl.clearBufferuiv(gl.COLOR, 1, new Uint32Array([0, 0, 0, 0]));
    gl.clearBufferfv(gl.DEPTH, 0, new Float32Array([1]));
    const viewProj = this.camera.viewProjection(this.aspect);
    this.uploadState();
    this.setCommonUniforms(this.pickProgram, viewProj);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    const planes = this.frustum(viewProj);
    for (const item of [...this.opaque, ...this.transparent]) {
      if (item.instances === 0 || !this.visible(item.bounds, planes)) continue;
      gl.bindVertexArray(item.vao);
      gl.drawElementsInstanced(item.mode, item.count, gl.UNSIGNED_INT, 0, item.instances);
    }
    gl.bindVertexArray(null);
    const id = new Uint32Array(4);
    const depth = new Uint32Array(4);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(x, y, 1, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, id);
    gl.readBuffer(gl.COLOR_ATTACHMENT1);
    gl.readPixels(x, y, 1, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, depth);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const objectIndex = id[0]!;
    if (objectIndex === 0) return { objectIndex: 0 };
    const z = new Float32Array(new Uint32Array([depth[0]!]).buffer)[0]!;
    const inv = this.camera.inverseViewProjection(this.aspect);
    let point: Vec3 | undefined;
    if (inv) {
      const nx = ((x + 0.5) / this.canvas.width) * 2 - 1;
      const ny = ((y + 0.5) / this.canvas.height) * 2 - 1;
      const nz = z * 2 - 1;
      const w = inv[3]! * nx + inv[7]! * ny + inv[11]! * nz + inv[15]!;
      point = [
        (inv[0]! * nx + inv[4]! * ny + inv[8]! * nz + inv[12]!) / w,
        (inv[1]! * nx + inv[5]! * ny + inv[9]! * nz + inv[13]!) / w,
        (inv[2]! * nx + inv[6]! * ny + inv[10]! * nz + inv[14]!) / w,
      ];
    }
    this.requestRender();
    return point ? { objectIndex, point } : { objectIndex };
  }

  /** Reads back the current frame as RGBA bytes (tests / screenshots). */
  readPixels(): { width: number; height: number; data: Uint8Array } {
    this.render();
    const gl = this.gl;
    const data = new Uint8Array(this.canvas.width * this.canvas.height * 4);
    gl.readPixels(0, 0, this.canvas.width, this.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return { width: this.canvas.width, height: this.canvas.height, data };
  }

  dispose(): void {
    if (this.disposed) return;
    if (!this.lost) this.clearGeometry();
    this.disposed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    const gl = this.gl;
    if (!this.lost) {
      gl.deleteProgram(this.meshProgram.program);
      gl.deleteProgram(this.pickProgram.program);
      if (this.stateTexture) gl.deleteTexture(this.stateTexture);
      if (this.pickFbo) gl.deleteFramebuffer(this.pickFbo);
      for (const t of this.pickTargets) {
        if (t instanceof WebGLTexture) gl.deleteTexture(t);
        else gl.deleteRenderbuffer(t);
      }
    }
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    // Release the context eagerly so many viewer instances do not exhaust the browser limit.
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

/** Render-space bounds of local bounds under a set of instance matrices. */
function boundsOfInstances(local: Bounds3, matrices: Float32Array): Bounds3 {
  const out = emptyBounds();
  if (isEmptyBounds(local)) return out;
  for (let k = 0; k < matrices.length; k += 16) {
    for (let i = 0; i < 8; i++) {
      const x = i & 1 ? local.maxX : local.minX;
      const y = i & 2 ? local.maxY : local.minY;
      const z = i & 4 ? local.maxZ : local.minZ;
      expandPoint(
        out,
        matrices[k]! * x + matrices[k + 4]! * y + matrices[k + 8]! * z + matrices[k + 12]!,
        matrices[k + 1]! * x + matrices[k + 5]! * y + matrices[k + 9]! * z + matrices[k + 13]!,
        matrices[k + 2]! * x + matrices[k + 6]! * y + matrices[k + 10]! * z + matrices[k + 14]!,
      );
    }
  }
  return out;
}
