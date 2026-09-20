// SPDX-License-Identifier: Apache-2.0
/**
 * Curve tessellation: polylines, indexed poly-curves (line and three-point
 * arc segments), circles, ellipses, lines, B-splines (rational and
 * non-rational), trimmed curves (by parameter or point, with sense
 * agreement), composite curves and 2D offset curves. Output is a packed xyz
 * polyline with a `closed` flag (closed polylines do not repeat the first
 * point).
 */

import { IfcDecodeError } from "../diagnostics.ts";
import { cross, dot, normalize, sub, transformPoint, type Mat4, type Vec3 } from "../math/mat4.ts";
import type { GeometryContext } from "./context.ts";
import { placementMatrix, readPoint, readVector } from "./placement.ts";

export interface Polyline {
  /** Packed xyz. */
  points: number[];
  closed: boolean;
}

const TWO_PI = Math.PI * 2;

/** Parametric curve abstraction used for trimming. */
interface ParamCurve {
  point(t: number): Vec3;
  /** Appends samples for parameters in [t0, t1] (either order), including both ends. */
  sample(t0: number, t1: number, out: number[]): void;
  /** Parameter of the point on the curve closest to p. */
  param(p: Vec3): number;
  /** Period of closed curves (radians for conics). */
  period?: number;
  /** Natural domain for full tessellation. */
  domain: [number, number];
  closed: boolean;
}

function pushPoint(out: number[], p: Vec3): void {
  const n = out.length;
  if (n >= 3 && out[n - 3] === p[0] && out[n - 2] === p[1] && out[n - 1] === p[2]) return;
  out.push(p[0], p[1], p[2]);
}

function lineCurve(ctx: GeometryContext, id: number): ParamCurve {
  const m = ctx.model;
  const p0 = readPoint(ctx, m.ref(id, 0));
  const v = readVector(ctx, m.ref(id, 1));
  const vv = dot(v, v);
  if (!(vv > 0)) throw new IfcDecodeError("IfcLine with zero direction", id, "CURVE_INVALID");
  const point = (t: number): Vec3 => [p0[0] + v[0] * t, p0[1] + v[1] * t, p0[2] + v[2] * t];
  return {
    point,
    sample(t0, t1, out) {
      pushPoint(out, point(t0));
      pushPoint(out, point(t1));
    },
    param: (p) => dot(sub(p, p0), v) / vv,
    domain: [0, 1],
    closed: false,
  };
}

function conicCurve(ctx: GeometryContext, id: number, rx: number, ry: number): ParamCurve {
  const m = ctx.model;
  const place = placementMatrix(ctx, m.ref(id, 0));
  if (!(rx > 0) || !(ry > 0) || !Number.isFinite(rx) || !Number.isFinite(ry)) {
    throw new IfcDecodeError("conic with non-positive radius", id, "CURVE_INVALID");
  }
  const point = (t: number): Vec3 => transformPoint(place, rx * Math.cos(t), ry * Math.sin(t), 0);
  const inv = (p: Vec3): number => {
    // project into the local frame (orthonormal placement)
    const o: Vec3 = [place[12]!, place[13]!, place[14]!];
    const d = sub(p, o);
    const x = dot(d, [place[0]!, place[1]!, place[2]!]);
    const y = dot(d, [place[4]!, place[5]!, place[6]!]);
    let a = Math.atan2(y / ry, x / rx);
    if (a < 0) a += TWO_PI;
    return a;
  };
  return {
    point,
    sample(t0, t1, out) {
      const sweep = t1 - t0;
      const n = ctx.arcSegments(Math.max(rx, ry), sweep);
      for (let i = 0; i <= n; i++) pushPoint(out, point(t0 + (sweep * i) / n));
    },
    param: inv,
    period: TWO_PI,
    domain: [0, TWO_PI],
    closed: true,
  };
}

