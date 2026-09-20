// SPDX-License-Identifier: Apache-2.0
/**
 * Swept and primitive solids: extrusions (straight, tapered and open-profile
 * ribbons), revolutions, profile sweeps along directrices (fixed reference /
 * surface curve / directrix-curve variants), swept disks (with fillets,
 * inner radius and caps), CSG primitives and half-space solids.
 *
 * Every function returns a closed, consistently oriented (outward) mesh where
 * the input allows it, expressed in the frame of the representation item
 * (i.e. the item's own Position is applied).
 */

import { IfcDecodeError } from "../diagnostics.ts";
import type { Bounds3 } from "../math/bounds.ts";
import {
  cross,
  dot,
  identity,
  invert,
  leastAlignedAxis,
  multiply,
  normalize,
  rotation,
  scale,
  sub,
  transformPoint,
  type Mat4,
  type Vec3,
} from "../math/mat4.ts";
import { triangulatePolygon } from "../triangulation/polygon.ts";
import type { GeometryContext } from "./context.ts";
import { tessellateCurve, type Polyline } from "./curves.ts";
import { MeshBuilder, meshVolume, reverseWinding, transformMesh, type MeshData } from "./mesh.ts";
import { placementMatrix, readDirection } from "./placement.ts";
import { profileShape, type ProfileArea } from "./profiles.ts";

// ------------------------------------------------------------------ helpers

function capIndices(ctx: GeometryContext, area: ProfileArea, entityId: number): number[] {
  const coords: number[] = [...area.outer];
  const holeStarts: number[] = [];
  for (const h of area.holes) {
    holeStarts.push(coords.length >> 1);
    coords.push(...h);
  }
  const tri = triangulatePolygon(coords, holeStarts);
  if (tri.forced > 0 || !tri.ok) {
    ctx.report("TRIANGULATION_FAILED", `profile cap triangulation needed ${tri.forced} forced ears${tri.ok ? "" : " (loop discarded)"}`, entityId);
  }
  return tri.indices;
}

function loopsOf(area: ProfileArea): number[][] {
  return [area.outer, ...area.holes];
}

/** Ensures a closed mesh has positive volume (outward normals). */
export function orientOutward(mesh: MeshData): MeshData {
  return meshVolume(mesh) < 0 ? reverseWinding(mesh) : mesh;
}

/**
 * Extrudes profile areas along `delta` (profile plane is local XY). Bottom at
 * z-plane of the profile, top at +delta.
 */
export function extrudeAreas(ctx: GeometryContext, areas: readonly ProfileArea[], delta: Vec3, entityId: number, endAreas?: readonly ProfileArea[]): MeshData {
  const b = new MeshBuilder();
  for (let ai = 0; ai < areas.length; ai++) {
    const area = areas[ai]!;
    const end = endAreas?.[ai];
    const loops = loopsOf(area);
    const endLoops = end ? loopsOf(end) : undefined;
    const bottomStart: number[] = [];
    const topStart: number[] = [];
    // vertices: all loops bottom, then all loops top (same order as cap coordinates)
    const base = b.vertexCount;
    let count = 0;
    for (const loop of loops) {
      bottomStart.push(base + count);
      for (let i = 0; i < loop.length; i += 2) b.addVertex(loop[i]!, loop[i + 1]!, 0);
      count += loop.length >> 1;
    }
    const topBase = b.vertexCount;
    let offset = 0;
    for (let li = 0; li < loops.length; li++) {
      const loop = loops[li]!;
      const endLoop = endLoops?.[li];
      topStart.push(topBase + offset);
      for (let i = 0; i < loop.length; i += 2) {
        const x = endLoop ? endLoop[i]! : loop[i]!;
        const y = endLoop ? endLoop[i + 1]! : loop[i + 1]!;
        b.addVertex(x + delta[0], y + delta[1], delta[2]);
      }
      offset += loop.length >> 1;
    }
    const cap = capIndices(ctx, area, entityId);
    for (let i = 0; i < cap.length; i += 3) {
      // bottom faces -z (reversed), top faces +z
      b.addTriangle(base + cap[i]!, base + cap[i + 2]!, base + cap[i + 1]!);
      b.addTriangle(topBase + cap[i]!, topBase + cap[i + 1]!, topBase + cap[i + 2]!);
    }
    for (let li = 0; li < loops.length; li++) {
      const n = loops[li]!.length >> 1;
      const bs = bottomStart[li]!, ts = topStart[li]!;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        b.addQuad(bs + i, bs + j, ts + j, ts + i);
      }
    }
  }
  const mesh = b.build();
  return delta[2] < 0 ? reverseWinding(mesh) : mesh;
}

