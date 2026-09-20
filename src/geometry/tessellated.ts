// SPDX-License-Identifier: Apache-2.0
/**
 * Tessellated and boundary-represented geometry: triangulated / polygonal
 * face sets (one-based indices, optional PnIndex, per-face colour maps),
 * faceted BReps (with voids), shell- and face-based surface models, advanced
 * BReps (planar faces, B-spline surfaces), curve-bounded planes and bounding
 * boxes. Every index is validated before use.
 */

import { IfcDecodeError } from "../diagnostics.ts";
import type { Rgba } from "../ifc/styles.ts";
import { transformPoint, type Vec3 } from "../math/mat4.ts";
import { triangulateFace } from "../triangulation/face.ts";
import type { GeometryContext } from "./context.ts";
import { tessellateCurve } from "./curves.ts";
import { MeshBuilder, type MeshData } from "./mesh.ts";
import { placementMatrix, readPoint } from "./placement.ts";
import { boxMesh } from "./solids.ts";

export interface ColoredMesh {
  mesh: MeshData;
  color?: Rgba;
}

function pointList(ctx: GeometryContext, listId: number, ownerId: number): Float64Array {
  const m = ctx.model;
  const t = m.type(listId);
  if (t !== "IFCCARTESIANPOINTLIST3D" && t !== "IFCCARTESIANPOINTLIST2D") {
    throw new IfcDecodeError(`expected IfcCartesianPointList, found ${t ?? "missing entity"}`, ownerId, t === undefined ? "IFC_REFERENCE_MISSING" : "GEOMETRY_INVALID");
  }
  const coords = m.store.numberRows(m.attr(listId, 0), 3);
  if (!coords) throw new IfcDecodeError("non-numeric coordinate list", listId, "GEOMETRY_INVALID");
  for (let i = 0; i < coords.length; i++) if (!Number.isFinite(coords[i]!)) throw new IfcDecodeError("non-finite coordinate", listId, "GEOMETRY_INVALID");
  return coords;
}

/** Validated 0-based vertex index for a 1-based index, honouring PnIndex. */
function makeIndexer(pointCount: number, pnIndex: Float64Array | undefined, ownerId: number): (oneBased: number) => number {
  return (i1: number): number => {
    let k = i1;
    if (pnIndex) {
      if (!(k >= 1 && k <= pnIndex.length) || !Number.isInteger(k)) throw new IfcDecodeError(`PnIndex reference ${k} out of range 1..${pnIndex.length}`, ownerId, "GEOMETRY_INVALID");
      k = pnIndex[k - 1]!;
    }
    if (!(k >= 1 && k <= pointCount) || !Number.isInteger(k)) {
      throw new IfcDecodeError(`coordinate index ${k} out of range 1..${pointCount}`, ownerId, "GEOMETRY_INVALID");
    }
    return k - 1;
  };
}

/** Colour-map assignment for a tessellated face set, or undefined. */
const colourMapIndexes = new WeakMap<GeometryContext, Map<number, number>>();

function colourMap(ctx: GeometryContext, faceSetId: number): { colours: Rgba[]; faceColour: Float64Array } | undefined {
  const m = ctx.model;
  let index = colourMapIndexes.get(ctx);
  if (!index) {
    index = new Map();
    for (const id of m.idsOfType("IFCINDEXEDCOLOURMAP")) {
      const target = m.ref(id, 0);
      if (target > 0 && !index.has(target)) index.set(target, id);
    }
    colourMapIndexes.set(ctx, index);
  }
  const mapId = index.get(faceSetId) ?? -1;
  if (mapId < 0) return undefined;
  const opacityRaw = m.num(mapId, 1);
  const opacity = Number.isFinite(opacityRaw) ? Math.min(1, Math.max(0, opacityRaw)) : 1;
  const listId = m.ref(mapId, 2);
  const rows = m.store.numberRows(m.attr(listId, 0), 3);
  const faceColour = m.store.numbers(m.attr(mapId, 3));
  if (!rows || !faceColour) return undefined;
  const colours: Rgba[] = [];
  for (let i = 0; i < rows.length; i += 3) colours.push({ r: rows[i]!, g: rows[i + 1]!, b: rows[i + 2]!, a: opacity });
  return { colours, faceColour };
}

