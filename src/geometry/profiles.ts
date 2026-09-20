// SPDX-License-Identifier: Apache-2.0
/**
 * Profile definitions → normalised 2D areas (outer loop counter-clockwise,
 * holes clockwise, no duplicate or collinear vertices) or open 2D curves.
 * Parameterised profiles are centred on their bounding box and then mapped
 * through the profile Position.
 */

import { IfcDecodeError } from "../diagnostics.ts";
import { transformPoint, type Mat4 } from "../math/mat4.ts";
import { signedArea } from "../triangulation/polygon.ts";
import type { GeometryContext } from "./context.ts";
import { tessellateCurve, offsetPolyline2D } from "./curves.ts";
import { axis2Placement2D, transformationOperator } from "./placement.ts";

/** One area of a profile: outer loop and holes, packed xy. */
export interface ProfileArea {
  outer: number[];
  holes: number[][];
}

export interface ProfileShape {
  /** Closed areas (empty for open profiles). */
  areas: ProfileArea[];
  /** Open centre curve for IfcArbitraryOpenProfileDef (packed xy). */
  open?: number[];
}

const profileCaches = new WeakMap<GeometryContext, Map<number, ProfileShape>>();

/** Cleans a closed loop: removes duplicates, closing point and collinear vertices. */
export function cleanLoop(xy: readonly number[], eps: number): number[] {
  const pts: number[] = [];
  const n = xy.length >> 1;
  for (let i = 0; i < n; i++) {
    const x = xy[i * 2]!, y = xy[i * 2 + 1]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const m = pts.length;
    if (m >= 2 && Math.abs(pts[m - 2]! - x) <= eps && Math.abs(pts[m - 1]! - y) <= eps) continue;
    pts.push(x, y);
  }
  // closing duplicate
  while (pts.length >= 4 && Math.abs(pts[0]! - pts[pts.length - 2]!) <= eps && Math.abs(pts[1]! - pts[pts.length - 1]!) <= eps) {
    pts.length -= 2;
  }
  // collinear removal (repeat until stable)
  let changed = true;
  let out = pts;
  while (changed && out.length >= 6) {
    changed = false;
    const next: number[] = [];
    const k = out.length >> 1;
    for (let i = 0; i < k; i++) {
      const pi = (i + k - 1) % k, ni = (i + 1) % k;
      const ax = out[pi * 2]!, ay = out[pi * 2 + 1]!;
      const bx = out[i * 2]!, by = out[i * 2 + 1]!;
      const cx = out[ni * 2]!, cy = out[ni * 2 + 1]!;
      const cr = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const len = Math.hypot(cx - ax, cy - ay);
      const between = (bx - ax) * (cx - bx) + (by - ay) * (cy - by) >= 0;
      if (Math.abs(cr) <= eps * Math.max(len, eps) && between) {
        changed = true;
        continue;
      }
      next.push(bx, by);
    }
    out = next;
  }
  return out;
}

function orientLoop(xy: number[], ccw: boolean): number[] {
  const area = signedArea(xy, 0, xy.length >> 1);
  if (area > 0 === ccw) return xy;
  const out: number[] = [];
  for (let i = (xy.length >> 1) - 1; i >= 0; i--) out.push(xy[i * 2]!, xy[i * 2 + 1]!);
  return out;
}

function normalizeArea(ctx: GeometryContext, outer: number[], holes: number[][], id: number): ProfileArea | undefined {
  const o = cleanLoop(outer, ctx.epsilon);
  if (o.length < 6 || Math.abs(signedArea(o, 0, o.length >> 1)) <= ctx.epsilon * ctx.epsilon) {
    ctx.report("PROFILE_INVALID", "profile outer loop is degenerate", id);
    return undefined;
  }
  const hs: number[][] = [];
  for (const h of holes) {
    const c = cleanLoop(h, ctx.epsilon);
    if (c.length >= 6 && Math.abs(signedArea(c, 0, c.length >> 1)) > ctx.epsilon * ctx.epsilon) hs.push(orientLoop(c, false));
  }
  return { outer: orientLoop(o, true), holes: hs };
}

