// SPDX-License-Identifier: Apache-2.0
/**
 * Z-up orbit camera in double precision. The camera stores eye and target in
 * render-origin-relative metres; view/projection matrices are produced in
 * Float64 and converted to Float32 only when uploaded as uniforms.
 */

import type { Bounds3 } from "../math/bounds.ts";
import { cross, dot, invert, multiply, normalize, rotation, sub, type Mat4, type Vec3 } from "../math/mat4.ts";

export interface CameraState {
  eye: Vec3;
  target: Vec3;
  fov: number;
}

export function lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const z = normalize(sub(eye, target));
  let x = cross(up, z);
  if (Math.hypot(x[0], x[1], x[2]) < 1e-9) x = cross([0, 1, 0], z);
  x = normalize(x);
  const y = cross(z, x);
  const m = new Float64Array(16);
  m[0] = x[0]; m[4] = x[1]; m[8] = x[2]; m[12] = -dot(x, eye);
  m[1] = y[0]; m[5] = y[1]; m[9] = y[2]; m[13] = -dot(y, eye);
  m[2] = z[0]; m[6] = z[1]; m[10] = z[2]; m[14] = -dot(z, eye);
  m[15] = 1;
  return m;
}

export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float64Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

export class OrbitCamera {
  eye: Vec3 = [20, -30, 18];
  target: Vec3 = [0, 0, 0];
  fov = (45 * Math.PI) / 180;
  /** Scene bounds (render space) used for clipping planes. */
  sceneBounds: Bounds3 | undefined;

  get distance(): number {
    return Math.hypot(this.eye[0] - this.target[0], this.eye[1] - this.target[1], this.eye[2] - this.target[2]);
  }

  get direction(): Vec3 {
    return normalize(sub(this.target, this.eye));
  }

  state(): CameraState {
    return { eye: [...this.eye], target: [...this.target], fov: this.fov };
  }

  setState(s: CameraState): void {
    this.eye = [...s.eye];
    this.target = [...s.target];
    this.fov = s.fov;
  }

  view(): Mat4 {
    return lookAt(this.eye, this.target, [0, 0, 1]);
  }

  clipRange(): [number, number] {
    const d = this.distance;
    let far = d * 4 + 1;
    const b = this.sceneBounds;
    if (b && b.minX <= b.maxX) {
      const c: Vec3 = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2];
      const r = Math.hypot(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ) / 2;
      far = Math.hypot(this.eye[0] - c[0], this.eye[1] - c[1], this.eye[2] - c[2]) + r * 1.05 + 1e-3;
    }
    far = Math.max(far, d * 1.5);
    const near = Math.max(far * 1e-5, Math.min(d * 0.05, far * 0.001));
    return [near, far];
  }

  projection(aspect: number): Mat4 {
    const [near, far] = this.clipRange();
    return perspective(this.fov, aspect, near, far);
  }

  viewProjection(aspect: number): Mat4 {
    return multiply(this.projection(aspect), this.view());
  }

  inverseViewProjection(aspect: number): Mat4 | undefined {
    return invert(this.viewProjection(aspect));
  }

  /** Orbits eye and target around `pivot` (yaw about +Z, pitch about the camera right axis). */
  orbit(yaw: number, pitch: number, pivot: Vec3 = this.target): void {
    const rz = rotation([0, 0, 1], yaw);
    const apply = (m: Mat4, p: Vec3): Vec3 => {
      const d = sub(p, pivot);
      return [
        pivot[0] + m[0]! * d[0] + m[4]! * d[1] + m[8]! * d[2],
        pivot[1] + m[1]! * d[0] + m[5]! * d[1] + m[9]! * d[2],
        pivot[2] + m[2]! * d[0] + m[6]! * d[1] + m[10]! * d[2],
      ];
    };
    let eye = apply(rz, this.eye);
    let target = apply(rz, this.target);
    const dir = normalize(sub(target, eye));
    const elevation = Math.asin(Math.max(-1, Math.min(1, -dir[2])));
    const limit = (89 * Math.PI) / 180;
    const clamped = Math.max(-limit, Math.min(limit, elevation + pitch)) - elevation;
    if (Math.abs(clamped) > 1e-12) {
      const right = normalize(cross(dir, [0, 0, 1]));
      const rp = rotation(right, -clamped);
      eye = apply(rp, eye);
      target = apply(rp, target);
    }
    this.eye = eye;
    this.target = target;
  }

  /** Pans by screen-space pixels. */
  pan(dxPixels: number, dyPixels: number, viewportHeight: number): void {
    const dir = this.direction;
    const right = normalize(cross(dir, [0, 0, 1]));
    const up = normalize(cross(right, dir));
    const scale = (2 * this.distance * Math.tan(this.fov / 2)) / Math.max(1, viewportHeight);
    const dx = -dxPixels * scale, dy = dyPixels * scale;
    const move: Vec3 = [right[0] * dx + up[0] * dy, right[1] * dx + up[1] * dy, right[2] * dx + up[2] * dy];
    this.eye = [this.eye[0] + move[0], this.eye[1] + move[1], this.eye[2] + move[2]];
    this.target = [this.target[0] + move[0], this.target[1] + move[1], this.target[2] + move[2]];
  }

  /** Dollies towards `focus` (defaults to target) by `factor` (<1 zooms in). */
  zoom(factor: number, focus?: Vec3): void {
    const f = Math.max(0.05, Math.min(20, factor));
    const pivot = focus ?? this.target;
    const lerp = (p: Vec3): Vec3 => [pivot[0] + (p[0] - pivot[0]) * f, pivot[1] + (p[1] - pivot[1]) * f, pivot[2] + (p[2] - pivot[2]) * f];
    const newEye = lerp(this.eye);
    const newTarget = focus ? lerp(this.target) : this.target;
    if (Math.hypot(newEye[0] - newTarget[0], newEye[1] - newTarget[1], newEye[2] - newTarget[2]) < 1e-4) return;
    this.eye = newEye;
    this.target = newTarget;
  }

  /** Camera state that frames `bounds` keeping the current view direction. */
  fitState(bounds: Bounds3, aspect: number, padding = 1.15): CameraState {
    const c: Vec3 = [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, (bounds.minZ + bounds.maxZ) / 2];
    const r = Math.max(1e-3, Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ) / 2);
    const halfV = this.fov / 2;
    const halfH = Math.atan(Math.tan(halfV) * aspect);
    const d = (r * padding) / Math.sin(Math.min(halfV, halfH));
    const dir = this.direction;
    return { eye: [c[0] - dir[0] * d, c[1] - dir[1] * d, c[2] - dir[2] * d], target: c, fov: this.fov };
  }

  /** Standard view direction presets. */
  presetState(name: "top" | "front" | "side" | "iso", bounds: Bounds3, aspect: number): CameraState {
    const dirs: Record<string, Vec3> = {
      top: normalize([0.0001, 0.0001, -1]),
      front: [0, 1, 0],
      side: [-1, 0, 0],
      iso: normalize([-1, 1, -0.8]),
    };
    const saved = this.state();
    const dir = dirs[name]!;
    this.eye = [this.target[0] - dir[0], this.target[1] - dir[1], this.target[2] - dir[2]];
    const s = this.fitState(bounds, aspect);
    this.setState(saved);
    return s;
  }
}
