// SPDX-License-Identifier: Apache-2.0
/**
 * Programmatic IFC (STEP Part 21) writer for tests, fixtures and the demo
 * model. Values are StepValues serialised by the project's own writer.
 */

import { serializeEntity } from "../../src/step/writer.ts";
import type { StepValue } from "../../src/step/store.ts";

export type Arg = StepValue;

export const $: Arg = { kind: "null" };
export const STAR: Arg = { kind: "derived" };
export const ref = (id: number): Arg => ({ kind: "ref", id });
export const str = (value: string): Arg => ({ kind: "string", value });
export const en = (value: string): Arg => ({ kind: "enum", value });
export const real = (value: number): Arg => ({ kind: "real", value });
export const int = (value: number): Arg => ({ kind: "integer", value });
export const list = (values: Arg[]): Arg => ({ kind: "list", values });
export const typed = (type: string, v: Arg): Arg => ({ kind: "typed", type, args: [v] });
export const reals = (values: number[]): Arg => list(values.map(real));
export const refs = (ids: number[]): Arg => list(ids.map(ref));
export const bool = (v: boolean): Arg => en(v ? "T" : "F");

let guidCounter = 0;
const GUID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
/** Deterministic 22-character IFC GlobalId. */
export function guid(): string {
  let n = ++guidCounter;
  let s = "";
  for (let i = 0; i < 22; i++) {
    s = GUID_CHARS[n % 64]! + s;
    n = Math.floor(n / 64);
  }
  return s;
}

export interface Hierarchy {
  project: number;
  site: number;
  building: number;
  storey: number;
  context: number;
  body: number;
  storeyPlacement: number;
  ownerHistory: number;
}

export class IfcBuilder {
  readonly schema: string;
  private readonly lines: string[] = [];
  private next = 1;
  private readonly headerName: string;
  private cache = new Map<string, number>();

  constructor(schema = "IFC4", name = "fixture.ifc") {
    this.schema = schema;
    this.headerName = name;
  }

  /** Adds an entity; returns its instance name. */
  add(type: string, ...args: Arg[]): number {
    const id = this.next++;
    this.lines.push(serializeEntity(id, type.toUpperCase(), args));
    return id;
  }

  /** Adds a raw line (for malformed-input tests). Returns the id it claims. */
  raw(line: string): void {
    this.lines.push(line);
  }

  reserve(): number {
    return this.next++;
  }

  addWithId(id: number, type: string, ...args: Arg[]): number {
    this.lines.push(serializeEntity(id, type.toUpperCase(), args));
    return id;
  }

  toString(): string {
    return [
      "ISO-10303-21;",
      "HEADER;",
      "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
      `FILE_NAME('${this.headerName}','2026-09-19T00:00:00',('ifc-lens'),('ifc-lens'),'ifc-lens builder','ifc-lens','');`,
      `FILE_SCHEMA(('${this.schema}'));`,
      "ENDSEC;",
      "DATA;",
      ...this.lines,
      "ENDSEC;",
      "END-ISO-10303-21;",
      "",
    ].join("\n");
  }

  bytes(): Uint8Array {
    return new TextEncoder().encode(this.toString());
  }

  // ---------------------------------------------------------- geometry

  point(x: number, y: number, z?: number): number {
    const key = `p${x},${y},${z}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const id = this.add("IFCCARTESIANPOINT", reals(z === undefined ? [x, y] : [x, y, z]));
    this.cache.set(key, id);
    return id;
  }

  direction(x: number, y: number, z?: number): number {
    const key = `d${x},${y},${z}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const id = this.add("IFCDIRECTION", reals(z === undefined ? [x, y] : [x, y, z]));
    this.cache.set(key, id);
    return id;
  }

  axis3(origin: [number, number, number] = [0, 0, 0], axis?: [number, number, number], refDir?: [number, number, number]): number {
    return this.add(
      "IFCAXIS2PLACEMENT3D",
      ref(this.point(...origin)),
      axis ? ref(this.direction(...axis)) : $,
      refDir ? ref(this.direction(...refDir)) : $,
    );
  }

  axis2(origin: [number, number] = [0, 0], refDir?: [number, number]): number {
    return this.add("IFCAXIS2PLACEMENT2D", ref(this.point(...origin)), refDir ? ref(this.direction(...refDir)) : $);
  }

  localPlacement(parent: number | null, origin: [number, number, number] = [0, 0, 0], axis?: [number, number, number], refDir?: [number, number, number]): number {
    return this.add("IFCLOCALPLACEMENT", parent ? ref(parent) : $, ref(this.axis3(origin, axis, refDir)));
  }

  polyline2(points: [number, number][]): number {
    const ids = points.map(([x, y]) => this.point(x, y));
    return this.add("IFCPOLYLINE", refs([...ids, ids[0]!]));
  }

  polyline3(points: [number, number, number][]): number {
    return this.add("IFCPOLYLINE", refs(points.map((p) => this.point(...p))));
  }

