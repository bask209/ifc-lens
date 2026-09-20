// SPDX-License-Identifier: Apache-2.0
/**
 * Coordinate systems: Cartesian points and directions, axis placements,
 * object placements (local, grid, linear) with cached absolute transforms and
 * cycle detection, representation-context world coordinate systems and
 * Cartesian transformation operators (including mirroring and non-uniform
 * scaling).
 */

import { IfcDecodeError } from "../diagnostics.ts";
import {
  cross,
  dot,
  fromBasis,
  identity,
  isFiniteMatrix,
  leastAlignedAxis,
  multiply,
  normalize,
  scale,
  sub,
  type Mat4,
  type Vec3,
} from "../math/mat4.ts";
import type { GeometryContext } from "./context.ts";

const EPS = 1e-12;

/** Coordinates of an IfcCartesianPoint (2D points get z = 0). */
export function readPoint(ctx: GeometryContext, id: number): Vec3 {
  const m = ctx.model;
  if (m.type(id) !== "IFCCARTESIANPOINT") {
    throw new IfcDecodeError(`expected IfcCartesianPoint, found ${m.type(id) ?? "missing entity"}`, id, id > 0 && !m.has(id) ? "IFC_REFERENCE_MISSING" : "IFC_INVALID_ATTRIBUTE");
  }
  const h = m.attr(id, 0);
  const s = m.store;
  const n = s.count(h);
  let c = h + 1;
  const out: Vec3 = [0, 0, 0];
  for (let i = 0; i < n && i < 3; i++) {
    const v = s.num(c);
    if (!Number.isFinite(v)) throw new IfcDecodeError("non-numeric point coordinate", id);
    out[i] = v;
    c = s.next(c);
  }
  return out;
}

/** Direction ratios of an IfcDirection (not normalised). */
export function readDirection(ctx: GeometryContext, id: number): Vec3 {
  const m = ctx.model;
  if (m.type(id) !== "IFCDIRECTION") {
    throw new IfcDecodeError(`expected IfcDirection, found ${m.type(id) ?? "missing entity"}`, id);
  }
  const values = m.store.numbers(m.attr(id, 0));
  if (!values || values.length < 2) throw new IfcDecodeError("invalid direction ratios", id);
  const d: Vec3 = [values[0]!, values[1]!, values[2] ?? 0];
  if (!d.every(Number.isFinite)) throw new IfcDecodeError("non-finite direction", id);
  return d;
}

/** IfcVector as a scaled direction. */
export function readVector(ctx: GeometryContext, id: number): Vec3 {
  const m = ctx.model;
  if (m.type(id) !== "IFCVECTOR") throw new IfcDecodeError(`expected IfcVector, found ${m.type(id)}`, id);
  const d = normalize(readDirection(ctx, m.ref(id, 0)));
  const mag = m.num(id, 1);
  return scale(d, Number.isFinite(mag) ? mag : 1);
}

function optionalDirection(ctx: GeometryContext, id: number): Vec3 | undefined {
  if (id <= 0) return undefined;
  const d = readDirection(ctx, id);
  const l = Math.hypot(d[0], d[1], d[2]);
  return l > EPS ? [d[0] / l, d[1] / l, d[2] / l] : undefined;
}

/** Right-handed placement matrix from origin, axis (Z) and reference direction (X). */
export function placementFromAxes(origin: Vec3, axis: Vec3 | undefined, refDirection: Vec3 | undefined): Mat4 {
  const z = normalize(axis ?? [0, 0, 1]);
  const zz: Vec3 = z[0] === 0 && z[1] === 0 && z[2] === 0 ? [0, 0, 1] : z;
  let x = refDirection ? normalize(refDirection) : ([1, 0, 0] as Vec3);
  x = sub(x, scale(zz, dot(x, zz)));
  if (Math.hypot(x[0], x[1], x[2]) < 1e-9) {
    const fallback = leastAlignedAxis(zz);
    x = sub(fallback, scale(zz, dot(fallback, zz)));
  }
  x = normalize(x);
  const y = normalize(cross(zz, x));
  return fromBasis(x, y, zz, origin);
}

