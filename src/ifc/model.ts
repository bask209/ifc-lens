// SPDX-License-Identifier: Apache-2.0
/**
 * Generic IFC model facade over a packed StepStore: schema family, units,
 * relationship indexes, product discovery and the spatial tree. Only the
 * small set of attributes the viewer needs is decoded; every other entity
 * stays queryable by id.
 */

import { DiagnosticLog } from "../diagnostics.ts";
import { Tag, type StepHeader, type StepStore, type StepValue } from "../step/store.ts";
import {
  NON_RENDERED_TYPES,
  PLACEMENT_TYPES,
  SPATIAL_TYPES,
  detectSchemaFamily,
  prettyTypeName,
  type IfcSchemaFamily,
} from "./schema.ts";
import { resolveProjectUnits, type UnitContext } from "./units.ts";

export interface EntitySummary {
  id: number;
  type: string;
  /** Human readable type name (IfcWallStandardCase). */
  typeName: string;
  globalId?: string;
  name?: string;
  description?: string;
  objectType?: string;
  tag?: string;
  longName?: string;
}

export interface SpatialNode {
  id: number;
  type: string;
  name: string;
  /** Child node ids in display order. */
  children: number[];
  /** "spatial" containers, "element" products, "group"/"unassigned" synthetic nodes. */
  kind: "spatial" | "element" | "unassigned";
}

/** Synthetic tree node id used for products that are not spatially contained. */
export const UNASSIGNED_NODE_ID = -1;

function pushMulti(map: Map<number, number[]>, key: number, value: number): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export interface RelationshipIndex {
  aggregateChildren: Map<number, number[]>;
  aggregateParent: Map<number, number>;
  nestChildren: Map<number, number[]>;
  nestParent: Map<number, number>;
  containedProducts: Map<number, number[]>;
  containmentParent: Map<number, number>;
  propertyDefinitionsByObject: Map<number, number[]>;
  typeByObject: Map<number, number>;
  materialsByObject: Map<number, number[]>;
  classificationsByObject: Map<number, number[]>;
  openingsByElement: Map<number, number[]>;
  openingHost: Map<number, number>;
  fillingsByOpening: Map<number, number[]>;
  fillingOpening: Map<number, number>;
  groupsByObject: Map<number, number[]>;
  adheringFeatures: Map<number, number[]>;
}

export class IfcModel {
  readonly store: StepStore;
  readonly header: StepHeader;
  readonly schema: IfcSchemaFamily;
  readonly diagnostics: DiagnosticLog;
  readonly units: UnitContext;
  readonly relations: RelationshipIndex;
  /** Product instance names in file order. */
  readonly products: number[];
  private readonly productSet: Set<number>;
  private spatialTreeCache: SpatialNode[] | undefined;

  constructor(store: StepStore, diagnostics: DiagnosticLog = new DiagnosticLog()) {
    this.store = store;
    this.header = store.header;
    this.diagnostics = diagnostics;
    this.schema = detectSchemaFamily(store.header.schemaIdentifiers);
    if (this.schema === "UNKNOWN") {
      diagnostics.add({
        code: "IFC_SCHEMA_UNKNOWN",
        severity: "warning",
        message: `Unrecognised FILE_SCHEMA ${JSON.stringify(store.header.schemaIdentifiers)}; decoding with IFC4 attribute layout`,
      });
    }
    this.units = resolveProjectUnits(store);
    this.relations = this.buildRelations();
    this.products = this.findProducts();
    this.productSet = new Set(this.products);
  }

  // ------------------------------------------------------------------ access

  get entityCount(): number {
    return this.store.entityCount;
  }

  has(id: number): boolean {
    return this.store.indexOfId(id) >= 0;
  }

  /** Upper-case STEP type name of an instance. */
  type(id: number): string | undefined {
    return this.store.typeOf(id);
  }

  isProduct(id: number): boolean {
    return this.productSet.has(id);
  }

  /** Value handle of attribute `i` of instance `id` (-1 when absent). */
  attr(id: number, i: number): number {
    const k = this.store.indexOfId(id);
    return k < 0 ? -1 : this.store.arg(k, i);
  }

