// SPDX-License-Identifier: Apache-2.0
/**
 * Representation item interpreter. Converts one IfcRepresentationItem into
 * renderer-neutral parts (meshes / line sets with optional explicit colour)
 * and mapped-item instances. Boolean trees are compiled through the CSG
 * backend with depth, size and time budgets; failures degrade per item.
 */

import { IfcDecodeError, IfcResourceLimitError } from "../diagnostics.ts";
import type { Rgba } from "../ifc/styles.ts";
import { boundsOverlap, type Bounds3 } from "../math/bounds.ts";
import { identity, invert, multiply, type Mat4 } from "../math/mat4.ts";
import type { GeometryContext } from "./context.ts";
import { tessellateCurve } from "./curves.ts";
import { mergeMeshes, meshBounds, transformMesh, type LineData, type MeshData } from "./mesh.ts";
import { placementMatrix, transformationOperator } from "./placement.ts";
import {
  csgPrimitive,
  extrudedAreaSolid,
  halfSpaceMesh,
  profileSweepSolid,
  revolvedAreaSolid,
  sweptDiskSolid,
} from "./solids.ts";
import {
  annotationFillArea,
  boundingBoxGeometry,
  brepGeometry,
  curveBoundedPlane,
  polygonalFaceSet,
  triangulatedFaceSet,
} from "./tessellated.ts";

export interface GeometryPart {
  mesh?: MeshData;
  lines?: LineData;
  color?: Rgba;
  /** Representation item that produced the part. */
  itemId: number;
}

export interface MappedInstance {
  /** IfcRepresentationMap id. */
  mapId: number;
  /** Map coordinates → item-parent coordinates. */
  transform: Mat4;
  color?: Rgba;
}

export interface ItemResult {
  parts: GeometryPart[];
  instances: MappedInstance[];
}

const CURVE_TYPES = new Set([
  "IFCPOLYLINE", "IFCINDEXEDPOLYCURVE", "IFCTRIMMEDCURVE", "IFCCOMPOSITECURVE", "IFCCIRCLE", "IFCELLIPSE",
  "IFCBSPLINECURVEWITHKNOTS", "IFCRATIONALBSPLINECURVEWITHKNOTS", "IFCOFFSETCURVE2D", "IFCLINE",
  "IFCCOMPOSITECURVEONSURFACE", "IFCBOUNDARYCURVE", "IFCOUTERBOUNDARYCURVE",
]);

const SOLID_SWEEPS = new Set([
  "IFCSURFACECURVESWEPTAREASOLID", "IFCFIXEDREFERENCESWEPTAREASOLID", "IFCDIRECTRIXCURVESWEPTAREASOLID",
  "IFCDIRECTRIXDERIVEDREFERENCESWEPTAREASOLID",
]);

const BREP_TYPES = new Set([
  "IFCFACETEDBREP", "IFCFACETEDBREPWITHVOIDS", "IFCADVANCEDBREP", "IFCADVANCEDBREPWITHVOIDS",
  "IFCSHELLBASEDSURFACEMODEL", "IFCFACEBASEDSURFACEMODEL", "IFCCLOSEDSHELL", "IFCOPENSHELL", "IFCCONNECTEDFACESET",
]);

const PRIMITIVES = new Set(["IFCBLOCK", "IFCRECTANGULARPYRAMID", "IFCRIGHTCIRCULARCONE", "IFCRIGHTCIRCULARCYLINDER", "IFCSPHERE"]);

const IGNORED_ITEMS = new Set([
  "IFCCARTESIANPOINT", "IFCCARTESIANPOINTLIST2D", "IFCCARTESIANPOINTLIST3D", "IFCTEXTLITERAL", "IFCTEXTLITERALWITHEXTENT",
  "IFCDIRECTION", "IFCAXIS2PLACEMENT3D", "IFCAXIS2PLACEMENT2D", "IFCAXIS1PLACEMENT", "IFCVECTOR",
]);

