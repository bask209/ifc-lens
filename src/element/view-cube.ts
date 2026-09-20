// SPDX-License-Identifier: Apache-2.0
/**
 * Orientation cube. A CSS 3D cube in the viewport corner, kept in sync with
 * the camera. Each face carries a 3×3 grid of regions: the centre selects the
 * face view, the edges and corners select the 12 edge and 8 corner views, so
 * all 26 standard orientations are reachable with one click. Regions are
 * ordinary buttons with accessible names; faces turned away from the camera
 * are removed from the accessibility tree and the tab order.
 *
 * The cube costs no GPU work: it is DOM, updated with one matrix per frame.
 */

import type { Mat4, Vec3 } from "../math/mat4.ts";

export interface ViewCubeCallbacks {
  /** A view direction was chosen: the camera should look from `direction`. */
  select(direction: Vec3, label: string): void;
}

interface FaceSpec {
  key: string;
  label: string;
  /** Outward normal in world coordinates (model space, Z up). */
  n: Vec3;
  /** Face-local right and down directions in world coordinates. */
  u: Vec3;
  v: Vec3;
}

const SIZE = 78;
const HALF = SIZE / 2;

const FACES: FaceSpec[] = [
  { key: "top", label: "Top", n: [0, 0, 1], u: [1, 0, 0], v: [0, -1, 0] },
  { key: "bottom", label: "Bottom", n: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0] },
  { key: "front", label: "Front", n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { key: "back", label: "Back", n: [0, 1, 0], u: [-1, 0, 0], v: [0, 0, -1] },
  { key: "right", label: "Right", n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, -1] },
  { key: "left", label: "Left", n: [-1, 0, 0], u: [0, -1, 0], v: [0, 0, -1] },
];

/** Direction selected by a face region (column/row 0..2, centre = 1). */
export function regionDirection(face: FaceSpec, col: number, row: number): Vec3 {
  const cu = col - 1;
  const rv = row - 1;
  const d: Vec3 = [
    face.n[0] + face.u[0] * cu + face.v[0] * rv,
    face.n[1] + face.u[1] * cu + face.v[1] * rv,
    face.n[2] + face.u[2] * cu + face.v[2] * rv,
  ];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return [d[0] / l, d[1] / l, d[2] / l];
}

/** "top-front-right" style name of a view direction (model space, Z up). */
export function directionLabel(d: Vec3): string {
  const parts: string[] = [];
  if (d[2] > 0.2) parts.push("top");
  else if (d[2] < -0.2) parts.push("bottom");
  if (d[1] < -0.2) parts.push("front");
  else if (d[1] > 0.2) parts.push("back");
  if (d[0] > 0.2) parts.push("right");
  else if (d[0] < -0.2) parts.push("left");
  return parts.join("-") || "front";
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

export class ViewCube {
  readonly root: HTMLElement;
  private readonly cube: HTMLElement;
  private readonly faces: { spec: FaceSpec; element: HTMLElement; buttons: HTMLButtonElement[] }[] = [];
  private readonly callbacks: ViewCubeCallbacks;
  private lastTransform = "";

  constructor(callbacks: ViewCubeCallbacks) {
    this.callbacks = callbacks;
    this.root = el("div", "cube-scene");
    this.root.setAttribute("role", "group");
    this.root.setAttribute("aria-label", "View orientation");
    this.root.setAttribute("part", "view-cube");
    this.cube = el("div", "cube");
    this.root.append(this.cube);
    for (const spec of FACES) {
      const face = el("div", "cube-face");
      face.dataset.face = spec.key;
      face.style.transform = `matrix3d(${spec.u.join(",")},0,${spec.v.join(",")},0,${spec.n.join(",")},0,${spec.n.map((c) => c * HALF).join(",")},1)`;
      const buttons: HTMLButtonElement[] = [];
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
          const direction = regionDirection(spec, col, row);
          const label = directionLabel(direction);
          const b = el("button", "cube-cell");
          b.type = "button";
          b.dataset.direction = direction.map((c) => c.toFixed(6)).join(",");
          b.dataset.view = label;
          if (col === 1 && row === 1) {
            b.classList.add("cube-cell-face");
            b.textContent = spec.label;
          }
          b.setAttribute("aria-label", `View from ${label.replace(/-/g, " ")}`);
          b.title = `View from ${label.replace(/-/g, " ")}`;
          b.addEventListener("click", () => this.callbacks.select(direction, label));
          buttons.push(b);
          face.append(b);
        }
      }
      this.cube.append(face);
      this.faces.push({ spec, element: face, buttons });
    }
  }

  /**
   * Re-orients the cube from the camera's view matrix. Column i of the CSS
   * matrix is where world axis i lands in CSS space (x right, y down,
   * z towards the viewer), i.e. (right·e, -up·e, back·e).
   */
  update(view: Mat4): void {
    const m = view;
    const t = `matrix3d(${m[0]},${-m[1]!},${m[2]},0,${m[4]},${-m[5]!},${m[6]},0,${m[8]},${-m[9]!},${m[10]},0,0,0,0,1)`;
    if (t === this.lastTransform) return;
    this.lastTransform = t;
    this.cube.style.transform = t;
    // Hide faces that point away from the camera from assistive technology
    // and the tab order; they are also visually hidden (backface-visibility).
    const back: Vec3 = [m[2]!, m[6]!, m[10]!];
    for (const face of this.faces) {
      const facing = face.spec.n[0] * back[0] + face.spec.n[1] * back[1] + face.spec.n[2] * back[2] > 0.06;
      if (face.element.dataset.visible === String(facing)) continue;
      face.element.dataset.visible = String(facing);
      face.element.setAttribute("aria-hidden", facing ? "false" : "true");
      for (const b of face.buttons) b.tabIndex = facing ? 0 : -1;
    }
  }
}
