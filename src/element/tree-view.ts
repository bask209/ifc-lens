// SPDX-License-Identifier: Apache-2.0
/**
 * Accessible spatial tree (ARIA tree pattern, roving tabindex). Children are
 * rendered lazily on expansion and in pages of PAGE_SIZE, so trees with
 * hundreds of thousands of nodes stay responsive. All model text is inserted
 * with textContent.
 */

import type { TreeNodeWire } from "../protocol/messages.ts";
import { ICONS } from "./icons.ts";

const PAGE_SIZE = 250;
const SEARCH_LIMIT = 400;

export interface TreeCallbacks {
  select(id: number, mode: "replace" | "add" | "toggle"): void;
  fit(id: number): void;
  setVisible(id: number, visible: boolean): void;
  isVisible(id: number): boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

export class TreeView {
  readonly root: HTMLUListElement;
  private readonly callbacks: TreeCallbacks;
  private nodes = new Map<number, TreeNodeWire>();
  private parents = new Map<number, number>();
  private readonly items = new Map<number, HTMLLIElement>();
  private selected = new Set<number>();
  private filter = "";
  private focusId: number | undefined;

  constructor(root: HTMLUListElement, callbacks: TreeCallbacks) {
    this.root = root;
    this.callbacks = callbacks;
    root.setAttribute("role", "tree");
    root.setAttribute("aria-multiselectable", "true");
    root.addEventListener("keydown", (e) => this.keydown(e));
    root.addEventListener("click", (e) => this.click(e));
    root.addEventListener("dblclick", (e) => {
      const id = this.idOf(e.target);
      if (id !== undefined) this.callbacks.fit(id);
    });
  }

  setModel(nodes: readonly TreeNodeWire[]): void {
    this.nodes = new Map(nodes.map((n) => [n.id, n]));
    this.parents = new Map();
    for (const n of nodes) for (const c of n.children) if (!this.parents.has(c)) this.parents.set(c, n.id);
    this.selected.clear();
    this.focusId = undefined;
    this.render();
  }

  clear(): void {
    this.setModel([]);
  }

  get size(): number {
    return this.nodes.size;
  }

  private roots(): TreeNodeWire[] {
    return [...this.nodes.values()].filter((n) => !this.parents.has(n.id));
  }

  setFilter(text: string): void {
    this.filter = text.trim().toLowerCase();
    this.render();
  }

  private render(): void {
    this.items.clear();
    this.root.replaceChildren();
    if (this.filter) {
      let count = 0;
      for (const n of this.nodes.values()) {
        const hay = `${n.name} ${n.type} ${n.id}`.toLowerCase();
        if (!hay.includes(this.filter)) continue;
        if (count++ >= SEARCH_LIMIT) {
          const li = el("li", { role: "none" });
          li.textContent = `Showing the first ${SEARCH_LIMIT} matches. Refine the search to narrow the list.`;
          li.className = "type";
          this.root.append(li);
          break;
        }
        this.root.append(this.item(n, 1, true));
      }
      if (count === 0 && this.nodes.size > 0) {
        const li = el("li", { role: "none" });
        li.className = "type";
        li.textContent = "No elements match this search.";
        this.root.append(li);
      }
    } else {
      for (const r of this.roots()) {
        const li = this.item(r, 1, false);
        this.root.append(li);
        this.autoExpand(r, li, 1);
      }
    }
    const first = this.root.querySelector<HTMLLIElement>('[role="treeitem"]');
    if (first) this.setFocusable(this.focusId !== undefined && this.items.has(this.focusId) ? this.items.get(this.focusId)! : first);
  }

  /** Expands spatial containers down to storey level by default. */
  private autoExpand(node: TreeNodeWire, li: HTMLLIElement, level: number): void {
    if (node.kind === "element" || level > 5 || node.children.length === 0) return;
    const spatialChildren = node.children.some((c) => this.nodes.get(c)?.kind === "spatial");
    if (level <= 2 || spatialChildren) {
      this.expand(li, node);
      for (const c of node.children) {
        const child = this.nodes.get(c);
        const cli = this.items.get(c);
        if (child && cli) this.autoExpand(child, cli, level + 1);
      }
    }
  }