const DIRECT_ITEM_TYPES = [
  "IFCEXTRUDEDAREASOLID", "IFCEXTRUDEDAREASOLIDTAPERED", "IFCREVOLVEDAREASOLID", "IFCREVOLVEDAREASOLIDTAPERED",
  "IFCSWEPTDISKSOLID", "IFCSWEPTDISKSOLIDPOLYGONAL", "IFCTRIANGULATEDFACESET", "IFCTRIANGULATEDIRREGULARNETWORK",
  "IFCPOLYGONALFACESET", "IFCBOOLEANRESULT", "IFCBOOLEANCLIPPINGRESULT", "IFCCSGSOLID", "IFCMAPPEDITEM",
  "IFCBOUNDINGBOX", "IFCCURVEBOUNDEDPLANE", "IFCANNOTATIONFILLAREA", "IFCGEOMETRICSET", "IFCGEOMETRICCURVESET",
];

/** Every representation item type the dispatcher turns into geometry. */
export const SUPPORTED_ITEM_TYPES: ReadonlySet<string> = new Set([
  ...DIRECT_ITEM_TYPES,
  ...CURVE_TYPES,
  ...SOLID_SWEEPS,
  ...BREP_TYPES,
  ...PRIMITIVES,
  "IFCHALFSPACESOLID", "IFCPOLYGONALBOUNDEDHALFSPACE", "IFCBOXEDHALFSPACE", // Boolean operands
]);

function curveLines(ctx: GeometryContext, id: number): LineData {
  const poly = tessellateCurve(ctx, id);
  const n = poly.points.length / 3;
  const idx: number[] = [];
  for (let i = 0; i + 1 < n; i++) idx.push(i, i + 1);
  if (poly.closed && n > 2) idx.push(n - 1, 0);
  return { positions: Float64Array.from(poly.points), indices: Uint32Array.from(idx) };
}

/** Evaluates a representation item. Never returns partially built geometry. */
export function itemGeometry(ctx: GeometryContext, id: number): ItemResult {
  const result = ctx.itemGuard.run(id, () => itemGeometryInner(ctx, id));
  const color = ctx.styles.itemColor(id);
  if (color) {
    for (const p of result.parts) p.color ??= color;
    for (const inst of result.instances) inst.color ??= color;
  }
  return result;
}

function meshPart(id: number, mesh: MeshData): ItemResult {
  return { parts: mesh.indices.length > 0 ? [{ mesh, itemId: id }] : [], instances: [] };
}

function itemGeometryInner(ctx: GeometryContext, id: number): ItemResult {
  const m = ctx.model;
  const t = m.type(id);
  if (t === undefined) throw new IfcDecodeError(`unresolved representation item #${id}`, id, "IFC_REFERENCE_MISSING");
  switch (t) {
    case "IFCEXTRUDEDAREASOLID":
    case "IFCEXTRUDEDAREASOLIDTAPERED":
      return meshPart(id, extrudedAreaSolid(ctx, id));
    case "IFCREVOLVEDAREASOLID":
    case "IFCREVOLVEDAREASOLIDTAPERED":
      return meshPart(id, revolvedAreaSolid(ctx, id));
    case "IFCSWEPTDISKSOLID":
    case "IFCSWEPTDISKSOLIDPOLYGONAL":
      return meshPart(id, sweptDiskSolid(ctx, id));
    case "IFCTRIANGULATEDFACESET":
    case "IFCTRIANGULATEDIRREGULARNETWORK":
      return { parts: triangulatedFaceSet(ctx, id).map((c) => ({ ...c, itemId: id })), instances: [] };
    case "IFCPOLYGONALFACESET":
      return { parts: polygonalFaceSet(ctx, id).map((c) => ({ ...c, itemId: id })), instances: [] };
    case "IFCBOOLEANRESULT":
    case "IFCBOOLEANCLIPPINGRESULT":
      return meshPart(id, booleanResult(ctx, id));
    case "IFCCSGSOLID":
      return meshPart(id, operandMesh(ctx, m.ref(id, 0), undefined));
    case "IFCMAPPEDITEM":
      return mappedItem(ctx, id);
    case "IFCBOUNDINGBOX":
      return meshPart(id, boundingBoxGeometry(ctx, id));
    case "IFCCURVEBOUNDEDPLANE":
      return meshPart(id, curveBoundedPlane(ctx, id));
    case "IFCANNOTATIONFILLAREA":
      return meshPart(id, annotationFillArea(ctx, id));
    case "IFCGEOMETRICSET":
    case "IFCGEOMETRICCURVESET": {
      const out: ItemResult = { parts: [], instances: [] };
      for (const el of m.refs(id, 0)) {
        const r = itemGeometry(ctx, el);
        out.parts.push(...r.parts);
        out.instances.push(...r.instances);
      }
      return out;
    }
    case "IFCHALFSPACESOLID":
    case "IFCPOLYGONALBOUNDEDHALFSPACE":
    case "IFCBOXEDHALFSPACE":
      ctx.report("GEOMETRY_UNSUPPORTED", `${t} is unbounded and only meaningful as a Boolean operand`, id, "info");
      return { parts: [], instances: [] };
    default:
      break;
  }
  if (SOLID_SWEEPS.has(t)) return meshPart(id, profileSweepSolid(ctx, id));
  if (BREP_TYPES.has(t)) return meshPart(id, brepGeometry(ctx, id));
  if (PRIMITIVES.has(t)) return meshPart(id, csgPrimitive(ctx, id));
  if (CURVE_TYPES.has(t)) {
    const lines = curveLines(ctx, id);
    return { parts: lines.indices.length > 0 ? [{ lines, itemId: id }] : [], instances: [] };
  }
  if (IGNORED_ITEMS.has(t)) return { parts: [], instances: [] };
  throw new IfcDecodeError(`unsupported representation item ${t}`, id, "GEOMETRY_UNSUPPORTED");
}

