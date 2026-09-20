// SPDX-License-Identifier: Apache-2.0
/**
 * Product geometry engine: representation selection, placement composition
 * (context × product placement × item), colour resolution, semantic opening
 * subtraction, mapped-item instancing decisions, budgets and scheduling
 * priority. Output is renderer-neutral.
 */

import { DiagnosticLog, IfcCycleError, IfcDecodeError, IfcResourceLimitError, throwIfAborted } from "../diagnostics.ts";
import type { IfcModel } from "../ifc/model.ts";
import { NON_RENDERED_TYPES } from "../ifc/schema.ts";
import { colorKey, defaultColorForType, type Rgba } from "../ifc/styles.ts";
import { emptyBounds, isEmptyBounds, transformBounds, unionBounds, type Bounds3 } from "../math/bounds.ts";
import { identity, invert, multiply, scaling, type Mat4 } from "../math/mat4.ts";
import type { CsgBackend } from "../csg/backend.ts";
import { NativeCsgBackend } from "../csg/native.ts";
import { GeometryContext, type GeometryLimits, type TessellationQuality } from "./context.ts";
import { itemGeometry, mapDefinition, operandMesh, reportItemError, type GeometryPart, type MappedInstance } from "./items.ts";
import { meshBounds, mergeMeshes, transformLines, transformMesh, type MeshData } from "./mesh.ts";
import { contextTransform, objectPlacement } from "./placement.ts";

export interface ResolvedPart {
  mesh?: MeshData;
  lines?: GeometryPart["lines"];
  colorKey: string;
}

export interface GeometryDefinition {
  key: string;
  /** Parts in definition coordinates (file length units). */
  parts: ResolvedPart[];
}

export interface ProductInstance {
  key: string;
  /** Definition coordinates → world metres. */
  transform: Mat4;
}

export interface ProductGeometry {
  productId: number;
  /** Product frame → world metres (includes unit scale). */
  world: Mat4;
  /** Unique parts in the product frame (file units). */
  parts: ResolvedPart[];
  instances: ProductInstance[];
  bounds: Bounds3;
  triangles: number;
}

export interface EngineOptions {
  limits?: Partial<GeometryLimits>;
  quality?: Partial<TessellationQuality>;
  diagnostics?: DiagnosticLog;
  csg?: CsgBackend;
  /** Mapped definitions used at least this often are instanced. */
  instancingThreshold?: number;
  signal?: AbortSignal;
}

interface RepresentationChoice {
  repId: number;
  contextId: number;
  items: number[];
}

const SOLID_REPRESENTATION_TYPES = new Set([
  "SWEPTSOLID", "ADVANCEDSWEPTSOLID", "BREP", "ADVANCEDBREP", "CSG", "CLIPPING", "SURFACEMODEL", "TESSELLATION",
  "MAPPEDREPRESENTATION", "SOLIDMODEL", "SECTIONEDSPINE", "ADVANCEDSURFACE", "TRIANGULATEDIRREGULARNETWORK",
]);
const CURVE_REPRESENTATION_TYPES = new Set(["CURVE2D", "CURVE3D", "CURVE", "GEOMETRICCURVESET", "GEOMETRICSET", "ANNOTATION2D", "POINT", "POINTCLOUD"]);
const CURVE_IDENTIFIERS = new Set(["AXIS", "FOOTPRINT", "ANNOTATION", "PLAN", "REFERENCE", "PROFILE", "SURVEYPOINTS"]);

function representationScore(identifier: string, type: string): number {
  if (identifier === "BODY") return 100;
  if (identifier === "FACETATION") return 80;
  if (identifier === "BODY-FALLBACK") return 70;
  if (identifier === "BOX" || type === "BOUNDINGBOX") return 10;
  if (CURVE_IDENTIFIERS.has(identifier) || CURVE_REPRESENTATION_TYPES.has(type)) return 20;
  if (identifier === "CLEARANCE" || identifier === "LIGHTING" || identifier === "COG") return 5;
  if (SOLID_REPRESENTATION_TYPES.has(type)) return 60;
  return 30;
}

