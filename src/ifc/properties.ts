// SPDX-License-Identifier: Apache-2.0
/**
 * Lazy property extraction for one object: identity attributes, property
 * sets, quantity sets, type properties, materials and classifications.
 * Nothing is precomputed beyond the reverse relationship indexes.
 */

import { Tag } from "../step/store.ts";
import type { IfcModel } from "./model.ts";
import { prettyTypeName, SPATIAL_TYPES } from "./schema.ts";
import { MEASURE_UNIT_TYPES, QUANTITY_UNIT_TYPES, resolveUnit } from "./units.ts";

export interface PropertyValue {
  name: string;
  value: string | number | boolean | null;
  unit?: string;
}

export interface PropertyGroup {
  name: string;
  /** Instance that defines the group (property set, quantity set, …); 0 for synthetic groups. */
  sourceId: number;
  kind: "attributes" | "pset" | "qto" | "type" | "material" | "classification" | "relations";
  properties: PropertyValue[];
}

const MAX_PROPERTIES_PER_GROUP = 2000;
const MAX_NESTING = 8;

function measureUnit(model: IfcModel, measureType: string | undefined): string | undefined {
  if (!measureType) return undefined;
  const unitType = MEASURE_UNIT_TYPES[measureType];
  return unitType ? model.units.symbols.get(unitType) : undefined;
}

/** Converts a value handle (typed measure, string, number, enum, list) into a display value. */
function simpleValue(model: IfcModel, h: number): { value: PropertyValue["value"]; unit?: string } {
  const s = model.store;
  if (h < 0) return { value: null };
  switch (s.tag(h)) {
    case Tag.Null:
    case Tag.Derived:
      return { value: null };
    case Tag.Integer:
    case Tag.Real:
    case Tag.BigInteger:
      return { value: s.num(h) };
    case Tag.String:
      return { value: s.str(h) ?? "" };
    case Tag.Enum: {
      const e = s.enumName(h)!;
      if (e === "T") return { value: true };
      if (e === "F") return { value: false };
      if (e === "U") return { value: "UNKNOWN" };
      return { value: e };
    }
    case Tag.Ref:
      return { value: `#${s.ref(h)}` };
    case Tag.Binary:
      return { value: s.value(h).kind === "binary" ? `"${(s.value(h) as { value: string }).value}"` : "" };
    case Tag.Typed: {
      const type = s.typedName(h);
      const inner = s.count(h) === 1 ? h + 1 : -1;
      const v = inner >= 0 ? simpleValue(model, inner) : { value: null };
      const unit = measureUnit(model, type);
      if (type === "IFCBOOLEAN" || type === "IFCLOGICAL") return { value: v.value };
      return unit ? { value: v.value, unit } : { value: v.value };
    }
    case Tag.List: {
      const parts = s.items(h).map((c) => {
        const v = simpleValue(model, c);
        return v.value === null ? "" : String(v.value);
      });
      return { value: parts.join(", ") };
    }
    default:
      return { value: null };
  }
}

function unitSymbol(model: IfcModel, unitRef: number): string | undefined {
  if (unitRef <= 0) return undefined;
  return resolveUnit(model.store, unitRef)?.symbol;
}