function mappedItem(ctx: GeometryContext, id: number): ItemResult {
  const m = ctx.model;
  // IfcMappedItem(MappingSource: IfcRepresentationMap, MappingTarget: IfcCartesianTransformationOperator)
  const mapId = m.ref(id, 0);
  if (m.type(mapId) !== "IFCREPRESENTATIONMAP") throw new IfcDecodeError("mapped item without IfcRepresentationMap", id, "IFC_REFERENCE_MISSING");
  const target = m.ref(id, 1);
  const targetMatrix = target > 0 ? transformationOperator(ctx, target) : identity();
  // IfcRepresentationMap(MappingOrigin, MappedRepresentation)
  const origin = placementMatrix(ctx, m.ref(mapId, 0));
  const inv = invert(origin);
  if (!inv) throw new IfcDecodeError("singular mapping origin", mapId, "PLACEMENT_INVALID");
  return { parts: [], instances: [{ mapId, transform: multiply(targetMatrix, inv) }] };
}

/** Geometry of a representation map (items in map coordinates), nested maps flattened. */
export function mapDefinition(ctx: GeometryContext, mapId: number): ItemResult {
  return ctx.mappedGuard.run(mapId, () => {
    const m = ctx.model;
    const rep = m.ref(mapId, 1);
    const out: ItemResult = { parts: [], instances: [] };
    for (const item of m.refs(rep, 3)) {
      try {
        const r = itemGeometry(ctx, item);
        out.parts.push(...r.parts);
        out.instances.push(...r.instances);
      } catch (e) {
        if (e instanceof IfcDecodeError || e instanceof IfcResourceLimitError) reportItemError(ctx, e, item);
        else throw e;
      }
    }
    return out;
  });
}

export function reportItemError(ctx: GeometryContext, e: IfcDecodeError | IfcResourceLimitError, itemId: number): void {
  if (e instanceof IfcResourceLimitError) {
    ctx.report("RESOURCE_LIMIT", e.message, itemId, "error");
  } else {
    ctx.report(e.code, e.message, e.entityId ?? itemId, e.code === "GEOMETRY_UNSUPPORTED" ? "warning" : "error");
  }
}

// ---------------------------------------------------------------- Booleans

function booleanOperator(ctx: GeometryContext, id: number): "union" | "intersection" | "difference" {
  const op = ctx.model.enumValue(id, 0);
  if (ctx.model.type(id) === "IFCBOOLEANCLIPPINGRESULT") return "difference";
  switch (op) {
    case "UNION": return "union";
    case "INTERSECTION": return "intersection";
    case "DIFFERENCE": return "difference";
    default: throw new IfcDecodeError(`unknown Boolean operator ${op}`, id, "GEOMETRY_INVALID");
  }
}