/** Ribbon surface for an open profile curve extruded along delta. */
function extrudeOpen(open: readonly number[], delta: Vec3): MeshData {
  const b = new MeshBuilder();
  const n = open.length >> 1;
  for (let i = 0; i < n; i++) b.addVertex(open[i * 2]!, open[i * 2 + 1]!, 0);
  for (let i = 0; i < n; i++) b.addVertex(open[i * 2]! + delta[0], open[i * 2 + 1]! + delta[1], delta[2]);
  for (let i = 0; i + 1 < n; i++) b.addQuad(i, i + 1, n + i + 1, n + i);
  return b.build();
}

// ------------------------------------------------------------- extrusions

export function extrudedAreaSolid(ctx: GeometryContext, id: number): MeshData {
  const m = ctx.model;
  const type = m.type(id);
  const profile = profileShape(ctx, m.ref(id, 0));
  const position = placementMatrix(ctx, m.ref(id, 1));
  const dirRatios = readDirection(ctx, m.ref(id, 2));
  const depth = m.num(id, 3);
  if (!(depth > 0) || !Number.isFinite(depth)) throw new IfcDecodeError(`extrusion depth must be positive (got ${depth})`, id, "GEOMETRY_INVALID");
  const dir = normalize(dirRatios);
  if (Math.abs(dir[2]) < 1e-9) throw new IfcDecodeError("extrusion direction lies in the profile plane", id, "GEOMETRY_INVALID");
  const delta = scale(dir, depth);
  let mesh: MeshData;
  if (profile.open) {
    mesh = extrudeOpen(profile.open, delta);
  } else {
    let endAreas: ProfileArea[] | undefined;
    if (type === "IFCEXTRUDEDAREASOLIDTAPERED") {
      const end = profileShape(ctx, m.ref(id, 4));
      const compatible =
        end.areas.length === profile.areas.length &&
        end.areas.every((a, i) => a.outer.length === profile.areas[i]!.outer.length && a.holes.length === profile.areas[i]!.holes.length && a.holes.every((h, k) => h.length === profile.areas[i]!.holes[k]!.length));
      if (compatible) endAreas = end.areas;
      else ctx.report("GEOMETRY_UNSUPPORTED", "tapered extrusion with topologically different end profile rendered as straight extrusion", id, "info");
    }
    mesh = extrudeAreas(ctx, profile.areas, delta, id, endAreas);
  }
  return transformMesh(mesh, position);
}

// ------------------------------------------------------------- revolution

