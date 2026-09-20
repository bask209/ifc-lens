// SPDX-License-Identifier: Apache-2.0
/**
 * Presentation style resolution: IfcStyledItem → surface colour/transparency,
 * material colours through IfcMaterialDefinitionRepresentation, and default
 * colours per product type when a file carries no styling.
 */

import type { IfcModel } from "./model.ts";
import { TRANSLUCENT_TYPES } from "./schema.ts";

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Stable batching key for a colour (8-bit quantised). */
export function colorKey(c: Rgba): string {
  const q = (x: number): number => Math.round(Math.min(1, Math.max(0, x)) * 255);
  return `${q(c.r)},${q(c.g)},${q(c.b)},${q(c.a)}`;
}

export function colorFromKey(key: string): Rgba {
  const [r, g, b, a] = key.split(",").map((s) => Number(s) / 255);
  return { r: r ?? 0.8, g: g ?? 0.8, b: b ?? 0.8, a: a ?? 1 };
}

const DEFAULT_TYPE_COLORS: Record<string, Rgba> = {
  IFCWALL: { r: 0.91, g: 0.89, b: 0.85, a: 1 },
  IFCWALLSTANDARDCASE: { r: 0.91, g: 0.89, b: 0.85, a: 1 },
  IFCWALLELEMENTEDCASE: { r: 0.91, g: 0.89, b: 0.85, a: 1 },
  IFCCURTAINWALL: { r: 0.6, g: 0.75, b: 0.85, a: 0.5 },
  IFCSLAB: { r: 0.72, g: 0.72, b: 0.72, a: 1 },
  IFCROOF: { r: 0.62, g: 0.36, b: 0.3, a: 1 },
  IFCCOVERING: { r: 0.8, g: 0.78, b: 0.72, a: 1 },
  IFCWINDOW: { r: 0.55, g: 0.75, b: 0.92, a: 0.45 },
  IFCPLATE: { r: 0.6, g: 0.75, b: 0.88, a: 0.6 },
  IFCDOOR: { r: 0.62, g: 0.47, b: 0.33, a: 1 },
  IFCCOLUMN: { r: 0.7, g: 0.72, b: 0.76, a: 1 },
  IFCBEAM: { r: 0.66, g: 0.69, b: 0.74, a: 1 },
  IFCMEMBER: { r: 0.66, g: 0.69, b: 0.74, a: 1 },
  IFCFOOTING: { r: 0.6, g: 0.6, b: 0.58, a: 1 },
  IFCPILE: { r: 0.6, g: 0.6, b: 0.58, a: 1 },
  IFCSTAIR: { r: 0.75, g: 0.73, b: 0.7, a: 1 },
  IFCSTAIRFLIGHT: { r: 0.75, g: 0.73, b: 0.7, a: 1 },
  IFCRAMP: { r: 0.75, g: 0.73, b: 0.7, a: 1 },
  IFCRAILING: { r: 0.45, g: 0.47, b: 0.5, a: 1 },
  IFCFURNISHINGELEMENT: { r: 0.7, g: 0.55, b: 0.4, a: 1 },
  IFCFURNITURE: { r: 0.7, g: 0.55, b: 0.4, a: 1 },
  IFCSPACE: { r: 0.45, g: 0.65, b: 0.9, a: 0.12 },
  IFCSPATIALZONE: { r: 0.45, g: 0.8, b: 0.6, a: 0.18 },
  IFCEXTERNALSPATIALELEMENT: { r: 0.45, g: 0.8, b: 0.6, a: 0.18 },
  IFCSITE: { r: 0.55, g: 0.68, b: 0.45, a: 1 },
  IFCGEOGRAPHICELEMENT: { r: 0.5, g: 0.66, b: 0.42, a: 1 },
  IFCPIPESEGMENT: { r: 0.35, g: 0.55, b: 0.8, a: 1 },
  IFCPIPEFITTING: { r: 0.35, g: 0.55, b: 0.8, a: 1 },
  IFCDUCTSEGMENT: { r: 0.62, g: 0.7, b: 0.78, a: 1 },
  IFCDUCTFITTING: { r: 0.62, g: 0.7, b: 0.78, a: 1 },
  IFCFLOWSEGMENT: { r: 0.4, g: 0.6, b: 0.8, a: 1 },
  IFCFLOWFITTING: { r: 0.4, g: 0.6, b: 0.8, a: 1 },
  IFCCABLESEGMENT: { r: 0.3, g: 0.3, b: 0.3, a: 1 },
  IFCCABLECARRIERSEGMENT: { r: 0.55, g: 0.55, b: 0.55, a: 1 },
  IFCREINFORCINGBAR: { r: 0.45, g: 0.35, b: 0.3, a: 1 },
  IFCOPENINGELEMENT: { r: 0.9, g: 0.4, b: 0.3, a: 0.3 },
  IFCANNOTATION: { r: 0.2, g: 0.2, b: 0.2, a: 1 },
  IFCGRID: { r: 0.3, g: 0.3, b: 0.3, a: 1 },
  IFCALIGNMENT: { r: 0.85, g: 0.3, b: 0.2, a: 1 },
  IFCCOURSE: { r: 0.45, g: 0.45, b: 0.47, a: 1 },
  IFCPAVEMENT: { r: 0.4, g: 0.4, b: 0.42, a: 1 },
  IFCEARTHWORKSFILL: { r: 0.6, g: 0.5, b: 0.38, a: 1 },
  IFCTRACKELEMENT: { r: 0.5, g: 0.45, b: 0.4, a: 1 },
  IFCRAIL: { r: 0.55, g: 0.55, b: 0.58, a: 1 },
};