function transformXY(xy: readonly number[], m: Mat4): number[] {
  const out = new Array<number>(xy.length);
  for (let i = 0; i < xy.length; i += 2) {
    const p = transformPoint(m, xy[i]!, xy[i + 1]!, 0);
    out[i] = p[0];
    out[i + 1] = p[1];
  }
  return out;
}

/** Closed curve → packed xy loop. */
function curveLoop(ctx: GeometryContext, curveId: number): number[] {
  const poly = tessellateCurve(ctx, curveId);
  const out: number[] = [];
  for (let i = 0; i < poly.points.length; i += 3) out.push(poly.points[i]!, poly.points[i + 1]!);
  return out;
}

/** Appends arc points from angle a0 to a1 around (cx, cy); endpoints included. */
function arc(ctx: GeometryContext, out: number[], cx: number, cy: number, r: number, a0: number, a1: number): void {
  if (!(r > 0)) {
    out.push(cx, cy);
    return;
  }
  const n = ctx.arcSegments(r, a1 - a0);
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
}

function positive(ctx: GeometryContext, id: number, index: number, name: string): number {
  const v = ctx.model.num(id, index);
  if (!(v > 0) || !Number.isFinite(v)) throw new IfcDecodeError(`${name} must be positive`, id, "PROFILE_INVALID");
  return v;
}

function optionalNonNeg(ctx: GeometryContext, id: number, index: number): number {
  const v = ctx.model.num(id, index);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function roundedRect(ctx: GeometryContext, w: number, h: number, r: number): number[] {
  const out: number[] = [];
  const hw = w / 2, hh = h / 2;
  const rr = Math.min(r, hw, hh);
  if (rr <= 0) return [-hw, -hh, hw, -hh, hw, hh, -hw, hh];
  arc(ctx, out, hw - rr, -hh + rr, rr, -Math.PI / 2, 0);
  arc(ctx, out, hw - rr, hh - rr, rr, 0, Math.PI / 2);
  arc(ctx, out, -hw + rr, hh - rr, rr, Math.PI / 2, Math.PI);
  arc(ctx, out, -hw + rr, -hh + rr, rr, Math.PI, (3 * Math.PI) / 2);
  return out;
}

function circleLoop(ctx: GeometryContext, r: number, ry = r): number[] {
  const n = Math.max(3, ctx.arcSegments(Math.max(r, ry), Math.PI * 2));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n;
    out.push(r * Math.cos(a), ry * Math.sin(a));
  }
  return out;
}

function shift(xy: number[], dx: number, dy: number): number[] {
  for (let i = 0; i < xy.length; i += 2) {
    xy[i]! += dx;
    xy[i + 1]! += dy;
  }
  return xy;
}

/** Symmetric or asymmetric I section, centred on its bounding box. */
function iShape(ctx: GeometryContext, bottomWidth: number, depth: number, tw: number, tfBottom: number, rBottom: number, topWidth: number, tfTop: number, rTop: number): number[] {
  const out: number[] = [];
  const hb = bottomWidth / 2, ht = topWidth / 2, hd = depth / 2, hw = tw / 2;
  const rb = Math.max(0, Math.min(rBottom, hb - hw, depth - tfBottom - tfTop));
  const rt = Math.max(0, Math.min(rTop, ht - hw, depth - tfBottom - tfTop));
  out.push(-hb, -hd, hb, -hd, hb, -hd + tfBottom);
  if (rb > 0) arc(ctx, out, hw + rb, -hd + tfBottom + rb, rb, -Math.PI / 2, -Math.PI);
  else out.push(hw, -hd + tfBottom);
  if (rt > 0) arc(ctx, out, hw + rt, hd - tfTop - rt, rt, Math.PI, Math.PI / 2);
  else out.push(hw, hd - tfTop);
  out.push(ht, hd - tfTop, ht, hd, -ht, hd, -ht, hd - tfTop);
  if (rt > 0) arc(ctx, out, -hw - rt, hd - tfTop - rt, rt, Math.PI / 2, 0);
  else out.push(-hw, hd - tfTop);
  if (rb > 0) arc(ctx, out, -hw - rb, -hd + tfBottom + rb, rb, 0, -Math.PI / 2);
  else out.push(-hw, -hd + tfBottom);
  out.push(-hb, -hd + tfBottom);
  return out;
}