export function axis2Placement3D(ctx: GeometryContext, id: number): Mat4 {
  const m = ctx.model;
  const origin = readPoint(ctx, m.ref(id, 0));
  const axis = optionalDirection(ctx, m.ref(id, 1));
  const ref = optionalDirection(ctx, m.ref(id, 2));
  return placementFromAxes(origin, axis, ref);
}

export function axis2Placement2D(ctx: GeometryContext, id: number): Mat4 {
  const m = ctx.model;
  const o = readPoint(ctx, m.ref(id, 0));
  const refId = m.ref(id, 1);
  let x: Vec3 = [1, 0, 0];
  if (refId > 0) {
    const d = readDirection(ctx, refId);
    const l = Math.hypot(d[0], d[1]);
    if (l > EPS) x = [d[0] / l, d[1] / l, 0];
  }
  const y: Vec3 = [-x[1], x[0], 0];
  return fromBasis(x, y, [0, 0, 1], [o[0], o[1], 0]);
}

/** Any IfcPlacement subtype (Axis1/Axis2 2D/3D) as a matrix. */
export function placementMatrix(ctx: GeometryContext, id: number): Mat4 {
  if (id <= 0) return identity();
  const t = ctx.model.type(id);
  switch (t) {
    case "IFCAXIS2PLACEMENT3D":
      return axis2Placement3D(ctx, id);
    case "IFCAXIS2PLACEMENT2D":
      return axis2Placement2D(ctx, id);
    case "IFCAXIS1PLACEMENT": {
      const origin = readPoint(ctx, ctx.model.ref(id, 0));
      return placementFromAxes(origin, optionalDirection(ctx, ctx.model.ref(id, 1)), undefined);
    }
    case undefined:
      throw new IfcDecodeError(`unresolved placement reference #${id}`, id, "IFC_REFERENCE_MISSING");
    default:
      throw new IfcDecodeError(`unsupported placement ${t}`, id, "PLACEMENT_INVALID");
  }
}

/** Absolute transform of an IfcObjectPlacement (cached, cycle-safe). */
export function objectPlacement(ctx: GeometryContext, id: number): Mat4 {
  if (id <= 0) return identity();
  const cached = ctx.placementCache.get(id);
  if (cached) return cached;
  const result = ctx.placementGuard.run(id, () => computeObjectPlacement(ctx, id));
  if (!isFiniteMatrix(result)) throw new IfcDecodeError("placement produced non-finite matrix", id, "PLACEMENT_INVALID");
  ctx.placementCache.set(id, result);
  return result;
}

function computeObjectPlacement(ctx: GeometryContext, id: number): Mat4 {
  const m = ctx.model;
  const t = m.type(id);
  switch (t) {
    case "IFCLOCALPLACEMENT": {
      const relTo = m.ref(id, 0);
      const relative = placementMatrix(ctx, m.ref(id, 1));
      return relTo > 0 ? multiply(objectPlacement(ctx, relTo), relative) : relative;
    }
    case "IFCLINEARPLACEMENT": {
      // IFC4X3: (PlacementRelTo, RelativePlacement, CartesianPosition)
      const relTo = m.ref(id, 0);
      const cartesian = m.ref(id, 2);
      let local: Mat4;
      if (cartesian > 0) {
        local = placementMatrix(ctx, cartesian);
      } else {
        ctx.report("PLACEMENT_INVALID", "IfcLinearPlacement without CartesianPosition: alignment-based positioning is not evaluated", id);
        local = identity();
      }
      return relTo > 0 ? multiply(objectPlacement(ctx, relTo), local) : local;
    }
    case "IFCGRIDPLACEMENT":
      return gridPlacement(ctx, id);
    case undefined:
      throw new IfcDecodeError(`unresolved object placement #${id}`, id, "IFC_REFERENCE_MISSING");
    default:
      throw new IfcDecodeError(`unsupported object placement ${t}`, id, "PLACEMENT_INVALID");
  }
}

function gridOfAxis(ctx: GeometryContext, axisId: number): number {
  const m = ctx.model;
  for (const grid of m.idsOfType("IFCGRID")) {
    for (let i = 7; i <= 9; i++) if (m.refs(grid, i).includes(axisId)) return grid;
  }
  return -1;
}

