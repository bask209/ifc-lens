// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OrbitCamera } from "../../src/renderer/camera.ts";
import { transformPoint, type Vec3 } from "../../src/math/mat4.ts";
import { directionLabel, regionDirection } from "../../src/element/view-cube.ts";

const elevation = (c: OrbitCamera): number => Math.asin(-c.direction[2]);

describe("orbit camera", () => {
  it("fits bounds so the whole box is inside the frustum", () => {
    const c = new OrbitCamera();
    const b = { minX: -10, minY: -5, minZ: 0, maxX: 10, maxY: 5, maxZ: 8 };
    c.sceneBounds = b;
    c.setState(c.fitState(b, 16 / 9));
    const vp = c.viewProjection(16 / 9);
    for (let i = 0; i < 8; i++) {
      const p = transformPoint(vp, i & 1 ? b.maxX : b.minX, i & 2 ? b.maxY : b.minY, i & 4 ? b.maxZ : b.minZ);
      const w = vp[3]! * (i & 1 ? b.maxX : b.minX) + vp[7]! * (i & 2 ? b.maxY : b.minY) + vp[11]! * (i & 4 ? b.maxZ : b.minZ) + vp[15]!;
      for (const v of p) assert.ok(Math.abs(v / w) <= 1, `corner ${i} inside clip space`);
    }
  });

  it("orbits around a pivot preserving distance and clamping pitch", () => {
    const c = new OrbitCamera();
    c.eye = [10, 0, 0];
    c.target = [0, 0, 0];
    const d = c.distance;
    c.orbit(Math.PI / 2, 0);
    assert.ok(Math.abs(c.distance - d) < 1e-9);
    assert.ok(Math.abs(c.eye[0]) < 1e-9 && Math.abs(c.eye[1] - 10) < 1e-9);
    const e0 = elevation(c);
    c.orbit(0, 0.2);
    assert.ok(Math.abs(elevation(c) - e0 - 0.2) < 1e-9, "positive pitch looks further down");
    c.orbit(0, 10);
    assert.ok(elevation(c) <= (89 * Math.PI) / 180 + 1e-9);
  });

  it("zooms towards a focus point and pans in screen space", () => {
    const c = new OrbitCamera();
    c.eye = [0, -10, 0];
    c.target = [0, 0, 0];
    c.zoom(0.5, [2, 0, 0]);
    assert.ok(Math.abs(c.eye[0] - 1) < 1e-9 && Math.abs(c.eye[1] + 5) < 1e-9);
    const before = [...c.target];
    c.pan(100, 0, 500);
    assert.ok(c.target[0] < before[0]!, "dragging right moves the scene right (camera left)");
  });

  it("keeps a sane near/far ratio", () => {
    const c = new OrbitCamera();
    c.sceneBounds = { minX: -1000, minY: -1000, minZ: 0, maxX: 1000, maxY: 1000, maxZ: 100 };
    c.eye = [0, -1, 1];
    c.target = [0, 0, 1];
    const [near, far] = c.clipRange();
    assert.ok(near > 0 && far / near <= 1e5 + 1);
  });
});

describe("orientation cube geometry", () => {
  it("maps face regions to the 26 standard view directions", () => {
    const top = { key: "top", label: "Top", n: [0, 0, 1] as Vec3, u: [1, 0, 0] as Vec3, v: [0, -1, 0] as Vec3 };
    // centre → the face normal
    assert.deepEqual(regionDirection(top, 1, 1), [0, 0, 1]);
    // edge → normal + one neighbour, normalised
    const r = Math.SQRT1_2;
    assert.deepEqual(regionDirection(top, 2, 1).map((x) => +x.toFixed(6)), [r, 0, r].map((x) => +x.toFixed(6)));
    assert.deepEqual(regionDirection(top, 1, 0).map((x) => +x.toFixed(6)), [0, r, r].map((x) => +x.toFixed(6)));
    // corner → three faces
    const c = 1 / Math.sqrt(3);
    assert.deepEqual(regionDirection(top, 2, 2).map((x) => +x.toFixed(6)), [c, -c, c].map((x) => +x.toFixed(6)));
    // every region is a unit vector, and the 6 faces cover 26 distinct directions
    const faces = [
      top,
      { key: "bottom", label: "Bottom", n: [0, 0, -1] as Vec3, u: [1, 0, 0] as Vec3, v: [0, 1, 0] as Vec3 },
      { key: "front", label: "Front", n: [0, -1, 0] as Vec3, u: [1, 0, 0] as Vec3, v: [0, 0, -1] as Vec3 },
      { key: "back", label: "Back", n: [0, 1, 0] as Vec3, u: [-1, 0, 0] as Vec3, v: [0, 0, -1] as Vec3 },
      { key: "right", label: "Right", n: [1, 0, 0] as Vec3, u: [0, 1, 0] as Vec3, v: [0, 0, -1] as Vec3 },
      { key: "left", label: "Left", n: [-1, 0, 0] as Vec3, u: [0, -1, 0] as Vec3, v: [0, 0, -1] as Vec3 },
    ];
    const seen = new Set<string>();
    for (const f of faces) {
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
          const d = regionDirection(f, col, row);
          assert.ok(Math.abs(Math.hypot(...d) - 1) < 1e-12);
          seen.add(d.map((x) => Math.round(x * 1e6) / 1e6).join(","));
        }
      }
    }
    assert.equal(seen.size, 26);
  });

  it("names directions the way the buttons announce them", () => {
    assert.equal(directionLabel([0, 0, 1]), "top");
    assert.equal(directionLabel([0, -1, 0]), "front");
    assert.equal(directionLabel([1, 0, 0]), "right");
    const c = 1 / Math.sqrt(3);
    assert.equal(directionLabel([c, -c, c]), "top-front-right");
    assert.equal(directionLabel([-c, c, -c]), "bottom-back-left");
  });
});
