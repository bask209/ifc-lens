// SPDX-License-Identifier: Apache-2.0
/** Helpers that run the real pipeline (parser → model → geometry engine) in Node. */

import { DiagnosticLog } from "../../src/diagnostics.ts";
import { GeometryEngine, type EngineOptions, type ProductGeometry } from "../../src/geometry/engine.ts";
import { mergeMeshes, transformLines, transformMesh, type LineData, type MeshData } from "../../src/geometry/mesh.ts";
import { IfcModel } from "../../src/ifc/model.ts";
import { parseStepText } from "../../src/step/parser.ts";

export function loadModel(text: string): IfcModel {
  const diagnostics = new DiagnosticLog();
  const p = parseStepText(text, { diagnostics });
  return new IfcModel(p.store, diagnostics);
}

export interface Built {
  model: IfcModel;
  engine: GeometryEngine;
  products: Map<number, ProductGeometry>;
}

export function buildAll(text: string, options: EngineOptions = {}): Built {
  const model = loadModel(text);
  const engine = new GeometryEngine(model, options);
  const products = new Map<number, ProductGeometry>();
  for (const id of engine.prepare()) {
    const g = engine.buildProduct(id);
    if (g) products.set(id, g);
  }
  return { model, engine, products };
}

/** All triangles of a product (unique parts + instances) in world metres. */
export function worldMesh(built: Built, productId: number): MeshData {
  const g = built.products.get(productId);
  if (!g) return { positions: new Float64Array(0), indices: new Uint32Array(0) };
  const meshes: MeshData[] = [];
  for (const p of g.parts) if (p.mesh) meshes.push(transformMesh(p.mesh, g.world));
  for (const inst of g.instances) {
    const def = built.engine.definition(inst.key)!;
    for (const p of def.parts) if (p.mesh) meshes.push(transformMesh(p.mesh, inst.transform));
  }
  return meshes.length ? mergeMeshes(meshes) : { positions: new Float64Array(0), indices: new Uint32Array(0) };
}

export function worldLines(built: Built, productId: number): LineData[] {
  const g = built.products.get(productId);
  if (!g) return [];
  return g.parts.filter((p) => p.lines).map((p) => transformLines(p.lines!, g.world));
}

export function diagnosticCodes(model: IfcModel): string[] {
  return model.diagnostics.items.map((d) => d.code);
}

export function approx(actual: number, expected: number, tolerance: number, message?: string): void {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`${message ?? "value"}: expected ${expected} ± ${tolerance}, got ${actual}`);
  }
}