function readProperty(model: IfcModel, id: number, prefix: string, out: PropertyValue[], depth: number): void {
  if (out.length >= MAX_PROPERTIES_PER_GROUP || depth > MAX_NESTING) return;
  const type = model.type(id);
  if (!type) return;
  const name = prefix + (model.str(id, 0) ?? `#${id}`);
  switch (type) {
    case "IFCPROPERTYSINGLEVALUE": {
      const v = simpleValue(model, model.attr(id, 2));
      const unit = unitSymbol(model, model.ref(id, 3)) ?? v.unit;
      out.push(unit ? { name, value: v.value, unit } : { name, value: v.value });
      return;
    }
    case "IFCPROPERTYENUMERATEDVALUE": {
      const v = simpleValue(model, model.attr(id, 2));
      out.push({ name, value: v.value });
      return;
    }
    case "IFCPROPERTYLISTVALUE": {
      const v = simpleValue(model, model.attr(id, 2));
      const unit = unitSymbol(model, model.ref(id, 3)) ?? v.unit;
      out.push(unit ? { name, value: v.value, unit } : { name, value: v.value });
      return;
    }
    case "IFCPROPERTYBOUNDEDVALUE": {
      const upper = simpleValue(model, model.attr(id, 2));
      const lower = simpleValue(model, model.attr(id, 3));
      const unit = unitSymbol(model, model.ref(id, 4)) ?? upper.unit ?? lower.unit;
      const text = `${lower.value ?? "–"} … ${upper.value ?? "–"}`;
      out.push(unit ? { name, value: text, unit } : { name, value: text });
      return;
    }
    case "IFCPROPERTYREFERENCEVALUE": {
      const target = model.ref(id, 3);
      out.push({ name, value: target > 0 ? `${prettyTypeName(model.type(target) ?? "")} #${target}` : null });
      return;
    }
    case "IFCPROPERTYTABLEVALUE": {
      const defining = model.attr(id, 2);
      const rows = defining >= 0 ? model.store.count(defining) : 0;
      out.push({ name, value: `table (${rows} rows)` });
      return;
    }
    case "IFCCOMPLEXPROPERTY": {
      for (const child of model.refs(id, 3)) readProperty(model, child, `${name} / `, out, depth + 1);
      return;
    }
    default:
      out.push({ name, value: prettyTypeName(type) });
  }
}

function readQuantity(model: IfcModel, id: number, prefix: string, out: PropertyValue[], depth: number): void {
  if (out.length >= MAX_PROPERTIES_PER_GROUP || depth > MAX_NESTING) return;
  const type = model.type(id);
  if (!type) return;
  const name = prefix + (model.str(id, 0) ?? `#${id}`);
  if (type === "IFCPHYSICALCOMPLEXQUANTITY") {
    for (const child of model.refs(id, 2)) readQuantity(model, child, `${name} / `, out, depth + 1);
    return;
  }
  // IfcPhysicalSimpleQuantity: (Name, Description, Unit, Value[, Formula])
  const value = model.num(id, 3);
  const explicitUnit = unitSymbol(model, model.ref(id, 2));
  const unitType = QUANTITY_UNIT_TYPES[type];
  const unit = explicitUnit ?? (unitType ? model.units.symbols.get(unitType) : undefined);
  const v = Number.isFinite(value) ? value : null;
  out.push(unit ? { name, value: v, unit } : { name, value: v });
}

/** Property sets and quantity sets attached through IfcRelDefinesByProperties. */
function definitionGroups(model: IfcModel, definitionIds: readonly number[], namePrefix: string, kindOverride?: PropertyGroup["kind"]): PropertyGroup[] {
  const groups: PropertyGroup[] = [];
  const seen = new Set<number>();
  const visit = (id: number): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const type = model.type(id);
    if (!type) return;
    if (type === "IFCPROPERTYSET") {
      const props: PropertyValue[] = [];
      for (const p of model.refs(id, 4)) readProperty(model, p, "", props, 0);
      groups.push({ name: namePrefix + (model.str(id, 2) ?? `Property set #${id}`), sourceId: id, kind: kindOverride ?? "pset", properties: props });
    } else if (type === "IFCELEMENTQUANTITY") {
      const props: PropertyValue[] = [];
      for (const q of model.refs(id, 5)) readQuantity(model, q, "", props, 0);
      groups.push({ name: namePrefix + (model.str(id, 2) ?? `Quantities #${id}`), sourceId: id, kind: kindOverride ?? "qto", properties: props });
    } else if (type === "IFCPREDEFINEDPROPERTYSET" || type.startsWith("IFCDOOR") || type.startsWith("IFCWINDOW")) {
      // Predefined property sets (e.g. IfcDoorLiningProperties): show attributes generically.
      const props: PropertyValue[] = [];
      const n = model.attrCount(id);
      for (let i = 4; i < n; i++) {
        const v = simpleValue(model, model.attr(id, i));
        if (v.value !== null) props.push({ name: `Attribute ${i + 1}`, value: v.value });
      }
      groups.push({ name: namePrefix + (model.str(id, 2) ?? prettyTypeName(type)), sourceId: id, kind: kindOverride ?? "pset", properties: props });
    }
  };
  for (const id of definitionIds) {
    const type = model.type(id);
    // IFC4 IfcPropertySetDefinitionSet is a typed aggregate; refs() already flattened it.
    if (type) visit(id);
  }
  return groups;
}

