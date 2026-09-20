// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeEdges, meshBounds, meshVolume, weldMesh } from "../../src/geometry/mesh.ts";
import { determinant3 } from "../../src/math/mat4.ts";
import { $, IfcBuilder, en, guid, real, ref, refs, str, type Hierarchy } from "../helpers/ifc-builder.ts";
import { approx, buildAll, worldMesh } from "../helpers/model.ts";

function mappedScene(count: number, mirrorLast: boolean): { text: string; products: number[]; mapId: number } {
  const b = new IfcBuilder();
  const h = b.hierarchy();
  const origin = b.axis3([1, 0, 0]); // non-trivial mapping origin
  const rep = b.add("IFCSHAPEREPRESENTATION", ref(h.body), str("Body"), str("SweptSolid"), refs([b.box(1, 2, 3, [1, 0, 0])]));
  const mapId = b.add("IFCREPRESENTATIONMAP", ref(origin), ref(rep));
  const products: number[] = [];
  for (let i = 0; i < count; i++) {
    const mirror = mirrorLast && i === count - 1;
    const op = b.add(
      "IFCCARTESIANTRANSFORMATIONOPERATOR3D",
      $,
      mirror ? ref(b.direction(0, -1, 0)) : $,
      ref(b.point(0, 0, 0)),
      real(1),
      $,
    );
    const item = b.add("IFCMAPPEDITEM", ref(mapId), ref(op));
    const shape = b.shape(h.body, [item], "MappedRepresentation");
    products.push(b.element("IFCCOLUMN", `Column ${i}`, b.localPlacement(h.storeyPlacement, [i * 5, 0, 0]), shape, h));
  }
  b.contain(h, h.storey, products);
  return { text: b.toString(), products, mapId };
}