/** Splits faces into per-colour meshes when a colour map applies. */
class FaceSink {
  private readonly builders = new Map<number, MeshBuilder>();
  private readonly map: { colours: Rgba[]; faceColour: Float64Array } | undefined;
  private readonly positions: Float64Array;
  private readonly vertexMaps = new Map<number, Map<number, number>>();

  constructor(positions: Float64Array, map: { colours: Rgba[]; faceColour: Float64Array } | undefined) {
    this.positions = positions;
    this.map = map;
  }

  private builderFor(face: number): [MeshBuilder, Map<number, number>] {
    let key = -1;
    if (this.map) {
      const c = this.map.faceColour[face];
      if (c !== undefined && c >= 1 && c <= this.map.colours.length) key = c - 1;
    }
    let b = this.builders.get(key);
    let vm = this.vertexMaps.get(key);
    if (!b || !vm) {
      b = new MeshBuilder();
      vm = new Map();
      this.builders.set(key, b);
      this.vertexMaps.set(key, vm);
    }
    return [b, vm];
  }

  triangle(face: number, a: number, b: number, c: number): void {
    const [builder, vm] = this.builderFor(face);
    const v = (i: number): number => {
      let k = vm.get(i);
      if (k === undefined) {
        k = builder.addVertex(this.positions[i * 3]!, this.positions[i * 3 + 1]!, this.positions[i * 3 + 2]!);
        vm.set(i, k);
      }
      return k;
    };
    builder.addTriangle(v(a), v(b), v(c));
  }

  result(): ColoredMesh[] {
    const out: ColoredMesh[] = [];
    for (const [key, b] of this.builders) {
      if (b.triangleCount === 0) continue;
      const colour = key >= 0 ? this.map!.colours[key] : undefined;
      out.push(colour ? { mesh: b.build(), color: colour } : { mesh: b.build() });
    }
    return out;
  }
}

export function triangulatedFaceSet(ctx: GeometryContext, id: number): ColoredMesh[] {
  const m = ctx.model;
  const coords = pointList(ctx, m.ref(id, 0), id);
  const pointCount = coords.length / 3;
  const rows = m.store.intRows(m.attr(id, 3));
  if (!rows) throw new IfcDecodeError("invalid CoordIndex", id, "GEOMETRY_INVALID");
  const pnHandle = m.attr(id, 4);
  const pn = pnHandle >= 0 && !m.store.isNull(pnHandle) ? m.store.numbers(pnHandle) : undefined;
  const index = makeIndexer(pointCount, pn, id);
  const sink = new FaceSink(coords, colourMap(ctx, id));
  let degenerate = 0;
  for (let f = 0; f < rows.length; f++) {
    const r = rows[f]!;
    if (r.length !== 3) throw new IfcDecodeError(`triangle ${f + 1} has ${r.length} indices`, id, "GEOMETRY_INVALID");
    const a = index(r[0]!), b = index(r[1]!), c = index(r[2]!);
    if (a === b || b === c || a === c) {
      degenerate++;
      continue;
    }
    sink.triangle(f, a, b, c);
  }
  if (degenerate > 0) ctx.report("GEOMETRY_INVALID", `${degenerate} degenerate triangles skipped`, id, "info");
  return sink.result();
}