  rectangleProfile(x: number, y: number, position?: number): number {
    return this.add("IFCRECTANGLEPROFILEDEF", en("AREA"), $, position ? ref(position) : ref(this.axis2()), real(x), real(y));
  }

  circleProfile(r: number): number {
    return this.add("IFCCIRCLEPROFILEDEF", en("AREA"), $, ref(this.axis2()), real(r));
  }

  arbitraryProfile(outer: [number, number][], holes: [number, number][][] = []): number {
    if (holes.length === 0) return this.add("IFCARBITRARYCLOSEDPROFILEDEF", en("AREA"), $, ref(this.polyline2(outer)));
    return this.add("IFCARBITRARYPROFILEDEFWITHVOIDS", en("AREA"), $, ref(this.polyline2(outer)), refs(holes.map((h) => this.polyline2(h))));
  }

  extrusion(profile: number, depth: number, position?: number, direction: [number, number, number] = [0, 0, 1]): number {
    return this.add("IFCEXTRUDEDAREASOLID", ref(profile), ref(position ?? this.axis3()), ref(this.direction(...direction)), real(depth));
  }

  box(x: number, y: number, z: number, origin: [number, number, number] = [0, 0, 0]): number {
    const profile = this.rectangleProfile(x, y, this.axis2([x / 2, y / 2]));
    return this.extrusion(profile, z, this.axis3(origin));
  }

  shape(context: number, items: number[], type = "SweptSolid", identifier = "Body"): number {
    const rep = this.add("IFCSHAPEREPRESENTATION", ref(context), str(identifier), str(type), refs(items));
    return this.add("IFCPRODUCTDEFINITIONSHAPE", $, $, refs([rep]));
  }

  styled(item: number, rgb: [number, number, number], transparency = 0): number {
    const colour = this.add("IFCCOLOURRGB", $, real(rgb[0]), real(rgb[1]), real(rgb[2]));
    const rendering = this.add("IFCSURFACESTYLERENDERING", ref(colour), real(transparency), $, $, $, $, $, $, en("NOTDEFINED"));
    const style = this.add("IFCSURFACESTYLE", $, en("BOTH"), refs([rendering]));
    return this.add("IFCSTYLEDITEM", ref(item), refs([style]), $);
  }

  // ---------------------------------------------------------- semantics

  /**
   * Project → site → building → storey with SI units (metre or millimetre)
   * and a 3D body sub-context.
   */
  hierarchy(options: { lengthUnit?: "METRE" | "MILLIMETRE"; angleUnit?: "RADIAN" | "DEGREE"; name?: string } = {}): Hierarchy {
    const person = this.add("IFCPERSON", $, str("Tester"), $, $, $, $, $, $);
    const org = this.add("IFCORGANIZATION", $, str("ifc-lens"), $, $, $);
    const pao = this.add("IFCPERSONANDORGANIZATION", ref(person), ref(org), $);
    const app = this.add("IFCAPPLICATION", ref(org), str("1.0"), str("ifc-lens builder"), str("ifc-lens"));
    const ownerHistory = this.add("IFCOWNERHISTORY", ref(pao), ref(app), $, en("ADDED"), $, $, $, int(0));
    const units: number[] = [];
    if (options.lengthUnit === "MILLIMETRE") units.push(this.add("IFCSIUNIT", STAR, en("LENGTHUNIT"), en("MILLI"), en("METRE")));
    else units.push(this.add("IFCSIUNIT", STAR, en("LENGTHUNIT"), $, en("METRE")));
    units.push(this.add("IFCSIUNIT", STAR, en("AREAUNIT"), $, en("SQUARE_METRE")));
    units.push(this.add("IFCSIUNIT", STAR, en("VOLUMEUNIT"), $, en("CUBIC_METRE")));
    const radian = this.add("IFCSIUNIT", STAR, en("PLANEANGLEUNIT"), $, en("RADIAN"));
    if (options.angleUnit === "DEGREE") {
      const dims = this.add("IFCDIMENSIONALEXPONENTS", int(0), int(0), int(0), int(0), int(0), int(0), int(0));
      const mwu = this.add("IFCMEASUREWITHUNIT", typed("IFCPLANEANGLEMEASURE", real(Math.PI / 180)), ref(radian));
      units.push(this.add("IFCCONVERSIONBASEDUNIT", ref(dims), en("PLANEANGLEUNIT"), str("DEGREE"), ref(mwu)));
    } else {
      units.push(radian);
    }
    const assignment = this.add("IFCUNITASSIGNMENT", refs(units));
    const context = this.add("IFCGEOMETRICREPRESENTATIONCONTEXT", $, str("Model"), int(3), real(1e-5), ref(this.axis3()), $);
    const body = this.add("IFCGEOMETRICREPRESENTATIONSUBCONTEXT", str("Body"), str("Model"), STAR, STAR, STAR, STAR, ref(context), $, en("MODEL_VIEW"), $);
    const project = this.add("IFCPROJECT", str(guid()), ref(ownerHistory), str(options.name ?? "Test project"), $, $, $, $, refs([context]), ref(assignment));
    const sitePlacement = this.localPlacement(null);
    const site = this.add("IFCSITE", str(guid()), ref(ownerHistory), str("Site"), $, $, ref(sitePlacement), $, $, en("ELEMENT"), $, $, $, $, $);
    const buildingPlacement = this.localPlacement(sitePlacement);
    const building = this.add("IFCBUILDING", str(guid()), ref(ownerHistory), str("Building"), $, $, ref(buildingPlacement), $, $, en("ELEMENT"), $, $, $);
    const storeyPlacement = this.localPlacement(buildingPlacement);
    const storey = this.add("IFCBUILDINGSTOREY", str(guid()), ref(ownerHistory), str("Ground floor"), $, $, ref(storeyPlacement), $, $, en("ELEMENT"), real(0));
    this.add("IFCRELAGGREGATES", str(guid()), ref(ownerHistory), $, $, ref(project), refs([site]));
    this.add("IFCRELAGGREGATES", str(guid()), ref(ownerHistory), $, $, ref(site), refs([building]));
    this.add("IFCRELAGGREGATES", str(guid()), ref(ownerHistory), $, $, ref(building), refs([storey]));
    return { project, site, building, storey, context, body, storeyPlacement, ownerHistory };
  }