describe("geometry engine", () => {
  it("instances repeated representation maps and applies mapping origin/target", () => {
    const s = mappedScene(4, false);
    const built = buildAll(s.text);
    for (const [i, id] of s.products.entries()) {
      const g = built.products.get(id)!;
      assert.equal(g.parts.length, 0);
      assert.equal(g.instances.length, 1);
      const mesh = worldMesh(built, id);
      approx(meshVolume(mesh), 6, 1e-9);
      const bb = meshBounds(mesh);
      approx(bb.minX, i * 5, 1e-9); // box at x=1 in map space, mapping origin at x=1 → x=0
      approx(bb.maxY, 2, 1e-9);
    }
    const keys = new Set(s.products.map((id) => built.products.get(id)!.instances[0]!.key));
    assert.equal(keys.size, 1);
  });

  it("handles mirrored instances without inverting solids", () => {
    const s = mappedScene(3, true);
    const built = buildAll(s.text);
    const last = s.products.at(-1)!;
    const inst = built.products.get(last)!.instances[0]!;
    assert.ok(determinant3(inst.transform) < 0);
    const mesh = worldMesh(built, last);
    approx(meshVolume(mesh), 6, 1e-9); // winding corrected when baked
    const bb = meshBounds(mesh);
    approx(bb.minY, -2, 1e-9);
    approx(bb.maxY, 0, 1e-9);
  });

  it("bakes single-use maps instead of instancing them", () => {
    const s = mappedScene(1, false);
    const built = buildAll(s.text);
    const g = built.products.get(s.products[0]!)!;
    assert.equal(g.instances.length, 0);
    assert.equal(g.parts.length, 1);
  });

  it("detects cyclic mapped items", () => {
    const b = new IfcBuilder();
    const h = b.hierarchy();
    const repId = b.reserve();
    const mapId = b.add("IFCREPRESENTATIONMAP", ref(b.axis3()), ref(repId));
    const item = b.add("IFCMAPPEDITEM", ref(mapId), $);
    b.addWithId(repId, "IFCSHAPEREPRESENTATION", ref(h.body), str("Body"), str("MappedRepresentation"), refs([item]));
    const p = b.element("IFCPROXY", "Cycle", b.localPlacement(null), b.shape(h.body, [item, b.box(1, 1, 1)], "MappedRepresentation"), h);
    const built = buildAll(b.toString());
    assert.ok(built.model.diagnostics.items.some((d) => d.code === "IFC_REFERENCE_CYCLE"));
    approx(meshVolume(worldMesh(built, p)), 1, 1e-9);
  });

  it("subtracts semantic openings from their hosts", () => {
    const b = new IfcBuilder();
    const h = b.hierarchy();
    const wp = b.localPlacement(h.storeyPlacement, [10, 0, 0]);
    const wall = b.element("IFCWALL", "Wall", wp, b.shape(h.body, [b.box(5, 0.3, 3)]), h);
    b.opening(h, wall, wp, [1, 0.5, 2], [1, -0.1, 0.5]);
    b.opening(h, wall, wp, [1, 0.5, 1], [3, -0.1, 1]);
    b.contain(h, h.storey, [wall]);
    const built = buildAll(b.toString());
    const mesh = worldMesh(built, wall);
    approx(meshVolume(mesh), 4.5 - 0.3 * 2 - 0.3 * 1, 1e-9);
    const e = analyzeEdges(weldMesh(mesh, 1e-7));
    assert.equal(e.boundaryEdges, 0);
    assert.ok(!built.products.has(built.model.relations.openingsByElement.get(wall)![0]!), "openings are not rendered");
  });

  it("scales millimetre models and applies the context world coordinate system", () => {
    const b = new IfcBuilder();
    const h = b.hierarchy({ lengthUnit: "MILLIMETRE" });
    const shifted = b.add("IFCGEOMETRICREPRESENTATIONCONTEXT", $, str("Model"), { kind: "integer", value: 3 }, real(1e-5), ref(b.axis3([0, 0, 1000])), $);
    const rep = b.add("IFCSHAPEREPRESENTATION", ref(shifted), str("Body"), str("SweptSolid"), refs([b.box(1000, 1000, 1000)]));
    const p = b.element("IFCSLAB", "Slab", b.localPlacement(null, [2000, 0, 0]), b.add("IFCPRODUCTDEFINITIONSHAPE", $, $, refs([rep])), h);
    const built = buildAll(b.toString());
    const bb = meshBounds(worldMesh(built, p));
    approx(bb.minX, 2, 1e-12);
    approx(bb.minZ, 1, 1e-12);
    approx(bb.maxZ, 2, 1e-12);
  });

  it("resolves colours: styled item > material > type default", () => {
    const b = new IfcBuilder();
    const h = b.hierarchy();
    const styledItem = b.box(1, 1, 1);
    b.styled(styledItem, [1, 0, 0], 0.5);
    const styled = b.element("IFCWALL", "Styled", b.localPlacement(null), b.shape(h.body, [styledItem]), h);
    const matProduct = b.element("IFCSLAB", "Material", b.localPlacement(null), b.shape(h.body, [b.box(1, 1, 1)]), h);
    const material = b.add("IFCMATERIAL", str("Blue stuff"), $, $);
    const colour = b.add("IFCCOLOURRGB", $, real(0), real(0), real(1));
    const shading = b.add("IFCSURFACESTYLESHADING", ref(colour), $);
    const style = b.add("IFCSURFACESTYLE", $, en("BOTH"), refs([shading]));
    const si = b.add("IFCSTYLEDITEM", $, refs([style]), $);
    const srep = b.add("IFCSTYLEDREPRESENTATION", ref(h.context), $, $, refs([si]));
    b.add("IFCMATERIALDEFINITIONREPRESENTATION", $, $, refs([srep]), ref(material));
    b.add("IFCRELASSOCIATESMATERIAL", str(guid()), ref(h.ownerHistory), $, $, refs([matProduct]), ref(material));
    const plain = b.element("IFCDOOR", "Plain", b.localPlacement(null), b.shape(h.body, [b.box(1, 1, 1)]), h);
    const built = buildAll(b.toString());
    assert.equal(built.products.get(styled)!.parts[0]!.colorKey, "255,0,0,128");
    assert.equal(built.products.get(matProduct)!.parts[0]!.colorKey, "0,0,255,255");
    assert.equal(built.products.get(plain)!.parts[0]!.colorKey, "158,120,84,255");
  });

  it("keeps loading when references are missing or placements are cyclic", () => {
    const b = new IfcBuilder();
    const h: Hierarchy = b.hierarchy();
    const good = b.element("IFCWALL", "Good", b.localPlacement(null), b.shape(h.body, [b.box(1, 1, 1)]), h);
    const dangling = b.element("IFCWALL", "Dangling", b.localPlacement(null), b.shape(h.body, [987654]), h);
    const pa = b.reserve();
    const pb = b.add("IFCLOCALPLACEMENT", ref(pa), ref(b.axis3()));
    b.addWithId(pa, "IFCLOCALPLACEMENT", ref(pb), ref(b.axis3()));
    const cyclic = b.element("IFCWALL", "Cyclic", pb, b.shape(h.body, [b.box(1, 1, 1)]), h);
    const built = buildAll(b.toString());
    assert.ok(built.products.has(good));
    assert.ok(!built.products.has(dangling));
    assert.ok(!built.products.has(cyclic));
    const codes = built.model.diagnostics.items.map((d) => d.code);
    assert.ok(codes.includes("IFC_REFERENCE_MISSING"));
    assert.ok(codes.includes("IFC_REFERENCE_CYCLE"));
  });

  it("stops producing geometry when the triangle budget is exhausted", () => {
    const s = mappedScene(5, false);
    const built = buildAll(s.text, { limits: { maxTriangles: 30 } });
    assert.ok(built.products.size < 5);
    assert.ok(built.model.diagnostics.items.some((d) => d.code === "RESOURCE_LIMIT" && /triangle budget/.test(d.message)));
  });

  it("schedules cheap tessellated products before Booleans", () => {
    const b = new IfcBuilder();
    const h = b.hierarchy();
    const wp = b.localPlacement(null);
    const wall = b.element("IFCWALL", "Host", wp, b.shape(h.body, [b.box(3, 0.2, 3)]), h);
    b.opening(h, wall, wp, [1, 1, 1], [1, -0.5, 1]);
    const pts = b.add("IFCCARTESIANPOINTLIST3D", { kind: "list", values: [[0, 0, 0], [1, 0, 0], [0, 1, 0]].map((c) => ({ kind: "list", values: c.map((v) => ({ kind: "real", value: v })) })) }, $);
    const tfs = b.add("IFCTRIANGULATEDFACESET", ref(pts), $, $, { kind: "list", values: [{ kind: "list", values: [1, 2, 3].map((v) => ({ kind: "integer", value: v })) }] }, $);
    const mesh = b.element("IFCFURNISHINGELEMENT", "Mesh", b.localPlacement(null), b.shape(h.body, [tfs], "Tessellation"), h);
    const built = buildAll(b.toString());
    const order = built.engine.prepare();
    assert.ok(order.indexOf(mesh) < order.indexOf(wall));
  });
});