const COST_CLASS: Record<string, number> = {
  IFCTRIANGULATEDFACESET: 0,
  IFCPOLYGONALFACESET: 0,
  IFCTRIANGULATEDIRREGULARNETWORK: 0,
  IFCMAPPEDITEM: 1,
  IFCEXTRUDEDAREASOLID: 2,
  IFCFACETEDBREP: 3,
  IFCSHELLBASEDSURFACEMODEL: 3,
  IFCBOOLEANRESULT: 4,
  IFCBOOLEANCLIPPINGRESULT: 4,
  IFCSWEPTDISKSOLID: 5,
  IFCREVOLVEDAREASOLID: 3,
};

export class GeometryEngine {
  readonly model: IfcModel;
  readonly ctx: GeometryContext;
  private readonly instancingThreshold: number;
  private readonly signal: AbortSignal | undefined;
  private readonly mapUsage = new Map<number, number>();
  private readonly definitions = new Map<string, GeometryDefinition>();
  private readonly mapCache = new Map<number, { parts: GeometryPart[]; instances: MappedInstance[] }>();
  private readonly unitScale: Mat4;
  trianglesTotal = 0;
  private budgetExhausted = false;

  constructor(model: IfcModel, options: EngineOptions = {}) {
    this.model = model;
    const csg = options.csg ?? new NativeCsgBackend();
    this.ctx = new GeometryContext(model, csg, {
      ...(options.limits ? { limits: options.limits } : {}),
      ...(options.quality ? { quality: options.quality } : {}),
      diagnostics: options.diagnostics ?? model.diagnostics,
    });
    this.instancingThreshold = options.instancingThreshold ?? 2;
    this.signal = options.signal;
    const s = this.ctx.unitScale;
    this.unitScale = scaling(s, s, s);
  }

  /** Chooses the representation(s) to display for a product. */
  selectRepresentations(productId: number): RepresentationChoice[] {
    const m = this.model;
    const pds = m.ref(productId, 6);
    if (pds <= 0 || m.type(pds) !== "IFCPRODUCTDEFINITIONSHAPE") return [];
    const scored: { choice: RepresentationChoice; score: number }[] = [];
    for (const rep of m.refs(pds, 2)) {
      const t = m.type(rep);
      if (t !== "IFCSHAPEREPRESENTATION") continue;
      const identifier = (m.str(rep, 1) ?? "").toUpperCase();
      const type = (m.str(rep, 2) ?? "").toUpperCase();
      const items = m.refs(rep, 3);
      if (items.length === 0) continue;
      scored.push({ choice: { repId: rep, contextId: m.ref(rep, 0), items }, score: representationScore(identifier, type) });
    }
    if (scored.length === 0) return [];
    const best = Math.max(...scored.map((s) => s.score));
    return scored.filter((s) => s.score === best).map((s) => s.choice);
  }

  /**
   * Products with geometry in scheduling order (tessellated first, Booleans and
   * sweeps last). Also counts mapped-definition usage for instancing.
   */
  prepare(): number[] {
    const m = this.model;
    const entries: { id: number; cost: number; order: number }[] = [];
    let order = 0;
    for (const id of m.products) {
      if (NON_RENDERED_TYPES.has(m.type(id) ?? "")) continue;
      const reps = this.selectRepresentations(id);
      if (reps.length === 0) continue;
      let cost = 0;
      const hasOpenings = (m.relations.openingsByElement.get(id)?.length ?? 0) > 0;
      for (const r of reps) {
        for (const item of r.items) {
          const t = m.type(item) ?? "";
          cost = Math.max(cost, COST_CLASS[t] ?? 3);
          if (t === "IFCMAPPEDITEM" && !hasOpenings) {
            const mapId = m.ref(item, 0);
            this.mapUsage.set(mapId, (this.mapUsage.get(mapId) ?? 0) + 1);
          }
        }
      }
      if (hasOpenings) cost = Math.max(cost, 4);
      entries.push({ id, cost, order: order++ });
    }
    entries.sort((a, b) => a.cost - b.cost || a.order - b.order);
    return entries.map((e) => e.id);
  }

  productColor(productId: number): Rgba {
    return this.ctx.styles.materialColor(productId) ?? defaultColorForType(this.model.type(productId) ?? "");
  }

  private resolvedMap(mapId: number): { parts: GeometryPart[]; instances: MappedInstance[] } {
    let hit = this.mapCache.get(mapId);
    if (!hit) {
      hit = mapDefinition(this.ctx, mapId);
      this.mapCache.set(mapId, hit);
    }
    return hit;
  }