  private item(n: TreeNodeWire, level: number, flat: boolean): HTMLLIElement {
    const li = el("li", { role: "treeitem", "aria-level": String(level), tabindex: "-1", "data-id": String(n.id) });
    li.setAttribute("aria-selected", this.selected.has(n.id) ? "true" : "false");
    const hasChildren = !flat && n.children.length > 0;
    if (hasChildren) li.setAttribute("aria-expanded", "false");
    const row = el("div", { class: "row" });
    row.style.paddingLeft = `${(level - 1) * 14 + 4}px`;
    const twisty = el("button", { class: "twisty", type: "button", tabindex: "-1", "aria-hidden": "true" });
    if (!hasChildren) twisty.setAttribute("data-leaf", "");
    twisty.innerHTML = ICONS.twisty;
    const label = el("span", { class: "label" });
    label.textContent = n.name;
    const type = el("span", { class: "type" });
    type.textContent = n.kind === "unassigned" ? `${n.children.length}` : n.type;
    label.append(type);
    const eye = el("button", { class: "eye", type: "button", tabindex: "-1" });
    const visible = this.callbacks.isVisible(n.id);
    eye.setAttribute("aria-pressed", visible ? "true" : "false");
    eye.setAttribute("aria-label", `${visible ? "Hide" : "Show"} ${n.name}`);
    eye.innerHTML = visible ? ICONS.eye : ICONS.eyeOff;
    row.dataset.hidden = visible ? "false" : "true";
    row.append(twisty, label, eye);
    li.append(row);
    li.setAttribute("aria-label", `${n.name}, ${n.type || "group"}`);
    this.items.set(n.id, li);
    return li;
  }

  private expand(li: HTMLLIElement, node: TreeNodeWire): void {
    if (li.getAttribute("aria-expanded") !== "false") return;
    li.setAttribute("aria-expanded", "true");
    const group = el("ul", { role: "group" });
    li.append(group);
    const level = Number(li.getAttribute("aria-level")) + 1;
    this.appendPage(group, node, 0, level);
  }

  private appendPage(group: HTMLUListElement, node: TreeNodeWire, start: number, level: number): void {
    const end = Math.min(node.children.length, start + PAGE_SIZE);
    for (let i = start; i < end; i++) {
      const child = this.nodes.get(node.children[i]!);
      if (child) group.append(this.item(child, level, false));
    }
    if (end < node.children.length) {
      const li = el("li", { role: "none" });
      const more = el("button", { class: "more", type: "button" });
      more.textContent = `Show ${Math.min(PAGE_SIZE, node.children.length - end)} more of ${node.children.length - end}`;
      more.style.marginLeft = `${(level - 1) * 14 + 26}px`;
      more.addEventListener("click", (e) => {
        e.stopPropagation();
        li.remove();
        this.appendPage(group, node, end, level);
      });
      li.append(more);
      group.append(li);
    }
  }

  private collapse(li: HTMLLIElement): void {
    if (li.getAttribute("aria-expanded") !== "true") return;
    li.setAttribute("aria-expanded", "false");
    li.querySelector(":scope > ul")?.remove();
  }

  private idOf(target: EventTarget | null): number | undefined {
    const li = (target as HTMLElement | null)?.closest?.('[role="treeitem"]');
    return li ? Number(li.getAttribute("data-id")) : undefined;
  }

  private setFocusable(li: HTMLLIElement): void {
    this.root.querySelectorAll('[role="treeitem"][tabindex="0"]').forEach((x) => x.setAttribute("tabindex", "-1"));
    li.setAttribute("tabindex", "0");
    this.focusId = Number(li.getAttribute("data-id"));
  }

  private focus(li: HTMLLIElement): void {
    this.setFocusable(li);
    li.focus();
    li.scrollIntoView({ block: "nearest" });
  }

  private click(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const li = target.closest<HTMLLIElement>('[role="treeitem"]');
    if (!li) return;
    const id = Number(li.getAttribute("data-id"));
    const node = this.nodes.get(id);
    if (target.closest(".eye")) {
      this.callbacks.setVisible(id, !this.callbacks.isVisible(id));
      return;
    }
    if (target.closest(".twisty") && node) {
      if (li.getAttribute("aria-expanded") === "true") this.collapse(li);
      else this.expand(li, node);
      return;
    }
    this.setFocusable(li);
    this.callbacks.select(id, e.ctrlKey || e.metaKey ? "toggle" : e.shiftKey ? "add" : "replace");
  }