export const FALLBACK_COLOR: Rgba = { r: 0.8, g: 0.8, b: 0.8, a: 1 };

export function defaultColorForType(type: string): Rgba {
  const c = DEFAULT_TYPE_COLORS[type];
  if (c) return c;
  if (TRANSLUCENT_TYPES.has(type)) return { r: 0.5, g: 0.7, b: 0.9, a: 0.2 };
  if (type.endsWith("TYPE")) return FALLBACK_COLOR;
  return FALLBACK_COLOR;
}

/** Resolves styles lazily and caches per item/material/style id. */
export class StyleResolver {
  private readonly model: IfcModel;
  private itemStyles: Map<number, number[]> | undefined;
  private readonly styleCache = new Map<number, Rgba | null>();
  private materialColors: Map<number, Rgba> | undefined;

  constructor(model: IfcModel) {
    this.model = model;
  }

  private buildItemIndex(): Map<number, number[]> {
    const map = new Map<number, number[]>();
    for (const id of this.model.idsOfType("IFCSTYLEDITEM")) {
      const item = this.model.ref(id, 0);
      if (item <= 0) continue;
      const list = map.get(item);
      if (list) list.push(id);
      else map.set(item, [id]);
    }
    return map;
  }

  /** Colour assigned directly to a representation item, if any. */
  itemColor(itemId: number): Rgba | undefined {
    this.itemStyles ??= this.buildItemIndex();
    const styled = this.itemStyles.get(itemId);
    if (!styled) return undefined;
    for (const s of styled) {
      for (const style of this.model.refs(s, 1)) {
        const c = this.styleColor(style, 0);
        if (c) return c;
      }
    }
    return undefined;
  }

  /** Colour of a presentation style / assignment / surface style. */
  styleColor(styleId: number, depth: number): Rgba | undefined {
    if (depth > 6) return undefined;
    const cached = this.styleCache.get(styleId);
    if (cached !== undefined) return cached ?? undefined;
    const m = this.model;
    let result: Rgba | undefined;
    switch (m.type(styleId)) {
      case "IFCPRESENTATIONSTYLEASSIGNMENT":
        for (const s of m.refs(styleId, 0)) {
          result = this.styleColor(s, depth + 1);
          if (result) break;
        }
        break;
      case "IFCSURFACESTYLE":
        // (Name, Side, Styles)
        for (const s of m.refs(styleId, 2)) {
          result = this.styleColor(s, depth + 1);
          if (result) break;
        }
        break;
      case "IFCSURFACESTYLESHADING":
      case "IFCSURFACESTYLERENDERING": {
        const colour = this.rgb(m.ref(styleId, 0));
        if (colour) {
          const t = m.num(styleId, 1);
          result = { ...colour, a: Number.isFinite(t) ? Math.min(1, Math.max(0, 1 - t)) : 1 };
        }
        break;
      }
      case "IFCCURVESTYLE": {
        // (Name, CurveFont, CurveWidth, CurveColour, ModelOrDraughting)
        const colour = this.rgb(m.ref(styleId, 3));
        if (colour) result = { ...colour, a: 1 };
        break;
      }
      case "IFCFILLAREASTYLE": {
        for (const s of m.refs(styleId, 1)) {
          const c = this.rgb(s);
          if (c) {
            result = { ...c, a: 1 };
            break;
          }
        }
        break;
      }
      default:
        break;
    }
    this.styleCache.set(styleId, result ?? null);
    return result;
  }

