// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UNASSIGNED_NODE_ID } from "../../src/ifc/model.ts";
import { getPropertyGroups } from "../../src/ifc/properties.ts";
import { detectSchemaFamily, prettyTypeName } from "../../src/ifc/schema.ts";
import { $, IfcBuilder, en, int, real, ref, refs, str, typed, guid } from "../helpers/ifc-builder.ts";
import { loadModel } from "../helpers/model.ts";

function sample(schema = "IFC4", lengthUnit: "METRE" | "MILLIMETRE" = "METRE") {
  const b = new IfcBuilder(schema);
  const h = b.hierarchy({ lengthUnit, angleUnit: "DEGREE" });
  const wallPlacement = b.localPlacement(h.storeyPlacement);
  const wall = b.element("IFCWALL", "<script>alert(1)</script>", wallPlacement, b.shape(h.body, [b.box(4, 0.2, 3)]), h);
  const slab = b.element("IFCSLAB", "Floor", b.localPlacement(h.storeyPlacement), b.shape(h.body, [b.box(5, 5, 0.2)]), h);
  const loose = b.element("IFCFURNISHINGELEMENT", "Loose chair", b.localPlacement(null), b.shape(h.body, [b.box(0.5, 0.5, 0.9)]), h);
  b.contain(h, h.storey, [wall, slab]);
  b.propertySet(h, [wall], "Pset_WallCommon", [
    ["IsExternal", typed("IFCBOOLEAN", en("T"))],
    ["Reference", typed("IFCIDENTIFIER", str("W-01"))],
    ["Width", typed("IFCLENGTHMEASURE", real(200))],
  ]);
  b.quantities(h, [wall], "Qto_WallBaseQuantities", { length: [["Length", 4000]], volume: [["NetVolume", 2.4]] });
  const material = b.add("IFCMATERIAL", str("Concrete"), $, $);
  const layer = b.add("IFCMATERIALLAYER", ref(material), real(200), $, $, $, $, $);
  const layerSet = b.add("IFCMATERIALLAYERSET", refs([layer]), str("Wall 200"), $);
  const usage = b.add("IFCMATERIALLAYERSETUSAGE", ref(layerSet), en("AXIS2"), en("POSITIVE"), real(0), $);
  b.add("IFCRELASSOCIATESMATERIAL", str(guid()), ref(h.ownerHistory), $, $, refs([wall]), ref(usage));
  const wallType = b.add("IFCWALLTYPE", str(guid()), ref(h.ownerHistory), str("Basic 200"), $, $, $, $, $, $, en("STANDARD"));
  b.add("IFCRELDEFINESBYTYPE", str(guid()), ref(h.ownerHistory), $, $, refs([wall]), ref(wallType));
  const source = b.add("IFCCLASSIFICATION", $, $, $, str("Uniclass"), $, $, $);
  const cref = b.add("IFCCLASSIFICATIONREFERENCE", $, str("EF_25_10"), str("Walls"), ref(source), $, $);
  b.add("IFCRELASSOCIATESCLASSIFICATION", str(guid()), ref(h.ownerHistory), $, $, refs([wall]), ref(cref));
  const opening = b.opening(h, wall, wallPlacement, [1, 0.4, 2], [1, -0.1, 0]);
  return { text: b.toString(), h, wall, slab, loose, opening, wallType };
}

