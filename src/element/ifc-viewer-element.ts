// SPDX-License-Identifier: Apache-2.0
/**
 * <ifc-viewer>: Shadow-DOM custom element wrapping IfcViewer with a tool
 * rail, spatial tree, property inspector, section tool and status strip.
 * It defines no global styles and keeps all state per instance.
 */

import type { IfcDiagnostic } from "../diagnostics.ts";
import type { EntitySummary } from "../ifc/model.ts";
import type { PropertyGroup } from "../ifc/properties.ts";
import { isEmptyBounds } from "../math/bounds.ts";
import type { Vec3 } from "../math/mat4.ts";
import {
  IfcViewer,
  type ClipPlane,
  type FitOptions,
  type IfcSource,
  type LoadOptions,
  type ModelHandle,
  type SelectOptions,
} from "../core/viewer.ts";
import { ICONS } from "./icons.ts";
import { PropertiesView } from "./properties-view.ts";
import { VIEWER_CSS } from "./styles.ts";
import { TreeView } from "./tree-view.ts";
import { ViewCube } from "./view-cube.ts";

const TEMPLATE = `
<div class="root" part="root" data-ui="full">
  <div class="viewport" part="viewport">
    <canvas part="canvas" tabindex="0" aria-label="3D model view"></canvas>
    <div class="overlay empty" part="empty"><p><strong>No model loaded.</strong> Drop an .ifc file here or choose Open.<br><span class="muted">New to the viewer? Open Help, bottom right.</span></p></div>
    <div class="overlay error" hidden><div class="error-card" role="alert" part="error"><h2>Could not open the model</h2><p class="error-text"></p><button type="button" class="dismiss">Dismiss</button></div></div>
    <nav class="toolbar" part="toolbar" aria-label="Viewer tools">
      <button class="tool" type="button" data-action="open" aria-label="Open IFC file" title="Open IFC file">${ICONS.open}</button>
      <hr>
      <button class="tool" type="button" data-action="fit" aria-label="Fit model (F)" title="Fit model (F)">${ICONS.fit}</button>
      <button class="tool" type="button" data-action="fit-selection" aria-label="Fit selection" title="Fit selection" disabled>${ICONS.fitSelection}</button>
      <button class="tool" type="button" data-action="top" aria-label="Top view" title="Top view">${ICONS.top}</button>
      <button class="tool" type="button" data-action="iso" aria-label="Isometric view" title="Isometric view">${ICONS.iso}</button>
      <hr>
      <button class="tool" type="button" data-action="hide" aria-label="Hide selection (H)" title="Hide selection (H)" disabled>${ICONS.hide}</button>
      <button class="tool" type="button" data-action="isolate" aria-label="Isolate selection (I)" title="Isolate selection (I)" disabled>${ICONS.isolate}</button>
      <button class="tool" type="button" data-action="show-all" aria-label="Show all (A)" title="Show all (A)">${ICONS.showAll}</button>
      <hr>
      <button class="tool" type="button" data-action="section" aria-label="Section plane (C)" title="Section plane (C)" aria-pressed="false">${ICONS.section}</button>
      <button class="tool" type="button" data-action="sidebar" aria-label="Model panel" title="Model panel" aria-pressed="true">${ICONS.sidebar}</button>
    </nav>
    <div class="clip-panel" part="clip-panel" hidden role="group" aria-label="Section plane">
      <fieldset><legend>Section axis</legend>
        <button type="button" class="axis" data-axis="x" aria-pressed="false">X</button>
        <button type="button" class="axis" data-axis="y" aria-pressed="false">Y</button>
        <button type="button" class="axis" data-axis="z" aria-pressed="true">Z</button>
      </fieldset>
      <input type="range" min="0" max="1000" value="500" aria-label="Section position">
      <div>
        <button type="button" class="tool" data-action="flip" aria-label="Flip section side" title="Flip section side">${ICONS.flip}</button>
      </div>
    </div>
    <div class="pivot" part="pivot" data-active="false" aria-hidden="true"></div>
    <button class="help-button" type="button" part="help-button" data-action="help" aria-expanded="false" aria-controls="help-panel" title="How to use this viewer (?)">${ICONS.help}<span>Help</span></button>
    <div class="help-panel" part="help-panel" id="help-panel" role="dialog" aria-modal="false" aria-label="How to use this viewer" tabindex="-1" hidden>
      <header><h2>How to use</h2><button type="button" class="tool close" data-action="help-close" aria-label="Close help">${ICONS.close}</button></header>
      <div class="help-scroll">
        <h3>Move around</h3>
        <dl>
          <dt>Drag</dt><dd>Orbit around the marked point under the cursor</dd>
          <dt>Middle or right drag</dt><dd>Pan, as does Shift&nbsp;+&nbsp;drag</dd>
          <dt>Scroll</dt><dd>Zoom towards the cursor</dd>
          <dt>Double click</dt><dd>Zoom to that element</dd>
          <dt>Cube, top right</dt><dd>Click a face, edge or corner for a straight-on view</dd>
          <dt class="touch-only">Touch</dt><dd class="touch-only">One finger orbits, two pinch and pan</dd>
        </dl>
        <h3>Inspect</h3>
        <dl>
          <dt>Click</dt><dd>Select; Ctrl/Cmd click toggles, Shift click adds</dd>
          <dt>Model panel</dt><dd>Browse the spatial tree, search it, read properties</dd>
          <dt>Eye icon</dt><dd>Hide one element or a whole storey</dd>
          <dt>Tool rail, top left</dt><dd>Fit, views, hide, isolate, show all, section plane</dd>
        </dl>
        <h3>Keys, with the view focused</h3>
        <ul class="keys">
          <li><kbd>F</kbd> Fit</li>
          <li><kbd>H</kbd> Hide</li>
          <li><kbd>I</kbd> Isolate</li>
          <li><kbd>A</kbd> Show all</li>
          <li><kbd>C</kbd> Section plane</li>
          <li><kbd>Esc</kbd> Clear</li>
          <li><kbd>&larr;</kbd><kbd>&rarr;</kbd><kbd>&uarr;</kbd><kbd>&darr;</kbd> Orbit</li>
          <li><kbd>+</kbd><kbd>&minus;</kbd> Zoom</li>
          <li><kbd>?</kbd> This help</li>
        </ul>
        <h3>Open a model</h3>
        <p>Drop an <code>.ifc</code> or <code>.ifczip</code> file on the view, or use the folder button. Files stay in your browser.</p>
      </div>
    </div>
  </div>
  <aside class="sidebar" part="sidebar" aria-label="Model">
    <section class="panel" part="tree">
      <header><h2 id="tree-heading">Model</h2><span class="meta tree-meta"></span></header>
      <input class="search" type="search" placeholder="Search by name, type or ID" aria-label="Search elements">
      <div class="scroll"><ul class="tree" aria-labelledby="tree-heading"></ul></div>
    </section>
    <section class="panel" part="properties">
      <header><h2 id="props-heading">Properties</h2><span class="meta props-meta"></span></header>
      <div class="scroll"><div class="props" aria-labelledby="props-heading"></div></div>
    </section>
  </aside>
  <div class="status" part="status">
    <span class="text" role="status" aria-live="polite">Ready</span>
    <span class="counts"></span>
    <span class="tape" role="progressbar" aria-label="Loading progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" hidden><span class="fill"></span></span>
  </div>
  <input class="file" type="file" accept=".ifc,.ifczip,.IFC" hidden>
</div>`;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const hasSheets = typeof CSSStyleSheet !== "undefined" && "replaceSync" in CSSStyleSheet.prototype;
let sharedSheet: CSSStyleSheet | undefined;