  private rgb(id: number): { r: number; g: number; b: number } | undefined {
    const m = this.model;
    const t = m.type(id);
    if (t === "IFCCOLOURRGB") {
      const r = m.num(id, 1), g = m.num(id, 2), b = m.num(id, 3);
      if ([r, g, b].every((x) => Number.isFinite(x))) {
        const clamp = (x: number): number => Math.min(1, Math.max(0, x > 1 ? x / 255 : x));
        return { r: clamp(r), g: clamp(g), b: clamp(b) };
      }
    }
    if (t === "IFCDRAUGHTINGPREDEFINEDCOLOUR") {
      const name = (m.str(id, 0) ?? "").toLowerCase();
      const table: Record<string, [number, number, number]> = {
        black: [0, 0, 0], red: [1, 0, 0], green: [0, 1, 0], blue: [0, 0, 1], yellow: [1, 1, 0],
        magenta: [1, 0, 1], cyan: [0, 1, 1], white: [1, 1, 1],
      };
      const c = table[name];
      if (c) return { r: c[0], g: c[1], b: c[2] };
    }
    return undefined;
  }

  private buildMaterialColors(): Map<number, Rgba> {
    const map = new Map<number, Rgba>();
    const m = this.model;
    for (const id of m.idsOfType("IFCMATERIALDEFINITIONREPRESENTATION")) {
      // (Name, Description, Representations, RepresentedMaterial)
      const material = m.ref(id, 3);
      if (material <= 0 || map.has(material)) continue;
      for (const rep of m.refs(id, 2)) {
        for (const item of m.refs(rep, 3)) {
          if (m.type(item) !== "IFCSTYLEDITEM") continue;
          for (const style of m.refs(item, 1)) {
            const c = this.styleColor(style, 0);
            if (c) {
              map.set(material, c);
              break;
            }
          }
          if (map.has(material)) break;
        }
        if (map.has(material)) break;
      }
    }
    return map;
  }

  /** Colour derived from the object's associated material (first coloured one). */
  materialColor(objectId: number): Rgba | undefined {
    this.materialColors ??= this.buildMaterialColors();
    if (this.materialColors.size === 0) return undefined;
    const m = this.model;
    const candidates = [...(m.relations.materialsByObject.get(objectId) ?? [])];
    const typeObject = m.relations.typeByObject.get(objectId);
    if (typeObject !== undefined) candidates.push(...(m.relations.materialsByObject.get(typeObject) ?? []));
    for (const c of candidates) {
      const color = this.resolveMaterialSelect(c, 0);
      if (color) return color;
    }
    return undefined;
  }

  private resolveMaterialSelect(id: number, depth: number): Rgba | undefined {
    if (depth > 6) return undefined;
    const direct = this.materialColors!.get(id);
    if (direct) return direct;
    const m = this.model;
    switch (m.type(id)) {
      case "IFCMATERIALLIST":
        for (const x of m.refs(id, 0)) {
          const c = this.resolveMaterialSelect(x, depth + 1);
          if (c) return c;
        }
        return undefined;
      case "IFCMATERIALLAYERSETUSAGE":
      case "IFCMATERIALPROFILESETUSAGE":
        return this.resolveMaterialSelect(m.ref(id, 0), depth + 1);
      case "IFCMATERIALLAYERSET":
        for (const layer of m.refs(id, 0)) {
          const c = this.resolveMaterialSelect(m.ref(layer, 0), depth + 1);
          if (c) return c;
        }
        return undefined;
      case "IFCMATERIALPROFILESET":
        for (const p of m.refs(id, 2)) {
          const c = this.resolveMaterialSelect(m.ref(p, 2), depth + 1);
          if (c) return c;
        }
        return undefined;
      case "IFCMATERIALCONSTITUENTSET":
        for (const p of m.refs(id, 2)) {
          const c = this.resolveMaterialSelect(m.ref(p, 2), depth + 1);
          if (c) return c;
        }
        return undefined;
      default:
        return undefined;
    }
  }
}
