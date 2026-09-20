// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NativeCsgBackend } from "../../src/csg/native.ts";
import { GeometryContext } from "../../src/geometry/context.ts";
import { tessellateCurve } from "../../src/geometry/curves.ts";
import { analyzeEdges, isFiniteMesh, meshBounds, meshVolume, weldMesh } from "../../src/geometry/mesh.ts";
import { profileShape } from "../../src/geometry/profiles.ts";
import { signedArea } from "../../src/triangulation/polygon.ts";
import { $, IfcBuilder, bool, en, int, list, real, reals, ref, refs, str, typed, singleItemModel, type Arg } from "../helpers/ifc-builder.ts";
import { approx, buildAll, loadModel, worldMesh } from "../helpers/model.ts";

function ctxFor(b: IfcBuilder): GeometryContext {
  return new GeometryContext(loadModel(b.toString()), new NativeCsgBackend());
}

function productMesh(build: Parameters<typeof singleItemModel>[0], options: Parameters<typeof singleItemModel>[1] = {}) {
  const { text, productId } = singleItemModel(build, options);
  const built = buildAll(text);
  return { built, mesh: worldMesh(built, productId), productId };
}

function closed(mesh: ReturnType<typeof worldMesh>): boolean {
  const e = analyzeEdges(weldMesh(mesh, 1e-7));
  return e.boundaryEdges === 0 && e.nonManifoldEdges === 0 && e.inconsistentEdges === 0;
}

function profileArea(b: IfcBuilder, id: number): number {
  const shape = profileShape(ctxFor(b), id);
  let a = 0;
  for (const area of shape.areas) {
    a += signedArea(area.outer, 0, area.outer.length / 2);
    for (const h of area.holes) a += signedArea(h, 0, h.length / 2);
  }
  return a;
}

describe("curves", () => {
  it("tessellates circles within the chord tolerance", () => {
    const b = new IfcBuilder();
    const c = b.add("IFCCIRCLE", ref(b.axis2()), real(10));
    const poly = tessellateCurve(ctxFor(b), c);
    assert.ok(poly.closed);
    const n = poly.points.length / 3;
    assert.ok(n >= 12 && n <= 96, `${n} segments`);
    for (let i = 0; i < poly.points.length; i += 3) approx(Math.hypot(poly.points[i]!, poly.points[i + 1]!), 10, 1e-9);
  });

  it("trims circles by parameter in degrees honouring SenseAgreement", () => {
    const b = new IfcBuilder();
    b.hierarchy({ angleUnit: "DEGREE" });
    const c = b.add("IFCCIRCLE", ref(b.axis2()), real(1));
    const ccw = b.add("IFCTRIMMEDCURVE", ref(c), list([typed("IFCPARAMETERVALUE", real(0))]), list([typed("IFCPARAMETERVALUE", real(90))]), bool(true), en("PARAMETER"));
    const cw = b.add("IFCTRIMMEDCURVE", ref(c), list([typed("IFCPARAMETERVALUE", real(0))]), list([typed("IFCPARAMETERVALUE", real(90))]), bool(false), en("PARAMETER"));
    const ctx = ctxFor(b);
    const a = tessellateCurve(ctx, ccw).points;
    approx(a.at(-3)!, 0, 1e-9);
    approx(a.at(-2)!, 1, 1e-9);
    const midA = a[Math.floor(a.length / 6) * 3 + 1]!;
    assert.ok(midA > 0, "counter-clockwise arc stays in y > 0");
    const bpts = tessellateCurve(ctx, cw).points;
    assert.ok(bpts.length > a.length, "clockwise arc is the long (270°) way round");
  });

  it("trims lines by Cartesian points", () => {
    const b = new IfcBuilder();
    const line = b.add("IFCLINE", ref(b.point(0, 0)), ref(b.add("IFCVECTOR", ref(b.direction(1, 0)), real(2))));
    const t = b.add("IFCTRIMMEDCURVE", ref(line), list([ref(b.point(1, 0))]), list([ref(b.point(5, 0))]), bool(true), en("CARTESIAN"));
    assert.deepEqual(tessellateCurve(ctxFor(b), t).points, [1, 0, 0, 5, 0, 0]);
  });

  it("evaluates indexed poly curves with arc segments", () => {
    const b = new IfcBuilder();
    const pts = b.add("IFCCARTESIANPOINTLIST2D", list([reals([0, 0]), reals([1, 1]), reals([2, 0]), reals([2, -1])]), $);
    const curve = b.add("IFCINDEXEDPOLYCURVE", ref(pts), list([typed("IFCARCINDEX", list([int(1), int(2), int(3)])), typed("IFCLINEINDEX", list([int(3), int(4)]))]), $);
    const p = tessellateCurve(ctxFor(b), curve).points;
    for (let i = 0; i < p.length - 3; i += 3) {
      if (p[i + 1]! >= 0 && p[i]! <= 2) approx(Math.hypot(p[i]! - 1, p[i + 1]!), 1, 1e-9);
    }
    assert.deepEqual(p.slice(-3), [2, -1, 0]);
  });

  it("rejects out-of-range indexed curve indices", () => {
    const b = new IfcBuilder();
    const pts = b.add("IFCCARTESIANPOINTLIST2D", list([reals([0, 0]), reals([1, 1])]), $);
    const curve = b.add("IFCINDEXEDPOLYCURVE", ref(pts), list([typed("IFCLINEINDEX", list([int(1), int(99)]))]), $);
    assert.throws(() => tessellateCurve(ctxFor(b), curve), /out of range/);
  });

  it("evaluates B-splines through their end control points", () => {
    const b = new IfcBuilder();
    const ctrl = [b.point(0, 0), b.point(1, 2), b.point(3, 2), b.point(4, 0)];
    const s = b.add("IFCBSPLINECURVEWITHKNOTS", int(3), refs(ctrl), en("UNSPECIFIED"), bool(false), bool(false), list([int(4), int(4)]), reals([0, 1]), en("UNSPECIFIED"));
    const p = tessellateCurve(ctxFor(b), s).points;
    assert.deepEqual(p.slice(0, 3), [0, 0, 0]);
    approx(p.at(-3)!, 4, 1e-12);
    approx(p.at(-2)!, 0, 1e-12);
  });

  it("concatenates composite curves honouring SameSense", () => {
    const b = new IfcBuilder();
    const a = b.polyline3([[0, 0, 0], [1, 0, 0]]);
    const c = b.polyline3([[2, 0, 0], [1, 0, 0]]);
    const s1 = b.add("IFCCOMPOSITECURVESEGMENT", en("CONTINUOUS"), bool(true), ref(a));
    const s2 = b.add("IFCCOMPOSITECURVESEGMENT", en("CONTINUOUS"), bool(false), ref(c));
    const cc = b.add("IFCCOMPOSITECURVE", refs([s1, s2]), bool(false));
    assert.deepEqual(tessellateCurve(ctxFor(b), cc).points, [0, 0, 0, 1, 0, 0, 2, 0, 0]);
  });
});