export class IfcViewerElement extends HTMLElement {
  static readonly observedAttributes = ["src", "ui", "theme", "autofit", "credentials", "render-backend", "worker-url"];

  private readonly shadow: ShadowRoot;
  private core: IfcViewer | undefined;
  private tree!: TreeView;
  private cube: ViewCube | undefined;
  private props!: PropertiesView;
  private readonly $ = <T extends Element>(sel: string): T => this.shadow.querySelector<T>(sel)!;
  private clipAxis: "x" | "y" | "z" = "z";
  private clipFlip = false;
  private clipEnabled = false;
  private disposeTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private loadedName = "";
  private diagnosticCount = 0;
  private descendantCache = new Map<number, number[]>();
  private initError: Error | undefined;
  private pivotPoint: Vec3 | null = null;
  private colorScheme: MediaQueryList | undefined;
  private readonly onColorScheme = (): void => this.syncTheme();

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: "open" });
    if (hasSheets) {
      sharedSheet ??= (() => {
        const s = new CSSStyleSheet();
        s.replaceSync(VIEWER_CSS);
        return s;
      })();
      this.shadow.adoptedStyleSheets = [sharedSheet];
      this.shadow.innerHTML = TEMPLATE;
    } else {
      this.shadow.innerHTML = `<style>${VIEWER_CSS}</style>${TEMPLATE}`;
    }
  }

  // ------------------------------------------------------------ lifecycle

  connectedCallback(): void {
    if (this.disposeTimer !== undefined) {
      clearTimeout(this.disposeTimer);
      this.disposeTimer = undefined;
    }
    if (this.disposed) return;
    if (!this.hasAttribute("theme")) this.setAttribute("theme", "auto");
    try {
      this.ensureCore();
    } catch {
      return; // reported by ensureCore
    }
    const src = this.getAttribute("src");
    if (src && this.loadedName !== src) void this.loadSrc(src);
  }

  disconnectedCallback(): void {
    // Moving the element within the document must not destroy the model.
    this.disposeTimer = setTimeout(() => {
      if (!this.isConnected) void this.dispose();
    }, 0);
  }

  attributeChangedCallback(name: string, oldValue: string | null, value: string | null): void {
    if (oldValue === value) return;
    switch (name) {
      case "src":
        if (this.core && value) void this.loadSrc(value);
        else if (this.core && !value) void this.unload();
        break;
      case "ui":
        this.$<HTMLElement>(".root").dataset.ui = value === "minimal" || value === "none" ? value : "full";
        break;
      case "theme":
        requestAnimationFrame(() => this.syncTheme());
        break;
      case "render-backend":
        if (value && value !== "webgl2" && value !== "auto") {
          this.dispatch("ifc-error", { fatal: false, error: new Error(`render-backend "${value}" is not available; using webgl2`) });
        }
        break;
      default:
        break;
    }
  }

  private ensureCore(): IfcViewer {
    if (this.core) return this.core;
    if (this.initError) throw this.initError;
    const canvas = this.$<HTMLCanvasElement>("canvas");
    const workerUrl = this.getAttribute("worker-url");
    try {
      this.core = new IfcViewer({ canvas, ...(workerUrl ? { workerUrl: new URL(workerUrl, document.baseURI) } : {}) });
    } catch (e) {
      // Typically: no WebGL2. Explain it in the UI and through ifc-error.
      const error = e instanceof Error ? e : new Error(String(e));
      this.initError = error;
      this.$<HTMLElement>(".overlay.empty").hidden = true;
      this.$<HTMLElement>(".error-card h2").textContent = "The 3D view cannot start";
      this.$<HTMLElement>(".error-text").textContent = `${error.message}. Enable hardware acceleration or use a browser with WebGL2 support.`;
      this.$<HTMLElement>(".overlay.error").hidden = false;
      this.setStatus(error.message, "error");
      queueMicrotask(() => this.dispatch("ifc-error", { fatal: true, error }));
      throw error;
    }
    this.tree = new TreeView(this.$<HTMLUListElement>(".tree"), {
      select: (id, mode) => this.select(id, { mode }),
      fit: (id) => void this.fit([id]),
      setVisible: (id, visible) => (visible ? this.show([id]) : this.hide([id])),
      isVisible: (id) => this.nodeVisible(id),
    });
    this.props = new PropertiesView(this.$<HTMLElement>(".props"));
    this.cube = new ViewCube({ select: (direction) => void this.core!.viewFrom(direction) });
    this.$<HTMLElement>(".viewport").append(this.cube.root);
    const renderer = this.core.renderer;
    renderer.onRender = () => {
      this.cube?.update(renderer.camera.view());
      this.drawPivot();
    };
    this.cube.update(renderer.camera.view());
    this.core.onOrbitPivot = (point) => {
      this.pivotPoint = point;
      if (point) this.drawPivot();
      else this.$<HTMLElement>(".pivot").dataset.active = "false";
    };
    this.wireCore(this.core);
    this.wireUi();
    this.syncTheme();
    if (typeof matchMedia === "function") {
      this.colorScheme = matchMedia("(prefers-color-scheme: dark)");
      this.colorScheme.addEventListener?.("change", this.onColorScheme);
    }
    return this.core;
  }

  /** Feeds the themed CSS colours (background, accent) to the WebGL renderer. */
  private syncTheme(): void {
    const core = this.core;
    if (!core || typeof getComputedStyle !== "function") return;
    const parse = (css: string): [number, number, number] | undefined => {
      const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(css);
      return m ? [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255] : undefined;
    };
    const bg = parse(getComputedStyle(this.$<HTMLElement>(".viewport")).backgroundColor);
    if (bg) core.renderer.setBackground([bg[0], bg[1], bg[2], 1]);
    const probe = this.$<HTMLElement>(".tape .fill");
    const accent = parse(getComputedStyle(probe).backgroundColor);
    if (accent) core.renderer.setHighlight([accent[0], accent[1], accent[2], 0.7]);
  }

  private dispatch(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  private wireCore(core: IfcViewer): void {
    const forward = [
      "ifc-load-start", "ifc-progress", "ifc-model-ready", "ifc-geometry-progress", "ifc-load",
      "ifc-selection-change", "ifc-visibility-change", "ifc-diagnostic", "ifc-resource-limit", "ifc-error", "ifc-unload",
    ];
    for (const type of forward) core.addEventListener(type, (e: Event) => this.dispatch(type, (e as CustomEvent).detail));
    core.addEventListener("ifc-load-start", () => {
      this.$<HTMLElement>(".overlay.error").hidden = true;
      this.$<HTMLElement>(".overlay.empty").hidden = true;
      this.tree.clear();
      this.props.showHint("Loading…");
      this.diagnosticCount = 0;
      this.setStatus("Opening file…");
      this.setProgress(0);
    });
    core.addEventListener("ifc-progress", (e) => {
      const { phase, completed, total } = e.detail;
      const t = total ?? 0;
      if (phase === "parse") {
        this.setStatus(t ? `Reading ${formatBytes(completed)} of ${formatBytes(t)}` : `Reading ${formatBytes(completed)}`);
        this.setProgress(t ? (completed / t) * 0.45 : 0.2);
      } else if (phase === "index") {
        this.setStatus("Indexing entities and relationships");
        this.setProgress(0.5);
      } else if (phase === "geometry") {
        this.setStatus(`Building geometry: ${completed} of ${t} elements`);
        this.setProgress(0.5 + (t ? completed / t : 0) * 0.5);
      }
    });
    core.addEventListener("ifc-model-ready", () => {
      const md = core.model!;
      this.descendantCache.clear();
      this.tree.setModel(md.tree);
      this.$<HTMLElement>(".tree-meta").textContent = `${md.schema}, ${md.productCount} elements`;
      this.props.showHint("Select an element in the view or the tree to see its properties.");
    });
    core.addEventListener("ifc-diagnostic", (e) => {
      const d: IfcDiagnostic = e.detail;
      if (d.severity !== "info") this.diagnosticCount++;
    });
    core.addEventListener("ifc-load", (e) => {
      const s = e.detail.stats;
      this.setProgress(1);
      this.setStatus(
        `${this.loadedName ? `${this.loadedName}: ` : ""}${s.productsWithGeometry} of ${s.products} elements shown` +
          (this.diagnosticCount ? `, ${this.diagnosticCount} issues reported` : ""),
      );
      this.$<HTMLElement>(".counts").textContent = `${s.triangles.toLocaleString()} triangles`;
      setTimeout(() => this.setProgress(undefined), 600);
      if (this.clipEnabled) this.applyClip();
    });
    core.addEventListener("ifc-error", (e) => {
      if (!e.detail.fatal) {
        this.setStatus(e.detail.error.message, "error");
        return;
      }
      this.setProgress(undefined);
      this.setStatus(e.detail.error.message, "error");
      this.$<HTMLElement>(".error-text").textContent = e.detail.error.message;
      this.$<HTMLElement>(".overlay.error").hidden = false;
      if (!core.model) this.$<HTMLElement>(".overlay.empty").hidden = true;
      this.props.showHint("No model loaded.");
    });
    core.addEventListener("ifc-selection-change", (e) => this.onSelection(e.detail.selectedIds));
    core.addEventListener("ifc-visibility-change", () => this.tree.refreshVisibility());
    core.addEventListener("ifc-unload", () => {
      this.tree.clear();
      this.props.showHint("No model loaded.");
      this.$<HTMLElement>(".overlay.empty").hidden = false;
      this.$<HTMLElement>(".tree-meta").textContent = "";
      this.$<HTMLElement>(".counts").textContent = "";
      this.setStatus("Ready");
      this.setProgress(undefined);
    });
  }

  private wireUi(): void {
    const toolbar = this.$<HTMLElement>(".toolbar");
    toolbar.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-action]");
      if (btn) this.action(btn.dataset.action!);
    });
    this.$<HTMLElement>(".clip-panel").addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const axis = target.closest<HTMLButtonElement>("[data-axis]");
      if (axis) {
        this.clipAxis = axis.dataset.axis as "x" | "y" | "z";
        this.shadow.querySelectorAll<HTMLButtonElement>("[data-axis]").forEach((b) => b.setAttribute("aria-pressed", String(b === axis)));
        this.applyClip();
      }
      if (target.closest('[data-action="flip"]')) {
        this.clipFlip = !this.clipFlip;
        this.applyClip();
      }
    });
    this.$<HTMLInputElement>(".clip-panel input").addEventListener("input", () => this.applyClip());
    this.$<HTMLInputElement>(".search").addEventListener("input", (e) => this.tree.setFilter((e.target as HTMLInputElement).value));
    this.$<HTMLButtonElement>(".dismiss").addEventListener("click", () => {
      this.$<HTMLElement>(".overlay.error").hidden = true;
      if (!this.core?.model) this.$<HTMLElement>(".overlay.empty").hidden = false;
    });
    const file = this.$<HTMLInputElement>(".file");
    file.addEventListener("change", () => {
      const f = file.files?.[0];
      if (f) void this.load(f).catch(() => undefined);
      file.value = "";
    });
    const canvas = this.$<HTMLCanvasElement>("canvas");
    canvas.addEventListener("keydown", (e) => this.shortcut(e));
    canvas.addEventListener("pointerdown", () => this.toggleHelp(false));
    this.$<HTMLButtonElement>(".help-button").addEventListener("click", () => this.toggleHelp());
    const help = this.$<HTMLElement>(".help-panel");
    help.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest('[data-action="help-close"]')) this.toggleHelp(false);
    });
    help.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.toggleHelp(false);
      }
    });
    const viewport = this.$<HTMLElement>(".viewport");
    viewport.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        viewport.dataset.drop = "true";
      }
    });
    viewport.addEventListener("dragleave", () => delete viewport.dataset.drop);
    viewport.addEventListener("drop", (e) => {
      delete viewport.dataset.drop;
      const f = e.dataTransfer?.files?.[0];
      if (f) {
        e.preventDefault();
        void this.load(f).catch(() => undefined);
      }
    });
  }

  private action(name: string): void {
    const core = this.ensureCore();
    const sel = core.selection;
    switch (name) {
      case "open":
        this.$<HTMLInputElement>(".file").click();
        break;
      case "fit":
        void core.fit();
        break;
      case "fit-selection":
        if (sel.length) void core.fit(sel);
        break;
      case "top":
      case "iso":
        void core.viewPreset(name);
        break;
      case "hide":
        if (sel.length) {
          core.hide(sel);
          core.clearSelection();
        }
        break;
      case "isolate":
        if (sel.length) this.isolate(sel);
        break;
      case "show-all":
        core.showAll();
        break;
      case "section":
        this.toggleClip();
        break;
      case "help":
        this.toggleHelp();
        break;
      case "help-close":
        this.toggleHelp(false);
        break;
      case "sidebar": {
        const root = this.$<HTMLElement>(".root");
        const open = root.dataset.sidebar === "closed";
        root.dataset.sidebar = open ? "open" : "closed";
        this.$<HTMLElement>('[data-action="sidebar"]').setAttribute("aria-pressed", String(open));
        requestAnimationFrame(() => core.renderer.requestRender());
        break;
      }
      default:
        break;
    }
  }

  private shortcut(e: KeyboardEvent): void {
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    const core = this.ensureCore();
    const sel = core.selection;
    let handled = true;
    switch (e.key) {
      case "f":
      case "F":
        void core.fit(sel.length ? sel : undefined);
        break;
      case "Escape":
        if (this.helpOpen) this.toggleHelp(false);
        else if (this.clipEnabled) this.toggleClip(false);
        else core.clearSelection();
        break;
      case "?":
        this.toggleHelp();
        break;
      case "h":
      case "H":
        this.action("hide");
        break;
      case "i":
      case "I":
        this.action("isolate");
        break;
      case "a":
      case "A":
        core.showAll();
        break;
      case "c":
      case "C":
        this.toggleClip();
        break;
      case "ArrowLeft":
        core.renderer.camera.orbit(0.1, 0);
        break;
      case "ArrowRight":
        core.renderer.camera.orbit(-0.1, 0);
        break;
      case "ArrowUp":
        core.renderer.camera.orbit(0, -0.1);
        break;
      case "ArrowDown":
        core.renderer.camera.orbit(0, 0.1);
        break;
      case "+":
      case "=":
        core.renderer.camera.zoom(0.8);
        break;
      case "-":
        core.renderer.camera.zoom(1.25);
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      core.renderer.requestRender();
    }
  }

  private get helpOpen(): boolean {
    return !this.$<HTMLElement>(".help-panel").hidden;
  }

  /** Show or hide the help panel, keeping focus where the user can carry on. */
  private toggleHelp(open = !this.helpOpen): void {
    const panel = this.$<HTMLElement>(".help-panel");
    if (open === !panel.hidden) return;
    const hadFocus = this.shadow.activeElement !== null && panel.contains(this.shadow.activeElement);
    panel.hidden = !open;
    const button = this.$<HTMLButtonElement>(".help-button");
    button.setAttribute("aria-expanded", String(open));
    if (open) panel.focus();
    else if (hadFocus) button.focus();
  }

  /** Position the orbit anchor marker for the current camera. */
  private drawPivot(): void {
    const marker = this.$<HTMLElement>(".pivot");
    const point = this.pivotPoint;
    if (!point || !this.core) {
      marker.dataset.active = "false";
      return;
    }
    const at = this.core.project(point);
    if (!at) {
      marker.dataset.active = "false";
      return;
    }
    marker.style.left = `${at.x}px`;
    marker.style.top = `${at.y}px`;
    marker.dataset.active = "true";
  }

  private toggleClip(force?: boolean): void {
    this.clipEnabled = force ?? !this.clipEnabled;
    this.$<HTMLElement>(".clip-panel").hidden = !this.clipEnabled;
    this.$<HTMLElement>('[data-action="section"]').setAttribute("aria-pressed", String(this.clipEnabled));
    if (this.clipEnabled) this.applyClip();
    else this.core?.setClipPlane(null);
  }

  private applyClip(): void {
    const core = this.core;
    if (!core || !this.clipEnabled) return;
    const b = core.modelBounds();
    if (isEmptyBounds(b)) return;
    const t = Number(this.$<HTMLInputElement>(".clip-panel input").value) / 1000;
    const axisIndex = { x: 0, y: 1, z: 2 }[this.clipAxis];
    const min = [b.minX, b.minY, b.minZ][axisIndex]!;
    const max = [b.maxX, b.maxY, b.maxZ][axisIndex]!;
    const pos = min + (max - min) * t;
    const normal: [number, number, number] = [0, 0, 0];
    normal[axisIndex] = this.clipFlip ? -1 : 1;
    core.setClipPlane({ normal, distance: this.clipFlip ? -pos : pos });
  }

  private setStatus(text: string, kind: "info" | "error" = "info"): void {
    const el = this.$<HTMLElement>(".status .text");
    el.textContent = text;
    el.dataset.kind = kind;
  }

  private setProgress(fraction: number | undefined): void {
    const tape = this.$<HTMLElement>(".tape");
    if (fraction === undefined) {
      tape.hidden = true;
      return;
    }
    tape.hidden = false;
    const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
    tape.setAttribute("aria-valuenow", String(pct));
    this.$<HTMLElement>(".tape .fill").style.width = `${pct}%`;
  }

  private descendants(id: number): number[] {
    let d = this.descendantCache.get(id);
    if (d) return d;
    const byId = new Map((this.core?.tree ?? []).map((n) => [n.id, n]));
    d = [];
    const stack = [id];
    const seen = new Set<number>();
    while (stack.length) {
      const x = stack.pop()!;
      if (seen.has(x)) continue;
      seen.add(x);
      if (this.core?.hasGeometry(x)) d.push(x);
      const n = byId.get(x);
      if (n) stack.push(...n.children);
    }
    this.descendantCache.set(id, d);
    return d;
  }

  private nodeVisible(id: number): boolean {
    const core = this.core;
    if (!core) return true;
    if (core.hasGeometry(id)) return core.isVisible(id);
    const d = this.descendants(id);
    return d.length === 0 || d.some((x) => core.isVisible(x));
  }

  private onSelection(ids: readonly number[]): void {
    const hasSel = ids.length > 0;
    for (const a of ["fit-selection", "hide", "isolate"]) this.$<HTMLButtonElement>(`[data-action="${a}"]`).disabled = !hasSel;
    this.tree.setSelection(ids, true);
    this.$<HTMLElement>(".props-meta").textContent = ids.length > 1 ? `${ids.length} selected` : ids.length === 1 ? `#${ids[0]}` : "";
    if (!hasSel) {
      this.props.showHint("Select an element in the view or the tree to see its properties.");
      return;
    }
    const token = this.props.begin();
    const id = ids[ids.length - 1]!;
    void this.getProperties(id).then(
      (groups) => this.props.render(token, groups, ids.length > 1 ? `${ids.length} elements selected; showing the last one.` : undefined),
      () => this.props.showHint("Properties are unavailable for this element."),
    );
  }

  private async loadSrc(src: string): Promise<void> {
    this.loadedName = src;
    try {
      await this.load(src);
    } catch {
      // reported through ifc-error
    }
  }

  // ------------------------------------------------------------ public API

  /** Underlying renderer-level viewer. */
  get viewer(): IfcViewer {
    return this.ensureCore();
  }

  get src(): string | null {
    return this.getAttribute("src");
  }

  set src(value: string | null) {
    if (value === null) this.removeAttribute("src");
    else this.setAttribute("src", value);
  }

  load(source: IfcSource, options: LoadOptions = {}): Promise<ModelHandle> {
    let core: IfcViewer;
    try {
      core = this.ensureCore();
    } catch (e) {
      return Promise.reject(e);
    }
    if (typeof source === "string") this.loadedName = source.split(/[\\/]/).pop() ?? source;
    else if (typeof File !== "undefined" && source instanceof File) this.loadedName = source.name;
    else this.loadedName = "";
    const credentials = this.getAttribute("credentials");
    const autofit = this.getAttribute("autofit");
    return core.load(source, {
      ...(credentials === "include" || credentials === "omit" || credentials === "same-origin" ? { credentials } : {}),
      ...(autofit === "false" ? { fit: false } : {}),
      ...options,
    });
  }

  unload(): Promise<void> {
    return this.ensureCore().unload();
  }

  select(ids: number | Iterable<number>, options?: SelectOptions): void {
    this.ensureCore().select(ids, options);
  }

  clearSelection(): void {
    this.ensureCore().clearSelection();
  }

  get selection(): number[] {
    return this.core?.selection ?? [];
  }

  hide(ids: Iterable<number>): void {
    this.ensureCore().hide(ids);
  }

  show(ids: Iterable<number>): void {
    this.ensureCore().show(ids);
  }

  isolate(ids: Iterable<number>): void {
    this.ensureCore().isolate(ids);
  }

  showAll(): void {
    this.ensureCore().showAll();
  }

  fit(ids?: Iterable<number>, options?: FitOptions): Promise<void> {
    return this.ensureCore().fit(ids, options);
  }

  setClipPlane(plane: ClipPlane | null): void {
    this.ensureCore().setClipPlane(plane);
  }

  getProperties(id: number): Promise<PropertyGroup[]> {
    return this.ensureCore().getProperties(id);
  }

  getEntity(id: number): Promise<EntitySummary | null> {
    return this.ensureCore().getEntity(id);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.colorScheme?.removeEventListener?.("change", this.onColorScheme);
    await this.core?.dispose();
    this.core = undefined;
  }
}

/** Registers <ifc-viewer> once (safe to call repeatedly). */
export function defineIfcViewer(name = "ifc-viewer"): void {
  if (typeof customElements === "undefined") return;
  if (!customElements.get(name)) customElements.define(name, name === "ifc-viewer" ? IfcViewerElement : class extends IfcViewerElement {});
}

declare global {
  interface HTMLElementTagNameMap {
    "ifc-viewer": IfcViewerElement;
  }
}