/** Polyline through explicit points, parameterised by segment index (IFC convention). */
function polylineCurve(points: Vec3[]): ParamCurve {
  const n = points.length;
  const point = (t: number): Vec3 => {
    if (n === 0) return [0, 0, 0];
    const i = Math.min(Math.max(Math.floor(t), 0), n - 2);
    if (n === 1) return points[0]!;
    const f = t - i;
    const a = points[i]!, b = points[i + 1]!;
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  };
  return {
    point,
    sample(t0, t1, out) {
      pushPoint(out, point(t0));
      if (t1 >= t0) {
        for (let i = Math.floor(t0) + 1; i < t1; i++) pushPoint(out, points[i]!);
      } else {
        for (let i = Math.ceil(t0) - 1; i > t1; i--) pushPoint(out, points[i]!);
      }
      pushPoint(out, point(t1));
    },
    param(p) {
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i + 1 < n; i++) {
        const a = points[i]!, b = points[i + 1]!;
        const ab = sub(b, a);
        const l2 = dot(ab, ab);
        const f = l2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, a), ab) / l2)) : 0;
        const q: Vec3 = [a[0] + ab[0] * f, a[1] + ab[1] * f, a[2] + ab[2] * f];
        const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i + f;
        }
      }
      return best;
    },
    domain: [0, Math.max(0, n - 1)],
    closed: false,
  };
}

/** Wraps an already tessellated polyline as an arc-length parameterised curve. */
function sampledCurve(poly: Polyline): ParamCurve {
  const pts: Vec3[] = [];
  for (let i = 0; i < poly.points.length; i += 3) pts.push([poly.points[i]!, poly.points[i + 1]!, poly.points[i + 2]!]);
  if (poly.closed && pts.length > 0) pts.push(pts[0]!);
  const c = polylineCurve(pts);
  return { ...c, closed: poly.closed };
}

function bsplineCurve(ctx: GeometryContext, id: number, rational: boolean): ParamCurve {
  const m = ctx.model;
  const degree = Math.trunc(m.num(id, 0));
  const ctrl = m.refs(id, 1).map((p) => readPoint(ctx, p));
  const mults = m.store.numbers(m.attr(id, 5)) ?? new Float64Array(0);
  const knotValues = m.store.numbers(m.attr(id, 6)) ?? new Float64Array(0);
  const weights = rational ? (m.store.numbers(m.attr(id, 8)) ?? new Float64Array(0)) : undefined;
  if (!(degree >= 1) || degree > 25 || ctrl.length < degree + 1) {
    throw new IfcDecodeError("invalid B-spline degree/control points", id, "CURVE_INVALID");
  }
  const knots: number[] = [];
  for (let i = 0; i < knotValues.length; i++) {
    const k = Math.trunc(mults[i] ?? 1);
    if (k < 1 || k > degree + 1 || knots.length + k > 100000) throw new IfcDecodeError("invalid knot multiplicity", id, "CURVE_INVALID");
    for (let j = 0; j < k; j++) knots.push(knotValues[i]!);
  }
  if (knots.length !== ctrl.length + degree + 1) {
    throw new IfcDecodeError(`B-spline knot count ${knots.length} != ${ctrl.length + degree + 1}`, id, "CURVE_INVALID");
  }
  if (weights && weights.length !== ctrl.length) throw new IfcDecodeError("B-spline weight count mismatch", id, "CURVE_INVALID");
  const n = ctrl.length;
  const tMin = knots[degree]!;
  const tMax = knots[n]!;
  const point = (tIn: number): Vec3 => {
    const t = Math.min(Math.max(tIn, tMin), tMax);
    let span = degree;
    while (span < n - 1 && t >= knots[span + 1]!) span++;
    // de Boor in homogeneous coordinates
    const d: [number, number, number, number][] = [];
    for (let j = 0; j <= degree; j++) {
      const p = ctrl[span - degree + j]!;
      const w = weights ? weights[span - degree + j]! : 1;
      d.push([p[0] * w, p[1] * w, p[2] * w, w]);
    }
    for (let r = 1; r <= degree; r++) {
      for (let j = degree; j >= r; j--) {
        const i = span - degree + j;
        const denom = knots[i + degree - r + 1]! - knots[i]!;
        const alpha = denom === 0 ? 0 : (t - knots[i]!) / denom;
        const a = d[j - 1]!, b = d[j]!;
        d[j] = [(1 - alpha) * a[0] + alpha * b[0], (1 - alpha) * a[1] + alpha * b[1], (1 - alpha) * a[2] + alpha * b[2], (1 - alpha) * a[3] + alpha * b[3]];
      }
    }
    const r = d[degree]!;
    const w = r[3] === 0 ? 1 : r[3];
    return [r[0] / w, r[1] / w, r[2] / w];
  };
  const spans = new Set(knots).size - 1;
  const perSpan = degree === 1 ? 1 : Math.min(32, 8 * degree);
  const sample = (t0: number, t1: number, out: number[]): void => {
    const count = Math.min(ctx.limits.maxCurveSegments, Math.max(2, Math.ceil((perSpan * Math.max(1, spans) * Math.abs(t1 - t0)) / Math.max(tMax - tMin, 1e-300))));
    for (let i = 0; i <= count; i++) pushPoint(out, point(t0 + ((t1 - t0) * i) / count));
  };
  const closed = m.bool(id, 3) === true;
  return {
    point,
    sample,
    param(p) {
      // coarse search then golden-section refinement
      const steps = Math.max(16, spans * perSpan);
      let best = tMin;
      let bestD = Infinity;
      for (let i = 0; i <= steps; i++) {
        const t = tMin + ((tMax - tMin) * i) / steps;
        const q = point(t);
        const dd = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
        if (dd < bestD) {
          bestD = dd;
          best = t;
        }
      }
      let lo = Math.max(tMin, best - (tMax - tMin) / steps);
      let hi = Math.min(tMax, best + (tMax - tMin) / steps);
      for (let k = 0; k < 40; k++) {
        const a = lo + (hi - lo) * 0.382, b = lo + (hi - lo) * 0.618;
        const qa = point(a), qb = point(b);
        const da = (qa[0] - p[0]) ** 2 + (qa[1] - p[1]) ** 2 + (qa[2] - p[2]) ** 2;
        const db = (qb[0] - p[0]) ** 2 + (qb[1] - p[1]) ** 2 + (qb[2] - p[2]) ** 2;
        if (da < db) hi = b;
        else lo = a;
      }
      return (lo + hi) / 2;
    },
    domain: [tMin, tMax],
    closed,
  };
}

