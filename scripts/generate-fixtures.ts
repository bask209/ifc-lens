// SPDX-License-Identifier: Apache-2.0
/**
 * Writes generated, Apache-2.0 test fixtures and the demo model:
 *   demo/models/harbour-pavilion.ifc      (committed demo model)
 *   tests/fixtures/generated/*.ifc        (browser/integration fixtures)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDemoBuilding } from "../tests/helpers/demo-building.ts";
import { $, IfcBuilder, ref, refs, str, guid } from "../tests/helpers/ifc-builder.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "tests", "fixtures", "generated");
mkdirSync(out, { recursive: true });
mkdirSync(join(root, "demo", "models"), { recursive: true });

const demo = buildDemoBuilding().text;
writeFileSync(join(root, "demo", "models", "harbour-pavilion.ifc"), demo);
writeFileSync(join(out, "demo.ifc"), demo);

// Single named box (picking / XSS-safety / selection tests)
{
  const b = new IfcBuilder("IFC4", "box.ifc");
  const h = b.hierarchy();
  const wall = b.element("IFCWALL", "<img src=x onerror=alert(1)>", b.localPlacement(h.storeyPlacement), b.shape(h.body, [b.box(4, 4, 4, [-2, -2, 0])]), h);
  b.contain(h, h.storey, [wall]);
  writeFileSync(join(out, "box.ifc"), b.toString());
}

// IFC2X3 building (walls + slab via extrusions and a faceted BRep)
{
  const b = new IfcBuilder("IFC2X3", "ifc2x3-basic.ifc");
  const h = b.hierarchy({ lengthUnit: "MILLIMETRE" });
  const ids = [
    b.element("IFCWALLSTANDARDCASE", "Wall A", b.localPlacement(h.storeyPlacement), b.shape(h.body, [b.box(6000, 200, 3000)]), h),
    b.element("IFCWALLSTANDARDCASE", "Wall B", b.localPlacement(h.storeyPlacement, [0, 4000, 0]), b.shape(h.body, [b.box(6000, 200, 3000)]), h),
    b.element("IFCSLAB", "Slab", b.localPlacement(h.storeyPlacement, [0, 0, -200]), b.shape(h.body, [b.box(6000, 4200, 200)]), h),
  ];
  b.contain(h, h.storey, ids);
  writeFileSync(join(out, "ifc2x3-basic.ifc"), b.toString());
}

// Unsupported item next to a supported one (diagnostic, no crash)
{
  const b = new IfcBuilder("IFC4", "unsupported.ifc");
  const h = b.hierarchy();
  const odd = b.add("IFCSECTIONEDSPINE", $, $, $);
  const p = b.element("IFCBUILDINGELEMENTPROXY", "Mixed", b.localPlacement(h.storeyPlacement), b.shape(h.body, [odd, b.box(1, 1, 1)]), h);
  b.contain(h, h.storey, [p]);
  writeFileSync(join(out, "unsupported.ifc"), b.toString());
}

// Malformed STEP: syntax errors, dangling reference and a cycle, still loadable
{
  const b = new IfcBuilder("IFC4", "malformed.ifc");
  const h = b.hierarchy();
  const ok = b.element("IFCWALL", "Survivor", b.localPlacement(h.storeyPlacement), b.shape(h.body, [b.box(2, 2, 2)]), h);
  const dangling = b.element("IFCWALL", "Dangling", b.localPlacement(h.storeyPlacement), b.shape(h.body, [9999999]), h);
  b.contain(h, h.storey, [ok, dangling]);
  b.raw("#8000000=IFCWALL('broken',,);");
  b.raw("#8000001=IFCWALL(((((((;");
  writeFileSync(join(out, "malformed.ifc"), b.toString());
}

// Not a STEP file at all
writeFileSync(join(out, "not-ifc.ifc"), "<html><body>This is not an IFC file</body></html>\n");

// Many products (resource-limit and progress tests)
{
  const b = new IfcBuilder("IFC4", "grid.ifc");
  const h = b.hierarchy();
  const ids: number[] = [];
  for (let i = 0; i < 30; i++) for (let j = 0; j < 30; j++) {
    ids.push(b.element("IFCCOLUMN", `C${i}-${j}`, b.localPlacement(h.storeyPlacement, [i * 2, j * 2, 0]), b.shape(h.body, [b.box(0.4, 0.4, 3)]), h));
  }
  b.contain(h, h.storey, ids);
  b.add("IFCRELASSIGNSTOGROUP", str(guid()), ref(h.ownerHistory), $, $, refs(ids.slice(0, 3)), $, ref(b.add("IFCGROUP", str(guid()), ref(h.ownerHistory), str("Group"), $, $)));
  writeFileSync(join(out, "grid.ifc"), b.toString());
}

// Visual fixture: mapped item rotated + mirrored, polygonal face set with holes
{
  const b = new IfcBuilder("IFC4", "visual-mapped.ifc");
  const h = b.hierarchy();
  const lshape = b.extrusion(b.arbitraryProfile([[0, 0], [2, 0], [2, 0.5], [0.5, 0.5], [0.5, 1.5], [0, 1.5]]), 0.4);
  const map = b.add("IFCREPRESENTATIONMAP", ref(b.axis3()), ref(b.add("IFCSHAPEREPRESENTATION", ref(h.body), str("Body"), str("SweptSolid"), refs([lshape]))));
  const ids: number[] = [];
  const ops: [string, number][] = [
    ["plain", b.add("IFCCARTESIANTRANSFORMATIONOPERATOR3D", $, $, ref(b.point(0, 0, 0)), $, $)],
    ["rotated", b.add("IFCCARTESIANTRANSFORMATIONOPERATOR3D", ref(b.direction(0, 1, 0)), $, ref(b.point(0, 0, 0)), $, $)],
    ["mirrored", b.add("IFCCARTESIANTRANSFORMATIONOPERATOR3D", ref(b.direction(1, 0, 0)), ref(b.direction(0, -1, 0)), ref(b.point(0, 0, 0)), $, $)],
  ];
  ops.forEach(([name, op], i) => {
    const item = b.add("IFCMAPPEDITEM", ref(map), ref(op));
    ids.push(b.element("IFCMEMBER", `L ${name}`, b.localPlacement(h.storeyPlacement, [i * 3, 0, 0]), b.shape(h.body, [item], "MappedRepresentation"), h));
  });
  const pts = b.add("IFCCARTESIANPOINTLIST3D", { kind: "list", values: [[0, 0, 0], [4, 0, 0], [4, 3, 0], [0, 3, 0], [0.5, 0.5, 0], [0.5, 1.5, 0], [1.5, 1.5, 0], [1.5, 0.5, 0], [2.5, 1, 0], [2.5, 2.5, 0], [3.5, 2.5, 0], [3.5, 1, 0]].map((c) => ({ kind: "list" as const, values: c.map((v) => ({ kind: "real" as const, value: v })) })) }, $);
  const idx = (a: number[]) => ({ kind: "list" as const, values: a.map((v) => ({ kind: "integer" as const, value: v })) });
  const face = b.add("IFCINDEXEDPOLYGONALFACEWITHVOIDS", idx([1, 2, 3, 4]), { kind: "list", values: [idx([5, 6, 7, 8]), idx([9, 10, 11, 12])] });
  ids.push(b.element("IFCPLATE", "Perforated plate", b.localPlacement(h.storeyPlacement, [0, -4, 0]), b.shape(h.body, [b.add("IFCPOLYGONALFACESET", ref(pts), $, refs([face]), $)], "Tessellation"), h));
  b.contain(h, h.storey, ids);
  writeFileSync(join(out, "visual-mapped.ifc"), b.toString());
}

console.log(`fixtures written to ${out} and demo/models/`);