function parameterized(ctx: GeometryContext, id: number, type: string): ProfileShape {
  const m = ctx.model;
  let areas: { outer: number[]; holes: number[][] }[] = [];
  switch (type) {
    case "IFCRECTANGLEPROFILEDEF": {
      const w = positive(ctx, id, 3, "XDim"), h = positive(ctx, id, 4, "YDim");
      areas = [{ outer: [-w / 2, -h / 2, w / 2, -h / 2, w / 2, h / 2, -w / 2, h / 2], holes: [] }];
      break;
    }
    case "IFCROUNDEDRECTANGLEPROFILEDEF": {
      const w = positive(ctx, id, 3, "XDim"), h = positive(ctx, id, 4, "YDim");
      areas = [{ outer: roundedRect(ctx, w, h, optionalNonNeg(ctx, id, 5)), holes: [] }];
      break;
    }
    case "IFCRECTANGLEHOLLOWPROFILEDEF": {
      const w = positive(ctx, id, 3, "XDim"), h = positive(ctx, id, 4, "YDim");
      const t = positive(ctx, id, 5, "WallThickness");
      const ri = optionalNonNeg(ctx, id, 6), ro = optionalNonNeg(ctx, id, 7);
      const inner = w > 2 * t && h > 2 * t ? [roundedRect(ctx, w - 2 * t, h - 2 * t, ri)] : [];
      areas = [{ outer: roundedRect(ctx, w, h, ro), holes: inner }];
      break;
    }
    case "IFCCIRCLEPROFILEDEF": {
      const r = positive(ctx, id, 3, "Radius");
      areas = [{ outer: circleLoop(ctx, r), holes: [] }];
      break;
    }
    case "IFCCIRCLEHOLLOWPROFILEDEF": {
      const r = positive(ctx, id, 3, "Radius");
      const t = positive(ctx, id, 4, "WallThickness");
      areas = [{ outer: circleLoop(ctx, r), holes: t < r ? [circleLoop(ctx, r - t)] : [] }];
      break;
    }
    case "IFCELLIPSEPROFILEDEF": {
      areas = [{ outer: circleLoop(ctx, positive(ctx, id, 3, "SemiAxis1"), positive(ctx, id, 4, "SemiAxis2")), holes: [] }];
      break;
    }
    case "IFCISHAPEPROFILEDEF": {
      const b = positive(ctx, id, 3, "OverallWidth"), d = positive(ctx, id, 4, "OverallDepth");
      const tw = positive(ctx, id, 5, "WebThickness"), tf = positive(ctx, id, 6, "FlangeThickness");
      const r = optionalNonNeg(ctx, id, 7);
      areas = [{ outer: iShape(ctx, b, d, tw, tf, r, b, tf, r), holes: [] }];
      break;
    }
    case "IFCASYMMETRICISHAPEPROFILEDEF": {
      const b = positive(ctx, id, 3, "BottomFlangeWidth"), d = positive(ctx, id, 4, "OverallDepth");
      const tw = positive(ctx, id, 5, "WebThickness"), tfb = positive(ctx, id, 6, "BottomFlangeThickness");
      const rb = optionalNonNeg(ctx, id, 7);
      const bt = m.num(id, 8) > 0 ? m.num(id, 8) : b;
      const tft = m.num(id, 9) > 0 ? m.num(id, 9) : tfb;
      const rt = optionalNonNeg(ctx, id, 10);
      areas = [{ outer: iShape(ctx, b, d, tw, tfb, rb, bt, tft, rt), holes: [] }];
      break;
    }
    case "IFCLSHAPEPROFILEDEF": {
      const d = positive(ctx, id, 3, "Depth");
      const w = m.num(id, 4) > 0 ? m.num(id, 4) : d;
      const t = positive(ctx, id, 5, "Thickness");
      const r = Math.min(optionalNonNeg(ctx, id, 6), w - t, d - t);
      const out: number[] = [0, 0, w, 0, w, t];
      if (r > 0) arc(ctx, out, t + r, t + r, r, -Math.PI / 2, -Math.PI);
      else out.push(t, t);
      out.push(t, d, 0, d);
      areas = [{ outer: shift(out, -w / 2, -d / 2), holes: [] }];
      break;
    }
    case "IFCUSHAPEPROFILEDEF": {
      const d = positive(ctx, id, 3, "Depth"), b = positive(ctx, id, 4, "FlangeWidth");
      const tw = positive(ctx, id, 5, "WebThickness"), tf = positive(ctx, id, 6, "FlangeThickness");
      const r = Math.min(optionalNonNeg(ctx, id, 7), b - tw, d / 2 - tf);
      const out: number[] = [0, 0, b, 0, b, tf];
      if (r > 0) arc(ctx, out, tw + r, tf + r, r, -Math.PI / 2, -Math.PI);
      else out.push(tw, tf);
      if (r > 0) arc(ctx, out, tw + r, d - tf - r, r, Math.PI, Math.PI / 2);
      else out.push(tw, d - tf);
      out.push(b, d - tf, b, d, 0, d);
      areas = [{ outer: shift(out, -b / 2, -d / 2), holes: [] }];
      break;
    }
    case "IFCCSHAPEPROFILEDEF": {
      const d = positive(ctx, id, 3, "Depth"), w = positive(ctx, id, 4, "Width");
      const t = positive(ctx, id, 5, "WallThickness");
      const g = Math.min(optionalNonNeg(ctx, id, 6), d / 2);
      const out: number[] = [0, 0, w, 0];
      if (g > t) out.push(w, g, w - t, g, w - t, t);
      else out.push(w, t);
      out.push(t, t, t, d - t);
      if (g > t) out.push(w - t, d - t, w - t, d - g, w, d - g);
      else out.push(w, d - t);
      out.push(w, d, 0, d);
      areas = [{ outer: shift(out, -w / 2, -d / 2), holes: [] }];
      break;
    }
    case "IFCTSHAPEPROFILEDEF": {
      const d = positive(ctx, id, 3, "Depth"), b = positive(ctx, id, 4, "FlangeWidth");
      const tw = positive(ctx, id, 5, "WebThickness"), tf = positive(ctx, id, 6, "FlangeThickness");
      const r = Math.min(optionalNonNeg(ctx, id, 7), b / 2 - tw / 2, d - tf);
      const out: number[] = [-tw / 2, -d / 2, tw / 2, -d / 2];
      if (r > 0) arc(ctx, out, tw / 2 + r, d / 2 - tf - r, r, Math.PI, Math.PI / 2);
      else out.push(tw / 2, d / 2 - tf);
      out.push(b / 2, d / 2 - tf, b / 2, d / 2, -b / 2, d / 2, -b / 2, d / 2 - tf);
      if (r > 0) arc(ctx, out, -tw / 2 - r, d / 2 - tf - r, r, Math.PI / 2, 0);
      else out.push(-tw / 2, d / 2 - tf);
      areas = [{ outer: out, holes: [] }];
      break;
    }
    case "IFCZSHAPEPROFILEDEF": {
      const d = positive(ctx, id, 3, "Depth"), b = positive(ctx, id, 4, "FlangeWidth");
      const tw = positive(ctx, id, 5, "WebThickness"), tf = positive(ctx, id, 6, "FlangeThickness");
      const out = [
        -b + tw / 2, -d / 2, tw / 2, -d / 2, tw / 2, d / 2 - tf, b - tw / 2, d / 2 - tf,
        b - tw / 2, d / 2, -tw / 2, d / 2, -tw / 2, -d / 2 + tf, -b + tw / 2, -d / 2 + tf,
      ];
      areas = [{ outer: out, holes: [] }];
      break;
    }
    case "IFCTRAPEZIUMPROFILEDEF": {
      const bx = positive(ctx, id, 3, "BottomXDim"), tx = positive(ctx, id, 4, "TopXDim");
      const y = positive(ctx, id, 5, "YDim");
      const off = Number.isFinite(m.num(id, 6)) ? m.num(id, 6) : 0;
      areas = [{ outer: [-bx / 2, -y / 2, bx / 2, -y / 2, -bx / 2 + off + tx, y / 2, -bx / 2 + off, y / 2], holes: [] }];
      break;
    }
    default:
      throw new IfcDecodeError(`unsupported profile ${type}`, id, "GEOMETRY_UNSUPPORTED");
  }
  const posId = m.ref(id, 2);
  const pos = posId > 0 ? axis2Placement2D(ctx, posId) : undefined;
  const result: ProfileShape = { areas: [] };
  for (const a of areas) {
    const outer = pos ? transformXY(a.outer, pos) : a.outer;
    const holes = pos ? a.holes.map((h) => transformXY(h, pos)) : a.holes;
    const n = normalizeArea(ctx, outer, holes, id);
    if (n) result.areas.push(n);
  }
  return result;
}

