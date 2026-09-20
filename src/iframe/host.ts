// SPDX-License-Identifier: Apache-2.0
/**
 * Iframe side of the bridge: accepts commands only from the configured parent
 * origin and window with the session nonce, executes them against a viewer
 * and forwards selected viewer events to the parent.
 */

import { BRIDGE_CHANNEL, BRIDGE_EVENTS, BRIDGE_VERSION, exactOrigin, validateCommand, validateEnvelope, type BridgeCommand } from "./protocol.ts";

/** Subset of the <ifc-viewer> API the bridge drives. */
export interface BridgeTarget extends EventTarget {
  load(source: string): Promise<unknown>;
  unload(): Promise<void>;
  select(ids: number[], options?: { fit?: boolean; mode?: "replace" | "add" | "toggle" }): void;
  clearSelection(): void;
  hide(ids: number[]): void;
  show(ids: number[]): void;
  isolate(ids: number[]): void;
  showAll(): void;
  fit(ids?: number[]): Promise<void>;
  setClipPlane(plane: { normal: [number, number, number]; distance: number } | null): void;
  getProperties(id: number): Promise<unknown>;
}

export interface MessageSourceWindow {
  postMessage(message: unknown, targetOrigin: string): void;
}

export interface MessageListenerWindow {
  addEventListener(type: "message", listener: (e: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (e: MessageEvent) => void): void;
}

export interface BridgeHostOptions {
  target: BridgeTarget;
  /** Exact origin of the embedding page. */
  parentOrigin: string;
  sessionNonce: string;
  /** Window allowed to send commands (normally window.parent). */
  parent: MessageSourceWindow;
  /** Window receiving messages (normally window). */
  receiver: MessageListenerWindow;
}

function serializable(detail: unknown, depth = 0): unknown {
  if (depth > 16) return null;
  if (detail instanceof Error) return { name: detail.name, message: detail.message };
  if (Array.isArray(detail)) return detail.map((v) => serializable(v, depth + 1));
  if (detail && typeof detail === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(detail)) {
      if (v instanceof Error) out[k] = { name: v.name, message: v.message };
      else if (typeof v === "number" || typeof v === "string" || typeof v === "boolean" || v === null) out[k] = v;
      else if (v && typeof v === "object") out[k] = serializable(v, depth + 1);
    }
    return out;
  }
  return detail;
}

export class BridgeHost {
  private readonly options: BridgeHostOptions;
  private readonly origin: string;
  private readonly listener: (e: MessageEvent) => void;
  private readonly forwarders: [string, (e: Event) => void][] = [];

  constructor(options: BridgeHostOptions) {
    this.options = options;
    this.origin = exactOrigin(options.parentOrigin);
    this.listener = (e) => void this.onMessage(e);
    options.receiver.addEventListener("message", this.listener);
    for (const name of BRIDGE_EVENTS) {
      const fn = (e: Event): void => this.send("event", { name, detail: serializable((e as CustomEvent).detail) });
      options.target.addEventListener(name, fn);
      this.forwarders.push([name, fn]);
    }
    this.send("ready", {});
  }

  private send(type: string, payload: unknown, requestId?: string): void {
    this.options.parent.postMessage(
      { channel: BRIDGE_CHANNEL, version: BRIDGE_VERSION, sessionNonce: this.options.sessionNonce, type, payload, ...(requestId ? { requestId } : {}) },
      this.origin,
    );
  }

  /** Returns true when the message was accepted and executed. */
  async onMessage(e: MessageEvent): Promise<boolean> {
    if (e.origin !== this.origin) return false;
    if (e.source !== (this.options.parent as unknown)) return false;
    const env = validateEnvelope(e.data);
    if (!env || env.sessionNonce !== this.options.sessionNonce) return false;
    const command = validateCommand(env);
    if (!command) {
      if (env.requestId) this.send("response", { ok: false, error: `invalid command "${env.type}"` }, env.requestId);
      return false;
    }
    try {
      const result = await this.execute(command);
      if (env.requestId) this.send("response", { ok: true, result: serializable(result) ?? null }, env.requestId);
    } catch (err) {
      if (env.requestId) this.send("response", { ok: false, error: err instanceof Error ? err.message : String(err) }, env.requestId);
    }
    return true;
  }

  private async execute(c: BridgeCommand): Promise<unknown> {
    const t = this.options.target;
    switch (c.type) {
      case "load":
        await t.load(c.payload.url);
        return null;
      case "unload":
        return t.unload();
      case "select":
        t.select(c.payload.ids, { ...(c.payload.fit !== undefined ? { fit: c.payload.fit } : {}), ...(c.payload.mode ? { mode: c.payload.mode } : {}) });
        return null;
      case "clearSelection":
        t.clearSelection();
        return null;
      case "hide":
        t.hide(c.payload.ids);
        return null;
      case "show":
        t.show(c.payload.ids);
        return null;
      case "isolate":
        t.isolate(c.payload.ids);
        return null;
      case "showAll":
        t.showAll();
        return null;
      case "fit":
        await t.fit(c.payload?.ids);
        return null;
      case "setClipPlane":
        t.setClipPlane(c.payload.plane);
        return null;
      case "getProperties":
        return t.getProperties(c.payload.id);
    }
  }

  dispose(): void {
    this.options.receiver.removeEventListener("message", this.listener);
    for (const [name, fn] of this.forwarders) this.options.target.removeEventListener(name, fn);
  }
}
