// SPDX-License-Identifier: Apache-2.0
/** Semantic property inspector: one <details> per group, a row-header table per group. */

import type { PropertyGroup, PropertyValue } from "../ifc/properties.ts";

function formatValue(v: PropertyValue["value"]): string {
  if (v === null) return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") {
    if (Number.isInteger(v)) return String(v);
    const abs = Math.abs(v);
    return abs !== 0 && (abs < 1e-4 || abs >= 1e9) ? v.toExponential(4) : String(Math.round(v * 1e6) / 1e6);
  }
  return v;
}

export class PropertiesView {
  readonly root: HTMLElement;
  private token = 0;

  constructor(root: HTMLElement) {
    this.root = root;
    this.showHint("Select an element in the view or the tree to see its properties.");
  }

  showHint(text: string): void {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = text;
    this.root.replaceChildren(p);
  }

  /** Starts a request; returns a token used to discard stale responses. */
  begin(): number {
    return ++this.token;
  }

  render(token: number, groups: PropertyGroup[], extraNote?: string): void {
    if (token !== this.token) return;
    const frag = document.createDocumentFragment();
    if (extraNote) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = extraNote;
      frag.append(p);
    }
    for (const g of groups) {
      const details = document.createElement("details");
      details.open = g.kind === "attributes" || groups.length <= 4 || g.kind === "pset";
      const summary = document.createElement("summary");
      summary.textContent = g.name;
      details.append(summary);
      const table = document.createElement("table");
      const caption = document.createElement("caption");
      caption.className = "sr-only";
      caption.textContent = g.name;
      table.append(caption);
      const body = document.createElement("tbody");
      for (const prop of g.properties) {
        const tr = document.createElement("tr");
        const th = document.createElement("th");
        th.scope = "row";
        th.textContent = prop.name;
        const td = document.createElement("td");
        td.textContent = formatValue(prop.value);
        if (prop.unit) {
          const u = document.createElement("span");
          u.className = "unit";
          u.textContent = prop.unit;
          td.append(u);
        }
        tr.append(th, td);
        body.append(tr);
      }
      if (g.properties.length === 0) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 2;
        td.className = "hint";
        td.textContent = "No values";
        tr.append(td);
        body.append(tr);
      }
      table.append(body);
      details.append(table);
      frag.append(details);
    }
    this.root.replaceChildren(frag);
  }
}