describe("profiles", () => {
  it("computes parameterised profile areas", () => {
    const b = new IfcBuilder();
    const rect = b.rectangleProfile(2, 3);
    const hollow = b.add("IFCRECTANGLEHOLLOWPROFILEDEF", en("AREA"), $, ref(b.axis2()), real(2), real(3), real(0.1), $, $);
    const circle = b.circleProfile(1);
    const ring = b.add("IFCCIRCLEHOLLOWPROFILEDEF", en("AREA"), $, ref(b.axis2()), real(1), real(0.25));
    const ishape = b.add("IFCISHAPEPROFILEDEF", en("AREA"), $, ref(b.axis2()), real(0.2), real(0.4), real(0.01), real(0.02), $);
    const lshape = b.add("IFCLSHAPEPROFILEDEF", en("AREA"), $, ref(b.axis2()), real(0.1), real(0.08), real(0.01), $, $, $);
    const ushape = b.add("IFCUSHAPEPROFILEDEF", en("AREA"), $, ref(b.axis2()), real(0.2), real(0.1), real(0.01), real(0.015), $, $, $);
    const tshape = b.add("IFCTSHAPEPROFILEDEF", en("AREA"), $, ref(b.axis2()), real(0.3), real(0.2), real(0.02), real(0.03), $, $, $, $, $);
    const zshape = b.add("IFCZSHAPEPROFILEDEF", en("AREA"), $, ref(b.axis2()), real(0.2), real(0.1), real(0.01), real(0.02), $, $);
    const trap = b.add("IFCTRAPEZIUMPROFILEDEF", en("AREA"), $, ref(b.axis2()), real(4), real(2), real(1), real(1));
    approx(profileArea(b, rect), 6, 1e-12);
    approx(profileArea(b, hollow), 6 - 1.8 * 2.8, 1e-12);
    approx(profileArea(b, circle), Math.PI, 0.1);
    approx(profileArea(b, ring), Math.PI * (1 - 0.75 ** 2), 0.1);
    approx(profileArea(b, ishape), 2 * 0.2 * 0.02 + 0.01 * 0.36, 1e-12);
    approx(profileArea(b, lshape), 0.1 * 0.01 + 0.07 * 0.01, 1e-12);
    approx(profileArea(b, ushape), 2 * 0.1 * 0.015 + 0.01 * 0.17, 1e-12);
    approx(profileArea(b, tshape), 0.2 * 0.03 + 0.02 * 0.27, 1e-12);
    approx(profileArea(b, zshape), 2 * 0.1 * 0.02 + 0.01 * 0.16, 1e-12);
    approx(profileArea(b, trap), 3, 1e-12);
  });

  it("applies profile position and derived-profile operators, including mirroring", () => {
    const b = new IfcBuilder();
    const base = b.rectangleProfile(2, 1, b.axis2([5, 0]));
    const op = b.add("IFCCARTESIANTRANSFORMATIONOPERATOR2D", ref(b.direction(-1, 0)), $, ref(b.point(0, 0)), $);
    const derived = b.add("IFCDERIVEDPROFILEDEF", en("AREA"), $, ref(base), ref(op), $);
    const shape = profileShape(ctxFor(b), derived);
    const xs = shape.areas[0]!.outer.filter((_, i) => i % 2 === 0);
    assert.ok(Math.max(...xs) <= -3.999 && Math.min(...xs) >= -6.001);
    assert.ok(signedArea(shape.areas[0]!.outer, 0, 4) > 0, "outer loop normalised to CCW");
  });

  it("rejects non-positive dimensions", () => {
    const b = new IfcBuilder();
    const bad = b.add("IFCRECTANGLEPROFILEDEF", en("AREA"), $, ref(b.axis2()), real(-1), real(1));
    assert.throws(() => profileShape(ctxFor(b), bad), /positive/);
  });

  it("builds centre-line profiles as closed outlines", () => {
    const b = new IfcBuilder();
    const centre = b.polyline3([[0, 0, 0], [10, 0, 0]]);
    const p = b.add("IFCCENTERLINEPROFILEDEF", en("AREA"), $, ref(centre), real(0.2));
    approx(profileArea(b, p), 2, 1e-9);
  });
});