function basisCurve(ctx: GeometryContext, id: number): ParamCurve {
  const m = ctx.model;
  const t = m.type(id);
  switch (t) {
    case "IFCLINE":
      return lineCurve(ctx, id);
    case "IFCCIRCLE": {
      const r = m.num(id, 1);
      return conicCurve(ctx, id, r, r);
    }
    case "IFCELLIPSE":
      return conicCurve(ctx, id, m.num(id, 1), m.num(id, 2));
    case "IFCPOLYLINE":
      return polylineCurve(m.refs(id, 0).map((p) => readPoint(ctx, p)));
    case "IFCBSPLINECURVEWITHKNOTS":
      return bsplineCurve(ctx, id, false);
    case "IFCRATIONALBSPLINECURVEWITHKNOTS":
      return bsplineCurve(ctx, id, true);
    default:
      return sampledCurve(tessellateCurve(ctx, id));
  }
}

function trimParam(ctx: GeometryContext, curve: ParamCurve, trimHandle: number, preferParameter: boolean, isConic: boolean): number | undefined {
  const s = ctx.model.store;
  let param: number | undefined;
  let point: Vec3 | undefined;
  for (const h of s.items(trimHandle)) {
    const typed = s.typedName(h);
    if (typed === "IFCPARAMETERVALUE") {
      const v = s.num(h);
      if (Number.isFinite(v)) param = isConic ? v * ctx.angleScale : v;
    } else {
      const ref = s.ref(h);
      if (ref > 0 && ctx.model.type(ref) === "IFCCARTESIANPOINT") point = readPoint(ctx, ref);
    }
  }
  if (param !== undefined && (preferParameter || point === undefined)) return param;
  if (point !== undefined) return curve.param(point);
  return param;
}