export function revolvedAreaSolid(ctx: GeometryContext, id: number): MeshData {
  const m = ctx.model;
  const profile = profileShape(ctx, m.ref(id, 0));
  const position = placementMatrix(ctx, m.ref(id, 1));
  const axisPlacement = placementMatrix(ctx, m.ref(id, 2));
  let angle = m.num(id, 3) * ctx.angleScale;
  if (!Number.isFinite(angle) || angle === 0) throw new IfcDecodeError("revolution angle must be non-zero", id, "GEOMETRY_INVALID");
  const full = Math.abs(angle) >= Math.PI * 2 - 1e-9;
  if (full) angle = Math.sign(angle) * Math.PI * 2;
  const origin: Vec3 = [axisPlacement[12]!, axisPlacement[13]!, axisPlacement[14]!];
  const axis = normalize([axisPlacement[8]!, axisPlacement[9]!, axisPlacement[10]!]);
  let maxR = 0;
  const loops: number[][] = [];
  for (const a of profile.areas) loops.push(...loopsOf(a));
  for (const l of loops) {
    for (let i = 0; i < l.length; i += 2) {
      const d = sub([l[i]!, l[i + 1]!, 0], origin);
      const along = dot(d, axis);
      maxR = Math.max(maxR, Math.hypot(d[0] - axis[0] * along, d[1] - axis[1] * along, d[2] - axis[2] * along));
    }
  }
  const steps = Math.max(ctx.arcSegments(maxR, Math.abs(angle)), full ? 8 : 2);
  const b = new MeshBuilder();
  const ringCount = full ? steps : steps + 1;
  const rotations: Mat4[] = [];
  for (let s = 0; s < ringCount; s++) {
    const r = rotation(axis, (angle * s) / steps);
    // rotate about axis through origin: T(o) R T(-o)
    const t = identity();
    t[12] = origin[0];
    t[13] = origin[1];
    t[14] = origin[2];
    const ti = identity();
    ti[12] = -origin[0];
    ti[13] = -origin[1];
    ti[14] = -origin[2];
    rotations.push(multiply(t, multiply(r, ti)));
  }
  for (const area of profile.areas) {
    const areaLoops = loopsOf(area);
    const loopBase: number[] = [];
    const areaVertexCount = areaLoops.reduce((s, l) => s + (l.length >> 1), 0);
    const ringBase = b.vertexCount;
    for (let s = 0; s < ringCount; s++) {
      for (const l of areaLoops) {
        for (let i = 0; i < l.length; i += 2) {
          const p = transformPoint(rotations[s]!, l[i]!, l[i + 1]!, 0);
          b.addVertex(p[0], p[1], p[2]);
        }
      }
    }
    let off = 0;
    for (const l of areaLoops) {
      loopBase.push(off);
      off += l.length >> 1;
    }
    for (let s = 0; s < steps; s++) {
      const r0 = ringBase + s * areaVertexCount;
      const r1 = ringBase + ((s + 1) % ringCount) * areaVertexCount;
      for (let li = 0; li < areaLoops.length; li++) {
        const n = areaLoops[li]!.length >> 1;
        const lb = loopBase[li]!;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          b.addQuad(r0 + lb + i, r0 + lb + j, r1 + lb + j, r1 + lb + i);
        }
      }
    }
    if (!full) {
      const cap = capIndices(ctx, area, id);
      const last = ringBase + steps * areaVertexCount;
      for (let i = 0; i < cap.length; i += 3) {
        b.addTriangle(ringBase + cap[i]!, ringBase + cap[i + 2]!, ringBase + cap[i + 1]!);
        b.addTriangle(last + cap[i]!, last + cap[i + 1]!, last + cap[i + 2]!);
      }
    }
  }
  return transformMesh(orientOutward(b.build()), position);
}

// ------------------------------------------------------------------ sweeps

interface Frame {
  p: Vec3;
  /** Tangent of the incoming segment (unit). */
  tin: Vec3;
  /** Tangent of the outgoing segment (unit). */
  tout: Vec3;
  x: Vec3;
  y: Vec3;
}

function polylinePoints(poly: Polyline): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i < poly.points.length; i += 3) {
    const p: Vec3 = [poly.points[i]!, poly.points[i + 1]!, poly.points[i + 2]!];
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]) > 1e-12) pts.push(p);
  }
  return pts;
}

/** Trims a polyline by IFC parameters (segment-index parameterisation). */
function trimPolyline(pts: Vec3[], start: number, end: number): Vec3[] {
  const n = pts.length;
  if (n < 2) return pts;
  const at = (t: number): Vec3 => {
    const i = Math.min(Math.max(Math.floor(t), 0), n - 2);
    const f = Math.min(Math.max(t - i, 0), 1);
    const a = pts[i]!, b = pts[i + 1]!;
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  };
  const t0 = Math.max(0, Math.min(start, end));
  const t1 = Math.min(n - 1, Math.max(start, end));
  const out: Vec3[] = [at(t0)];
  for (let i = Math.floor(t0) + 1; i < t1; i++) out.push(pts[i]!);
  out.push(at(t1));
  return out;
}

/**
 * Builds frames along a directrix. `reference(tangent)` returns the desired
 * profile X axis before orthogonalisation; when undefined, rotation-minimising
 * (parallel transport) frames are used.
 */
