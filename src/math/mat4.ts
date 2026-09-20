// SPDX-License-Identifier: Apache-2.0
/**
 * Double-precision 4x4 affine matrices, column-major (element (row r, col c)
 * at index c*4 + r), acting on column vectors: p' = M p.
 */

export type Mat4 = Float64Array;
export type Vec3 = [number, number, number];

export function identity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function isIdentity(m: Mat4, eps = 1e-12): boolean {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      const expected = r === c ? 1 : 0;
      if (Math.abs(m[c * 4 + r]! - expected) > eps) return false;
    }
  }
  return true;
}

export function translation(x: number, y: number, z: number): Mat4 {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

export function scaling(x: number, y: number, z: number): Mat4 {
  const m = identity();
  m[0] = x;
  m[5] = y;
  m[10] = z;
  return m;
}

/** Rotation about a unit axis by `angle` radians (right-handed). */
export function rotation(axis: Vec3, angle: number): Mat4 {
  const [x, y, z] = normalize(axis);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  const m = identity();
  m[0] = t * x * x + c;
  m[1] = t * x * y + s * z;
  m[2] = t * x * z - s * y;
  m[4] = t * x * y - s * z;
  m[5] = t * y * y + c;
  m[6] = t * y * z + s * x;
  m[8] = t * x * z + s * y;
  m[9] = t * y * z - s * x;
  m[10] = t * z * z + c;
  return m;
}

/** Matrix whose columns are the given basis vectors and origin. */
export function fromBasis(x: Vec3, y: Vec3, z: Vec3, origin: Vec3): Mat4 {
  const m = new Float64Array(16);
  m[0] = x[0]; m[1] = x[1]; m[2] = x[2];
  m[4] = y[0]; m[5] = y[1]; m[6] = y[2];
  m[8] = z[0]; m[9] = z[1]; m[10] = z[2];
  m[12] = origin[0]; m[13] = origin[1]; m[14] = origin[2];
  m[15] = 1;
  return m;
}

/** out = a * b (apply b first, then a). */
export function multiply(a: Mat4, b: Mat4, out: Mat4 = new Float64Array(16)): Mat4 {
  const r = out === a || out === b ? new Float64Array(16) : out;
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4]!, b1 = b[c * 4 + 1]!, b2 = b[c * 4 + 2]!, b3 = b[c * 4 + 3]!;
    r[c * 4] = a[0]! * b0 + a[4]! * b1 + a[8]! * b2 + a[12]! * b3;
    r[c * 4 + 1] = a[1]! * b0 + a[5]! * b1 + a[9]! * b2 + a[13]! * b3;
    r[c * 4 + 2] = a[2]! * b0 + a[6]! * b1 + a[10]! * b2 + a[14]! * b3;
    r[c * 4 + 3] = a[3]! * b0 + a[7]! * b1 + a[11]! * b2 + a[15]! * b3;
  }
  if (r !== out) out.set(r);
  return out;
}

/** Multiplies a chain left-to-right: multiplyAll(A, B, C) = A*B*C. */
export function multiplyAll(...ms: Mat4[]): Mat4 {
  let r = identity();
  for (const m of ms) r = multiply(r, m);
  return r;
}

export function determinant3(m: Mat4): number {
  const a = m[0]!, b = m[4]!, c = m[8]!;
  const d = m[1]!, e = m[5]!, f = m[9]!;
  const g = m[2]!, h = m[6]!, i = m[10]!;
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

/** Inverse of a general 4x4 matrix; returns undefined when singular. */
export function invert(m: Mat4): Mat4 | undefined {
  const a00 = m[0]!, a01 = m[1]!, a02 = m[2]!, a03 = m[3]!;
  const a10 = m[4]!, a11 = m[5]!, a12 = m[6]!, a13 = m[7]!;
  const a20 = m[8]!, a21 = m[9]!, a22 = m[10]!, a23 = m[11]!;
  const a30 = m[12]!, a31 = m[13]!, a32 = m[14]!, a33 = m[15]!;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) return undefined;
  const inv = 1 / det;
  const o = new Float64Array(16);
  o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * inv;
  o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * inv;
  o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * inv;
  o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * inv;
  o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * inv;
  o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * inv;
  o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * inv;
  o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * inv;
  o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * inv;
  o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * inv;
  o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * inv;
  o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * inv;
  o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * inv;
  o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * inv;
  o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * inv;
  o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * inv;
  return o;
}

export function transformPoint(m: Mat4, x: number, y: number, z: number): Vec3 {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ];
}

export function transformDirection(m: Mat4, x: number, y: number, z: number): Vec3 {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z,
    m[1]! * x + m[5]! * y + m[9]! * z,
    m[2]! * x + m[6]! * y + m[10]! * z,
  ];
}

/** Transforms packed xyz positions in place. */
export function transformPositions(m: Mat4, positions: Float64Array): void {
  const m0 = m[0]!, m1 = m[1]!, m2 = m[2]!, m4 = m[4]!, m5 = m[5]!, m6 = m[6]!;
  const m8 = m[8]!, m9 = m[9]!, m10 = m[10]!, m12 = m[12]!, m13 = m[13]!, m14 = m[14]!;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!;
    positions[i] = m0 * x + m4 * y + m8 * z + m12;
    positions[i + 1] = m1 * x + m5 * y + m9 * z + m13;
    positions[i + 2] = m2 * x + m6 * y + m10 * z + m14;
  }
}

/** Upper-left 3x3 inverse-transpose packed as a column-major Mat4 (for normals). */
export function normalMatrix(m: Mat4): Mat4 {
  const inv = invert(m);
  const out = identity();
  if (!inv) return out;
  // transpose of inverse
  out[0] = inv[0]!; out[1] = inv[4]!; out[2] = inv[8]!;
  out[4] = inv[1]!; out[5] = inv[5]!; out[6] = inv[9]!;
  out[8] = inv[2]!; out[9] = inv[6]!; out[10] = inv[10]!;
  return out;
}

export function isFiniteMatrix(m: Mat4): boolean {
  for (let i = 0; i < 16; i++) if (!Number.isFinite(m[i]!)) return false;
  return true;
}

export function getTranslation(m: Mat4): Vec3 {
  return [m[12]!, m[13]!, m[14]!];
}

/** Largest axis scale factor of the linear part. */
export function maxScale(m: Mat4): number {
  const sx = Math.hypot(m[0]!, m[1]!, m[2]!);
  const sy = Math.hypot(m[4]!, m[5]!, m[6]!);
  const sz = Math.hypot(m[8]!, m[9]!, m[10]!);
  return Math.max(sx, sy, sz);
}

export function equalsApprox(a: Mat4, b: Mat4, eps = 1e-9): boolean {
  for (let i = 0; i < 16; i++) if (Math.abs(a[i]! - b[i]!) > eps) return false;
  return true;
}

// ---- small vector helpers ----

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
export function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l > 0 && Number.isFinite(l) ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}
/** Global axis least aligned with `v` (used to build a perpendicular). */
export function leastAlignedAxis(v: Vec3): Vec3 {
  const ax = Math.abs(v[0]), ay = Math.abs(v[1]), az = Math.abs(v[2]);
  if (ax <= ay && ax <= az) return [1, 0, 0];
  if (ay <= az) return [0, 1, 0];
  return [0, 0, 1];
}
/** Any unit vector perpendicular to unit `v`. */
export function perpendicular(v: Vec3): Vec3 {
  return normalize(cross(v, leastAlignedAxis(v)));
}