function trimmedCurve(ctx: GeometryContext, id: number): Polyline {
  const m = ctx.model;
  const basisId = m.ref(id, 0);
  const basisType = m.type(basisId);
  const curve = basisCurve(ctx, basisId);
  const isConic = basisType === "IFCCIRCLE" || basisType === "IFCELLIPSE";
  const master = m.enumValue(id, 4);
  const preferParameter = master !== "CARTESIAN";
  let t1 = trimParam(ctx, curve, m.attr(id, 1), preferParameter, isConic);
  let t2 = trimParam(ctx, curve, m.attr(id, 2), preferParameter, isConic);
  if (t1 === undefined || t2 === undefined) throw new IfcDecodeError("trimmed curve without usable trims", id, "CURVE_INVALID");
  const sense = m.bool(id, 3) !== false;
  const out: number[] = [];
  if (curve.period) {
    const P = curve.period;
    if (sense) {
      while (t2 <= t1 + 1e-12) t2 += P;
      while (t2 - t1 > P + 1e-9) t2 -= P;
    } else {
      while (t2 >= t1 - 1e-12) t2 -= P;
      while (t1 - t2 > P + 1e-9) t2 += P;
    }
    curve.sample(t1, t2, out);
  } else {
    if (!sense && t2 > t1) [t1, t2] = [t2, t1];
    curve.sample(t1, t2, out);
  }
  return { points: out, closed: false };
}

/** Circle through three points (for IfcArcIndex), sampled from a to c through b. */
function arcThrough(ctx: GeometryContext, a: Vec3, b: Vec3, c: Vec3, out: number[]): void {
  const ab = sub(b, a), ac = sub(c, a);
  const n = cross(ab, ac);
  const nn = dot(n, n);
  if (nn < 1e-24 * Math.max(dot(ab, ab), dot(ac, ac)) ** 2 || !(nn > 0)) {
    pushPoint(out, a);
    pushPoint(out, b);
    pushPoint(out, c);
    return;
  }
  // circumcentre
  const t1 = cross(n, ab);
  const t2 = cross(ac, n);
  const f1 = dot(ac, ac) / (2 * nn);
  const f2 = dot(ab, ab) / (2 * nn);
  const center: Vec3 = [a[0] + t1[0] * f1 + t2[0] * f2, a[1] + t1[1] * f1 + t2[1] * f2, a[2] + t1[2] * f1 + t2[2] * f2];
  const u = normalize(sub(a, center));
  const nz = normalize(n);
  const v = cross(nz, u);
  const r = Math.hypot(a[0] - center[0], a[1] - center[1], a[2] - center[2]);
  const ang = (p: Vec3): number => {
    const d = sub(p, center);
    let x = Math.atan2(dot(d, v), dot(d, u));
    if (x < 0) x += TWO_PI;
    return x;
  };
  const endAngle = ang(c);
  const n2 = ctx.arcSegments(r, endAngle);
  for (let i = 0; i <= n2; i++) {
    const t = (endAngle * i) / n2;
    const ct = Math.cos(t), st = Math.sin(t);
    pushPoint(out, [center[0] + r * (u[0] * ct + v[0] * st), center[1] + r * (u[1] * ct + v[1] * st), center[2] + r * (u[2] * ct + v[2] * st)]);
  }
}

function indexedPolyCurve(ctx: GeometryContext, id: number): Polyline {
  const m = ctx.model;
  const listId = m.ref(id, 0);
  const listType = m.type(listId);
  let coords: Float64Array | undefined;
  if (listType === "IFCCARTESIANPOINTLIST2D") coords = m.store.numberRows(m.attr(listId, 0), 3);
  else if (listType === "IFCCARTESIANPOINTLIST3D") coords = m.store.numberRows(m.attr(listId, 0), 3);
  if (!coords) throw new IfcDecodeError("indexed poly curve without point list", id, "CURVE_INVALID");
  const count = coords.length / 3;
  const pt = (i1: number): Vec3 => {
    const i = i1 - 1;
    if (!(i >= 0 && i < count)) throw new IfcDecodeError(`point index ${i1} out of range 1..${count}`, id, "CURVE_INVALID");
    return [coords[i * 3]!, coords[i * 3 + 1]!, coords[i * 3 + 2]!];
  };
  const out: number[] = [];
  const segHandle = m.attr(id, 1);
  if (segHandle < 0 || m.store.isNull(segHandle)) {
    for (let i = 1; i <= count; i++) pushPoint(out, pt(i));
  } else {
    const s = m.store;
    for (const seg of s.items(segHandle)) {
      const kind = s.typedName(seg);
      const idx = s.numbers(seg + 1);
      if (!idx) continue;
      if (kind === "IFCARCINDEX" && idx.length === 3) {
        arcThrough(ctx, pt(idx[0]!), pt(idx[1]!), pt(idx[2]!), out);
      } else {
        for (const i of idx) pushPoint(out, pt(i));
      }
    }
  }
  return closeIfCoincident(out, ctx.epsilon);
}