function directrixFrames(pts: Vec3[], closed: boolean, reference?: (t: Vec3) => Vec3 | undefined): Frame[] {
  const n = pts.length;
  const seg = (i: number): Vec3 => normalize(sub(pts[(i + 1) % n]!, pts[i]!));
  const frames: Frame[] = [];
  let prevX: Vec3 | undefined;
  let prevT: Vec3 | undefined;
  for (let i = 0; i < n; i++) {
    const tin = i > 0 ? seg(i - 1) : closed ? seg(n - 1) : seg(0);
    const tout = i < n - 1 ? seg(i) : closed ? seg(i) : tin;
    let x: Vec3 | undefined;
    const t = tin;
    // Frames are perpendicular to the outgoing segment (the closing segment for closed loops).
    const tt = i < n - 1 || closed ? tout : tin;
    const ref = reference?.(tt);
    if (ref) {
      x = sub(ref, scale(tt, dot(ref, tt)));
    } else if (prevX && prevT) {
      // parallel transport of the previous X across the turn prevT → tt
      const axis = cross(prevT, tt);
      const s = Math.hypot(axis[0], axis[1], axis[2]);
      const c = dot(prevT, tt);
      x = prevX;
      if (s > 1e-12) {
        const r = rotation(normalize(axis), Math.atan2(s, c));
        x = [r[0]! * x[0] + r[4]! * x[1] + r[8]! * x[2], r[1]! * x[0] + r[5]! * x[1] + r[9]! * x[2], r[2]! * x[0] + r[6]! * x[1] + r[10]! * x[2]];
      }
      x = sub(x, scale(tt, dot(x, tt)));
    }
    if (!x || Math.hypot(x[0], x[1], x[2]) < 1e-9) x = cross(leastAlignedAxis(tt), tt);
    x = normalize(x);
    const y = normalize(cross(tt, x));
    frames.push({ p: pts[i]!, tin: t, tout, x, y });
    prevX = x;
    prevT = tt;
  }
  return frames;
}

/**
 * Places a 2D cross-section ring at each frame; interior rings are projected
 * onto the mitre (bisector) plane so the section stays constant.
 */
function sectionRing(frame: Frame, loop: readonly number[], isEnd: boolean, maxMitre: number): Vec3[] {
  const out: Vec3[] = [];
  const bis = normalize([frame.tin[0] + frame.tout[0], frame.tin[1] + frame.tout[1], frame.tin[2] + frame.tout[2]]);
  const useMitre = !isEnd && Math.hypot(bis[0], bis[1], bis[2]) > 0.5;
  const plane = useMitre ? bis : frame.tout;
  const along = isEnd ? frame.tin : frame.tout;
  const denom = dot(along, plane);
  for (let i = 0; i < loop.length; i += 2) {
    const u = loop[i]!, v = loop[i + 1]!;
    let off: Vec3 = [frame.x[0] * u + frame.y[0] * v, frame.x[1] * u + frame.y[1] * v, frame.x[2] * u + frame.y[2] * v];
    if (useMitre && Math.abs(denom) > 1e-6) {
      const k = dot(off, plane) / denom;
      const shift = Math.max(-maxMitre, Math.min(maxMitre, k));
      off = sub(off, scale(along, shift));
    }
    out.push([frame.p[0] + off[0], frame.p[1] + off[1], frame.p[2] + off[2]]);
  }
  return out;
}

/**
 * Sweeps profile areas along a directrix polyline; caps open ends.
 * Profile loops are in the frame plane (profile X → frame x, Y → frame y).
 */
function sweepAreas(ctx: GeometryContext, areas: readonly ProfileArea[], frames: Frame[], closed: boolean, entityId: number): MeshData {
  const b = new MeshBuilder();
  let extent = 0;
  for (const a of areas) for (let i = 0; i < a.outer.length; i++) extent = Math.max(extent, Math.abs(a.outer[i]!));
  const maxMitre = extent * 4 + ctx.epsilon;
  const nf = frames.length;
  const rings = closed ? nf : nf;
  for (const area of areas) {
    const loops = loopsOf(area);
    const perRing = loops.reduce((s, l) => s + (l.length >> 1), 0);
    const base = b.vertexCount;
    for (let f = 0; f < rings; f++) {
      const isEnd = !closed && (f === 0 || f === nf - 1);
      for (const l of loops) for (const p of sectionRing(frames[f]!, l, isEnd, maxMitre)) b.addVertex(p[0], p[1], p[2]);
    }
    const segs = closed ? nf : nf - 1;
    for (let f = 0; f < segs; f++) {
      const r0 = base + f * perRing;
      const r1 = base + ((f + 1) % rings) * perRing;
      let lb = 0;
      for (const l of loops) {
        const n = l.length >> 1;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          b.addQuad(r0 + lb + i, r0 + lb + j, r1 + lb + j, r1 + lb + i);
        }
        lb += n;
      }
    }
    if (!closed) {
      const cap = capIndices(ctx, area, entityId);
      const last = base + (nf - 1) * perRing;
      for (let i = 0; i < cap.length; i += 3) {
        b.addTriangle(base + cap[i]!, base + cap[i + 2]!, base + cap[i + 1]!);
        b.addTriangle(last + cap[i]!, last + cap[i + 1]!, last + cap[i + 2]!);
      }
    }
  }
  return orientOutward(b.build());
}