  /** Flattens nested mapped instances into (part, transform) pairs in item coordinates. */
  private flattenInstance(
    inst: MappedInstance,
    parent: Mat4,
    inherited: Rgba,
    out: { part: GeometryPart; transform: Mat4; color: Rgba }[],
    active: Set<number> = new Set(),
  ): void {
    if (active.has(inst.mapId)) throw new IfcCycleError(inst.mapId);
    if (active.size >= this.ctx.limits.maxMappedItemDepth) {
      throw new IfcResourceLimitError({ resource: "mapped-item-depth", actual: active.size + 1, limit: this.ctx.limits.maxMappedItemDepth });
    }
    active.add(inst.mapId);
    try {
      const def = this.resolvedMap(inst.mapId);
      const t = multiply(parent, inst.transform);
      const color = inst.color ?? inherited;
      for (const p of def.parts) out.push({ part: p, transform: t, color: p.color ?? color });
      for (const nested of def.instances) this.flattenInstance(nested, t, color, out, active);
    } finally {
      active.delete(inst.mapId);
    }
  }

  definition(key: string): GeometryDefinition | undefined {
    return this.definitions.get(key);
  }

  /** Builds geometry for one product; returns null when it has none. */
  buildProduct(productId: number): ProductGeometry | null {
    throwIfAborted(this.signal);
    if (this.budgetExhausted) return null;
    const m = this.model;
    const ctx = this.ctx;
    ctx.productId = productId;
    ctx.deadline = performance.now() + ctx.limits.maxProductMillis;
    try {
      const placement = objectPlacement(ctx, m.ref(productId, 5));
      const reps = this.selectRepresentations(productId);
      if (reps.length === 0) return null;
      const productColor = this.productColor(productId);
      const hasOpenings = (m.relations.openingsByElement.get(productId)?.length ?? 0) > 0;
      const world = multiply(this.unitScale, placement);
      const parts: ResolvedPart[] = [];
      const instances: ProductInstance[] = [];
      const bakedMeshes: { mesh: MeshData; color: Rgba }[] = [];
      for (const rep of reps) {
        const frame = contextTransform(ctx, rep.contextId); // item coordinates → product frame
        for (const item of rep.items) {
          // Everything derived from one item is committed only if the item
          // succeeds, so a bad item never discards its siblings.
          const itemParts: ResolvedPart[] = [];
          const itemInstances: ProductInstance[] = [];
          const itemBaked: { mesh: MeshData; color: Rgba }[] = [];
          try {
            this.collectItem(item, frame, world, productColor, hasOpenings, itemParts, itemInstances, itemBaked);
          } catch (e) {
            if (e instanceof IfcDecodeError || e instanceof IfcResourceLimitError) {
              reportItemError(ctx, e, item);
              continue;
            }
            throw e;
          }
          parts.push(...itemParts);
          instances.push(...itemInstances);
          bakedMeshes.push(...itemBaked);
        }
      }
      if (hasOpenings) {
        for (const cut of this.subtractOpenings(productId, placement, bakedMeshes)) parts.push({ mesh: cut.mesh, colorKey: colorKey(cut.color) });
      }
      return this.finishProduct(productId, world, parts, instances);
    } catch (e) {
      if (e instanceof IfcDecodeError || e instanceof IfcResourceLimitError) {
        reportItemError(ctx, e, productId);
        return null;
      }
      throw e;
    } finally {
      ctx.productId = undefined;
      ctx.deadline = Infinity;
    }
  }

