// SPDX-License-Identifier: Apache-2.0
/**
 * Machine-readable IFC support matrix. docs/ifc-support.md is generated from
 * this table (npm run docs:support) and a unit test checks that every entity
 * listed as supported is actually handled by the geometry dispatcher.
 */

export interface IfcSupportEntry {
  entity: string;
  category: "placement" | "profile" | "curve" | "solid" | "tessellation" | "brep" | "boolean" | "instancing" | "surface" | "semantic" | "presentation";
  ifc2x3: "full" | "partial" | "none" | "n/a";
  ifc4: "full" | "partial" | "none" | "n/a";
  ifc4x3: "full" | "partial" | "none" | "n/a";
  phase: "MVP" | "v1" | "v2";
  limitations?: string[];
}

export const SUPPORT_MATRIX: readonly IfcSupportEntry[] = [
  { entity: "IfcLocalPlacement", category: "placement", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "MVP", limitations: ["Cycles and chains deeper than maxPlacementDepth are reported and the product is skipped"] },
  { entity: "IfcAxis2Placement3D", category: "placement", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "MVP" },
  { entity: "IfcAxis2Placement2D", category: "placement", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "MVP" },
  { entity: "IfcAxis1Placement", category: "placement", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1" },
  { entity: "IfcGridPlacement", category: "placement", ifc2x3: "partial", ifc4: "partial", ifc4x3: "partial", phase: "v1", limitations: ["Grid axes must be straight lines or polylines"] },
  { entity: "IfcLinearPlacement", category: "placement", ifc2x3: "n/a", ifc4: "n/a", ifc4x3: "partial", phase: "v2", limitations: ["Uses CartesianPosition; alignment-based evaluation is not implemented"] },
  { entity: "IfcGeometricRepresentationContext.WorldCoordinateSystem", category: "placement", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1" },
  { entity: "IfcCartesianTransformationOperator3D", category: "instancing", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "MVP", limitations: ["Mirroring through Axis2 and non-uniform scale are honoured"] },
  { entity: "IfcCartesianTransformationOperator3DnonUniform", category: "instancing", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1" },
  { entity: "IfcCartesianTransformationOperator2D", category: "profile", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1" },
  { entity: "IfcMappedItem / IfcRepresentationMap", category: "instancing", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "MVP", limitations: ["Maps used at least twice are GPU-instanced; hosts with openings are baked"] },
  { entity: "IfcRectangleProfileDef", category: "profile", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "MVP" },
  { entity: "IfcRoundedRectangleProfileDef", category: "profile", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1" },
  { entity: "IfcRectangleHollowProfileDef", category: "profile", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1" },
  { entity: "IfcCircleProfileDef", category: "profile", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "MVP" },
  { entity: "IfcCircleHollowProfileDef", category: "profile", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1" },
  { entity: "IfcEllipseProfileDef", category: "profile", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1" },
  { entity: "IfcIShapeProfileDef", category: "profile", ifc2x3: "full", ifc4: "partial", ifc4x3: "partial", phase: "v1", limitations: ["FlangeEdgeRadius and FlangeSlope are not modelled"] },
  { entity: "IfcAsymmetricIShapeProfileDef", category: "profile", ifc2x3: "full", ifc4: "partial", ifc4x3: "partial", phase: "v1", limitations: ["Edge radii and slopes are not modelled"] },
  { entity: "IfcLShapeProfileDef", category: "profile", ifc2x3: "partial", ifc4: "partial", ifc4x3: "partial", phase: "v1", limitations: ["EdgeRadius and LegSlope are not modelled"] },
  { entity: "IfcUShapeProfileDef", category: "profile", ifc2x3: "partial", ifc4: "partial", ifc4x3: "partial", phase: "v1", limitations: ["EdgeRadius and FlangeSlope are not modelled"] },
  { entity: "IfcCShapeProfileDef", category: "profile", ifc2x3: "partial", ifc4: "partial", ifc4x3: "partial", phase: "v1", limitations: ["InternalFilletRadius is not modelled"] },
  { entity: "IfcTShapeProfileDef", category: "profile", ifc2x3: "partial", ifc4: "partial", ifc4x3: "partial", phase: "v1", limitations: ["Edge radii and slopes are not modelled"] },
  { entity: "IfcZShapeProfileDef", category: "profile", ifc2x3: "partial", ifc4: "partial", ifc4x3: "partial", phase: "v1", limitations: ["Fillet and edge radii are not modelled"] },
  { entity: "IfcTrapeziumProfileDef", category: "profile", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1" },
  { entity: "IfcArbitraryClosedProfileDef", category: "profile", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "MVP" },
  { entity: "IfcArbitraryProfileDefWithVoids", category: "profile", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "MVP" },
  { entity: "IfcArbitraryOpenProfileDef", category: "profile", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1", limitations: ["Extruded as an open ribbon surface"] },
  { entity: "IfcCenterLineProfileDef", category: "profile", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1" },
  { entity: "IfcDerivedProfileDef / IfcMirroredProfileDef", category: "profile", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1" },
  { entity: "IfcCompositeProfileDef", category: "profile", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1" },
  { entity: "IfcPolyline", category: "curve", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "MVP" },
  { entity: "IfcIndexedPolyCurve", category: "curve", ifc2x3: "n/a", ifc4: "full", ifc4x3: "full", phase: "MVP", limitations: ["IfcLineIndex and IfcArcIndex segments"] },
  { entity: "IfcCircle / IfcEllipse", category: "curve", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1" },
  { entity: "IfcLine", category: "curve", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1", limitations: ["Unbounded lines are drawn over their unit parameter range"] },
  { entity: "IfcTrimmedCurve", category: "curve", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1", limitations: ["Trimming by parameter and by point, SenseAgreement and MasterRepresentation honoured"] },
  { entity: "IfcCompositeCurve", category: "curve", ifc2x3: "full", ifc4: "full", ifc4x3: "partial", phase: "v1", limitations: ["IFC4X3 IfcCurveSegment supported for IfcLine and IfcCircle parents only"] },
  { entity: "IfcBSplineCurveWithKnots / IfcRationalBSplineCurveWithKnots", category: "curve", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v2" },
  { entity: "IfcOffsetCurve2D", category: "curve", ifc2x3: "partial", ifc4: "partial", ifc4x3: "partial", phase: "v2", limitations: ["Mitred offset of the tessellated basis curve"] },
  { entity: "IfcExtrudedAreaSolid", category: "solid", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "MVP", limitations: ["Arbitrary extrusion direction, holes, solid and profile positions"] },
  { entity: "IfcExtrudedAreaSolidTapered", category: "solid", ifc2x3: "n/a", ifc4: "partial", ifc4x3: "partial", phase: "v1", limitations: ["End profile must have the same vertex structure; otherwise a straight extrusion is shown with a diagnostic"] },
  { entity: "IfcRevolvedAreaSolid", category: "solid", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1" },
  { entity: "IfcRevolvedAreaSolidTapered", category: "solid", ifc2x3: "n/a", ifc4: "partial", ifc4x3: "partial", phase: "v2", limitations: ["End profile ignored"] },
  { entity: "IfcSweptDiskSolid", category: "solid", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1", limitations: ["Rotation-minimising frames, mitred joints, inner radius, caps; Start/EndParam honoured on polyline directrices"] },
  { entity: "IfcSweptDiskSolidPolygonal", category: "solid", ifc2x3: "n/a", ifc4: "full", ifc4x3: "full", phase: "v1" },
  { entity: "IfcFixedReferenceSweptAreaSolid", category: "solid", ifc2x3: "n/a", ifc4: "full", ifc4x3: "full", phase: "v1" },
  { entity: "IfcSurfaceCurveSweptAreaSolid", category: "solid", ifc2x3: "partial", ifc4: "partial", ifc4x3: "partial", phase: "v1", limitations: ["Reference surface must be an IfcPlane"] },
  { entity: "IfcDirectrixCurveSweptAreaSolid", category: "solid", ifc2x3: "n/a", ifc4: "n/a", ifc4x3: "partial", phase: "v2", limitations: ["Rotation-minimising frames"] },
  { entity: "IfcBlock / IfcRectangularPyramid / IfcRightCircularCone / IfcRightCircularCylinder / IfcSphere", category: "solid", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1" },
  { entity: "IfcCsgSolid", category: "boolean", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1" },
  { entity: "IfcBooleanResult", category: "boolean", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1", limitations: ["Project-native mesh CSG; operand size and time budgets apply"] },
  { entity: "IfcBooleanClippingResult", category: "boolean", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1" },
  { entity: "IfcHalfSpaceSolid / IfcBoxedHalfSpace", category: "boolean", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1", limitations: ["Base surface must be an IfcPlane"] },
  { entity: "IfcPolygonalBoundedHalfSpace", category: "boolean", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1" },
  { entity: "IfcRelVoidsElement (semantic openings)", category: "semantic", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1", limitations: ["All openings of a host are subtracted from its body meshes"] },
  { entity: "IfcTriangulatedFaceSet", category: "tessellation", ifc2x3: "n/a", ifc4: "full", ifc4x3: "full", phase: "MVP", limitations: ["Normals are regenerated with a crease angle"] },
  { entity: "IfcTriangulatedIrregularNetwork", category: "tessellation", ifc2x3: "n/a", ifc4: "n/a", ifc4x3: "full", phase: "v1" },
  { entity: "IfcPolygonalFaceSet", category: "tessellation", ifc2x3: "n/a", ifc4: "full", ifc4x3: "full", phase: "v1" },
  { entity: "IfcIndexedColourMap", category: "presentation", ifc2x3: "n/a", ifc4: "full", ifc4x3: "full", phase: "v1" },
  { entity: "IfcFacetedBrep / IfcFacetedBrepWithVoids", category: "brep", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1" },
  { entity: "IfcShellBasedSurfaceModel / IfcFaceBasedSurfaceModel", category: "brep", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1" },
  { entity: "IfcAdvancedBrep", category: "brep", ifc2x3: "n/a", ifc4: "partial", ifc4x3: "partial", phase: "v2", limitations: ["Planar faces exact; B-spline faces tessellated over the full parameter domain; other analytic faces approximated by their boundary polygon"] },
  { entity: "IfcCurveBoundedPlane", category: "surface", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1" },
  { entity: "IfcBoundingBox", category: "solid", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1" },
  { entity: "IfcGeometricSet / IfcGeometricCurveSet", category: "curve", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1", limitations: ["Curves rendered as lines; points ignored"] },
  { entity: "IfcAnnotationFillArea", category: "surface", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1" },
  { entity: "IfcStyledItem / IfcSurfaceStyle", category: "presentation", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1", limitations: ["Surface colour and transparency; textures are not supported"] },
  { entity: "IfcMaterialDefinitionRepresentation", category: "presentation", ifc2x3: "full", ifc4: "full", ifc4x3: "full", phase: "v1" },
  { entity: "IfcTextLiteral", category: "presentation", ifc2x3: "none", ifc4: "none", ifc4x3: "none", phase: "v2", limitations: ["Text annotations are ignored"] },
  { entity: "IfcSectionedSpine / IfcSectionedSolidHorizontal", category: "solid", ifc2x3: "none", ifc4: "none", ifc4x3: "none", phase: "v2", limitations: ["Reported as GEOMETRY_UNSUPPORTED per item"] },
  { entity: "IfcAlignment geometry (IfcGradientCurve, IfcSegmentedReferenceCurve, IfcClothoid)", category: "curve", ifc2x3: "n/a", ifc4: "n/a", ifc4x3: "none", phase: "v2", limitations: ["Reported as GEOMETRY_UNSUPPORTED per item"] },
];