function directrixPoints(ctx: GeometryContext, id: number, directrixIndex: number, startIndex: number, endIndex: number): { pts: Vec3[]; closed: boolean } {
  const m = ctx.model;
  const directrixId = m.ref(id, directrixIndex);
  const poly = tessellateCurve(ctx, directrixId);
  let pts = polylinePoints(poly);
  let closed = poly.closed && pts.length >= 3;
  const start = startIndex >= 0 ? m.num(id, startIndex) : Number.NaN;
  const end = endIndex >= 0 ? m.num(id, endIndex) : Number.NaN;
  if ((Number.isFinite(start) || Number.isFinite(end)) && m.type(directrixId) === "IFCPOLYLINE") {
    pts = trimPolyline(closed ? [...pts, pts[0]!] : pts, Number.isFinite(start) ? start : 0, Number.isFinite(end) ? end : pts.length - 1);
    closed = false;
  }
  if (pts.length < 2) throw new IfcDecodeError("directrix has fewer than two distinct points", id, "SWEEP_INVALID");
  return { pts, closed };
}

export function profileSweepSolid(ctx: GeometryContext, id: number): MeshData {
  const m = ctx.model;
  const type = m.type(id);
  const profile = profileShape(ctx, m.ref(id, 0));
  const position = placementMatrix(ctx, m.ref(id, 1));
  const { pts, closed } = directrixPoints(ctx, id, 2, 3, 4);
  let reference: ((t: Vec3) => Vec3 | undefined) | undefined;
  if (type === "IFCFIXEDREFERENCESWEPTAREASOLID") {
    const fixed = normalize(readDirection(ctx, m.ref(id, 5)));
    reference = () => fixed;
  } else if (type === "IFCSURFACECURVESWEPTAREASOLID") {
    const surface = m.ref(id, 5);
    let normal: Vec3 = [0, 0, 1];
    if (m.type(surface) === "IFCPLANE") {
      const p = placementMatrix(ctx, m.ref(surface, 0));
      normal = normalize([p[8]!, p[9]!, p[10]!]);
    }
    // profile Y follows the surface normal → X = normal × tangent
    reference = (t) => cross(normal, t);
  }
  if (profile.areas.length === 0) throw new IfcDecodeError("sweep profile has no closed area", id, "SWEEP_INVALID");
  const frames = directrixFrames(pts, closed, reference);
  return transformMesh(sweepAreas(ctx, profile.areas, frames, closed, id), position);
}

/** Replaces polyline corners with circular fillets of radius r. */
function filletPolyline(ctx: GeometryContext, pts: Vec3[], r: number): Vec3[] {
  if (!(r > 0) || pts.length < 3) return pts;
  const out: Vec3[] = [pts[0]!];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i]!;
    const a = normalize(sub(p, pts[i - 1]!));
    const bdir = normalize(sub(pts[i + 1]!, p));
    const cosTurn = dot(a, bdir);
    const theta = Math.acos(Math.max(-1, Math.min(1, -cosTurn))); // interior angle
    if (theta > Math.PI - 1e-6 || theta < 1e-6) {
      out.push(p);
      continue;
    }
    const lenIn = Math.hypot(...sub(p, pts[i - 1]!));
    const lenOut = Math.hypot(...sub(pts[i + 1]!, p));
    const d = Math.min(r / Math.tan(theta / 2), lenIn / 2, lenOut / 2);
    const rr = d * Math.tan(theta / 2);
    const t1: Vec3 = sub(p, scale(a, d));
    const t2: Vec3 = [p[0] + bdir[0] * d, p[1] + bdir[1] * d, p[2] + bdir[2] * d];
    const bis = normalize(sub(bdir, a));
    const centerDist = rr / Math.sin(theta / 2);
    const c: Vec3 = [p[0] + bis[0] * centerDist, p[1] + bis[1] * centerDist, p[2] + bis[2] * centerDist];
    const u = normalize(sub(t1, c));
    const w = normalize(sub(t2, c));
    const sweep = Math.acos(Math.max(-1, Math.min(1, dot(u, w))));
    const nrm = normalize(cross(u, w));
    const v = cross(nrm, u);
    const steps = Math.max(1, ctx.arcSegments(rr, sweep));
    for (let s = 0; s <= steps; s++) {
      const ang = (sweep * s) / steps;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      out.push([c[0] + rr * (u[0] * ca + v[0] * sa), c[1] + rr * (u[1] * ca + v[1] * sa), c[2] + rr * (u[2] * ca + v[2] * sa)]);
    }
  }
  out.push(pts[pts.length - 1]!);
  return out;
}