  /** Geometry of one representation item, split into unique parts, instances and meshes to cut. */
  private collectItem(
    item: number,
    frame: Mat4,
    world: Mat4,
    productColor: Rgba,
    hasOpenings: boolean,
    parts: ResolvedPart[],
    instances: ProductInstance[],
    baked: { mesh: MeshData; color: Rgba }[],
  ): void {
    const r = itemGeometry(this.ctx, item);
    const identityFrame = isIdentityFrame(frame);
    for (const p of r.parts) {
      const color = p.color ?? productColor;
      if (p.mesh) {
        const mesh = identityFrame ? p.mesh : transformMesh(p.mesh, frame);
        if (hasOpenings) baked.push({ mesh, color });
        else parts.push({ mesh, colorKey: colorKey(color) });
      } else if (p.lines) {
        parts.push({ lines: identityFrame ? p.lines : transformLines(p.lines, frame), colorKey: colorKey(color) });
      }
    }
    for (const inst of r.instances) {
      const usage = this.mapUsage.get(inst.mapId) ?? 0;
      if (!hasOpenings && usage >= this.instancingThreshold) {
        const inherited = inst.color ?? productColor;
        const key = `m${inst.mapId}|${colorKey(inherited)}`;
        this.ensureMapDefinition(key, inst.mapId, inherited);
        instances.push({ key, transform: multiply(world, multiply(frame, inst.transform)) });
        continue;
      }
      const flat: { part: GeometryPart; transform: Mat4; color: Rgba }[] = [];
      this.flattenInstance(inst, frame, productColor, flat);
      for (const f of flat) {
        if (f.part.mesh) {
          const mesh = transformMesh(f.part.mesh, f.transform);
          if (hasOpenings) baked.push({ mesh, color: f.color });
          else parts.push({ mesh, colorKey: colorKey(f.color) });
        } else if (f.part.lines) {
          parts.push({ lines: transformLines(f.part.lines, f.transform), colorKey: colorKey(f.color) });
        }
      }
    }
  }

  /** Bounds, triangle budget and final assembly of a product. */
  private finishProduct(productId: number, world: Mat4, parts: ResolvedPart[], instances: ProductInstance[]): ProductGeometry | null {
    if (parts.length === 0 && instances.length === 0) return null;
    let triangles = 0;
    let bounds = emptyBounds();
    for (const p of parts) {
      const data = p.mesh ?? p.lines!;
      if (p.mesh) triangles += p.mesh.indices.length / 3;
      bounds = unionBounds(bounds, transformBounds(meshBounds(data), world));
    }
    for (const inst of instances) {
      const def = this.definitions.get(inst.key)!;
      for (const p of def.parts) {
        const data = p.mesh ?? p.lines!;
        if (p.mesh) triangles += p.mesh.indices.length / 3;
        bounds = unionBounds(bounds, transformBounds(meshBounds(data), inst.transform));
      }
    }
    const limits = this.ctx.limits;
    if (this.trianglesTotal + triangles > limits.maxTriangles) {
      this.budgetExhausted = true;
      this.ctx.diagnostics.add({
        code: "RESOURCE_LIMIT",
        severity: "error",
        message: `triangle budget exhausted (${limits.maxTriangles}); remaining products are not displayed`,
        productId,
      });
      return null;
    }
    if (triangles > limits.maxVerticesPerProduct) {
      this.ctx.report("RESOURCE_LIMIT", `product exceeds maxVerticesPerProduct (${triangles} triangles)`, productId, "error");
      return null;
    }
    this.trianglesTotal += triangles;
    if (isEmptyBounds(bounds)) return null;
    return { productId, world, parts, instances, bounds, triangles };
  }

  private ensureMapDefinition(key: string, mapId: number, inherited: Rgba): void {
    if (this.definitions.has(key)) return;
    const flat: { part: GeometryPart; transform: Mat4; color: Rgba }[] = [];
    this.flattenInstance({ mapId, transform: identity() }, identity(), inherited, flat);
    const parts: ResolvedPart[] = [];
    for (const f of flat) {
      const colorK = colorKey(f.color);
      if (f.part.mesh) parts.push({ mesh: isIdentityFrame(f.transform) ? f.part.mesh : transformMesh(f.part.mesh, f.transform), colorKey: colorK });
      else if (f.part.lines) parts.push({ lines: isIdentityFrame(f.transform) ? f.part.lines : transformLines(f.part.lines, f.transform), colorKey: colorK });
    }
    this.definitions.set(key, { key, parts });
  }