describe("swept and primitive solids", () => {
  it("extrudes a rectangle into a closed box of the right volume", () => {
    const { mesh } = productMesh((b) => [b.box(2, 3, 4)]);
    approx(meshVolume(mesh), 24, 1e-9);
    assert.ok(closed(mesh));
    assert.ok(isFiniteMesh(mesh));
  });

  it("extrudes profiles with several holes", () => {
    const { mesh } = productMesh((b) => [b.extrusion(b.arbitraryProfile([[0, 0], [10, 0], [10, 10], [0, 10]], [[[1, 1], [3, 1], [3, 3], [1, 3]], [[5, 5], [8, 5], [8, 8], [5, 8]]]), 2)]);
    approx(meshVolume(mesh), (100 - 4 - 9) * 2, 1e-9);
    assert.ok(closed(mesh));
  });

  it("supports non-Z extrusion directions and rotated positions", () => {
    const { mesh } = productMesh((b) => [b.extrusion(b.rectangleProfile(1, 1), 2, b.axis3([0, 0, 0], [1, 0, 0], [0, 1, 0]), [0, 1, 1])]);
    approx(meshVolume(mesh), Math.SQRT1_2 * 2, 1e-9); // sheared prism: base area × height along normal
    const bounds = meshBounds(mesh);
    approx(bounds.maxX, Math.SQRT2, 1e-9);
    assert.ok(closed(mesh));
  });

  it("orients downward extrusions outward", () => {
    const { mesh } = productMesh((b) => [b.extrusion(b.rectangleProfile(1, 1), 3, undefined, [0, 0, -1])]);
    approx(meshVolume(mesh), 3, 1e-9);
  });

  it("reports malformed extrusion depth without crashing the model", () => {
    const { built, productId } = productMesh((b) => [b.extrusion(b.rectangleProfile(1, 1), -2), b.box(1, 1, 1, [5, 0, 0])]);
    approx(meshVolume(worldMesh(built, productId)), 1, 1e-9);
    assert.ok(built.model.diagnostics.items.some((d) => /depth must be positive/.test(d.message)));
  });

  it("revolves a profile into a torus-like ring", () => {
    const { mesh } = productMesh((b) => {
      const profile = b.rectangleProfile(1, 1, b.axis2([3, 0]));
      const axis = b.add("IFCAXIS1PLACEMENT", ref(b.point(0, 0, 0)), ref(b.direction(0, 1, 0)));
      return [b.add("IFCREVOLVEDAREASOLID", ref(profile), ref(b.axis3()), ref(axis), real(Math.PI * 2))];
    });
    // Pappus: area × 2π × centroid distance
    approx(meshVolume(mesh), 1 * 2 * Math.PI * 3, 0.5);
    assert.ok(closed(mesh));
  });

  it("revolves partial sweeps with caps (angle in degrees)", () => {
    const { mesh } = productMesh(
      (b) => {
        const profile = b.rectangleProfile(1, 1, b.axis2([3, 0]));
        const axis = b.add("IFCAXIS1PLACEMENT", ref(b.point(0, 0, 0)), ref(b.direction(0, 1, 0)));
        return [b.add("IFCREVOLVEDAREASOLID", ref(profile), ref(b.axis3()), ref(axis), real(90))];
      },
      { angleUnit: "DEGREE" },
    );
    approx(meshVolume(mesh), (Math.PI / 2) * 3, 0.1);
    assert.ok(closed(mesh));
  });

  it("sweeps a disk along a straight directrix", () => {
    const { mesh } = productMesh((b) => [b.add("IFCSWEPTDISKSOLID", ref(b.polyline3([[0, 0, 0], [0, 0, 10]])), real(0.5), $, $, $)]);
    approx(meshVolume(mesh), Math.PI * 0.25 * 10, 0.15);
    assert.ok(closed(mesh));
  });

  it("sweeps hollow disks around a 90° corner with mitred joints", () => {
    const { mesh } = productMesh((b) => [b.add("IFCSWEPTDISKSOLID", ref(b.polyline3([[0, 0, 0], [5, 0, 0], [5, 5, 0]])), real(0.5), real(0.4), $, $)]);
    const ring = Math.PI * (0.25 - 0.16);
    approx(meshVolume(mesh), ring * 10, 0.05);
    assert.ok(closed(mesh));
  });

  it("sweeps closed directrices without caps", () => {
    const { mesh } = productMesh((b) => [b.add("IFCSWEPTDISKSOLID", ref(b.polyline3([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 0]])), real(0.5), $, $, $)]);
    approx(meshVolume(mesh), Math.PI * 0.25 * 40, 0.8);
    assert.ok(closed(mesh));
  });

  it("fillets polygonal swept disks and diagnoses reversals", () => {
    const filleted = productMesh((b) => [b.add("IFCSWEPTDISKSOLIDPOLYGONAL", ref(b.polyline3([[0, 0, 0], [5, 0, 0], [5, 5, 0]])), real(0.2), $, $, $, real(1))]);
    assert.ok(closed(filleted.mesh));
    const reversed = productMesh((b) => [b.add("IFCSWEPTDISKSOLID", ref(b.polyline3([[0, 0, 0], [5, 0, 0], [0, 0.001, 0]])), real(0.2), $, $, $)]);
    assert.ok(reversed.built.model.diagnostics.items.some((d) => d.code === "SWEEP_INVALID"));
  });

  it("sweeps profiles with a fixed reference", () => {
    const { mesh } = productMesh((b) => [
      b.add("IFCFIXEDREFERENCESWEPTAREASOLID", ref(b.rectangleProfile(0.2, 0.4)), ref(b.axis3()), ref(b.polyline3([[0, 0, 0], [0, 10, 0]])), $, $, ref(b.direction(0, 0, 1))),
    ]);
    approx(meshVolume(mesh), 0.08 * 10, 1e-6);
    const bb = meshBounds(mesh);
    // profile X (0.2) follows the fixed reference (world Z); profile Y (0.4) = tangent × X = world X
    approx(bb.maxZ - bb.minZ, 0.2, 1e-6);
    approx(bb.maxX - bb.minX, 0.4, 1e-6);
  });

  it("builds CSG primitives with analytic volumes", () => {
    const vol = (build: Parameters<typeof productMesh>[0]): number => meshVolume(productMesh(build).mesh);
    approx(vol((b) => [b.add("IFCBLOCK", ref(b.axis3()), real(1), real(2), real(3))]), 6, 1e-12);
    approx(vol((b) => [b.add("IFCRECTANGULARPYRAMID", ref(b.axis3()), real(2), real(3), real(4))]), 8, 1e-12);
    approx(vol((b) => [b.add("IFCRIGHTCIRCULARCYLINDER", ref(b.axis3()), real(2), real(1))]), 2 * Math.PI, 0.1);
    approx(vol((b) => [b.add("IFCRIGHTCIRCULARCONE", ref(b.axis3()), real(3), real(1))]), Math.PI, 0.05);
    approx(vol((b) => [b.add("IFCSPHERE", ref(b.axis3()), real(1))]), (4 / 3) * Math.PI, 0.1);
  });

  it("converts millimetre models to metres", () => {
    const { mesh } = productMesh((b) => [b.box(1000, 2000, 3000)], { lengthUnit: "MILLIMETRE" });
    approx(meshVolume(mesh), 6, 1e-9);
  });
});