/** Line (point + unit direction) of a straight grid axis curve in grid coordinates. */
function axisLine(ctx: GeometryContext, axisId: number): { p: Vec3; d: Vec3 } | undefined {
  const m = ctx.model;
  const curve = m.ref(axisId, 1);
  const sameSense = m.bool(axisId, 2) !== false;
  let a: Vec3 | undefined;
  let b: Vec3 | undefined;
  if (m.type(curve) === "IFCPOLYLINE") {
    const pts = m.refs(curve, 0);
    if (pts.length >= 2) {
      a = readPoint(ctx, pts[0]!);
      b = readPoint(ctx, pts[pts.length - 1]!);
    }
  } else if (m.type(curve) === "IFCLINE") {
    a = readPoint(ctx, m.ref(curve, 0));
    b = [a[0], a[1], a[2]];
    const v = readVector(ctx, m.ref(curve, 1));
    b = [a[0] + v[0], a[1] + v[1], a[2] + v[2]];
  } else if (m.type(curve) === "IFCTRIMMEDCURVE" && m.type(m.ref(curve, 0)) === "IFCLINE") {
    const line = m.ref(curve, 0);
    a = readPoint(ctx, m.ref(line, 0));
    const v = readVector(ctx, m.ref(line, 1));
    b = [a[0] + v[0], a[1] + v[1], a[2] + v[2]];
  }
  if (!a || !b) return undefined;
  let d = normalize(sub(b, a));
  if (!sameSense) d = scale(d, -1);
  if (d[0] === 0 && d[1] === 0 && d[2] === 0) return undefined;
  return { p: a, d };
}

function gridPlacement(ctx: GeometryContext, id: number): Mat4 {
  const m = ctx.model;
  // IFC4X3: (PlacementRelTo, PlacementLocation, PlacementRefDirection); earlier: (PlacementLocation, PlacementRefDirection)
  const hasRelTo = m.attrCount(id) >= 3;
  const relTo = hasRelTo ? m.ref(id, 0) : -1;
  const location = m.ref(id, hasRelTo ? 1 : 0);
  const refDir = m.ref(id, hasRelTo ? 2 : 1);
  if (m.type(location) !== "IFCVIRTUALGRIDINTERSECTION") {
    throw new IfcDecodeError("grid placement without IfcVirtualGridIntersection", id, "PLACEMENT_INVALID");
  }
  const axes = m.refs(location, 0);
  const offsets = m.store.numbers(m.attr(location, 1)) ?? new Float64Array(0);
  if (axes.length < 2) throw new IfcDecodeError("virtual grid intersection needs two axes", location, "PLACEMENT_INVALID");
  const l1 = axisLine(ctx, axes[0]!);
  const l2 = axisLine(ctx, axes[1]!);
  if (!l1 || !l2) throw new IfcDecodeError("unsupported grid axis curve", location, "PLACEMENT_INVALID");
  // offset each axis to its left by the given distance
  const off = (l: { p: Vec3; d: Vec3 }, dist: number): Vec3 => [l.p[0] - l.d[1] * dist, l.p[1] + l.d[0] * dist, 0];
  const p1 = off(l1, offsets[0] ?? 0);
  const p2 = off(l2, offsets[1] ?? 0);
  const denom = l1.d[0] * l2.d[1] - l1.d[1] * l2.d[0];
  if (Math.abs(denom) < 1e-12) throw new IfcDecodeError("parallel grid axes", location, "PLACEMENT_INVALID");
  const t = ((p2[0] - p1[0]) * l2.d[1] - (p2[1] - p1[1]) * l2.d[0]) / denom;
  const point: Vec3 = [p1[0] + l1.d[0] * t, p1[1] + l1.d[1] * t, offsets[2] ?? 0];
  let xDir: Vec3 = [l1.d[0], l1.d[1], 0];
  if (refDir > 0) {
    if (m.type(refDir) === "IFCDIRECTION") xDir = normalize(readDirection(ctx, refDir));
  }
  const local = placementFromAxes(point, [0, 0, 1], xDir);
  const grid = gridOfAxis(ctx, axes[0]!);
  const gridMatrix = grid > 0 ? objectPlacement(ctx, m.ref(grid, 5)) : relTo > 0 ? objectPlacement(ctx, relTo) : identity();
  return multiply(gridMatrix, local);
}

