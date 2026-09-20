// SPDX-License-Identifier: Apache-2.0
/**
 * Headless API (no DOM, no WebGL): STEP parsing, the IFC model, geometry
 * generation and the load session. Usable in workers and in Node.
 */

export * from "../diagnostics.ts";
export * from "../step/index.ts";
export { IfcModel, UNASSIGNED_NODE_ID, type EntitySummary, type SpatialNode, type RelationshipIndex } from "../ifc/model.ts";
export { detectSchemaFamily, prettyTypeName, type IfcSchemaFamily } from "../ifc/schema.ts";
export { getPropertyGroups, type PropertyGroup, type PropertyValue } from "../ifc/properties.ts";
export { resolveProjectUnits, type UnitContext } from "../ifc/units.ts";
export { StyleResolver, colorKey, type Rgba } from "../ifc/styles.ts";
export { SUPPORT_MATRIX, type IfcSupportEntry } from "../ifc/support.ts";
export { GeometryEngine, type ProductGeometry, type GeometryDefinition, type EngineOptions } from "../geometry/engine.ts";
export { DEFAULT_GEOMETRY_LIMITS, type GeometryLimits, type TessellationQuality } from "../geometry/context.ts";
export * from "../geometry/mesh.ts";
export { NativeCsgBackend, meshBoolean } from "../csg/native.ts";
export { booleanMeshes, type CsgBackend, type CsgOperation, type CsgSolid, type TriangleMesh64 } from "../csg/backend.ts";
export { triangulatePolygon, triangulateFace } from "../triangulation/index.ts";
export * from "../math/index.ts";
export { LoadSession, DEFAULT_WORKER_LIMITS, type SessionCallbacks } from "../worker/session.ts";
export type * from "../protocol/messages.ts";