const HALF_SPACES = new Set(["IFCHALFSPACESOLID", "IFCPOLYGONALBOUNDEDHALFSPACE", "IFCBOXEDHALFSPACE"]);

/** Mesh of a Boolean operand; half-spaces are bounded by `domain`. */
export function operandMesh(ctx: GeometryContext, id: number, domain: Bounds3 | undefined): MeshData {
  const m = ctx.model;
  const t = m.type(id);
  if (t && HALF_SPACES.has(t)) {
    if (!domain) throw new IfcDecodeError("half-space cannot be the first Boolean operand", id, "GEOMETRY_UNSUPPORTED");
    return halfSpaceMesh(ctx, id, domain);
  }
  if (t === "IFCBOOLEANRESULT" || t === "IFCBOOLEANCLIPPINGRESULT") return booleanResult(ctx, id);
  if (t === "IFCCSGSOLID") return operandMesh(ctx, m.ref(id, 0), domain);
  const r = itemGeometry(ctx, id);
  const meshes: MeshData[] = [];
  for (const p of r.parts) if (p.mesh) meshes.push(p.mesh);
  for (const inst of r.instances) {
    const def = mapDefinition(ctx, inst.mapId);
    for (const p of def.parts) if (p.mesh) meshes.push(transformMesh(p.mesh, inst.transform));
  }
  return meshes.length === 0 ? { positions: new Float64Array(0), indices: new Uint32Array(0) } : mergeMeshes(meshes);
}


function booleanResult(ctx: GeometryContext, id: number): MeshData {
  const m = ctx.model;
  if (ctx.booleanDepth >= ctx.limits.maxBooleanDepth) {
    throw new IfcResourceLimitError({ resource: "boolean-depth", actual: ctx.booleanDepth + 1, limit: ctx.limits.maxBooleanDepth, ...(ctx.productId !== undefined ? { productId: ctx.productId } : {}) });
  }
  ctx.booleanDepth++;
  try {
    const op = booleanOperator(ctx, id);
    const firstId = m.ref(id, 1);
    const secondId = m.ref(id, 2);
    const first = operandMesh(ctx, firstId, undefined);
    if (first.indices.length === 0) return first;
    const firstBounds = meshBounds(first);
    let second: MeshData;
    try {
      second = operandMesh(ctx, secondId, firstBounds);
    } catch (e) {
      if (e instanceof IfcDecodeError) {
        reportItemError(ctx, e, secondId);
        ctx.report("BOOLEAN_FAILED", `second operand of ${op} ignored`, id);
        return first;
      }
      throw e;
    }
    if (second.indices.length === 0) return op === "intersection" ? second : first;
    if (op !== "union" && !boundsOverlap(firstBounds, meshBounds(second), ctx.epsilon)) {
      return op === "difference" ? first : { positions: new Float64Array(0), indices: new Uint32Array(0) };
    }
    const size = (first.indices.length + second.indices.length) / 3;
    if (size > ctx.limits.maxBooleanTriangles) {
      ctx.report("RESOURCE_LIMIT", `Boolean operands too large (${size} triangles); showing first operand`, id);
      return op === "union" ? mergeMeshes([first, second]) : first;
    }
    if (ctx.checkDeadline()) {
      ctx.report("RESOURCE_LIMIT", "product time budget exhausted; Boolean skipped", id);
      return op === "union" ? mergeMeshes([first, second]) : first;
    }
    try {
      const a = ctx.csg.create(first);
      let b;
      let r;
      try {
        b = ctx.csg.create(second);
        r = ctx.csg.apply(op, a, b);
        const out = ctx.csg.exportMesh(r);
        return { positions: out.positions, indices: out.indices };
      } finally {
        if (r) ctx.csg.dispose(r);
        if (b) ctx.csg.dispose(b);
        ctx.csg.dispose(a);
      }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") throw e;
      ctx.report("BOOLEAN_FAILED", `${op} failed: ${e instanceof Error ? e.message : String(e)}`, id);
      return op === "union" ? mergeMeshes([first, second]) : first;
    }
  } finally {
    ctx.booleanDepth--;
  }
}