  /** Subtracts all related openings from the host meshes (product frame). */
  private subtractOpenings(hostId: number, hostPlacement: Mat4, meshes: { mesh: MeshData; color: Rgba }[]): { mesh: MeshData; color: Rgba }[] {
    const m = this.model;
    const ctx = this.ctx;
    const hostInv = invert(hostPlacement);
    if (!hostInv) return meshes;
    const cutters: MeshData[] = [];
    for (const opening of m.relations.openingsByElement.get(hostId) ?? []) {
      try {
        const openingPlacement = objectPlacement(ctx, m.ref(opening, 5));
        const toHost = multiply(hostInv, openingPlacement);
        for (const rep of this.selectRepresentations(opening)) {
          const frame = multiply(toHost, contextTransform(ctx, rep.contextId));
          for (const item of rep.items) {
            try {
              const mesh = operandMesh(ctx, item, undefined);
              if (mesh.indices.length > 0) cutters.push(transformMesh(mesh, frame));
            } catch (e) {
              if (e instanceof IfcDecodeError || e instanceof IfcResourceLimitError) reportItemError(ctx, e, item);
              else throw e;
            }
          }
        }
      } catch (e) {
        if (e instanceof IfcDecodeError || e instanceof IfcResourceLimitError) reportItemError(ctx, e, opening);
        else throw e;
      }
    }
    if (cutters.length === 0) return meshes;
    const out: { mesh: MeshData; color: Rgba }[] = [];
    for (const { mesh, color } of meshes) {
      let current = mesh;
      const hostBounds = meshBounds(current);
      // Merge all overlapping cutters into one operand: one Boolean per host part.
      const relevant = cutters.filter((c) => {
        const b = meshBounds(c);
        return b.minX <= hostBounds.maxX && b.maxX >= hostBounds.minX && b.minY <= hostBounds.maxY && b.maxY >= hostBounds.minY && b.minZ <= hostBounds.maxZ && b.maxZ >= hostBounds.minZ;
      });
      if (relevant.length > 0) {
        if (ctx.checkDeadline()) {
          ctx.report("RESOURCE_LIMIT", "product time budget exhausted; openings not subtracted", hostId);
        } else if ((current.indices.length + relevant.reduce((s, c) => s + c.indices.length, 0)) / 3 > ctx.limits.maxBooleanTriangles) {
          ctx.report("RESOURCE_LIMIT", "opening subtraction skipped: operands exceed maxBooleanTriangles", hostId);
        } else {
          // Mutually disjoint cutters can share one Boolean; overlapping ones are
          // subtracted in separate passes so no internal faces remain.
          for (const group of disjointGroups(relevant)) {
            try {
              const cutter = group.length === 1 ? group[0]! : mergeMeshes(group);
              const a = ctx.csg.create(current);
              let b;
              let r;
              try {
                b = ctx.csg.create(cutter);
                r = ctx.csg.apply("difference", a, b);
                const res = ctx.csg.exportMesh(r);
                current = { positions: res.positions, indices: res.indices };
              } finally {
                if (r) ctx.csg.dispose(r);
                if (b) ctx.csg.dispose(b);
                ctx.csg.dispose(a);
              }
            } catch (e) {
              if (e instanceof Error && e.name === "AbortError") throw e;
              ctx.report("BOOLEAN_FAILED", `opening subtraction failed: ${e instanceof Error ? e.message : String(e)}`, hostId);
            }
          }
        }
      }
      if (current.indices.length > 0) out.push({ mesh: current, color });
    }
    return out;
  }
}

/** Greedy partition of meshes into groups whose bounding boxes do not overlap. */
function disjointGroups(meshes: MeshData[]): MeshData[][] {
  const groups: { meshes: MeshData[]; bounds: Bounds3[] }[] = [];
  for (const mesh of meshes) {
    const b = meshBounds(mesh);
    const overlaps = (o: Bounds3): boolean =>
      b.minX < o.maxX && b.maxX > o.minX && b.minY < o.maxY && b.maxY > o.minY && b.minZ < o.maxZ && b.maxZ > o.minZ;
    const target = groups.find((g) => !g.bounds.some(overlaps));
    if (target) {
      target.meshes.push(mesh);
      target.bounds.push(b);
    } else {
      groups.push({ meshes: [mesh], bounds: [b] });
    }
  }
  return groups.map((g) => g.meshes);
}

function isIdentityFrame(m: Mat4): boolean {
  return (
    m[0] === 1 && m[1] === 0 && m[2] === 0 && m[4] === 0 && m[5] === 1 && m[6] === 0 &&
    m[8] === 0 && m[9] === 0 && m[10] === 1 && m[12] === 0 && m[13] === 0 && m[14] === 0
  );
}