function openCurveXY(ctx: GeometryContext, curveId: number): number[] {
  const poly = tessellateCurve(ctx, curveId);
  const out: number[] = [];
  for (let i = 0; i < poly.points.length; i += 3) out.push(poly.points[i]!, poly.points[i + 1]!);
  if (poly.closed && out.length >= 2) out.push(out[0]!, out[1]!);
  return out;
}

function computeProfile(ctx: GeometryContext, id: number): ProfileShape {
  const m = ctx.model;
  const type = m.type(id);
  switch (type) {
    case "IFCARBITRARYCLOSEDPROFILEDEF": {
      const a = normalizeArea(ctx, curveLoop(ctx, m.ref(id, 2)), [], id);
      return { areas: a ? [a] : [] };
    }
    case "IFCARBITRARYPROFILEDEFWITHVOIDS": {
      const holes = m.refs(id, 3).map((c) => curveLoop(ctx, c));
      const a = normalizeArea(ctx, curveLoop(ctx, m.ref(id, 2)), holes, id);
      return { areas: a ? [a] : [] };
    }
    case "IFCARBITRARYOPENPROFILEDEF":
      return { areas: [], open: openCurveXY(ctx, m.ref(id, 2)) };
    case "IFCCENTERLINEPROFILEDEF": {
      const centre = tessellateCurve(ctx, m.ref(id, 2));
      const t = positive(ctx, id, 3, "Thickness");
      const left = offsetPolyline2D(centre.points, centre.closed, t / 2);
      const right = offsetPolyline2D(centre.points, centre.closed, -t / 2);
      const xy = (pts: number[]): number[] => {
        const o: number[] = [];
        for (let i = 0; i < pts.length; i += 3) o.push(pts[i]!, pts[i + 1]!);
        return o;
      };
      if (centre.closed) {
        const a = normalizeArea(ctx, xy(left), [xy(right)], id);
        return { areas: a ? [a] : [] };
      }
      const outline = xy(left);
      const r = xy(right);
      for (let i = r.length - 2; i >= 0; i -= 2) outline.push(r[i]!, r[i + 1]!);
      const a = normalizeArea(ctx, outline, [], id);
      return { areas: a ? [a] : [] };
    }
    case "IFCDERIVEDPROFILEDEF":
    case "IFCMIRROREDPROFILEDEF": {
      const parent = profileShape(ctx, m.ref(id, 2));
      let op: Mat4;
      if (type === "IFCMIRROREDPROFILEDEF" && m.ref(id, 3) <= 0) {
        op = new Float64Array([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      } else {
        op = transformationOperator(ctx, m.ref(id, 3));
      }
      const areas: ProfileArea[] = [];
      for (const a of parent.areas) {
        const n = normalizeArea(ctx, transformXY(a.outer, op), a.holes.map((h) => transformXY(h, op)), id);
        if (n) areas.push(n);
      }
      return parent.open ? { areas, open: transformXY(parent.open, op) } : { areas };
    }
    case "IFCCOMPOSITEPROFILEDEF": {
      const areas: ProfileArea[] = [];
      for (const p of m.refs(id, 2)) areas.push(...profileShape(ctx, p).areas);
      return { areas };
    }
    case undefined:
      throw new IfcDecodeError(`unresolved profile reference #${id}`, id, "IFC_REFERENCE_MISSING");
    default:
      return parameterized(ctx, id, type);
  }
}

/** Resolves (and caches) a profile definition. */
export function profileShape(ctx: GeometryContext, id: number): ProfileShape {
  let cache = profileCaches.get(ctx);
  if (!cache) {
    cache = new Map();
    profileCaches.set(ctx, cache);
  }
  const hit = cache.get(id);
  if (hit) return hit;
  const shape = ctx.itemGuard.run(id, () => computeProfile(ctx, id));
  cache.set(id, shape);
  return shape;
}