describe("tessellated geometry and BReps", () => {
  const cubeCoords = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
  const cubeTris = [[1, 4, 3], [1, 3, 2], [5, 6, 7], [5, 7, 8], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 4, 8], [3, 8, 7], [4, 1, 5], [4, 5, 8]];
  const intList = (rows: number[][]): Arg => list(rows.map((r) => list(r.map(int))));

  it("reads triangulated face sets with one-based indices", () => {
    const { mesh } = productMesh((b) => {
      const pts = b.add("IFCCARTESIANPOINTLIST3D", list(cubeCoords.map((c) => reals(c))), $);
      return [b.add("IFCTRIANGULATEDFACESET", ref(pts), $, bool(true), intList(cubeTris), $)];
    });
    approx(meshVolume(mesh), 1, 1e-12);
  });

  it("applies PnIndex indirection", () => {
    const { mesh } = productMesh((b) => {
      const reversed = [...cubeCoords].reverse();
      const pts = b.add("IFCCARTESIANPOINTLIST3D", list(reversed.map((c) => reals(c))), $);
      const pn = list([8, 7, 6, 5, 4, 3, 2, 1].map(int));
      return [b.add("IFCTRIANGULATEDFACESET", ref(pts), $, bool(true), intList(cubeTris), pn)];
    });
    approx(meshVolume(mesh), 1, 1e-12);
  });

  it("rejects enormous or zero indices before accessing memory", () => {
    const { built, mesh } = productMesh((b) => {
      const pts = b.add("IFCCARTESIANPOINTLIST3D", list(cubeCoords.map((c) => reals(c))), $);
      return [b.add("IFCTRIANGULATEDFACESET", ref(pts), $, bool(true), intList([[1, 2, 2147483647]]), $), b.add("IFCTRIANGULATEDFACESET", ref(pts), $, bool(true), intList([[0, 1, 2]]), $), b.box(1, 1, 1)];
    });
    approx(meshVolume(mesh), 1, 1e-12);
    assert.equal(built.model.diagnostics.items.filter((d) => /out of range/.test(d.message)).length, 2);
  });

  it("splits triangulated face sets by indexed colour maps", () => {
    const { built, productId } = productMesh((b) => {
      const pts = b.add("IFCCARTESIANPOINTLIST3D", list(cubeCoords.map((c) => reals(c))), $);
      const tfs = b.add("IFCTRIANGULATEDFACESET", ref(pts), $, bool(true), intList(cubeTris), $);
      const colours = b.add("IFCCOLOURRGBLIST", list([reals([1, 0, 0]), reals([0, 0, 1])]));
      b.add("IFCINDEXEDCOLOURMAP", ref(tfs), real(1), ref(colours), list([1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2].map(int)));
      return [tfs];
    });
    const keys = built.products.get(productId)!.parts.map((p) => p.colorKey).sort();
    assert.deepEqual(keys, ["0,0,255,255", "255,0,0,255"]);
  });

  it("triangulates polygonal face sets with voids", () => {
    const { mesh } = productMesh((b) => {
      const pts = b.add("IFCCARTESIANPOINTLIST3D", list([[0, 0, 0], [4, 0, 0], [4, 4, 0], [0, 4, 0], [1, 1, 0], [1, 3, 0], [3, 3, 0], [3, 1, 0]].map((c) => reals(c))), $);
      const face = b.add("IFCINDEXEDPOLYGONALFACEWITHVOIDS", list([1, 2, 3, 4].map(int)), intList([[5, 6, 7, 8]]));
      return [b.add("IFCPOLYGONALFACESET", ref(pts), bool(false), refs([face]), $)];
    });
    let area = 0;
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const [a, bb, c] = [mesh.indices[i]! * 3, mesh.indices[i + 1]! * 3, mesh.indices[i + 2]! * 3];
      const p = mesh.positions;
      area += Math.abs((p[bb]! - p[a]!) * (p[c + 1]! - p[a + 1]!) - (p[bb + 1]! - p[a + 1]!) * (p[c]! - p[a]!)) / 2;
    }
    approx(area, 12, 1e-9);
  });

  function brepCube(b: IfcBuilder, size: number, origin: [number, number, number], reverseLast = false): number {
    const P = cubeCoords.map(([x, y, z]) => b.point(origin[0] + x! * size, origin[1] + y! * size, origin[2] + z! * size));
    const quads = [[1, 4, 3, 2], [5, 6, 7, 8], [1, 2, 6, 5], [2, 3, 7, 6], [3, 4, 8, 7], [4, 1, 5, 8]];
    const faces = quads.map((q, i) => {
      const loop = b.add("IFCPOLYLOOP", refs((reverseLast && i === 5 ? [...q].reverse() : q).map((k) => P[k - 1]!)));
      const bound = b.add("IFCFACEOUTERBOUND", ref(loop), bool(!(reverseLast && i === 5)));
      return b.add("IFCFACE", refs([bound]));
    });
    return b.add("IFCCLOSEDSHELL", refs(faces));
  }

  it("builds closed faceted BReps and honours bound orientation flags", () => {
    const { mesh } = productMesh((b) => [b.add("IFCFACETEDBREP", ref(brepCube(b, 2, [0, 0, 0], true)))]);
    approx(meshVolume(mesh), 8, 1e-9);
    assert.ok(closed(mesh));
  });

  it("builds BReps with voids", () => {
    const { mesh } = productMesh((b) => {
      const outer = brepCube(b, 4, [0, 0, 0]);
      // inner shell listed with inward orientation (reversed faces)
      const P = cubeCoords.map(([x, y, z]) => b.point(1 + x!, 1 + y!, 1 + z!));
      const quads = [[1, 2, 3, 4], [5, 8, 7, 6], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 8, 4], [4, 8, 5, 1]];
      const faces = quads.map((q) => b.add("IFCFACE", refs([b.add("IFCFACEOUTERBOUND", ref(b.add("IFCPOLYLOOP", refs(q.map((k) => P[k - 1]!)))), bool(true))])));
      const inner = b.add("IFCCLOSEDSHELL", refs(faces));
      return [b.add("IFCFACETEDBREPWITHVOIDS", ref(outer), refs([inner]))];
    });
    approx(meshVolume(mesh), 64 - 1, 1e-9);
  });

  it("renders open shells from shell-based surface models", () => {
    const { mesh } = productMesh((b) => {
      const loop = b.add("IFCPOLYLOOP", refs([b.point(0, 0, 0), b.point(1, 0, 0), b.point(1, 1, 0), b.point(0, 1, 0)]));
      const face = b.add("IFCFACE", refs([b.add("IFCFACEOUTERBOUND", ref(loop), bool(true))]));
      return [b.add("IFCSHELLBASEDSURFACEMODEL", refs([b.add("IFCOPENSHELL", refs([face]))]))];
    });
    assert.equal(mesh.indices.length, 6);
  });

  it("renders curves of axis/annotation representations as lines", () => {
    const b = new IfcBuilder();
    const h = b.hierarchy();
    const rep = b.add("IFCSHAPEREPRESENTATION", ref(h.body), str("Axis"), str("Curve3D"), refs([b.polyline3([[0, 0, 0], [3, 0, 0], [3, 4, 0]])]));
    const pds = b.add("IFCPRODUCTDEFINITIONSHAPE", $, $, refs([rep]));
    const p = b.element("IFCANNOTATION", "Axis", b.localPlacement(null), pds, h);
    const built = buildAll(b.toString());
    const g = built.products.get(p)!;
    assert.equal(g.parts.length, 1);
    assert.equal(g.parts[0]!.lines!.indices.length, 4);
  });

  it("reports unsupported representation items and keeps the rest", () => {
    const { built, mesh } = productMesh((b) => [b.add("IFCSECTIONEDSPINE", $, $, $), b.box(1, 1, 1)]);
    approx(meshVolume(mesh), 1, 1e-12);
    assert.ok(built.model.diagnostics.items.some((d) => d.code === "GEOMETRY_UNSUPPORTED" && /IFCSECTIONEDSPINE/.test(d.message)));
  });
});
