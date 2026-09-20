// SPDX-License-Identifier: Apache-2.0
/**
 * Schema-family detection. The viewer relies on attribute positions that are
 * stable across IFC2X3, IFC4 and IFC4X3 for the entities it decodes; where
 * positions differ, decoders branch on the family returned here.
 */

export type IfcSchemaFamily = "IFC2X3" | "IFC4" | "IFC4X3" | "UNKNOWN";

export function detectSchemaFamily(identifiers: readonly string[]): IfcSchemaFamily {
  for (const raw of identifiers) {
    const id = raw.trim().toUpperCase();
    if (id.startsWith("IFC2X3") || id.startsWith("IFC2X_FINAL") || id.startsWith("IFC2X2")) return "IFC2X3";
    if (id.startsWith("IFC4X3") || id.startsWith("IFC4X2") || id.startsWith("IFC4X1")) return "IFC4X3";
    if (id.startsWith("IFC4")) return "IFC4";
  }
  return "UNKNOWN";
}

/** Spatial structure element types (tree containers) across schema families. */
export const SPATIAL_TYPES: ReadonlySet<string> = new Set([
  "IFCPROJECT",
  "IFCSITE",
  "IFCBUILDING",
  "IFCBUILDINGSTOREY",
  "IFCSPACE",
  "IFCFACILITY",
  "IFCFACILITYPART",
  "IFCFACILITYPARTCOMMON",
  "IFCBRIDGE",
  "IFCBRIDGEPART",
  "IFCROAD",
  "IFCROADPART",
  "IFCRAILWAY",
  "IFCRAILWAYPART",
  "IFCMARINEFACILITY",
  "IFCMARINEPART",
  "IFCTUNNEL",
  "IFCTUNNELPART",
  "IFCSPATIALZONE",
  "IFCEXTERNALSPATIALELEMENT",
]);

/**
 * Product types that are never rendered as standalone geometry: openings are
 * subtracted from their hosts, virtual elements carry no body.
 */
export const NON_RENDERED_TYPES: ReadonlySet<string> = new Set([
  "IFCOPENINGELEMENT",
  "IFCOPENINGSTANDARDCASE",
  "IFCVOIDINGFEATURE",
  "IFCVIRTUALELEMENT",
]);

/** Types rendered semi-transparent by default when no style is present. */
export const TRANSLUCENT_TYPES: ReadonlySet<string> = new Set(["IFCSPACE", "IFCSPATIALZONE", "IFCEXTERNALSPATIALELEMENT"]);

/** Placement entity types that identify an IfcProduct's ObjectPlacement. */
export const PLACEMENT_TYPES: ReadonlySet<string> = new Set([
  "IFCLOCALPLACEMENT",
  "IFCGRIDPLACEMENT",
  "IFCLINEARPLACEMENT",
]);

/** Readable IFC type name from the upper-case STEP name (e.g. IFCWALL → IfcWall). */
const KNOWN_WORDS = [
  "Building", "Element", "Proxy", "Storey", "Standard", "Case", "Opening", "Covering", "Curtain", "Wall",
  "Window", "Door", "Slab", "Roof", "Stair", "Flight", "Ramp", "Railing", "Column", "Beam", "Member", "Plate",
  "Footing", "Pile", "Furnishing", "Furniture", "Flow", "Segment", "Fitting", "Terminal", "Controller",
  "Distribution", "Chamber", "Port", "Space", "Site", "Project", "Spatial", "Zone", "Geographic", "Assembly",
  "Pipe", "Duct", "Cable", "Carrier", "Air", "Sanitary", "Electric", "Appliance", "Discrete", "Accessory",
  "Fastener", "Mechanical", "Reinforcing", "Bar", "Mesh", "Tendon", "Anchor", "Transport", "Virtual",
  "Annotation", "Grid", "Bridge", "Part", "Road", "Railway", "Rail", "Track", "Course", "Pavement", "Kerb",
  "Earthworks", "Fill", "Cut", "Sign", "Signal", "Surface", "Feature", "Alignment", "Facility", "Marine",
  "Tunnel", "Chimney", "Shading", "Device", "Type", "System", "Group", "Energy", "Conversion", "Storage",
  "Treatment", "Moving", "Unitary", "Equipment", "Light", "Fixture", "Lamp", "Outlet", "Switching", "Sensor",
  "Actuator", "Alarm", "Valve", "Pump", "Fan", "Boiler", "Chiller", "Tank", "Coil", "Damper", "Filter",
  "Flow", "Meter", "Interceptor", "Waste", "Fire", "Suppression", "Stack", "Junction", "Box", "Protective",
  "Motor", "Connection", "Transformer", "Generator", "Engine", "Heat", "Exchanger", "Humidifier", "Burner",
  "Cooler", "Evaporative", "Condenser", "Cooling", "Tower", "Space", "Heater", "Tube", "Bundle", "Vibration",
  "Isolator", "Damper", "Silencer", "Sound", "Communications", "Audio", "Visual", "Mobile", "Telecom",
  "Structural", "Curve", "Load", "Point", "Reaction", "Action", "Local", "Placement", "Shape",
  "Representation", "Product", "Definition", "Rel", "Aggregates", "Contained", "In", "Structure",
  "Defines", "By", "Properties", "Property", "Set", "Single", "Value", "Quantity", "Length", "Area", "Volume",
  "Material", "Layer", "Usage", "Associates", "Classification", "Reference", "Voids", "Fills", "Deep",
  "Foundation", "Borehole", "Geomodel", "Geoslice", "Geotechnical", "Stratum", "Impact", "Protection",
  "Mooring", "Navigational", "Bearing", "Deflector", "Liquid", "Terminal", "Vehicle", "Kerb", "Wall",
  "Opening", "Recess", "Projection", "Stratum", "Buoy", "Contact",
];

const WORD_SET = [...new Set(KNOWN_WORDS)].sort((a, b) => b.length - a.length);

export function prettyTypeName(upper: string): string {
  if (!upper.startsWith("IFC")) return upper;
  let rest = upper.slice(3);
  let out = "Ifc";
  while (rest.length > 0) {
    const w = WORD_SET.find((word) => rest.startsWith(word.toUpperCase()));
    if (w) {
      out += w;
      rest = rest.slice(w.length);
    } else {
      out += rest.charAt(0) + rest.slice(1).toLowerCase();
      break;
    }
  }
  return out;
}