export function polygonalFaceSet(ctx: GeometryContext, id: number): ColoredMesh[] {
  const m = ctx.model;
  const coords = pointList(ctx, m.ref(id, 0), id);
  const pointCount = coords.length / 3;
  const pnHandle = m.attr(id, 3);
  const pn = pnHandle >= 0 && !m.store.isNull(pnHandle) ? m.store.numbers(pnHandle) : undefined;
  const index = makeIndexer(pointCount, pn, id);
  const sink = new FaceSink(coords, colourMap(ctx, id));
  const faces = m.refs(id, 2);
  let failed = 0;
  let degenerate = 0;
  for (let f = 0; f < faces.length; f++) {
    const face = faces[f]!;
    const ft = m.type(face);
    const outerIdx = m.store.numbers(m.attr(face, 0));
    if (!outerIdx || outerIdx.length < 3) {
      failed++;
      continue;
    }
    const outer = Array.from(outerIdx, index);
    const holes: number[][] = [];
    if (ft === "IFCINDEXEDPOLYGONALFACEWITHVOIDS") {
      for (const inner of m.store.intRows(m.attr(face, 1)) ?? []) {
        if (inner.length >= 3) holes.push(Array.from(inner, index));
      }
    }
    const tri = triangulateFace(coords, outer, holes);
    if (tri.normal[0] === 0 && tri.normal[1] === 0 && tri.normal[2] === 0) {
      degenerate++;
      continue;
    }
    if (!tri.ok || tri.forced > 0) failed++;
    for (let i = 0; i < tri.indices.length; i += 3) sink.triangle(f, tri.indices[i]!, tri.indices[i + 1]!, tri.indices[i + 2]!);
  }
  if (failed > 0) ctx.report("TRIANGULATION_FAILED", `${failed} polygonal faces could not be triangulated cleanly`, id);
  if (degenerate > 0) ctx.report("GEOMETRY_INVALID", `${degenerate} zero-area faces skipped`, id, "info");
  return sink.result();
}

// ----------------------------------------------------------- BRep / shells

/** Accumulates faces sharing vertices by IfcCartesianPoint id. */
class ShellBuilder {
  readonly builder = new MeshBuilder();
  private readonly byPoint = new Map<number, number>();
  failed = 0;
  /** Zero-area faces (collinear/duplicate points) skipped. */
  degenerate = 0;
  private readonly ctx: GeometryContext;

  constructor(ctx: GeometryContext) {
    this.ctx = ctx;
  }

  vertexOfPoint(pointId: number): number {
    let v = this.byPoint.get(pointId);
    if (v === undefined) {
      const p = readPoint(this.ctx, pointId);
      v = this.builder.addVertex(p[0], p[1], p[2]);
      this.byPoint.set(pointId, v);
    }
    return v;
  }

  vertexAt(p: Vec3): number {
    return this.builder.addVertex(p[0], p[1], p[2]);
  }

  /** Adds a planar face given loops of vertex indices (first = outer). */
  addFace(loops: number[][], outerIndex: number): void {
    if (loops.length === 0) return;
    const oi = outerIndex >= 0 ? outerIndex : largestLoop(this.builder.positions, loops);
    const outer = loops[oi]!;
    if (outer.length < 3) {
      this.failed++;
      return;
    }
    const holes = loops.filter((_, i) => i !== oi && loops[i]!.length >= 3);
    const tri = triangulateFace(this.builder.positions, outer, holes);
    if (tri.normal[0] === 0 && tri.normal[1] === 0 && tri.normal[2] === 0) {
      this.degenerate++;
      return;
    }
    if (!tri.ok || tri.forced > 0) this.failed++;
    for (let i = 0; i < tri.indices.length; i += 3) this.builder.addTriangle(tri.indices[i]!, tri.indices[i + 1]!, tri.indices[i + 2]!);
  }
}

function largestLoop(positions: number[], loops: number[][]): number {
  let best = 0;
  let bestArea = -1;
  for (let i = 0; i < loops.length; i++) {
    const l = loops[i]!;
    let nx = 0, ny = 0, nz = 0;
    for (let k = 0; k < l.length; k++) {
      const a = l[k]! * 3, b = l[(k + 1) % l.length]! * 3;
      nx += (positions[a + 1]! - positions[b + 1]!) * (positions[a + 2]! + positions[b + 2]!);
      ny += (positions[a + 2]! - positions[b + 2]!) * (positions[a]! + positions[b]!);
      nz += (positions[a]! - positions[b]!) * (positions[a + 1]! + positions[b + 1]!);
    }
    const area = Math.hypot(nx, ny, nz);
    if (area > bestArea) {
      bestArea = area;
      best = i;
    }
  }
  return best;
}

