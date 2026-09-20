// SPDX-License-Identifier: Apache-2.0
/**
 * Project unit resolution (IfcUnitAssignment on IfcProject.UnitsInContext).
 * Geometry is converted to metres and radians; property values keep their
 * source units and are labelled with the matching unit symbol.
 */

import type { StepStore } from "../step/store.ts";

export interface UnitContext {
  lengthToMetres: number;
  angleToRadians: number;
  areaToSquareMetres: number;
  volumeToCubicMetres: number;
  /** Unit symbol per IFC unit type enumeration (LENGTHUNIT → "mm"). */
  symbols: Map<string, string>;
}

export function defaultUnits(): UnitContext {
  return {
    lengthToMetres: 1,
    angleToRadians: 1,
    areaToSquareMetres: 1,
    volumeToCubicMetres: 1,
    symbols: new Map([
      ["LENGTHUNIT", "m"],
      ["AREAUNIT", "m²"],
      ["VOLUMEUNIT", "m³"],
      ["PLANEANGLEUNIT", "rad"],
    ]),
  };
}

const PREFIX_FACTORS: Record<string, number> = {
  EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 1e1,
  DECI: 1e-1, CENTI: 1e-2, MILLI: 1e-3, MICRO: 1e-6, NANO: 1e-9, PICO: 1e-12, FEMTO: 1e-15, ATTO: 1e-18,
};
const PREFIX_SYMBOLS: Record<string, string> = {
  EXA: "E", PETA: "P", TERA: "T", GIGA: "G", MEGA: "M", KILO: "k", HECTO: "h", DECA: "da",
  DECI: "d", CENTI: "c", MILLI: "m", MICRO: "µ", NANO: "n", PICO: "p", FEMTO: "f", ATTO: "a",
};
const SI_SYMBOLS: Record<string, string> = {
  METRE: "m", SQUARE_METRE: "m²", CUBIC_METRE: "m³", GRAM: "g", SECOND: "s", AMPERE: "A", KELVIN: "K",
  MOLE: "mol", CANDELA: "cd", RADIAN: "rad", STERADIAN: "sr", HERTZ: "Hz", NEWTON: "N", PASCAL: "Pa",
  JOULE: "J", WATT: "W", COULOMB: "C", VOLT: "V", FARAD: "F", OHM: "Ω", SIEMENS: "S", WEBER: "Wb",
  TESLA: "T", HENRY: "H", DEGREE_CELSIUS: "°C", LUMEN: "lm", LUX: "lx", BECQUEREL: "Bq", GRAY: "Gy",
  SIEVERT: "Sv",
};
const CONVERSION_SYMBOLS: Record<string, string> = {
  DEGREE: "°", INCH: "in", FOOT: "ft", YARD: "yd", MILE: "mi", "SQUARE INCH": "in²", "SQUARE FOOT": "ft²",
  "CUBIC INCH": "in³", "CUBIC FOOT": "ft³", GALLON: "gal", POUND: "lb", "US GALLON": "gal", GRAD: "gon",
};

/** Measure type name → unit type enumeration used for symbol lookup. */
export const MEASURE_UNIT_TYPES: Record<string, string> = {
  IFCLENGTHMEASURE: "LENGTHUNIT",
  IFCPOSITIVELENGTHMEASURE: "LENGTHUNIT",
  IFCNONNEGATIVELENGTHMEASURE: "LENGTHUNIT",
  IFCAREAMEASURE: "AREAUNIT",
  IFCVOLUMEMEASURE: "VOLUMEUNIT",
  IFCPLANEANGLEMEASURE: "PLANEANGLEUNIT",
  IFCPOSITIVEPLANEANGLEMEASURE: "PLANEANGLEUNIT",
  IFCMASSMEASURE: "MASSUNIT",
  IFCTIMEMEASURE: "TIMEUNIT",
  IFCTHERMODYNAMICTEMPERATUREMEASURE: "THERMODYNAMICTEMPERATUREUNIT",
  IFCPOWERMEASURE: "POWERUNIT",
  IFCELECTRICVOLTAGEMEASURE: "ELECTRICVOLTAGEUNIT",
  IFCELECTRICCURRENTMEASURE: "ELECTRICCURRENTUNIT",
  IFCFORCEMEASURE: "FORCEUNIT",
  IFCPRESSUREMEASURE: "PRESSUREUNIT",
  IFCENERGYMEASURE: "ENERGYUNIT",
  IFCFREQUENCYMEASURE: "FREQUENCYUNIT",
  IFCLUMINOUSFLUXMEASURE: "LUMINOUSFLUXUNIT",
  IFCILLUMINANCEMEASURE: "ILLUMINANCEUNIT",
  IFCSOLIDANGLEMEASURE: "SOLIDANGLEUNIT",
};

/** Quantity entity → unit type of its value. */
export const QUANTITY_UNIT_TYPES: Record<string, string> = {
  IFCQUANTITYLENGTH: "LENGTHUNIT",
  IFCQUANTITYAREA: "AREAUNIT",
  IFCQUANTITYVOLUME: "VOLUMEUNIT",
  IFCQUANTITYWEIGHT: "MASSUNIT",
  IFCQUANTITYTIME: "TIMEUNIT",
};