  attrCount(id: number): number {
    const k = this.store.indexOfId(id);
    return k < 0 ? 0 : this.store.argCount(k);
  }

  str(id: number, i: number): string | undefined {
    const h = this.attr(id, i);
    return h < 0 ? undefined : this.store.str(h);
  }

  num(id: number, i: number): number {
    const h = this.attr(id, i);
    return h < 0 ? Number.NaN : this.store.num(h);
  }

  ref(id: number, i: number): number {
    const h = this.attr(id, i);
    return h < 0 ? -1 : this.store.ref(h);
  }

  refs(id: number, i: number): number[] {
    const h = this.attr(id, i);
    return h < 0 ? [] : this.store.refs(h);
  }

  enumValue(id: number, i: number): string | undefined {
    const h = this.attr(id, i);
    return h < 0 ? undefined : this.store.enumName(h);
  }

  bool(id: number, i: number): boolean | undefined {
    const h = this.attr(id, i);
    return h < 0 ? undefined : this.store.bool(h);
  }

  isNull(id: number, i: number): boolean {
    const h = this.attr(id, i);
    return h < 0 || this.store.isNull(h);
  }

  /** Materialised attribute values of an instance (debugging / generic UI). */
  values(id: number): StepValue[] {
    const k = this.store.indexOfId(id);
    return k < 0 ? [] : this.store.argsValue(k);
  }

  idsOfType(type: string): number[] {
    return this.store.idsOfType(type);
  }

  // ------------------------------------------------------------ relations

  private buildRelations(): RelationshipIndex {
    const s = this.store;
    const r: RelationshipIndex = {
      aggregateChildren: new Map(),
      aggregateParent: new Map(),
      nestChildren: new Map(),
      nestParent: new Map(),
      containedProducts: new Map(),
      containmentParent: new Map(),
      propertyDefinitionsByObject: new Map(),
      typeByObject: new Map(),
      materialsByObject: new Map(),
      classificationsByObject: new Map(),
      openingsByElement: new Map(),
      openingHost: new Map(),
      fillingsByOpening: new Map(),
      fillingOpening: new Map(),
      groupsByObject: new Map(),
      adheringFeatures: new Map(),
    };
    const relatingAndRelated = (type: string, relatingIndex: number, relatedIndex: number, fn: (relating: number, related: number) => void): void => {
      for (const k of s.indicesOfType(type)) {
        const relatingHandle = s.arg(k, relatingIndex);
        const relatedHandle = s.arg(k, relatedIndex);
        if (relatingHandle < 0 || relatedHandle < 0) continue;
        const relatings = s.refs(relatingHandle);
        const relateds = s.refs(relatedHandle);
        for (const a of relatings) for (const b of relateds) if (a !== b) fn(a, b);
      }
    };
    relatingAndRelated("IFCRELAGGREGATES", 4, 5, (parent, child) => {
      if (!r.aggregateParent.has(child)) {
        r.aggregateParent.set(child, parent);
        pushMulti(r.aggregateChildren, parent, child);
      }
    });
    relatingAndRelated("IFCRELNESTS", 4, 5, (parent, child) => {
      if (!r.nestParent.has(child)) {
        r.nestParent.set(child, parent);
        pushMulti(r.nestChildren, parent, child);
      }
    });
    relatingAndRelated("IFCRELCONTAINEDINSPATIALSTRUCTURE", 5, 4, (structure, element) => {
      if (!r.containmentParent.has(element)) {
        r.containmentParent.set(element, structure);
        pushMulti(r.containedProducts, structure, element);
      }
    });
    relatingAndRelated("IFCRELDEFINESBYPROPERTIES", 5, 4, (definition, object) => {
      pushMulti(r.propertyDefinitionsByObject, object, definition);
    });
    relatingAndRelated("IFCRELDEFINESBYTYPE", 5, 4, (type, object) => {
      if (!r.typeByObject.has(object)) r.typeByObject.set(object, type);
    });
    relatingAndRelated("IFCRELASSOCIATESMATERIAL", 5, 4, (material, object) => {
      pushMulti(r.materialsByObject, object, material);
    });
    relatingAndRelated("IFCRELASSOCIATESCLASSIFICATION", 5, 4, (classification, object) => {
      pushMulti(r.classificationsByObject, object, classification);
    });
    relatingAndRelated("IFCRELVOIDSELEMENT", 4, 5, (host, opening) => {
      if (!r.openingHost.has(opening)) {
        r.openingHost.set(opening, host);
        pushMulti(r.openingsByElement, host, opening);
      }
    });
    relatingAndRelated("IFCRELFILLSELEMENT", 4, 5, (opening, filling) => {
      if (!r.fillingOpening.has(filling)) {
        r.fillingOpening.set(filling, opening);
        pushMulti(r.fillingsByOpening, opening, filling);
      }
    });
    relatingAndRelated("IFCRELASSIGNSTOGROUP", 6, 4, (group, object) => {
      pushMulti(r.groupsByObject, object, group);
    });
    relatingAndRelated("IFCRELADHERESTOELEMENT", 4, 5, (element, feature) => {
      pushMulti(r.adheringFeatures, element, feature);
    });
    return r;
  }