  /** An element (IfcWall, IfcSlab, …) with placement and representation. */
  element(type: string, name: string, placement: number, shape: number | null, h: Hierarchy, extra: Arg[] = []): number {
    return this.add(type, str(guid()), ref(h.ownerHistory), str(name), $, $, ref(placement), shape ? ref(shape) : $, $, ...extra);
  }

  contain(h: Hierarchy, structure: number, elements: number[]): number {
    return this.add("IFCRELCONTAINEDINSPATIALSTRUCTURE", str(guid()), ref(h.ownerHistory), $, $, refs(elements), ref(structure));
  }

  propertySet(h: Hierarchy, objects: number[], name: string, props: [string, Arg][]): number {
    const ids = props.map(([n, v]) => this.add("IFCPROPERTYSINGLEVALUE", str(n), $, v, $));
    const pset = this.add("IFCPROPERTYSET", str(guid()), ref(h.ownerHistory), str(name), $, refs(ids));
    this.add("IFCRELDEFINESBYPROPERTIES", str(guid()), ref(h.ownerHistory), $, $, refs(objects), ref(pset));
    return pset;
  }

  quantities(h: Hierarchy, objects: number[], name: string, q: { length?: [string, number][]; area?: [string, number][]; volume?: [string, number][] }): number {
    const ids: number[] = [];
    for (const [n, v] of q.length ?? []) ids.push(this.add("IFCQUANTITYLENGTH", str(n), $, $, real(v), $));
    for (const [n, v] of q.area ?? []) ids.push(this.add("IFCQUANTITYAREA", str(n), $, $, real(v), $));
    for (const [n, v] of q.volume ?? []) ids.push(this.add("IFCQUANTITYVOLUME", str(n), $, $, real(v), $));
    const qto = this.add("IFCELEMENTQUANTITY", str(guid()), ref(h.ownerHistory), str(name), $, $, refs(ids));
    this.add("IFCRELDEFINESBYPROPERTIES", str(guid()), ref(h.ownerHistory), $, $, refs(objects), ref(qto));
    return qto;
  }

  /** Opening element cutting `host`, with a box body. */
  opening(h: Hierarchy, host: number, hostPlacement: number, size: [number, number, number], origin: [number, number, number]): number {
    const placement = this.localPlacement(hostPlacement, origin);
    const shape = this.shape(h.body, [this.box(...size)]);
    const opening = this.add("IFCOPENINGELEMENT", str(guid()), ref(h.ownerHistory), str("Opening"), $, $, ref(placement), ref(shape), $, en("OPENING"));
    this.add("IFCRELVOIDSELEMENT", str(guid()), ref(h.ownerHistory), $, $, ref(host), ref(opening));
    return opening;
  }
}

/** One-product model around a single representation item (unit tests). */
export function singleItemModel(build: (b: IfcBuilder, h: Hierarchy) => number[], options: { schema?: string; lengthUnit?: "METRE" | "MILLIMETRE"; angleUnit?: "RADIAN" | "DEGREE"; type?: string } = {}): { text: string; productId: number } {
  const b = new IfcBuilder(options.schema ?? "IFC4");
  const h = b.hierarchy({ ...(options.lengthUnit ? { lengthUnit: options.lengthUnit } : {}), ...(options.angleUnit ? { angleUnit: options.angleUnit } : {}) });
  const items = build(b, h);
  const placement = b.localPlacement(h.storeyPlacement);
  const product = b.element(options.type ?? "IFCBUILDINGELEMENTPROXY", "Item", placement, b.shape(h.body, items), h);
  b.contain(h, h.storey, [product]);
  return { text: b.toString(), productId: product };
}
