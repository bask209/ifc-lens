// SPDX-License-Identifier: Apache-2.0
/**
 * Deterministic demo building ("Harbour pavilion") exercising the supported
 * geometry families. Written with the project's own builder; the output is
 * original work licensed Apache-2.0 like the rest of the repository.
 */

import { $, IfcBuilder, bool, en, guid, int, list, real, reals, ref, refs, str, typed, type Hierarchy } from "./ifc-builder.ts";

export interface DemoIds {
  walls: number[];
  windows: number[];
  columns: number[];
  slab: number;
  roof: number;
  terrain: number;
  handrail: number;
  pipes: number[];
  stair: number;
  furniture: number[];
  spaces: number[];
  beams: number[];
  door: number;
}

function wallWithOpenings(b: IfcBuilder, h: Hierarchy, name: string, origin: [number, number, number], length: number, rotated: boolean, openings: { x: number; width: number; sill: number; height: number }[], windowMap: number | null, ids: DemoIds, style: number | null): number {
  const placement = b.localPlacement(h.storeyPlacement, origin, [0, 0, 1], rotated ? [0, 1, 0] : [1, 0, 0]);
  const thickness = 0.3;
  const body = b.box(length, thickness, 3.2);
  if (style) b.add("IFCSTYLEDITEM", ref(body), refs([style]), $);
  const axis = b.add("IFCSHAPEREPRESENTATION", ref(h.context), str("Axis"), str("Curve2D"), refs([b.polyline3([[0, thickness / 2, 0], [length, thickness / 2, 0]])]));
  const bodyRep = b.add("IFCSHAPEREPRESENTATION", ref(h.body), str("Body"), str("SweptSolid"), refs([body]));
  const shape = b.add("IFCPRODUCTDEFINITIONSHAPE", $, $, refs([axis, bodyRep]));
  const wall = b.element("IFCWALL", name, placement, shape, h, [en("STANDARD")]);
  for (const o of openings) {
    const opening = b.opening(h, wall, placement, [o.width, thickness + 0.2, o.height], [o.x, -0.1, o.sill]);
    if (windowMap) {
      const wp = b.localPlacement(placement, [o.x, 0, o.sill]);
      const op = b.add("IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM", $, $, ref(b.point(0, 0, 0)), real(o.width), $, real(1), real(o.height));
      const item = b.add("IFCMAPPEDITEM", ref(windowMap), ref(op));
      const win = b.element("IFCWINDOW", `${name} window ${ids.windows.length + 1}`, wp, b.shape(h.body, [item], "MappedRepresentation"), h, [real(o.height), real(o.width), en("WINDOW"), en("SINGLE_PANEL"), $]);
      b.add("IFCRELFILLSELEMENT", str(guid()), ref(h.ownerHistory), $, $, ref(opening), ref(win));
      ids.windows.push(win);
    }
  }
  ids.walls.push(wall);
  return wall;
}