export function sweptDiskSolid(ctx: GeometryContext, id: number): MeshData {
  const m = ctx.model;
  const type = m.type(id);
  const radius = m.num(id, 1);
  if (!(radius > 0) || !Number.isFinite(radius)) throw new IfcDecodeError("swept disk radius must be positive", id, "SWEEP_INVALID");
  const innerRaw = m.num(id, 2);
  const inner = Number.isFinite(innerRaw) && innerRaw > 0 && innerRaw < radius ? innerRaw : 0;
  let { pts, closed } = directrixPoints(ctx, id, 0, 3, 4);
  if (type === "IFCSWEPTDISKSOLIDPOLYGONAL") {
    const fillet = m.num(id, 5);
    if (Number.isFinite(fillet) && fillet > 0) pts = filletPolyline(ctx, pts, fillet);
  }
  // near-reversal detection
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = normalize(sub(pts[i]!, pts[i - 1]!));
    const b = normalize(sub(pts[i + 1]!, pts[i]!));
    if (dot(a, b) < -0.999) {
      ctx.report("SWEEP_INVALID", "directrix turns back on itself; mitre clamped", id);
      break;
    }
  }
  const segments = Math.max(8, ctx.arcSegments(radius, Math.PI * 2));
  const circle = (r: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < segments; i++) {
      const a = (Math.PI * 2 * i) / segments;
      out.push(r * Math.cos(a), r * Math.sin(a));
    }
    return out;
  };
  const area: ProfileArea = { outer: circle(radius), holes: inner > 0 ? [reverseXY(circle(inner))] : [] };
  const frames = directrixFrames(pts, closed);
  return sweepAreas(ctx, [area], frames, closed, id);
}

function reverseXY(xy: number[]): number[] {
  const out: number[] = [];
  for (let i = (xy.length >> 1) - 1; i >= 0; i--) out.push(xy[i * 2]!, xy[i * 2 + 1]!);
  return out;
}

// -------------------------------------------------------------- primitives

function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): MeshData {
  const b = new MeshBuilder();
  const v = [
    b.addVertex(x0, y0, z0), b.addVertex(x1, y0, z0), b.addVertex(x1, y1, z0), b.addVertex(x0, y1, z0),
    b.addVertex(x0, y0, z1), b.addVertex(x1, y0, z1), b.addVertex(x1, y1, z1), b.addVertex(x0, y1, z1),
  ];
  const q = (a: number, bb: number, c: number, d: number): void => b.addQuad(v[a]!, v[bb]!, v[c]!, v[d]!);
  q(0, 3, 2, 1); // bottom
  q(4, 5, 6, 7); // top
  q(0, 1, 5, 4);
  q(1, 2, 6, 5);
  q(2, 3, 7, 6);
  q(3, 0, 4, 7);
  return b.build();
}

export function boxMesh(bounds: Bounds3): MeshData {
  return box(bounds.minX, bounds.minY, bounds.minZ, bounds.maxX, bounds.maxY, bounds.maxZ);
}

function coneOrCylinder(ctx: GeometryContext, rBottom: number, rTop: number, h: number): MeshData {
  const n = Math.max(8, ctx.arcSegments(Math.max(rBottom, rTop), Math.PI * 2));
  const b = new MeshBuilder();
  const bottomCenter = b.addVertex(0, 0, 0);
  const topCenter = b.addVertex(0, 0, h);
  const bottom: number[] = [], top: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n;
    bottom.push(b.addVertex(rBottom * Math.cos(a), rBottom * Math.sin(a), 0));
    top.push(rTop > 0 ? b.addVertex(rTop * Math.cos(a), rTop * Math.sin(a), h) : topCenter);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    b.addTriangle(bottomCenter, bottom[j]!, bottom[i]!);
    if (rTop > 0) {
      b.addTriangle(topCenter, top[i]!, top[j]!);
      b.addQuad(bottom[i]!, bottom[j]!, top[j]!, top[i]!);
    } else {
      b.addTriangle(bottom[i]!, bottom[j]!, topCenter);
    }
  }
  return b.build();
}