interface ResolvedUnit {
  type: string;
  /** Factor to the SI base unit of this type (e.g. MILLI METRE → 0.001). */
  factor: number;
  symbol: string;
}

/** Resolves an IfcNamedUnit / IfcDerivedUnit / IfcMonetaryUnit to factor + symbol. */
export function resolveUnit(store: StepStore, id: number, depth = 0): ResolvedUnit | undefined {
  if (depth > 8) return undefined;
  const k = store.indexOfId(id);
  if (k < 0) return undefined;
  const type = store.typeNameAt(k);
  if (type === "IFCSIUNIT") {
    // (Dimensions, UnitType, Prefix, Name)
    const unitType = store.enumName(store.arg(k, 1)) ?? "";
    const prefix = store.enumName(store.arg(k, 2));
    const name = store.enumName(store.arg(k, 3)) ?? "";
    let factor = prefix ? (PREFIX_FACTORS[prefix] ?? 1) : 1;
    if (name === "SQUARE_METRE") factor = factor * factor;
    if (name === "CUBIC_METRE") factor = factor * factor * factor;
    if (name === "GRAM") factor = factor * 1e-3; // SI base for mass is the kilogram
    const base = SI_SYMBOLS[name] ?? name.toLowerCase();
    const symbol = (prefix ? (PREFIX_SYMBOLS[prefix] ?? "") : "") + base;
    return { type: unitType, factor, symbol };
  }
  if (type === "IFCCONVERSIONBASEDUNIT" || type === "IFCCONVERSIONBASEDUNITWITHOFFSET") {
    // (Dimensions, UnitType, Name, ConversionFactor[, ConversionOffset])
    const unitType = store.enumName(store.arg(k, 1)) ?? "";
    const name = (store.str(store.arg(k, 2)) ?? "").toUpperCase();
    let factor = 1;
    const mwu = store.ref(store.arg(k, 3));
    const mk = store.indexOfId(mwu);
    if (mk >= 0 && store.typeNameAt(mk) === "IFCMEASUREWITHUNIT") {
      const value = store.num(store.arg(mk, 0));
      const inner = resolveUnit(store, store.ref(store.arg(mk, 1)), depth + 1);
      if (Number.isFinite(value) && value > 0) factor = value * (inner?.factor ?? 1);
    }
    return { type: unitType, factor, symbol: CONVERSION_SYMBOLS[name] ?? name.toLowerCase() };
  }
  if (type === "IFCMONETARYUNIT") {
    const currency = store.str(store.arg(k, 0)) ?? store.enumName(store.arg(k, 0)) ?? "";
    return { type: "MONETARYUNIT", factor: 1, symbol: currency };
  }
  if (type === "IFCDERIVEDUNIT") {
    // (Elements, UnitType, UserDefinedType[, Name])
    const unitType = store.enumName(store.arg(k, 1)) ?? "";
    const parts: string[] = [];
    for (const el of store.refs(store.arg(k, 0))) {
      const ek = store.indexOfId(el);
      if (ek < 0) continue;
      const u = resolveUnit(store, store.ref(store.arg(ek, 0)), depth + 1);
      const exp = store.num(store.arg(ek, 1));
      if (u) parts.push(exp === 1 ? u.symbol : `${u.symbol}${superscript(exp)}`);
    }
    return { type: unitType, factor: 1, symbol: parts.join("·") };
  }
  return undefined;
}

function superscript(n: number): string {
  const map: Record<string, string> = { "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };
  return String(n).split("").map((c) => map[c] ?? c).join("");
}

/** Reads the unit assignment of the first IfcProject (or any IfcUnitAssignment). */
export function resolveProjectUnits(store: StepStore): UnitContext {
  const units = defaultUnits();
  let assignment = -1;
  for (const k of store.indicesOfType("IFCPROJECT")) {
    assignment = store.ref(store.arg(k, 8));
    if (assignment > 0) break;
  }
  if (assignment < 0) {
    const all = store.indicesOfType("IFCUNITASSIGNMENT");
    if (all.length > 0) assignment = store.idAt(all[0]!);
  }
  const ak = store.indexOfId(assignment);
  if (ak < 0) return units;
  for (const unitId of store.refs(store.arg(ak, 0))) {
    const u = resolveUnit(store, unitId);
    if (!u || !u.type) continue;
    units.symbols.set(u.type, u.symbol);
    if (!(u.factor > 0) || !Number.isFinite(u.factor)) continue;
    switch (u.type) {
      case "LENGTHUNIT": units.lengthToMetres = u.factor; break;
      case "PLANEANGLEUNIT": units.angleToRadians = u.factor; break;
      case "AREAUNIT": units.areaToSquareMetres = u.factor; break;
      case "VOLUMEUNIT": units.volumeToCubicMetres = u.factor; break;
      default: break;
    }
  }
  return units;
}