function closeIfCoincident(points: number[], eps: number): Polyline {
  const n = points.length;
  if (n >= 12) {
    const dx = points[0]! - points[n - 3]!, dy = points[1]! - points[n - 2]!, dz = points[2]! - points[n - 1]!;
    if (Math.hypot(dx, dy, dz) <= eps * 10) {
      points.length = n - 3;
      return { points, closed: true };
    }
  }
  return { points, closed: false };
}

function compositeCurve(ctx: GeometryContext, id: number): Polyline {
  const m = ctx.model;
  const out: number[] = [];
  for (const seg of m.refs(id, 0)) {
    const segType = m.type(seg);
    let part: Polyline;
    let sameSense = true;
    if (segType === "IFCCOMPOSITECURVESEGMENT" || segType === "IFCREPARAMETRISEDCOMPOSITECURVESEGMENT") {
      sameSense = m.bool(seg, 1) !== false;
      part = tessellateCurve(ctx, m.ref(seg, 2));
    } else if (segType === "IFCCURVESEGMENT") {
      part = curveSegment(ctx, seg);
    } else {
      part = tessellateCurve(ctx, seg);
    }
    const pts = part.points;
    if (part.closed && pts.length >= 3) pts.push(pts[0]!, pts[1]!, pts[2]!);
    if (sameSense) {
      for (let i = 0; i < pts.length; i += 3) pushPoint(out, [pts[i]!, pts[i + 1]!, pts[i + 2]!]);
    } else {
      for (let i = pts.length - 3; i >= 0; i -= 3) pushPoint(out, [pts[i]!, pts[i + 1]!, pts[i + 2]!]);
    }
  }
  return closeIfCoincident(out, ctx.epsilon);
}

/**
 * IFC4X3 IfcCurveSegment (Transition, Placement, SegmentStart, SegmentLength,
 * ParentCurve) for line and circle parents; start/length are measured along
 * the parent curve.
 */
function curveSegment(ctx: GeometryContext, id: number): Polyline {
  const m = ctx.model;
  const place = placementMatrix(ctx, m.ref(id, 1));
  const start = m.num(id, 2);
  const length = m.num(id, 3);
  const parent = m.ref(id, 4);
  const parentType = m.type(parent);
  const out: number[] = [];
  if (!Number.isFinite(start) || !Number.isFinite(length)) throw new IfcDecodeError("curve segment without numeric start/length", id, "CURVE_INVALID");
  if (parentType === "IFCLINE") {
    const line = lineCurve(ctx, parent);
    const dir = line.point(1);
    const o = line.point(0);
    const speed = Math.hypot(dir[0] - o[0], dir[1] - o[1], dir[2] - o[2]) || 1;
    const a = line.point(start / speed), b = line.point((start + length) / speed);
    pushPoint(out, transformPoint(place, a[0], a[1], a[2]));
    pushPoint(out, transformPoint(place, b[0], b[1], b[2]));
    return { points: out, closed: false };
  }
  if (parentType === "IFCCIRCLE") {
    const r = m.num(parent, 1);
    const circle = conicCurve(ctx, parent, r, r);
    const local: number[] = [];
    circle.sample(start / r, (start + length) / r, local);
    for (let i = 0; i < local.length; i += 3) pushPoint(out, transformPoint(place, local[i]!, local[i + 1]!, local[i + 2]!));
    return { points: out, closed: false };
  }
  throw new IfcDecodeError(`IfcCurveSegment with ${parentType} parent is not supported`, id, "GEOMETRY_UNSUPPORTED");
}

function offsetCurve2D(ctx: GeometryContext, id: number): Polyline {
  const m = ctx.model;
  const basis = tessellateCurve(ctx, m.ref(id, 0));
  const dist = m.num(id, 1);
  if (!Number.isFinite(dist)) throw new IfcDecodeError("offset curve without distance", id, "CURVE_INVALID");
  return { points: offsetPolyline2D(basis.points, basis.closed, dist), closed: basis.closed };
}

