// SPDX-License-Identifier: Apache-2.0
/**
 * Pointer / wheel / touch navigation for the orbit camera.
 *  primary drag: orbit (around the picked point) · middle/right drag or
 *  shift+primary drag: pan · wheel/pinch: zoom towards the cursor ·
 *  click: select (ctrl/cmd toggle, shift add) · double click: fit.
 */

import type { Vec3 } from "../math/mat4.ts";
import type { Renderer } from "./renderer.ts";

export interface ControlCallbacks {
  onClick(objectIndex: number, mode: "replace" | "add" | "toggle"): void;
  onDoubleClick(objectIndex: number): void;
  onInteraction(): void;
  /** The orbit anchor changed: a point in render space while orbiting, undefined when idle. */
  onPivot?(point: Vec3 | undefined): void;
}

const DRAG_THRESHOLD = 4;

export class NavigationControls {
  private readonly renderer: Renderer;
  private readonly canvas: HTMLCanvasElement;
  private readonly callbacks: ControlCallbacks;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private mode: "none" | "orbit" | "pan" = "none";
  private start = { x: 0, y: 0 };
  private dragging = false;
  private pivotPoint: Vec3 | undefined;
  private pinch: { dist: number; mid: { x: number; y: number } } | undefined;
  private lastWheelPick = 0;
  private wheelFocus: Vec3 | undefined;
  enabled = true;
  private readonly listeners: [string, EventListener, AddEventListenerOptions?][] = [];

  constructor(renderer: Renderer, callbacks: ControlCallbacks) {
    this.renderer = renderer;
    this.canvas = renderer.canvas;
    this.callbacks = callbacks;
    this.listen("pointerdown", (e) => this.down(e as PointerEvent));
    this.listen("pointermove", (e) => this.move(e as PointerEvent));
    this.listen("pointerup", (e) => this.up(e as PointerEvent));
    this.listen("pointercancel", (e) => this.cancel(e as PointerEvent));
    this.listen("wheel", (e) => this.wheel(e as WheelEvent), { passive: false });
    this.listen("dblclick", (e) => this.dblclick(e as MouseEvent));
    this.listen("contextmenu", (e) => e.preventDefault());
    this.canvas.style.touchAction = "none";
  }

  private listen(type: string, fn: EventListener, options?: AddEventListenerOptions): void {
    this.canvas.addEventListener(type, fn, options);
    this.listeners.push([type, fn, options]);
  }

  dispose(): void {
    for (const [type, fn, options] of this.listeners) this.canvas.removeEventListener(type, fn, options);
    this.listeners.length = 0;
  }

  private local(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private down(e: PointerEvent): void {
    if (!this.enabled) return;
    this.canvas.setPointerCapture?.(e.pointerId);
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y), mid: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 } };
      this.mode = "none";
      this.dragging = true;
      return;
    }
    this.start = p;
    this.dragging = false;
    this.setPivot(undefined);
    this.mode = e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey) ? "pan" : "orbit";
  }

  private move(e: PointerEvent): void {
    if (!this.enabled || !this.pointers.has(e.pointerId)) return;
    const p = this.local(e);
    const prev = this.pointers.get(e.pointerId)!;
    this.pointers.set(e.pointerId, p);
    const cam = this.renderer.camera;
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      const mid = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
      if (dist > 0 && this.pinch.dist > 0) cam.zoom(this.pinch.dist / dist);
      cam.pan(mid.x - this.pinch.mid.x, mid.y - this.pinch.mid.y, this.canvas.clientHeight);
      this.pinch = { dist, mid };
      this.changed();
      return;
    }
    if (!this.dragging) {
      if (Math.hypot(p.x - this.start.x, p.y - this.start.y) < DRAG_THRESHOLD) return;
      this.dragging = true;
      if (this.mode === "orbit") this.setPivot(this.renderer.pick(this.start.x, this.start.y).point ?? [...this.renderer.camera.target]);
    }
    const dx = p.x - prev.x, dy = p.y - prev.y;
    if (this.mode === "orbit") {
      cam.orbit(-dx * 0.006, dy * 0.006, this.pivotPoint ?? cam.target);
    } else if (this.mode === "pan") {
      cam.pan(dx, dy, this.canvas.clientHeight);
    }
    this.changed();
  }

  private up(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = undefined;
    if (this.pointers.size > 0) return;
    const wasDrag = this.dragging;
    this.mode = "none";
    this.dragging = false;
    this.setPivot(undefined);
    if (!wasDrag && this.enabled && e.button === 0) {
      const p = this.local(e);
      const hit = this.renderer.pick(p.x, p.y);
      const mode = e.ctrlKey || e.metaKey ? "toggle" : e.shiftKey ? "add" : "replace";
      this.callbacks.onClick(hit.objectIndex, mode);
    }
  }

  private cancel(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    this.pinch = undefined;
    this.mode = "none";
    this.dragging = false;
    this.setPivot(undefined);
  }

  /** Current orbit anchor in render space, or undefined while not orbiting. */
  get pivot(): Vec3 | undefined {
    return this.pivotPoint;
  }

  private setPivot(point: Vec3 | undefined): void {
    if (point === this.pivotPoint) return;
    this.pivotPoint = point;
    this.callbacks.onPivot?.(point);
  }

  private wheel(e: WheelEvent): void {
    if (!this.enabled) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const delta = Math.max(-400, Math.min(400, e.deltaY * unit));
    const now = performance.now();
    if (now - this.lastWheelPick > 200) {
      const p = this.local(e);
      this.wheelFocus = this.renderer.pick(p.x, p.y).point;
      this.lastWheelPick = now;
    }
    this.renderer.camera.zoom(Math.exp(delta * 0.0012), this.wheelFocus);
    this.changed();
  }

  private dblclick(e: MouseEvent): void {
    if (!this.enabled) return;
    const p = this.local(e);
    this.callbacks.onDoubleClick(this.renderer.pick(p.x, p.y).objectIndex);
  }

  private changed(): void {
    this.renderer.requestRender();
    this.callbacks.onInteraction();
  }
}