/** Vertex loop of a face bound (IfcPolyLoop or IfcEdgeLoop). */
function boundLoop(ctx: GeometryContext, shell: ShellBuilder, loopId: number): number[] {
  const m = ctx.model;
  const t = m.type(loopId);
  if (t === "IFCPOLYLOOP") {
    const out: number[] = [];
    for (const p of m.refs(loopId, 0)) {
      const v = shell.vertexOfPoint(p);
      if (out.length === 0 || out[out.length - 1] !== v) out.push(v);
    }
    if (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
    return out;
  }
  if (t === "IFCEDGELOOP") {
    const out: number[] = [];
    for (const oe of m.refs(loopId, 0)) {
      // IfcOrientedEdge(EdgeStart*, EdgeEnd*, EdgeElement, Orientation)
      const edge = m.type(oe) === "IFCORIENTEDEDGE" ? m.ref(oe, 2) : oe;
      const forward = m.type(oe) === "IFCORIENTEDEDGE" ? m.bool(oe, 3) !== false : true;
      const pts = edgePoints(ctx, shell, edge);
      if (!forward) pts.reverse();
      for (let i = 0; i < pts.length - 1; i++) {
        if (out.length === 0 || out[out.length - 1] !== pts[i]) out.push(pts[i]!);
      }
    }
    if (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
    return out;
  }
  if (t === "IFCVERTEXLOOP") return [];
  throw new IfcDecodeError(`unsupported face bound loop ${t}`, loopId, "GEOMETRY_UNSUPPORTED");
}

/** Vertex indices along an edge (start → end), sampling curved edge geometry. */
function edgePoints(ctx: GeometryContext, shell: ShellBuilder, edgeId: number): number[] {
  const m = ctx.model;
  const vertexPoint = (vid: number): number => {
    if (m.type(vid) !== "IFCVERTEXPOINT") throw new IfcDecodeError("edge vertex is not an IfcVertexPoint", vid, "GEOMETRY_UNSUPPORTED");
    return shell.vertexOfPoint(m.ref(vid, 0));
  };
  const start = vertexPoint(m.ref(edgeId, 0));
  const end = vertexPoint(m.ref(edgeId, 1));
  if (m.type(edgeId) !== "IFCEDGECURVE") return [start, end];
  const curve = m.ref(edgeId, 2);
  const sameSense = m.bool(edgeId, 3) !== false;
  const ct = m.type(curve);
  if (ct === "IFCLINE" || ct === "IFCPOLYLINE" && m.refs(curve, 0).length <= 2) return [start, end];
  try {
    const poly = tessellateCurve(ctx, curve);
    const pts: Vec3[] = [];
    for (let i = 0; i < poly.points.length; i += 3) pts.push([poly.points[i]!, poly.points[i + 1]!, poly.points[i + 2]!]);
    if (!sameSense) pts.reverse();
    if (pts.length <= 2) return [start, end];
    const out = [start];
    for (let i = 1; i < pts.length - 1; i++) out.push(shell.vertexAt(pts[i]!));
    out.push(end);
    return out;
  } catch {
    return [start, end];
  }
}

function addFaceEntity(ctx: GeometryContext, shell: ShellBuilder, faceId: number): void {
  const m = ctx.model;
  const ft = m.type(faceId);
  if (ft === "IFCADVANCEDFACE" || ft === "IFCFACESURFACE") {
    const surface = m.ref(faceId, 1);
    const st = m.type(surface);
    if (st !== "IFCPLANE" && st !== undefined) {
      addSurfaceFace(ctx, shell, faceId, surface);
      return;
    }
  }
  const loops: number[][] = [];
  let outerIndex = -1;
  for (const bound of m.refs(faceId, 0)) {
    const loop = boundLoop(ctx, shell, m.ref(bound, 0));
    if (m.bool(bound, 1) === false) loop.reverse();
    if (loop.length < 3) continue;
    if (m.type(bound) === "IFCFACEOUTERBOUND" && outerIndex < 0) outerIndex = loops.length;
    loops.push(loop);
  }
  if (loops.length === 0) return;
  if (ft === "IFCFACESURFACE" || ft === "IFCADVANCEDFACE") {
    if (m.bool(faceId, 2) === false) for (const l of loops) l.reverse();
  }
  shell.addFace(loops, outerIndex);
}

/** Non-planar advanced face: tessellate the B-spline surface over its domain. */
function addSurfaceFace(ctx: GeometryContext, shell: ShellBuilder, faceId: number, surfaceId: number): void {
  const m = ctx.model;
  const st = m.type(surfaceId);
  if (st === "IFCBSPLINESURFACEWITHKNOTS" || st === "IFCRATIONALBSPLINESURFACEWITHKNOTS") {
    const grid = bsplineSurfaceGrid(ctx, surfaceId, st === "IFCRATIONALBSPLINESURFACEWITHKNOTS");
    const flip = m.bool(faceId, 2) === false;
    const rows = grid.length, cols = grid[0]!.length;
    const idx = grid.map((row) => row.map((p) => shell.vertexAt(p)));
    for (let i = 0; i + 1 < rows; i++) {
      for (let j = 0; j + 1 < cols; j++) {
        const a = idx[i]![j]!, b = idx[i + 1]![j]!, c = idx[i + 1]![j + 1]!, d = idx[i]![j + 1]!;
        if (flip) shell.builder.addQuad(a, d, c, b);
        else shell.builder.addQuad(a, b, c, d);
      }
    }
    ctx.report("GEOMETRY_UNSUPPORTED", "B-spline face tessellated over its full parameter domain (trimming boundaries ignored)", faceId, "info");
    return;
  }
  // Other analytic surfaces: fall back to the boundary polygon (approximation).
  const loops: number[][] = [];
  let outerIndex = -1;
  for (const bound of m.refs(faceId, 0)) {
    const loop = boundLoop(ctx, shell, m.ref(bound, 0));
    if (m.bool(bound, 1) === false) loop.reverse();
    if (loop.length < 3) continue;
    if (m.type(bound) === "IFCFACEOUTERBOUND" && outerIndex < 0) outerIndex = loops.length;
    loops.push(loop);
  }
  if (loops.length > 0) {
    if (m.bool(faceId, 2) === false) for (const l of loops) l.reverse();
    shell.addFace(loops, outerIndex);
    ctx.report("GEOMETRY_UNSUPPORTED", `${st} face approximated by its boundary polygon`, faceId, "info");
  }
}

function bsplineSurfaceGrid(ctx: GeometryContext, id: number, rational: boolean): Vec3[][] {
  const m = ctx.model;
  // (UDegree, VDegree, ControlPointsList, SurfaceForm, UClosed, VClosed, SelfIntersect, UMultiplicities, VMultiplicities, UKnots, VKnots, KnotSpec[, WeightsData])
  const ud = Math.trunc(m.num(id, 0)), vd = Math.trunc(m.num(id, 1));
  const rows = m.store.items(m.attr(id, 2)).map((row) => m.store.refs(row).map((p) => readPoint(ctx, p)));
  const expand = (multIdx: number, knotIdx: number): number[] => {
    const mult = m.store.numbers(m.attr(id, multIdx)) ?? new Float64Array(0);
    const k = m.store.numbers(m.attr(id, knotIdx)) ?? new Float64Array(0);
    const out: number[] = [];
    for (let i = 0; i < k.length; i++) for (let j = 0; j < Math.min(64, Math.trunc(mult[i] ?? 1)); j++) out.push(k[i]!);
    return out;
  };
  const uk = expand(7, 9), vk = expand(8, 10);
  const nu = rows.length, nv = rows[0]?.length ?? 0;
  const weights = rational ? m.store.items(m.attr(id, 12)).map((r) => m.store.numbers(r) ?? new Float64Array(0)) : undefined;
  if (!(ud >= 1 && vd >= 1) || nu < ud + 1 || nv < vd + 1 || uk.length !== nu + ud + 1 || vk.length !== nv + vd + 1) {
    throw new IfcDecodeError("invalid B-spline surface definition", id, "GEOMETRY_INVALID");
  }
  const basis = (knots: number[], deg: number, count: number, t: number): number[] => {
    // Cox–de Boor basis values for all control points at t
    const n = count;
    let N = new Array<number>(knots.length - 1).fill(0);
    const tMax = knots[n]!;
    for (let i = 0; i < knots.length - 1; i++) {
      if ((t >= knots[i]! && t < knots[i + 1]!) || (t === tMax && knots[i]! < knots[i + 1]! && knots[i + 1] === tMax)) N[i] = 1;
    }
    for (let p = 1; p <= deg; p++) {
      const next = new Array<number>(knots.length - 1 - p).fill(0);
      for (let i = 0; i < next.length; i++) {
        const d1 = knots[i + p]! - knots[i]!;
        const d2 = knots[i + p + 1]! - knots[i + 1]!;
        const a = d1 > 0 ? ((t - knots[i]!) / d1) * N[i]! : 0;
        const b = d2 > 0 ? ((knots[i + p + 1]! - t) / d2) * N[i + 1]! : 0;
        next[i] = a + b;
      }
      N = next;
    }
    return N.slice(0, n);
  };
  const su = Math.min(64, Math.max(4, (nu - ud) * 6)), sv = Math.min(64, Math.max(4, (nv - vd) * 6));
  const grid: Vec3[][] = [];
  for (let i = 0; i <= su; i++) {
    const u = uk[ud]! + ((uk[nu]! - uk[ud]!) * i) / su;
    const bu = basis(uk, ud, nu, u);
    const row: Vec3[] = [];
    for (let j = 0; j <= sv; j++) {
      const v = vk[vd]! + ((vk[nv]! - vk[vd]!) * j) / sv;
      const bv = basis(vk, vd, nv, v);
      let x = 0, y = 0, z = 0, w = 0;
      for (let a = 0; a < nu; a++) {
        if (bu[a] === 0) continue;
        for (let b = 0; b < nv; b++) {
          const coef = bu[a]! * bv[b]! * (weights ? (weights[a]?.[b] ?? 1) : 1);
          if (coef === 0) continue;
          const p = rows[a]![b]!;
          x += p[0] * coef;
          y += p[1] * coef;
          z += p[2] * coef;
          w += coef;
        }
      }
      row.push(w > 0 ? [x / w, y / w, z / w] : [x, y, z]);
    }
    grid.push(row);
  }
  return grid;
}

function addShell(ctx: GeometryContext, shell: ShellBuilder, shellId: number, reverse: boolean): void {
  const m = ctx.model;
  const before = shell.builder.indices.length;
  for (const face of m.refs(shellId, 0)) {
    try {
      addFaceEntity(ctx, shell, face);
    } catch (e) {
      if (e instanceof IfcDecodeError) {
        shell.failed++;
        continue;
      }
      throw e;
    }
  }
  if (reverse) {
    const ix = shell.builder.indices;
    for (let i = before; i < ix.length; i += 3) {
      const t = ix[i + 1]!;
      ix[i + 1] = ix[i + 2]!;
      ix[i + 2] = t;
    }
  }
}

export function brepGeometry(ctx: GeometryContext, id: number): MeshData {
  const m = ctx.model;
  const t = m.type(id);
  const shell = new ShellBuilder(ctx);
  switch (t) {
    case "IFCFACETEDBREP":
    case "IFCADVANCEDBREP":
      addShell(ctx, shell, m.ref(id, 0), false);
      break;
    case "IFCFACETEDBREPWITHVOIDS":
    case "IFCADVANCEDBREPWITHVOIDS":
      addShell(ctx, shell, m.ref(id, 0), false);
      for (const v of m.refs(id, 1)) addShell(ctx, shell, v, false);
      break;
    case "IFCSHELLBASEDSURFACEMODEL":
      for (const s of m.refs(id, 0)) addShell(ctx, shell, s, false);
      break;
    case "IFCFACEBASEDSURFACEMODEL":
      for (const s of m.refs(id, 0)) addShell(ctx, shell, s, false);
      break;
    case "IFCCLOSEDSHELL":
    case "IFCOPENSHELL":
    case "IFCCONNECTEDFACESET":
      addShell(ctx, shell, id, false);
      break;
    default:
      throw new IfcDecodeError(`unsupported BRep ${t}`, id, "GEOMETRY_UNSUPPORTED");
  }
  if (shell.failed > 0) ctx.report("TRIANGULATION_FAILED", `${shell.failed} faces could not be triangulated cleanly`, id);
  if (shell.degenerate > 0) ctx.report("GEOMETRY_INVALID", `${shell.degenerate} zero-area faces skipped`, id, "info");
  return shell.builder.build();
}

/** Planar face bounded by curves in a plane's coordinate system. */
export function curveBoundedPlane(ctx: GeometryContext, id: number): MeshData {
  const m = ctx.model;
  const plane = m.ref(id, 0);
  if (m.type(plane) !== "IFCPLANE") throw new IfcDecodeError(`curve-bounded surface on ${m.type(plane)} is not supported`, id, "GEOMETRY_UNSUPPORTED");
  const place = placementMatrix(ctx, m.ref(plane, 0));
  const b = new MeshBuilder();
  const loopOf = (curve: number): number[] => {
    const poly = tessellateCurve(ctx, curve);
    const out: number[] = [];
    for (let i = 0; i < poly.points.length; i += 3) {
      const p = transformPoint(place, poly.points[i]!, poly.points[i + 1]!, 0);
      out.push(b.addVertex(p[0], p[1], p[2]));
    }
    return out;
  };
  const outer = loopOf(m.ref(id, 1));
  const holes = m.refs(id, 2).map(loopOf);
  const tri = triangulateFace(b.positions, outer, holes, [place[8]!, place[9]!, place[10]!]);
  for (let i = 0; i < tri.indices.length; i += 3) b.addTriangle(tri.indices[i]!, tri.indices[i + 1]!, tri.indices[i + 2]!);
  return b.build();
}

/** Planar filled area bounded by curves (IfcAnnotationFillArea). */
export function annotationFillArea(ctx: GeometryContext, id: number): MeshData {
  const m = ctx.model;
  const b = new MeshBuilder();
  const loopOf = (curve: number): number[] => {
    const poly = tessellateCurve(ctx, curve);
    const out: number[] = [];
    for (let i = 0; i < poly.points.length; i += 3) out.push(b.addVertex(poly.points[i]!, poly.points[i + 1]!, poly.points[i + 2]!));
    return out;
  };
  const outer = loopOf(m.ref(id, 0));
  const holes = m.refs(id, 1).map(loopOf);
  const tri = triangulateFace(b.positions, outer, holes);
  for (let i = 0; i < tri.indices.length; i += 3) b.addTriangle(tri.indices[i]!, tri.indices[i + 1]!, tri.indices[i + 2]!);
  return b.build();
}

export function boundingBoxGeometry(ctx: GeometryContext, id: number): MeshData {
  const m = ctx.model;
  const c = readPoint(ctx, m.ref(id, 0));
  const x = m.num(id, 1), y = m.num(id, 2), z = m.num(id, 3);
  if (![x, y, z].every((v) => Number.isFinite(v) && v > 0)) throw new IfcDecodeError("bounding box dimensions must be positive", id, "GEOMETRY_INVALID");
  return boxMesh({ minX: c[0], minY: c[1], minZ: c[2], maxX: c[0] + x, maxY: c[1] + y, maxZ: c[2] + z });
}