export function buildDemoBuilding(schema = "IFC4"): { text: string; ids: DemoIds } {
  const b = new IfcBuilder(schema, "harbour-pavilion.ifc");
  const h = b.hierarchy({ name: "Harbour pavilion" });
  const ids: DemoIds = { walls: [], windows: [], columns: [], slab: 0, roof: 0, terrain: 0, handrail: 0, pipes: [], stair: 0, furniture: [], spaces: [], beams: [], door: 0 };

  const surface = (rgb: [number, number, number], transparency = 0): number => {
    const colour = b.add("IFCCOLOURRGB", $, real(rgb[0]), real(rgb[1]), real(rgb[2]));
    const rendering = b.add("IFCSURFACESTYLERENDERING", ref(colour), real(transparency), $, $, $, $, $, $, en("NOTDEFINED"));
    return b.add("IFCSURFACESTYLE", $, en("BOTH"), refs([rendering]));
  };
  const plaster = surface([0.93, 0.91, 0.86]);
  const glass = surface([0.55, 0.74, 0.86], 0.55);
  const timber = surface([0.62, 0.45, 0.3]);
  const steel = surface([0.36, 0.4, 0.45]);
  const concrete = surface([0.7, 0.7, 0.68]);
  const copper = surface([0.72, 0.45, 0.2]);
  const roofing = surface([0.28, 0.33, 0.38]);

  // --- window type as a unit-square representation map (scaled per window)
  const frameProfile = b.arbitraryProfile([[0, 0], [1, 0], [1, 1], [0, 1]], [[[0.06, 0.06], [0.94, 0.06], [0.94, 0.94], [0.06, 0.94]]]);
  const frame = b.extrusion(frameProfile, 0.08, b.axis3([0, 0.11, 0], [0, 1, 0], [1, 0, 0]));
  b.add("IFCSTYLEDITEM", ref(frame), refs([timber]), $);
  const pane = b.box(0.88, 0.02, 0.88, [0.06, 0.14, 0.06]);
  b.add("IFCSTYLEDITEM", ref(pane), refs([glass]), $);
  const windowRep = b.add("IFCSHAPEREPRESENTATION", ref(h.body), str("Body"), str("SweptSolid"), refs([frame, pane]));
  const windowMap = b.add("IFCREPRESENTATIONMAP", ref(b.axis3()), ref(windowRep));

  // --- walls with openings (Boolean subtraction) and filling windows (instanced)
  wallWithOpenings(b, h, "South facade", [0, 0, 0], 12, false, [{ x: 1.5, width: 2, sill: 0.9, height: 1.6 }, { x: 5, width: 2, sill: 0.9, height: 1.6 }, { x: 8.5, width: 2, sill: 0.9, height: 1.6 }], windowMap, ids, plaster);
  wallWithOpenings(b, h, "North facade", [0, 8, 0], 12, false, [{ x: 2, width: 3, sill: 0.6, height: 2 }, { x: 7, width: 3, sill: 0.6, height: 2 }], windowMap, ids, plaster);
  const west = wallWithOpenings(b, h, "West wall", [0.3, 0, 0], 8, true, [], null, ids, plaster);
  wallWithOpenings(b, h, "East wall", [12, 0, 0], 8, true, [{ x: 3, width: 1.2, sill: 0, height: 2.2 }], null, ids, plaster);
  void west;

  // door in the east wall opening
  const doorPlacement = b.localPlacement(h.storeyPlacement, [12, 3, 0], [0, 0, 1], [0, 1, 0]);
  const leaf = b.box(1.2, 0.06, 2.2, [0, 0.12, 0]);
  b.add("IFCSTYLEDITEM", ref(leaf), refs([timber]), $);
  ids.door = b.element("IFCDOOR", "Entrance door", doorPlacement, b.shape(h.body, [leaf]), h, [real(2.2), real(1.2), en("DOOR"), en("SINGLE_SWING_LEFT"), $]);

  // --- floor slab with a stair void (profile with hole)
  const slabProfile = b.arbitraryProfile([[0, 0], [12.3, 0], [12.3, 8.3], [0, 8.3]], [[[9, 5.5], [11.5, 5.5], [11.5, 7.5], [9, 7.5]]]);
  const slabItem = b.extrusion(slabProfile, 0.25, b.axis3([0, 0, -0.25]));
  b.add("IFCSTYLEDITEM", ref(slabItem), refs([concrete]), $);
  ids.slab = b.element("IFCSLAB", "Ground slab", b.localPlacement(h.storeyPlacement), b.shape(h.body, [slabItem]), h, [en("FLOOR")]);

  // --- mapped circular columns (instancing)
  const colRep = b.add("IFCSHAPEREPRESENTATION", ref(h.body), str("Body"), str("SweptSolid"), refs([b.extrusion(b.circleProfile(0.18), 3.2)]));
  const colMap = b.add("IFCREPRESENTATIONMAP", ref(b.axis3()), ref(colRep));
  for (let i = 0; i < 4; i++) {
    const item = b.add("IFCMAPPEDITEM", ref(colMap), ref(b.add("IFCCARTESIANTRANSFORMATIONOPERATOR3D", $, $, ref(b.point(0, 0, 0)), $, $)));
    const col = b.element("IFCCOLUMN", `Column C${i + 1}`, b.localPlacement(h.storeyPlacement, [2.4 + i * 2.4, 4, 0]), b.shape(h.body, [item], "MappedRepresentation"), h, [en("COLUMN")]);
    b.add("IFCSTYLEDITEM", ref(item), refs([steel]), $);
    ids.columns.push(col);
  }

  // --- steel I-beams (parameterised profile) along X
  for (let i = 0; i < 3; i++) {
    const profile = b.add("IFCISHAPEPROFILEDEF", en("AREA"), $, ref(b.axis2()), real(0.15), real(0.3), real(0.008), real(0.012), real(0.015));
    const beamItem = b.extrusion(profile, 12, b.axis3([0, 0, 0], [1, 0, 0], [0, 1, 0]));
    b.add("IFCSTYLEDITEM", ref(beamItem), refs([steel]), $);
    ids.beams.push(b.element("IFCBEAM", `Beam B${i + 1}`, b.localPlacement(h.storeyPlacement, [0.15, 1.5 + i * 2.5, 3.05]), b.shape(h.body, [beamItem]), h, [en("BEAM")]));
  }

  // --- pitched roof: slab clipped by two half-spaces (IfcBooleanClippingResult)
  const roofBlock = b.box(13, 9, 2.2, [-0.35, -0.35, 0]);
  const plane1 = b.add("IFCPLANE", ref(b.axis3([0, 4.15, 1.9], [0, 0.45, 0.893], [1, 0, 0])));
  const plane2 = b.add("IFCPLANE", ref(b.axis3([0, 4.15, 1.9], [0, -0.45, 0.893], [1, 0, 0])));
  const clip1 = b.add("IFCBOOLEANCLIPPINGRESULT", en("DIFFERENCE"), ref(roofBlock), ref(b.add("IFCHALFSPACESOLID", ref(plane1), bool(false))));
  const clip2 = b.add("IFCBOOLEANCLIPPINGRESULT", en("DIFFERENCE"), ref(clip1), ref(b.add("IFCHALFSPACESOLID", ref(plane2), bool(false))));
  const hollow = b.add("IFCBOOLEANRESULT", en("DIFFERENCE"), ref(clip2), ref(b.box(1.6, 1.2, 3, [7.2, 2.3, -0.5]))); // skylight
  b.add("IFCSTYLEDITEM", ref(hollow), refs([roofing]), $);
  ids.roof = b.element("IFCROOF", "Pitched roof", b.localPlacement(h.storeyPlacement, [0, 0, 3.2]), b.shape(h.body, [hollow], "Clipping"), h, [en("GABLE_ROOF")]);

  // --- stair: faceted BRep steps
  const stairItems: number[] = [];
  for (let s = 0; s < 8; s++) stairItems.push(b.box(2.3, 0.25, 0.2, [9.1, 5.5 + s * 0.25, s * 0.2 - 0.25]));
  const stairFaces: number[] = [];
  // one explicit BRep (a landing block) to exercise faceted BReps
  const P = (x: number, y: number, z: number): number => b.point(x, y, z);
  const corners = [P(9.1, 7.5, 1.35), P(11.4, 7.5, 1.35), P(11.4, 8, 1.35), P(9.1, 8, 1.35), P(9.1, 7.5, 1.55), P(11.4, 7.5, 1.55), P(11.4, 8, 1.55), P(9.1, 8, 1.55)];
  for (const q of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]) {
    const loop = b.add("IFCPOLYLOOP", refs(q.map((k) => corners[k]!)));
    stairFaces.push(b.add("IFCFACE", refs([b.add("IFCFACEOUTERBOUND", ref(loop), bool(true))])));
  }
  stairItems.push(b.add("IFCFACETEDBREP", ref(b.add("IFCCLOSEDSHELL", refs(stairFaces)))));
  for (const it of stairItems) b.add("IFCSTYLEDITEM", ref(it), refs([concrete]), $);
  ids.stair = b.element("IFCSTAIRFLIGHT", "Stair to terrace", b.localPlacement(h.storeyPlacement), b.shape(h.body, stairItems, "Brep"), h, [int(8), int(8), real(0.2), real(0.25), en("STRAIGHT")]);

  // --- handrail: swept disk along a polyline with a bend
  const rail = b.add("IFCSWEPTDISKSOLID", ref(b.polyline3([[9.05, 5.4, 0.9], [9.05, 7.4, 2.5], [11.4, 7.4, 2.5]])), real(0.025), $, $, $);
  b.add("IFCSTYLEDITEM", ref(rail), refs([steel]), $);
  ids.handrail = b.element("IFCRAILING", "Stair handrail", b.localPlacement(h.storeyPlacement), b.shape(h.body, [rail], "AdvancedSweptSolid"), h, [en("HANDRAIL")]);

  // --- pipes: hollow swept disks with fillets (IFC4 polygonal)
  for (let i = 0; i < 2; i++) {
    const path = b.polyline3([[0.6, 0.6 + i * 0.25, 0.2], [0.6, 7.2 + i * 0.25, 0.2], [0.6, 7.2 + i * 0.25, 2.8], [6, 7.2 + i * 0.25, 2.8]]);
    const pipe = b.add("IFCSWEPTDISKSOLIDPOLYGONAL", ref(path), real(0.05), real(0.042), $, $, real(0.25));
    b.add("IFCSTYLEDITEM", ref(pipe), refs([copper]), $);
    ids.pipes.push(b.element("IFCPIPESEGMENT", `Supply pipe ${i + 1}`, b.localPlacement(h.storeyPlacement), b.shape(h.body, [pipe], "AdvancedSweptSolid"), h, [en("RIGIDSEGMENT")]));
  }

  // --- furniture: revolved table leg + extruded top; tessellated bench with colour map
  const tableTop = b.extrusion(b.circleProfile(0.6), 0.04, b.axis3([0, 0, 0.72]));
  const legProfile = b.add("IFCARBITRARYCLOSEDPROFILEDEF", en("AREA"), $, ref(b.polyline2([[0, 0], [0.25, 0], [0.25, 0.03], [0.04, 0.08], [0.03, 0.72], [0, 0.72]])));
  const leg = b.add("IFCREVOLVEDAREASOLID", ref(legProfile), ref(b.axis3([0, 0, 0], [1, 0, 0], [0, 1, 0])), ref(b.add("IFCAXIS1PLACEMENT", ref(b.point(0, 0, 0)), ref(b.direction(0, 1, 0)))), real(Math.PI * 2));
  b.add("IFCSTYLEDITEM", ref(tableTop), refs([timber]), $);
  b.add("IFCSTYLEDITEM", ref(leg), refs([steel]), $);
  ids.furniture.push(b.element("IFCFURNITURE", "Round table", b.localPlacement(h.storeyPlacement, [4, 2.2, 0]), b.shape(h.body, [tableTop, leg], "SweptSolid"), h, [$, en("TABLE")]));
  const benchPts = [[0, 0, 0], [2, 0, 0], [2, 0.4, 0], [0, 0.4, 0], [0, 0, 0.45], [2, 0, 0.45], [2, 0.4, 0.45], [0, 0.4, 0.45]];
  const benchCoords = b.add("IFCCARTESIANPOINTLIST3D", list(benchPts.map((p) => reals(p))), $);
  const tris = [[1, 4, 3], [1, 3, 2], [5, 6, 7], [5, 7, 8], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 4, 8], [3, 8, 7], [4, 1, 5], [4, 5, 8]];
  const bench = b.add("IFCTRIANGULATEDFACESET", ref(benchCoords), $, bool(true), list(tris.map((t) => list(t.map(int)))), $);
  const palette = b.add("IFCCOLOURRGBLIST", list([reals([0.62, 0.45, 0.3]), reals([0.3, 0.3, 0.3])]));
  b.add("IFCINDEXEDCOLOURMAP", ref(bench), real(1), ref(palette), list([2, 2, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2].map(int)));
  ids.furniture.push(b.element("IFCFURNITURE", "Bench", b.localPlacement(h.storeyPlacement, [1.5, 6.5, 0]), b.shape(h.body, [bench], "Tessellation"), h, [$, en("BENCH")]));

  // --- spaces (translucent)
  const hall = b.element("IFCSPACE", "Hall", b.localPlacement(h.storeyPlacement), b.shape(h.body, [b.box(8.6, 7.7, 3, [0.3, 0.3, 0])]), h, [str("Main hall"), en("ELEMENT"), en("INTERNAL"), $]);
  const stairwell = b.element("IFCSPACE", "Stairwell", b.localPlacement(h.storeyPlacement), b.shape(h.body, [b.box(2.8, 7.7, 3, [8.9, 0.3, 0])]), h, [str("Stairwell"), en("ELEMENT"), en("INTERNAL"), $]);
  ids.spaces.push(hall, stairwell);

  // --- site terrain (triangulated irregular grid) under the site
  const n = 12;
  const pts: number[][] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const x = -8 + (i * 28) / n, y = -8 + (j * 24) / n;
    const d = Math.max(0, Math.hypot(x - 6, y - 4) - 9);
    pts.push([x, y, -0.3 - 0.02 * d * d + 0.12 * Math.sin(i * 0.9) * Math.cos(j * 0.7) * Math.min(1, d)]);
  }
  const faces: number[][] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * (n + 1) + i + 1, bb = a + 1, c = a + n + 2, d = a + n + 1;
    faces.push([a, bb, c], [a, c, d]);
  }
  const terrainCoords = b.add("IFCCARTESIANPOINTLIST3D", list(pts.map((p) => reals(p))), $);
  const terrainItem = b.add("IFCTRIANGULATEDFACESET", ref(terrainCoords), $, bool(false), list(faces.map((t) => list(t.map(int)))), $);
  const grass = surface([0.52, 0.64, 0.42]);
  b.add("IFCSTYLEDITEM", ref(terrainItem), refs([grass]), $);
  ids.terrain = b.element("IFCGEOGRAPHICELEMENT", "Terrain", b.localPlacement(null), b.shape(h.body, [terrainItem], "Tessellation"), h, [en("TERRAIN")]);

  // --- containment, properties, quantities, materials, classification
  const elements = [...ids.walls, ...ids.windows, ...ids.columns, ids.slab, ids.roof, ids.stair, ids.handrail, ...ids.pipes, ...ids.furniture, ...ids.beams, ids.door];
  b.contain(h, h.storey, elements);
  b.add("IFCRELAGGREGATES", str(guid()), ref(h.ownerHistory), $, $, ref(h.storey), refs(ids.spaces));
  b.contain(h, h.site, [ids.terrain]);
  b.propertySet(h, ids.walls, "Pset_WallCommon", [
    ["IsExternal", typed("IFCBOOLEAN", en("T"))],
    ["LoadBearing", typed("IFCBOOLEAN", en("T"))],
    ["FireRating", typed("IFCLABEL", str("REI 60"))],
    ["ThermalTransmittance", typed("IFCTHERMALTRANSMITTANCEMEASURE", real(0.21))],
  ]);
  for (const w of ids.walls) b.quantities(h, [w], "Qto_WallBaseQuantities", { length: [["Length", 12], ["Height", 3.2], ["Width", 0.3]] });
  b.propertySet(h, ids.columns, "Pset_ColumnCommon", [["Reference", typed("IFCIDENTIFIER", str("CHS 360"))], ["LoadBearing", typed("IFCBOOLEAN", en("T"))]]);
  b.propertySet(h, ids.spaces, "Pset_SpaceCommon", [["IsExternal", typed("IFCBOOLEAN", en("F"))], ["PubliclyAccessible", typed("IFCBOOLEAN", en("T"))]]);
  b.quantities(h, [ids.slab], "Qto_SlabBaseQuantities", { area: [["GrossArea", 97.1]], volume: [["NetVolume", 23.1]] });
  const mat = (name: string, style: number): number => {
    const m = b.add("IFCMATERIAL", str(name), $, str(name.toLowerCase()));
    const si = b.add("IFCSTYLEDITEM", $, refs([style]), $);
    const srep = b.add("IFCSTYLEDREPRESENTATION", ref(h.context), $, $, refs([si]));
    b.add("IFCMATERIALDEFINITIONREPRESENTATION", $, $, refs([srep]), ref(m));
    return m;
  };
  const concreteMat = mat("Concrete C30/37", concrete);
  const steelMat = mat("Steel S355", steel);
  const brick = mat("Lime plaster on brick", plaster);
  const layer = b.add("IFCMATERIALLAYER", ref(brick), real(0.3), $, str("Masonry"), $, $, $);
  const layerSet = b.add("IFCMATERIALLAYERSET", refs([layer]), str("External wall 300"), $);
  b.add("IFCRELASSOCIATESMATERIAL", str(guid()), ref(h.ownerHistory), $, $, refs(ids.walls), ref(b.add("IFCMATERIALLAYERSETUSAGE", ref(layerSet), en("AXIS2"), en("POSITIVE"), real(0), $)));
  b.add("IFCRELASSOCIATESMATERIAL", str(guid()), ref(h.ownerHistory), $, $, refs([ids.slab, ids.stair]), ref(concreteMat));
  b.add("IFCRELASSOCIATESMATERIAL", str(guid()), ref(h.ownerHistory), $, $, refs([...ids.columns, ...ids.beams, ids.handrail]), ref(steelMat));
  const uniclass = b.add("IFCCLASSIFICATION", $, str("2015"), $, str("Uniclass 2015"), $, $, $);
  const wallsRef = b.add("IFCCLASSIFICATIONREFERENCE", $, str("EF_25_10"), str("Walls"), ref(uniclass), $, $);
  b.add("IFCRELASSOCIATESCLASSIFICATION", str(guid()), ref(h.ownerHistory), $, $, refs(ids.walls), ref(wallsRef));
  const wallType = b.add("IFCWALLTYPE", str(guid()), ref(h.ownerHistory), str("External wall 300"), $, $, $, $, $, $, en("STANDARD"));
  b.add("IFCRELDEFINESBYTYPE", str(guid()), ref(h.ownerHistory), $, $, refs(ids.walls), ref(wallType));
  return { text: b.toString(), ids };
}
