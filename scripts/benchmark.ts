// SPDX-License-Identifier: Apache-2.0
/**
 * Pipeline benchmark on internally generated models (licensing is
 * unambiguous). Tiers: small (PR smoke), medium (nightly), large.
 *   node scripts/benchmark.ts [small|medium|large] [--json out.json]
 * Reports parse / index / geometry timings, throughput, triangles and heap.
 */
import { writeFileSync } from "node:fs";
import { LoadSession } from "../src/worker/session.ts";
import { $, IfcBuilder, bool, en, int, list, real, reals, ref, refs, str, guid } from "../tests/helpers/ifc-builder.ts";

const TIERS = { small: 12, medium: 60, large: 200 } as const;
type Tier = keyof typeof TIERS;

export function buildTower(storeys: number): string {
  const b = new IfcBuilder("IFC4", `tower-${storeys}.ifc`);
  const h = b.hierarchy({ lengthUnit: "MILLIMETRE" });
  const colRep = b.add("IFCSHAPEREPRESENTATION", ref(h.body), str("Body"), str("SweptSolid"), refs([b.extrusion(b.circleProfile(250), 3500)]));
  const colMap = b.add("IFCREPRESENTATIONMAP", ref(b.axis3()), ref(colRep));
  const chairPts = b.add("IFCCARTESIANPOINTLIST3D", list([[0, 0, 0], [500, 0, 0], [500, 500, 0], [0, 500, 0], [0, 0, 450], [500, 0, 450], [500, 500, 450], [0, 500, 450]].map((p) => reals(p))), $);
  const tris = [[1, 4, 3], [1, 3, 2], [5, 6, 7], [5, 7, 8], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 4, 8], [3, 8, 7], [4, 1, 5], [4, 5, 8]];
  for (let s = 0; s < storeys; s++) {
    const sp = b.localPlacement(h.storeyPlacement, [0, 0, s * 3600]);
    const storey = b.add("IFCBUILDINGSTOREY", str(guid()), ref(h.ownerHistory), str(`Level ${s}`), $, $, ref(sp), $, $, en("ELEMENT"), real(s * 3600));
    b.add("IFCRELAGGREGATES", str(guid()), ref(h.ownerHistory), $, $, ref(h.building), refs([storey]));
    const elements: number[] = [];
    for (let w = 0; w < 40; w++) {
      const angle = (w / 40) * Math.PI * 2;
      const wp = b.localPlacement(sp, [30000 * Math.cos(angle), 30000 * Math.sin(angle), 0], [0, 0, 1], [-Math.sin(angle), Math.cos(angle), 0]);
      const wall = b.element("IFCWALL", `W${s}-${w}`, wp, b.shape(h.body, [b.box(4700, 300, 3500)]), h);
      b.opening(h, wall, wp, [1800, 500, 1500], [1400, -100, 900]);
      elements.push(wall);
    }
    for (let c = 0; c < 64; c++) {
      const item = b.add("IFCMAPPEDITEM", ref(colMap), ref(b.add("IFCCARTESIANTRANSFORMATIONOPERATOR3D", $, $, ref(b.point(0, 0, 0)), $, $)));
      elements.push(b.element("IFCCOLUMN", `C${s}-${c}`, b.localPlacement(sp, [-21000 + (c % 8) * 6000, -21000 + Math.floor(c / 8) * 6000, 0]), b.shape(h.body, [item], "MappedRepresentation"), h));
    }
    for (let f = 0; f < 150; f++) {
      const tfs = b.add("IFCTRIANGULATEDFACESET", ref(chairPts), $, bool(true), list(tris.map((t) => list(t.map(int)))), $);
      elements.push(b.element("IFCFURNITURE", `F${s}-${f}`, b.localPlacement(sp, [-15000 + (f % 15) * 2000, -10000 + Math.floor(f / 15) * 2000, 0]), b.shape(h.body, [tfs], "Tessellation"), h));
    }
    const slab = b.element("IFCSLAB", `Slab ${s}`, b.localPlacement(sp, [0, 0, -250]), b.shape(h.body, [b.extrusion(b.circleProfile(31000), 250)]), h);
    elements.push(slab);
    b.contain(h, storey, elements);
    b.propertySet(h, elements.slice(0, 40), "Pset_WallCommon", [["IsExternal", { kind: "typed", type: "IFCBOOLEAN", args: [en("T")] }]]);
  }
  return b.toString();
}

export async function runBenchmark(tier: Tier) {
  const text = buildTower(TIERS[tier]);
  const bytes = new TextEncoder().encode(text);
  let triangles = 0;
  let firstGeometryMs = 0;
  const t0 = performance.now();
  const session = new LoadSession({
    progress() {},
    metadata() {},
    geometry(batch) {
      if (!firstGeometryMs) firstGeometryMs = performance.now() - t0;
      triangles = batch.trianglesReady;
    },
    diagnostic() {},
    resourceLimit() {},
  });
  const stats = await session.run({ kind: "buffer", buffer: bytes.buffer as ArrayBuffer, name: "tower.ifc" });
  const total = performance.now() - t0;
  const heap = process.memoryUsage();
  return {
    tier,
    inputBytes: bytes.length,
    entities: stats.entities,
    products: stats.products,
    productsWithGeometry: stats.productsWithGeometry,
    triangles: Math.max(triangles, stats.triangles),
    metadataReadyMs: Math.round(stats.parseMs + stats.indexMs),
    parseMs: Math.round(stats.parseMs),
    indexMs: Math.round(stats.indexMs),
    geometryMs: Math.round(stats.geometryMs),
    firstGeometryMs: Math.round(firstGeometryMs),
    fullGeometryMs: Math.round(total),
    parseMBps: +(bytes.length / 1e6 / (stats.parseMs / 1000)).toFixed(1),
    workerPeakBytes: heap.heapUsed + heap.arrayBuffers,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const tier = (process.argv[2] ?? "small") as Tier;
  if (!(tier in TIERS)) throw new Error(`tier must be one of ${Object.keys(TIERS).join(", ")}`);
  const result = await runBenchmark(tier);
  console.log(JSON.stringify(result, null, 2));
  const j = process.argv.indexOf("--json");
  if (j > 0) writeFileSync(process.argv[j + 1]!, JSON.stringify(result, null, 2) + "\n");
}