function sphere(ctx: GeometryContext, r: number): MeshData {
  const n = Math.max(12, ctx.arcSegments(r, Math.PI * 2));
  const rings = Math.max(6, n >> 1);
  const b = new MeshBuilder();
  const south = b.addVertex(0, 0, -r);
  const north = b.addVertex(0, 0, r);
  const grid: number[][] = [];
  for (let j = 1; j < rings; j++) {
    const phi = -Math.PI / 2 + (Math.PI * j) / rings;
    const row: number[] = [];
    for (let i = 0; i < n; i++) {
      const th = (Math.PI * 2 * i) / n;
      row.push(b.addVertex(r * Math.cos(phi) * Math.cos(th), r * Math.cos(phi) * Math.sin(th), r * Math.sin(phi)));
    }
    grid.push(row);
  }
  for (let i = 0; i < n; i++) {
    const k = (i + 1) % n;
    b.addTriangle(south, grid[0]![k]!, grid[0]![i]!);
    b.addTriangle(north, grid[grid.length - 1]![i]!, grid[grid.length - 1]![k]!);
    for (let j = 0; j + 1 < grid.length; j++) b.addQuad(grid[j]![i]!, grid[j]![k]!, grid[j + 1]![k]!, grid[j + 1]![i]!);
  }
  return b.build();
}

export function csgPrimitive(ctx: GeometryContext, id: number): MeshData {
  const m = ctx.model;
  const type = m.type(id);
  const position = placementMatrix(ctx, m.ref(id, 0));
  const pos = (i: number, name: string): number => {
    const v = m.num(id, i);
    if (!(v > 0) || !Number.isFinite(v)) throw new IfcDecodeError(`${name} must be positive`, id, "GEOMETRY_INVALID");
    return v;
  };
  let mesh: MeshData;
  switch (type) {
    case "IFCBLOCK":
      mesh = box(0, 0, 0, pos(1, "XLength"), pos(2, "YLength"), pos(3, "ZLength"));
      break;
    case "IFCRECTANGULARPYRAMID": {
      const x = pos(1, "XLength"), y = pos(2, "YLength"), h = pos(3, "Height");
      const b = new MeshBuilder();
      const v0 = b.addVertex(0, 0, 0), v1 = b.addVertex(x, 0, 0), v2 = b.addVertex(x, y, 0), v3 = b.addVertex(0, y, 0);
      const apex = b.addVertex(x / 2, y / 2, h);
      b.addQuad(v0, v3, v2, v1);
      b.addTriangle(v0, v1, apex);
      b.addTriangle(v1, v2, apex);
      b.addTriangle(v2, v3, apex);
      b.addTriangle(v3, v0, apex);
      mesh = b.build();
      break;
    }
    case "IFCRIGHTCIRCULARCONE":
      mesh = coneOrCylinder(ctx, pos(2, "BottomRadius"), 0, pos(1, "Height"));
      break;
    case "IFCRIGHTCIRCULARCYLINDER":
      mesh = coneOrCylinder(ctx, pos(2, "Radius"), pos(2, "Radius"), pos(1, "Height"));
      break;
    case "IFCSPHERE":
      mesh = sphere(ctx, pos(1, "Radius"));
      break;
    default:
      throw new IfcDecodeError(`unsupported CSG primitive ${type}`, id, "GEOMETRY_UNSUPPORTED");
  }
  return transformMesh(mesh, position);
}

// ------------------------------------------------------------- half-spaces

/**
 * Finite stand-in for a half-space solid covering `domain` (bounds of the
 * other Boolean operand in the item frame). The half-space material lies on
 * the side the plane normal points away from when AgreementFlag is TRUE.
 */