  // ------------------------------------------------------------- products

  /**
   * Discovers IfcProduct instances structurally: GlobalId string at [0],
   * ObjectPlacement reference/null at [5] and Representation reference/null at
   * [6], with at least one of them set, or a known spatial type.
   */
  private findProducts(): number[] {
    const s = this.store;
    const out: number[] = [];
    for (let k = 0; k < s.entityCount; k++) {
      const type = s.typeNameAt(k);
      if (type === "IFCPROJECT") continue;
      if (s.argCount(k) < 7) continue;
      const args = s.argsOf(k);
      let h = args + 1;
      if (s.tag(h) !== Tag.String) continue; // GlobalId
      for (let i = 0; i < 5; i++) h = s.next(h);
      const placementHandle = h;
      const representationHandle = s.next(h);
      const placementRef = s.ref(placementHandle);
      const representationRef = s.ref(representationHandle);
      const placementOk =
        s.isNull(placementHandle) || (placementRef > 0 && PLACEMENT_TYPES.has(s.typeOf(placementRef) ?? ""));
      const representationOk =
        s.isNull(representationHandle) ||
        (representationRef > 0 && s.typeOf(representationRef) === "IFCPRODUCTDEFINITIONSHAPE");
      if (!placementOk || !representationOk) continue;
      if (placementRef < 0 && representationRef < 0 && !SPATIAL_TYPES.has(type)) {
        // Both null: accept only when the entity participates in spatial relations.
        const id = s.idAt(k);
        if (!this.relations.containmentParent.has(id) && !this.relations.aggregateParent.has(id)) continue;
      }
      out.push(s.idAt(k));
    }
    return out;
  }

  /** Products that can carry body geometry (openings are consumed by hosts). */
  renderableProducts(): number[] {
    return this.products.filter((id) => !NON_RENDERED_TYPES.has(this.type(id) ?? ""));
  }

  summary(id: number): EntitySummary | null {
    const type = this.type(id);
    if (type === undefined) return null;
    const out: EntitySummary = { id, type, typeName: prettyTypeName(type) };
    const count = this.attrCount(id);
    const isRooted = count >= 4 && this.store.tag(this.attr(id, 0)) === Tag.String;
    if (isRooted) {
      out.globalId = this.str(id, 0);
      const name = this.str(id, 2);
      if (name !== undefined) out.name = name;
      const description = this.str(id, 3);
      if (description !== undefined) out.description = description;
      if (count >= 5) {
        const objectType = this.str(id, 4);
        if (objectType !== undefined) out.objectType = objectType;
      }
      if (this.isProduct(id) && count >= 8) {
        const t = this.str(id, 7);
        if (t !== undefined) {
          if (SPATIAL_TYPES.has(type)) out.longName = t;
          else out.tag = t;
        }
      }
      if (type === "IFCPROJECT") {
        const longName = this.str(id, 5);
        if (longName !== undefined) out.longName = longName;
      }
    } else {
      const name = count > 0 ? this.str(id, 0) : undefined;
      if (name !== undefined) out.name = name;
    }
    return out;
  }

  /** Display label: Name, else LongName, else type + id. */
  label(id: number): string {
    const s = this.summary(id);
    if (!s) return `#${id}`;
    return s.name || s.longName || `${s.typeName} #${id}`;
  }

