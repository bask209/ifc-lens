// SPDX-License-Identifier: Apache-2.0
/** Axis-aligned bounding boxes in double precision. */

import type { Mat4 } from "./mat4.ts";

export interface Bounds3 {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export function emptyBounds(): Bounds3 {
  return { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
}

export function isEmptyBounds(b: Bounds3): boolean {
  return !(b.minX <= b.maxX && b.minY <= b.maxY && b.minZ <= b.maxZ);
}

export function expandPoint(b: Bounds3, x: number, y: number, z: number): void {
  if (x < b.minX) b.minX = x;
  if (y < b.minY) b.minY = y;
  if (z < b.minZ) b.minZ = z;
  if (x > b.maxX) b.maxX = x;
  if (y > b.maxY) b.maxY = y;
  if (z > b.maxZ) b.maxZ = z;
}

export function unionBounds(a: Bounds3, b: Bounds3): Bounds3 {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    minZ: Math.min(a.minZ, b.minZ),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
    maxZ: Math.max(a.maxZ, b.maxZ),
  };
}

export function boundsOfPositions(positions: ArrayLike<number>): Bounds3 {
  const b = emptyBounds();
  for (let i = 0; i + 2 < positions.length; i += 3) expandPoint(b, positions[i]!, positions[i + 1]!, positions[i + 2]!);
  return b;
}

export function boundsCenter(b: Bounds3): [number, number, number] {
  return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2];
}

export function boundsDiagonal(b: Bounds3): number {
  if (isEmptyBounds(b)) return 0;
  return Math.hypot(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ);
}

export function boundsOverlap(a: Bounds3, b: Bounds3, eps = 0): boolean {
  return (
    a.minX <= b.maxX + eps && b.minX <= a.maxX + eps &&
    a.minY <= b.maxY + eps && b.minY <= a.maxY + eps &&
    a.minZ <= b.maxZ + eps && b.minZ <= a.maxZ + eps
  );
}

/** Bounds of the eight transformed corners. */
export function transformBounds(b: Bounds3, m: Mat4): Bounds3 {
  const out = emptyBounds();
  if (isEmptyBounds(b)) return out;
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? b.maxX : b.minX;
    const y = i & 2 ? b.maxY : b.minY;
    const z = i & 4 ? b.maxZ : b.minZ;
    expandPoint(
      out,
      m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
      m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
      m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
    );
  }
  return out;
}

export function boundsToArray(b: Bounds3): [number, number, number, number, number, number] {
  return [b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ];
}

export function boundsFromArray(a: ArrayLike<number>, offset = 0): Bounds3 {
  return {
    minX: a[offset]!, minY: a[offset + 1]!, minZ: a[offset + 2]!,
    maxX: a[offset + 3]!, maxY: a[offset + 4]!, maxZ: a[offset + 5]!,
  };
}