function materialProperties(model: IfcModel, materialId: number, out: PropertyValue[], depth = 0): void {
  if (depth > MAX_NESTING || out.length >= MAX_PROPERTIES_PER_GROUP) return;
  const type = model.type(materialId);
  if (!type) return;
  switch (type) {
    case "IFCMATERIAL":
      out.push({ name: "Material", value: model.str(materialId, 0) ?? `#${materialId}` });
      return;
    case "IFCMATERIALLIST":
      for (const m of model.refs(materialId, 0)) materialProperties(model, m, out, depth + 1);
      return;
    case "IFCMATERIALLAYERSETUSAGE":
      materialProperties(model, model.ref(materialId, 0), out, depth + 1);
      return;
    case "IFCMATERIALLAYERSET": {
      const setName = model.str(materialId, 1);
      if (setName) out.push({ name: "Layer set", value: setName });
      for (const layer of model.refs(materialId, 0)) materialProperties(model, layer, out, depth + 1);
      return;
    }
    case "IFCMATERIALLAYER": {
      const mat = model.ref(materialId, 0);
      const thickness = model.num(materialId, 1);
      const label = mat > 0 ? (model.str(mat, 0) ?? `#${mat}`) : "(no material)";
      const unit = model.units.symbols.get("LENGTHUNIT");
      out.push({ name: `Layer: ${label}`, value: Number.isFinite(thickness) ? thickness : null, ...(unit ? { unit } : {}) });
      return;
    }
    case "IFCMATERIALPROFILESETUSAGE":
    case "IFCMATERIALPROFILESETUSAGETAPERING":
      materialProperties(model, model.ref(materialId, 0), out, depth + 1);
      return;
    case "IFCMATERIALPROFILESET":
      for (const p of model.refs(materialId, 2)) materialProperties(model, p, out, depth + 1);
      return;
    case "IFCMATERIALPROFILE": {
      const mat = model.ref(materialId, 2);
      out.push({ name: `Profile: ${model.str(materialId, 0) ?? ""}`.trim(), value: mat > 0 ? (model.str(mat, 0) ?? `#${mat}`) : null });
      return;
    }
    case "IFCMATERIALCONSTITUENTSET":
      for (const c of model.refs(materialId, 2)) materialProperties(model, c, out, depth + 1);
      return;
    case "IFCMATERIALCONSTITUENT": {
      const mat = model.ref(materialId, 2);
      out.push({ name: `Constituent: ${model.str(materialId, 0) ?? ""}`.trim(), value: mat > 0 ? (model.str(mat, 0) ?? `#${mat}`) : null });
      return;
    }
    default:
      out.push({ name: prettyTypeName(type), value: `#${materialId}` });
  }
}