describe("IFC model", () => {
  it("detects schema families", () => {
    assert.equal(detectSchemaFamily(["IFC2X3"]), "IFC2X3");
    assert.equal(detectSchemaFamily(["IFC2X3_TC1"]), "IFC2X3");
    assert.equal(detectSchemaFamily(["IFC4"]), "IFC4");
    assert.equal(detectSchemaFamily(["IFC4X3_ADD2"]), "IFC4X3");
    assert.equal(detectSchemaFamily(["ifc4x1"]), "IFC4X3");
    assert.equal(detectSchemaFamily(["AP214"]), "UNKNOWN");
  });

  it("reports unknown schemas without failing", () => {
    const m = loadModel(sample("MYSCHEMA").text);
    assert.equal(m.schema, "UNKNOWN");
    assert.ok(m.diagnostics.count("IFC_SCHEMA_UNKNOWN") === 1);
    assert.ok(m.products.length > 0);
  });

  it("resolves project units (millimetre, degree)", () => {
    const m = loadModel(sample("IFC4", "MILLIMETRE").text);
    assert.equal(m.units.lengthToMetres, 0.001);
    assert.ok(Math.abs(m.units.angleToRadians - Math.PI / 180) < 1e-12);
    assert.equal(m.units.symbols.get("LENGTHUNIT"), "mm");
    assert.equal(m.units.symbols.get("PLANEANGLEUNIT"), "°");
  });

  it("discovers products structurally, including spatial elements", () => {
    const s = sample();
    const m = loadModel(s.text);
    for (const id of [s.h.site, s.h.building, s.h.storey, s.wall, s.slab, s.loose, s.opening]) assert.ok(m.isProduct(id), `#${id}`);
    assert.ok(!m.isProduct(s.h.project));
    assert.ok(!m.isProduct(s.wallType));
    assert.ok(!m.renderableProducts().includes(s.opening));
  });

  it("builds the spatial tree with openings under hosts and an Unassigned node", () => {
    const s = sample();
    const m = loadModel(s.text);
    const tree = m.spatialTree();
    const byId = new Map(tree.map((n) => [n.id, n]));
    assert.deepEqual(byId.get(s.h.project)!.children, [s.h.site]);
    assert.deepEqual(byId.get(s.h.storey)!.children, [s.wall, s.slab]);
    assert.deepEqual(byId.get(s.wall)!.children, [s.opening]);
    const unassigned = byId.get(UNASSIGNED_NODE_ID)!;
    assert.deepEqual(unassigned.children, [s.loose]);
    assert.equal(m.containerOf(s.wall), s.h.storey);
    assert.equal(m.containerOf(s.opening), s.h.storey);
  });

  it("keeps hostile names as literal text", () => {
    const s = sample();
    const m = loadModel(s.text);
    assert.equal(m.summary(s.wall)!.name, "<script>alert(1)</script>");
  });

  it("extracts attributes, property sets, quantities, type, materials and classification", () => {
    const s = sample("IFC4", "MILLIMETRE");
    const m = loadModel(s.text);
    const groups = getPropertyGroups(m, s.wall);
    const byName = new Map(groups.map((g) => [g.name, g]));
    const attrs = byName.get("Attributes")!.properties;
    assert.ok(attrs.some((p) => p.name === "Entity" && p.value === "IfcWall"));
    assert.ok(attrs.some((p) => p.name === "GlobalId" && typeof p.value === "string" && p.value.length === 22));
    const pset = byName.get("Pset_WallCommon")!.properties;
    assert.deepEqual(pset.find((p) => p.name === "IsExternal"), { name: "IsExternal", value: true });
    assert.deepEqual(pset.find((p) => p.name === "Width"), { name: "Width", value: 200, unit: "mm" });
    const qto = byName.get("Qto_WallBaseQuantities")!.properties;
    assert.deepEqual(qto.find((p) => p.name === "Length"), { name: "Length", value: 4000, unit: "mm" });
    assert.deepEqual(qto.find((p) => p.name === "NetVolume"), { name: "NetVolume", value: 2.4, unit: "m³" });
    const rel = byName.get("Relations")!.properties;
    assert.ok(rel.some((p) => p.name === "Type" && String(p.value).startsWith("Basic 200")));
    assert.ok(rel.some((p) => p.name === "Container" && String(p.value).startsWith("Ground floor")));
    const mats = byName.get("Materials")!.properties;
    assert.ok(mats.some((p) => p.name === "Layer set" && p.value === "Wall 200"));
    assert.ok(mats.some((p) => p.name === "Layer: Concrete" && p.value === 200));
    const cls = byName.get("Classification")!.properties;
    assert.deepEqual(cls[0], { name: "Uniclass", value: "EF_25_10 Walls" });
  });

  it("returns an empty list for unknown ids", () => {
    const m = loadModel(sample().text);
    assert.deepEqual(getPropertyGroups(m, 999999), []);
    assert.equal(m.summary(999999), null);
  });

  it("formats readable type names", () => {
    assert.equal(prettyTypeName("IFCWALLSTANDARDCASE"), "IfcWallStandardCase");
    assert.equal(prettyTypeName("IFCBUILDINGELEMENTPROXY"), "IfcBuildingElementProxy");
    assert.equal(prettyTypeName("IFCRELCONTAINEDINSPATIALSTRUCTURE"), "IfcRelContainedInSpatialStructure");
  });

  it("tolerates dangling relationship references", () => {
    const b = new IfcBuilder();
    const h = b.hierarchy();
    b.add("IFCRELCONTAINEDINSPATIALSTRUCTURE", str(guid()), ref(h.ownerHistory), $, $, refs([424242]), ref(h.storey));
    b.add("IFCRELAGGREGATES", str(guid()), ref(h.ownerHistory), $, $, ref(515151), refs([h.site]));
    const m = loadModel(b.toString());
    const tree = m.spatialTree();
    assert.ok(tree.some((n) => n.id === h.storey));
    assert.ok(!tree.some((n) => n.id === 424242));
    void int;
  });
});