/** World coordinate system of a representation context (walks sub-contexts to the parent). */
export function contextTransform(ctx: GeometryContext, contextId: number): Mat4 {
  const m = ctx.model;
  let cur = contextId;
  for (let i = 0; i < 16 && cur > 0; i++) {
    const t = m.type(cur);
    if (t === "IFCGEOMETRICREPRESENTATIONSUBCONTEXT") {
      cur = m.ref(cur, 6);
      continue;
    }
    if (t === "IFCGEOMETRICREPRESENTATIONCONTEXT") {
      const wcs = m.ref(cur, 4);
      if (wcs <= 0) return identity();
      try {
        return placementMatrix(ctx, wcs);
      } catch {
        return identity();
      }
    }
    break;
  }
  return identity();
}

/** IfcCartesianTransformationOperator 2D/3D (uniform or non-uniform) as a matrix. */
export function transformationOperator(ctx: GeometryContext, id: number): Mat4 {
  const m = ctx.model;
  const t = m.type(id);
  const is3D = t === "IFCCARTESIANTRANSFORMATIONOPERATOR3D" || t === "IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM";
  const is2D = t === "IFCCARTESIANTRANSFORMATIONOPERATOR2D" || t === "IFCCARTESIANTRANSFORMATIONOPERATOR2DNONUNIFORM";
  if (!is3D && !is2D) throw new IfcDecodeError(`unsupported transformation operator ${t}`, id, "GEOMETRY_UNSUPPORTED");
  const axis1 = optionalDirection(ctx, m.ref(id, 0));
  const axis2 = optionalDirection(ctx, m.ref(id, 1));
  const origin = readPoint(ctx, m.ref(id, 2));
  let s1 = m.num(id, 3);
  if (!Number.isFinite(s1)) s1 = 1;
  let s2 = s1;
  let s3 = s1;
  if (t === "IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM") {
    const a = m.num(id, 5), b = m.num(id, 6);
    if (Number.isFinite(a)) s2 = a;
    if (Number.isFinite(b)) s3 = b;
  } else if (t === "IFCCARTESIANTRANSFORMATIONOPERATOR2DNONUNIFORM") {
    const a = m.num(id, 4);
    if (Number.isFinite(a)) s2 = a;
  }
  let x: Vec3, y: Vec3, z: Vec3;
  if (is3D) {
    const axis3 = optionalDirection(ctx, m.ref(id, 4));
    z = axis3 ?? [0, 0, 1];
    // First projected axis
    let v: Vec3 = axis1 ?? (Math.abs(z[0]) > 1 - 1e-9 ? [0, 1, 0] : [1, 0, 0]);
    v = sub(v, scale(z, dot(v, z)));
    if (Math.hypot(v[0], v[1], v[2]) < 1e-9) v = sub(leastAlignedAxis(z), scale(z, dot(leastAlignedAxis(z), z)));
    x = normalize(v);
    // Second projected axis (keeps the given orientation: may be mirrored)
    if (axis2) {
      let w = sub(axis2, scale(z, dot(axis2, z)));
      w = sub(w, scale(x, dot(w, x)));
      y = Math.hypot(w[0], w[1], w[2]) < 1e-9 ? normalize(cross(z, x)) : normalize(w);
    } else {
      y = normalize(cross(z, x));
    }
  } else {
    z = [0, 0, 1];
    x = axis1 ? normalize([axis1[0], axis1[1], 0]) : [1, 0, 0];
    const perp: Vec3 = [-x[1], x[0], 0];
    if (axis2) {
      const sign = axis2[0] * perp[0] + axis2[1] * perp[1] < 0 ? -1 : 1;
      y = scale(perp, sign);
    } else {
      y = perp;
    }
  }
  return fromBasis(scale(x, s1), scale(y, s2), scale(z, is2D ? 1 : s3), origin);
}
