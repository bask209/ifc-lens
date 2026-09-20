// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NativeCsgBackend } from "../../src/csg/native.ts";
import { GeometryContext } from "../../src/geometry/context.ts";
import { axis2Placement2D, objectPlacement, placementFromAxes, transformationOperator } from "../../src/geometry/placement.ts";
import { determinant3, equalsApprox, identity, invert, multiply, rotation, scaling, transformPoint, translation } from "../../src/math/mat4.ts";
import { $, IfcBuilder, en, guid, real, ref, reals, refs, str } from "../helpers/ifc-builder.ts";
import { loadModel } from "../helpers/model.ts";

function ctxFor(b: IfcBuilder): GeometryContext {
  return new GeometryContext(loadModel(b.toString()), new NativeCsgBackend());
}

const near = (a: readonly number[], b: readonly number[], eps = 1e-9): void => {
  assert.equal(a.length, b.length);
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]!) <= eps, `index ${i}: ${v} vs ${b[i]}`));
};

describe("double-precision math", () => {
  it("composes translation, rotation and scale in column-vector order", () => {
    const m = multiply(translation(10, 0, 0), multiply(rotation([0, 0, 1], Math.PI / 2), scaling(2, 3, 4)));
    near(transformPoint(m, 1, 0, 0), [10, 2, 0]);
    near(transformPoint(m, 0, 1, 0), [7, 0, 0]);
    near(transformPoint(m, 0, 0, 1), [10, 0, 4]);
  });

  it("inverts matrices and detects mirroring determinants", () => {
    const m = multiply(translation(1, 2, 3), multiply(rotation([1, 1, 0], 0.7), scaling(2, -1, 0.5)));
    assert.ok(determinant3(m) < 0);
    assert.ok(equalsApprox(multiply(m, invert(m)!), identity(), 1e-12));
    assert.equal(invert(scaling(0, 1, 1)), undefined);
  });
});

describe("placements", () => {
  it("builds an orthonormal right-handed basis and orthogonalises RefDirection", () => {
    const m = placementFromAxes([1, 2, 3], [0, 0, 2], [1, 1, 0.5]);
    const x = [m[0]!, m[1]!, m[2]!];
    near(x, [Math.SQRT1_2, Math.SQRT1_2, 0]);
    near([m[8]!, m[9]!, m[10]!], [0, 0, 1]);
    assert.ok(Math.abs(determinant3(m) - 1) < 1e-12);
    near([m[12]!, m[13]!, m[14]!], [1, 2, 3]);
  });

  it("falls back to a valid basis when RefDirection is parallel to Axis", () => {
    const m = placementFromAxes([0, 0, 0], [1, 0, 0], [2, 0, 0]);
    assert.ok(Math.abs(determinant3(m) - 1) < 1e-12);
  });

  it("uses defaults for omitted axis and ref direction", () => {
    near(Array.from(placementFromAxes([0, 0, 0], undefined, undefined)), Array.from(identity()));
  });

  it("resolves a three-level local placement chain with rotation", () => {
    const b = new IfcBuilder();
    const root = b.localPlacement(null, [10, 0, 0]);
    const child = b.localPlacement(root, [0, 5, 0], [0, 0, 1], [0, 1, 0]); // rotated 90° about Z
    const grand = b.localPlacement(child, [1, 0, 0]);
    const ctx = ctxFor(b);
    near(transformPoint(objectPlacement(ctx, grand), 0, 0, 0), [10, 6, 0]);
    near(transformPoint(objectPlacement(ctx, grand), 1, 0, 0), [10, 7, 0]);
  });

  it("detects placement cycles instead of recursing forever", () => {
    const b = new IfcBuilder();
    const a1 = b.axis3();
    const a = b.reserve();
    const c = b.add("IFCLOCALPLACEMENT", ref(a), ref(a1));
    b.addWithId(a, "IFCLOCALPLACEMENT", ref(c), ref(a1));
    const ctx = ctxFor(b);
    assert.throws(() => objectPlacement(ctx, c), /cycle/i);
  });

  it("builds 2D placements in the XY plane", () => {
    const b = new IfcBuilder();
    const p = b.axis2([3, 4], [0, 1]);
    const m = axis2Placement2D(ctxFor(b), p);
    near(transformPoint(m, 1, 0, 0), [3, 5, 0]);
  });

  it("applies Cartesian transformation operators with mirroring and non-uniform scale", () => {
    const b = new IfcBuilder();
    const mirror = b.add("IFCCARTESIANTRANSFORMATIONOPERATOR3D", ref(b.direction(1, 0, 0)), ref(b.direction(0, -1, 0)), ref(b.point(0, 0, 0)), real(1), $);
    const nonUniform = b.add("IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM", $, $, ref(b.point(1, 1, 1)), real(2), $, real(3), real(4));
    const rotated = b.add("IFCCARTESIANTRANSFORMATIONOPERATOR3D", ref(b.direction(0, 1, 0)), $, ref(b.point(0, 0, 0)), $, $);
    const ctx = ctxFor(b);
    const m1 = transformationOperator(ctx, mirror);
    assert.ok(determinant3(m1) < 0, "mirror");
    near(transformPoint(m1, 0, 1, 0), [0, -1, 0]);
    const m2 = transformationOperator(ctx, nonUniform);
    near(transformPoint(m2, 1, 1, 1), [3, 4, 5]);
    const m3 = transformationOperator(ctx, rotated);
    near(transformPoint(m3, 1, 0, 0), [0, 1, 0]);
    near(transformPoint(m3, 0, 1, 0), [-1, 0, 0]);
  });

  it("evaluates grid placements at axis intersections", () => {
    const b = new IfcBuilder();
    const h = b.hierarchy();
    const u = b.add("IFCGRIDAXIS", str("A"), ref(b.polyline3([[0, 0, 0], [10, 0, 0]])), en("T"));
    const v = b.add("IFCGRIDAXIS", str("1"), ref(b.polyline3([[4, -5, 0], [4, 5, 0]])), en("T"));
    const gridPlacement = b.localPlacement(h.storeyPlacement, [100, 0, 0]);
    b.add("IFCGRID", str(guid()), ref(h.ownerHistory), str("Grid"), $, $, ref(gridPlacement), $, refs([u]), refs([v]), $);
    const intersection = b.add("IFCVIRTUALGRIDINTERSECTION", refs([u, v]), reals([0, 0, 2]));
    const gp = b.add("IFCGRIDPLACEMENT", ref(intersection), $);
    const ctx = ctxFor(b);
    near(transformPoint(objectPlacement(ctx, gp), 0, 0, 0), [104, 0, 2]);
  });
});