export function halfSpaceMesh(ctx: GeometryContext, id: number, domain: Bounds3): MeshData {
  const m = ctx.model;
  const type = m.type(id);
  const surface = m.ref(id, 0);
  if (m.type(surface) !== "IFCPLANE") throw new IfcDecodeError(`half-space base surface ${m.type(surface)} is not supported`, id, "GEOMETRY_UNSUPPORTED");
  const plane = placementMatrix(ctx, m.ref(surface, 0));
  const agreement = m.bool(id, 1) !== false;
  const inv = invert(plane);
  if (!inv) throw new IfcDecodeError("singular half-space plane placement", id, "GEOMETRY_INVALID");
  // domain corners in plane coordinates
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < 8; i++) {
    const p = transformPoint(inv, i & 1 ? domain.maxX : domain.minX, i & 2 ? domain.maxY : domain.minY, i & 4 ? domain.maxZ : domain.minZ);
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
    minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]);
  }
  const size = Math.max(maxX - minX, maxY - minY, maxZ - minZ, ctx.epsilon * 1000);
  const margin = size * 0.5 + ctx.epsilon * 100;
  const z0 = agreement ? Math.min(minZ, 0) - margin : 0;
  const z1 = agreement ? 0 : Math.max(maxZ, 0) + margin;
  const local = box(minX - margin, minY - margin, z0, maxX + margin, maxY + margin, z1);
  if (type === "IFCPOLYGONALBOUNDEDHALFSPACE") {
    // Intersect with the prism of the polygonal boundary (along Position Z).
    const position = placementMatrix(ctx, m.ref(id, 2));
    const poly = tessellateCurve(ctx, m.ref(id, 3));
    const xy: number[] = [];
    for (let i = 0; i < poly.points.length; i += 3) xy.push(poly.points[i]!, poly.points[i + 1]!);
    const profile = profileFromLoop(ctx, xy, id);
    const posInv = invert(position);
    if (!posInv || !profile) throw new IfcDecodeError("invalid polygonal boundary", id, "GEOMETRY_INVALID");
    let pzMin = Infinity, pzMax = -Infinity;
    for (let i = 0; i < 8; i++) {
      const p = transformPoint(posInv, i & 1 ? domain.maxX : domain.minX, i & 2 ? domain.maxY : domain.minY, i & 4 ? domain.maxZ : domain.minZ);
      pzMin = Math.min(pzMin, p[2]);
      pzMax = Math.max(pzMax, p[2]);
    }
    const h0 = pzMin - margin, h1 = pzMax + margin;
    const prism = transformMesh(extrudeAreas(ctx, [profile], [0, 0, h1 - h0], id), multiply(position, translationMat(0, 0, h0)));
    return intersectMeshes(ctx, prism, transformMesh(local, plane));
  }
  return transformMesh(local, plane);
}

function translationMat(x: number, y: number, z: number): Mat4 {
  const t = identity();
  t[12] = x;
  t[13] = y;
  t[14] = z;
  return t;
}

function profileFromLoop(ctx: GeometryContext, xy: number[], _id: number): ProfileArea | undefined {
  // reuse profile normalisation rules
  const clean: number[] = [];
  for (let i = 0; i < xy.length; i += 2) {
    const n = clean.length;
    if (n >= 2 && Math.abs(clean[n - 2]! - xy[i]!) <= ctx.epsilon && Math.abs(clean[n - 1]! - xy[i + 1]!) <= ctx.epsilon) continue;
    clean.push(xy[i]!, xy[i + 1]!);
  }
  while (clean.length >= 4 && Math.abs(clean[0]! - clean[clean.length - 2]!) <= ctx.epsilon && Math.abs(clean[1]! - clean[clean.length - 1]!) <= ctx.epsilon) clean.length -= 2;
  if (clean.length < 6) return undefined;
  let area = 0;
  const n = clean.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) area += clean[j * 2]! * clean[i * 2 + 1]! - clean[i * 2]! * clean[j * 2 + 1]!;
  return { outer: area >= 0 ? clean : reverseXY(clean), holes: [] };
}

/** Intersection of a prism with a half-space box through the CSG backend. */
function intersectMeshes(ctx: GeometryContext, a: MeshData, b: MeshData): MeshData {
  const sa = ctx.csg.create(a);
  let sb;
  let r;
  try {
    sb = ctx.csg.create(b);
    r = ctx.csg.apply("intersection", sa, sb);
    const out = ctx.csg.exportMesh(r);
    return { positions: out.positions, indices: out.indices };
  } finally {
    if (r) ctx.csg.dispose(r);
    if (sb) ctx.csg.dispose(sb);
    ctx.csg.dispose(sa);
  }
}