  // ---------------------------------------------------------- spatial tree

  /**
   * Builds the spatial tree rooted at IfcProject(s). Aggregation and nesting
   * provide decomposition, containment attaches elements to spatial
   * structures, openings hang below their host. Products reachable from no
   * root appear under a synthetic "Unassigned" node.
   */
  spatialTree(): SpatialNode[] {
    if (this.spatialTreeCache) return this.spatialTreeCache;
    const r = this.relations;
    const nodes: SpatialNode[] = [];
    const visited = new Set<number>();
    const roots = this.idsOfType("IFCPROJECT");
    const stack: { id: number; depth: number }[] = [];
    const childrenOf = (id: number): number[] => {
      const out: number[] = [];
      const add = (list: number[] | undefined): void => {
        if (list) for (const c of list) if (!visited.has(c) && this.has(c)) out.push(c);
      };
      add(r.aggregateChildren.get(id));
      add(r.containedProducts.get(id));
      add(r.nestChildren.get(id));
      add(r.openingsByElement.get(id));
      add(r.adheringFeatures.get(id));
      return out;
    };
    const kindOf = (id: number): SpatialNode["kind"] => {
      const t = this.type(id) ?? "";
      return SPATIAL_TYPES.has(t) || t === "IFCPROJECT" ? "spatial" : "element";
    };
    const MAX_DEPTH = 256;
    for (const root of roots) {
      if (visited.has(root)) continue;
      visited.add(root);
      stack.push({ id: root, depth: 0 });
      while (stack.length > 0) {
        const { id, depth } = stack.pop()!;
        const children = depth < MAX_DEPTH ? childrenOf(id) : [];
        for (const c of children) visited.add(c);
        nodes.push({ id, type: this.type(id) ?? "", name: this.label(id), children, kind: kindOf(id) });
        for (let i = children.length - 1; i >= 0; i--) stack.push({ id: children[i]!, depth: depth + 1 });
      }
    }
    // Products not reached from any project root.
    const unassigned: number[] = [];
    for (const p of this.products) {
      if (visited.has(p)) continue;
      // Prefer attaching subtrees at their topmost unvisited ancestor.
      let top = p;
      const seen = new Set<number>([p]);
      for (;;) {
        const parent = r.aggregateParent.get(top) ?? r.containmentParent.get(top) ?? r.nestParent.get(top) ?? r.openingHost.get(top);
        if (parent === undefined || visited.has(parent) || seen.has(parent) || !this.has(parent)) break;
        seen.add(parent);
        top = parent;
      }
      if (visited.has(top)) continue;
      visited.add(top);
      unassigned.push(top);
      stack.push({ id: top, depth: 0 });
      while (stack.length > 0) {
        const { id, depth } = stack.pop()!;
        const children = depth < MAX_DEPTH ? childrenOf(id) : [];
        for (const c of children) visited.add(c);
        nodes.push({ id, type: this.type(id) ?? "", name: this.label(id), children, kind: kindOf(id) });
        for (let i = children.length - 1; i >= 0; i--) stack.push({ id: children[i]!, depth: depth + 1 });
      }
    }
    if (unassigned.length > 0) {
      nodes.push({ id: UNASSIGNED_NODE_ID, type: "", name: "Unassigned", children: unassigned, kind: "unassigned" });
    }
    this.spatialTreeCache = nodes;
    return nodes;
  }

  /** Spatial container (storey/site/…) that holds a product, if any. */
  containerOf(id: number): number | undefined {
    const r = this.relations;
    let cur = id;
    const seen = new Set<number>();
    for (let i = 0; i < 64; i++) {
      if (seen.has(cur)) return undefined;
      seen.add(cur);
      const c = r.containmentParent.get(cur);
      if (c !== undefined) return c;
      const next = r.aggregateParent.get(cur) ?? r.nestParent.get(cur) ?? r.openingHost.get(cur) ?? r.fillingOpening.get(cur);
      if (next === undefined) return undefined;
      if (SPATIAL_TYPES.has(this.type(next) ?? "")) return next;
      cur = next;
    }
    return undefined;
  }
}