function classificationProperties(model: IfcModel, refId: number, out: PropertyValue[]): void {
  const type = model.type(refId);
  if (type === "IFCCLASSIFICATIONREFERENCE") {
    // IFC2x3: (Location, ItemReference, Name, ReferencedSource); IFC4: (Location, Identification, Name, ReferencedSource, Description, Sort)
    const ident = model.str(refId, 1);
    const name = model.str(refId, 2);
    const source = model.ref(refId, 3);
    const system = source > 0 ? (model.type(source) === "IFCCLASSIFICATION" ? model.str(source, 3) : model.str(source, 2)) : undefined;
    out.push({ name: system ?? "Classification", value: [ident, name].filter(Boolean).join(" ") || `#${refId}` });
  } else if (type === "IFCCLASSIFICATION") {
    out.push({ name: "Classification", value: model.str(refId, 3) ?? `#${refId}` });
  } else if (type) {
    out.push({ name: prettyTypeName(type), value: `#${refId}` });
  }
}

/** All property groups of an object, most important first. */
export function getPropertyGroups(model: IfcModel, id: number): PropertyGroup[] {
  const summary = model.summary(id);
  if (!summary) return [];
  const groups: PropertyGroup[] = [];
  const attrs: PropertyValue[] = [
    { name: "Express ID", value: id },
    { name: "Entity", value: summary.typeName },
  ];
  if (summary.globalId !== undefined) attrs.push({ name: "GlobalId", value: summary.globalId });
  if (summary.name !== undefined) attrs.push({ name: "Name", value: summary.name });
  if (summary.longName !== undefined) attrs.push({ name: "Long name", value: summary.longName });
  if (summary.description !== undefined) attrs.push({ name: "Description", value: summary.description });
  if (summary.objectType !== undefined) attrs.push({ name: "Object type", value: summary.objectType });
  if (summary.tag !== undefined) attrs.push({ name: "Tag", value: summary.tag });
  if (SPATIAL_TYPES.has(summary.type) && summary.type === "IFCBUILDINGSTOREY") {
    const elevation = model.num(id, 9);
    const unit = model.units.symbols.get("LENGTHUNIT");
    if (Number.isFinite(elevation)) attrs.push({ name: "Elevation", value: elevation, ...(unit ? { unit } : {}) });
  }
  groups.push({ name: "Attributes", sourceId: id, kind: "attributes", properties: attrs });

  const r = model.relations;
  const relations: PropertyValue[] = [];
  const container = model.containerOf(id);
  if (container !== undefined) relations.push({ name: "Container", value: `${model.label(container)} (#${container})` });
  const typeObject = r.typeByObject.get(id);
  if (typeObject !== undefined) relations.push({ name: "Type", value: `${model.label(typeObject)} (#${typeObject})` });
  const host = r.openingHost.get(id);
  if (host !== undefined) relations.push({ name: "Voids", value: `${model.label(host)} (#${host})` });
  const filled = r.fillingOpening.get(id);
  if (filled !== undefined) relations.push({ name: "Fills opening", value: `#${filled}` });
  for (const g of r.groupsByObject.get(id) ?? []) relations.push({ name: prettyTypeName(model.type(g) ?? "Group"), value: `${model.label(g)} (#${g})` });
  if (relations.length > 0) groups.push({ name: "Relations", sourceId: 0, kind: "relations", properties: relations });

  groups.push(...definitionGroups(model, r.propertyDefinitionsByObject.get(id) ?? [], ""));
  if (typeObject !== undefined) {
    const typeName = model.label(typeObject);
    groups.push(...definitionGroups(model, model.refs(typeObject, 5), `${typeName}: `, "type"));
  }

  const materials: PropertyValue[] = [];
  for (const m of r.materialsByObject.get(id) ?? []) materialProperties(model, m, materials);
  if (materials.length === 0 && typeObject !== undefined) {
    for (const m of r.materialsByObject.get(typeObject) ?? []) materialProperties(model, m, materials);
  }
  if (materials.length > 0) groups.push({ name: "Materials", sourceId: 0, kind: "material", properties: materials });

  const classes: PropertyValue[] = [];
  for (const c of r.classificationsByObject.get(id) ?? []) classificationProperties(model, c, classes);
  if (classes.length > 0) groups.push({ name: "Classification", sourceId: 0, kind: "classification", properties: classes });
  return groups;
}