  private visibleItems(): HTMLLIElement[] {
    return [...this.root.querySelectorAll<HTMLLIElement>('[role="treeitem"]')].filter((li) => {
      let p = li.parentElement?.closest('[role="treeitem"]');
      while (p) {
        if (p.getAttribute("aria-expanded") !== "true") return false;
        p = p.parentElement?.closest('[role="treeitem"]');
      }
      return true;
    });
  }

  private keydown(e: KeyboardEvent): void {
    const li = (e.target as HTMLElement).closest<HTMLLIElement>('[role="treeitem"]');
    if (!li) return;
    const id = Number(li.getAttribute("data-id"));
    const node = this.nodes.get(id);
    const items = this.visibleItems();
    const index = items.indexOf(li);
    let handled = true;
    switch (e.key) {
      case "ArrowDown":
        if (index + 1 < items.length) this.focus(items[index + 1]!);
        break;
      case "ArrowUp":
        if (index > 0) this.focus(items[index - 1]!);
        break;
      case "ArrowRight":
        if (node && li.getAttribute("aria-expanded") === "false") this.expand(li, node);
        else if (li.getAttribute("aria-expanded") === "true") {
          const first = li.querySelector<HTMLLIElement>(':scope > ul > [role="treeitem"]');
          if (first) this.focus(first);
        }
        break;
      case "ArrowLeft":
        if (li.getAttribute("aria-expanded") === "true") this.collapse(li);
        else {
          const parent = li.parentElement?.closest<HTMLLIElement>('[role="treeitem"]');
          if (parent) this.focus(parent);
        }
        break;
      case "Home":
        if (items[0]) this.focus(items[0]);
        break;
      case "End":
        if (items.length) this.focus(items[items.length - 1]!);
        break;
      case "Enter":
      case " ":
        this.callbacks.select(id, e.ctrlKey || e.metaKey ? "toggle" : e.shiftKey ? "add" : "replace");
        break;
      case "f":
      case "F":
        this.callbacks.fit(id);
        break;
      case "h":
      case "H":
        this.callbacks.setVisible(id, !this.callbacks.isVisible(id));
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  /** Reflects the viewer selection; expands ancestors of the first selected node. */
  setSelection(ids: readonly number[], reveal: boolean): void {
    this.selected = new Set(ids);
    for (const [id, li] of this.items) li.setAttribute("aria-selected", this.selected.has(id) ? "true" : "false");
    if (reveal && ids.length > 0 && !this.filter) {
      const id = ids[0]!;
      const chain: number[] = [];
      let p = this.parents.get(id);
      const guard = new Set<number>();
      while (p !== undefined && !guard.has(p)) {
        guard.add(p);
        chain.unshift(p);
        p = this.parents.get(p);
      }
      for (const a of chain) {
        const li = this.items.get(a);
        const node = this.nodes.get(a);
        if (li && node) this.expandToShow(li, node, chain[chain.indexOf(a) + 1] ?? id);
      }
      const target = this.items.get(id);
      if (target) {
        this.setFocusable(target);
        target.scrollIntoView({ block: "nearest" });
      }
    }
  }

  /** Expands `li` and pages in children until `childId` is rendered. */
  private expandToShow(li: HTMLLIElement, node: TreeNodeWire, childId: number): void {
    this.expand(li, node);
    let guard = 0;
    while (!this.items.has(childId) && guard++ < 10_000) {
      const more = li.querySelector<HTMLButtonElement>(":scope > ul > li > .more");
      if (!more) break;
      more.click();
    }
  }

  /** Refreshes eye buttons after visibility changes. */
  refreshVisibility(): void {
    for (const [id, li] of this.items) {
      const visible = this.callbacks.isVisible(id);
      const row = li.querySelector<HTMLElement>(":scope > .row")!;
      const eye = row.querySelector<HTMLButtonElement>(".eye")!;
      if (eye.getAttribute("aria-pressed") === String(visible)) continue;
      eye.setAttribute("aria-pressed", visible ? "true" : "false");
      eye.setAttribute("aria-label", `${visible ? "Hide" : "Show"} ${this.nodes.get(id)?.name ?? ""}`);
      eye.innerHTML = visible ? ICONS.eye : ICONS.eyeOff;
      row.dataset.hidden = visible ? "false" : "true";
    }
  }
}