/** Offsets a planar polyline to its left by `dist` with mitred joints. */
export function offsetPolyline2D(points: readonly number[], closed: boolean, dist: number): number[] {
  const n = points.length / 3;
  const out: number[] = [];
  const seg = (i: number): [number, number] => {
    const j = (i + 1) % n;
    const dx = points[j * 3]! - points[i * 3]!, dy = points[j * 3 + 1]! - points[i * 3 + 1]!;
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  };
  for (let i = 0; i < n; i++) {
    const hasPrev = closed || i > 0;
    const hasNext = closed || i < n - 1;
    const dPrev = hasPrev ? seg((i - 1 + n) % n) : seg(i);
    const dNext = hasNext ? seg(i) : dPrev;
    const nPrev: [number, number] = [-dPrev[1], dPrev[0]];
    const nNext: [number, number] = [-dNext[1], dNext[0]];
    let mx = nPrev[0] + nNext[0], my = nPrev[1] + nNext[1];
    const ml = Math.hypot(mx, my);
    if (ml < 1e-9) {
      mx = nNext[0];
      my = nNext[1];
    } else {
      mx /= ml;
      my /= ml;
    }
    const cos = mx * nNext[0] + my * nNext[1];
    const k = dist / Math.max(cos, 0.25);
    out.push(points[i * 3]! + mx * k, points[i * 3 + 1]! + my * k, points[i * 3 + 2]!);
  }
  return out;
}

/** Tessellates any supported IfcCurve into a polyline. */
export function tessellateCurve(ctx: GeometryContext, id: number): Polyline {
  return ctx.curveGuard.run(id, () => tessellateCurveInner(ctx, id));
}

function tessellateCurveInner(ctx: GeometryContext, id: number): Polyline {
  const m = ctx.model;
  const t = m.type(id);
  switch (t) {
    case "IFCPOLYLINE": {
      const out: number[] = [];
      for (const p of m.refs(id, 0)) pushPoint(out, readPoint(ctx, p));
      return closeIfCoincident(out, ctx.epsilon);
    }
    case "IFCINDEXEDPOLYCURVE":
      return indexedPolyCurve(ctx, id);
    case "IFCCIRCLE":
    case "IFCELLIPSE": {
      const c = basisCurve(ctx, id);
      const out: number[] = [];
      c.sample(0, TWO_PI, out);
      out.length -= 3; // drop duplicated start point
      return { points: out, closed: true };
    }
    case "IFCTRIMMEDCURVE":
      return trimmedCurve(ctx, id);
    case "IFCCOMPOSITECURVE":
    case "IFCCOMPOSITECURVEONSURFACE":
    case "IFCBOUNDARYCURVE":
    case "IFCOUTERBOUNDARYCURVE":
      return compositeCurve(ctx, id);
    case "IFCBSPLINECURVEWITHKNOTS":
    case "IFCRATIONALBSPLINECURVEWITHKNOTS": {
      const c = basisCurve(ctx, id);
      const out: number[] = [];
      c.sample(c.domain[0], c.domain[1], out);
      return closeIfCoincident(out, ctx.epsilon);
    }
    case "IFCLINE": {
      // Unbounded line: represent its unit parameter range.
      const c = lineCurve(ctx, id);
      const out: number[] = [];
      c.sample(0, 1, out);
      return { points: out, closed: false };
    }
    case "IFCOFFSETCURVE2D":
      return offsetCurve2D(ctx, id);
    case "IFCCURVESEGMENT":
      return curveSegment(ctx, id);
    case undefined:
      throw new IfcDecodeError(`unresolved curve reference #${id}`, id, "IFC_REFERENCE_MISSING");
    default:
      throw new IfcDecodeError(`unsupported curve type ${t}`, id, "GEOMETRY_UNSUPPORTED");
  }
}

/** Applies a matrix to a polyline (returns a new one). */
export function transformPolyline(poly: Polyline, mat: Mat4): Polyline {
  const out: number[] = new Array(poly.points.length);
  for (let i = 0; i < poly.points.length; i += 3) {
    const p = transformPoint(mat, poly.points[i]!, poly.points[i + 1]!, poly.points[i + 2]!);
    out[i] = p[0];
    out[i + 1] = p[1];
    out[i + 2] = p[2];
  }
  return { points: out, closed: poly.closed };
}

