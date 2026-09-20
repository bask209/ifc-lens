// SPDX-License-Identifier: Apache-2.0
/**
 * Versioned postMessage protocol between a host page and a viewer running in
 * an iframe. Every message is validated structurally; the receiving side also
 * verifies the sender origin (exact match), the sender window and a
 * per-session nonce. Replies always use an exact targetOrigin, never "*".
 */

export const BRIDGE_CHANNEL = "ifc-viewer";
export const BRIDGE_VERSION = 1;
const MAX_IDS = 1_000_000;

export interface BridgeEnvelope<T = unknown> {
  channel: typeof BRIDGE_CHANNEL;
  version: typeof BRIDGE_VERSION;
  sessionNonce: string;
  requestId?: string;
  type: string;
  payload?: T;
}

export type BridgeCommand =
  | { type: "load"; payload: { url: string } }
  | { type: "unload"; payload?: undefined }
  | { type: "select"; payload: { ids: number[]; fit?: boolean; mode?: "replace" | "add" | "toggle" } }
  | { type: "clearSelection"; payload?: undefined }
  | { type: "hide"; payload: { ids: number[] } }
  | { type: "show"; payload: { ids: number[] } }
  | { type: "isolate"; payload: { ids: number[] } }
  | { type: "showAll"; payload?: undefined }
  | { type: "fit"; payload?: { ids?: number[] } }
  | { type: "setClipPlane"; payload: { plane: { normal: [number, number, number]; distance: number } | null } }
  | { type: "getProperties"; payload: { id: number } };

export const BRIDGE_EVENTS = ["ifc-load-start", "ifc-progress", "ifc-model-ready", "ifc-load", "ifc-selection-change", "ifc-visibility-change", "ifc-error"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Structural validation of an incoming envelope; returns null for anything malformed. */
export function validateEnvelope(data: unknown): BridgeEnvelope | null {
  if (!isRecord(data)) return null;
  if (data.channel !== BRIDGE_CHANNEL || data.version !== BRIDGE_VERSION) return null;
  if (typeof data.sessionNonce !== "string" || data.sessionNonce.length < 8 || data.sessionNonce.length > 256) return null;
  if (typeof data.type !== "string" || data.type.length === 0 || data.type.length > 64) return null;
  if (data.requestId !== undefined && (typeof data.requestId !== "string" || data.requestId.length > 128)) return null;
  const out: BridgeEnvelope = { channel: BRIDGE_CHANNEL, version: BRIDGE_VERSION, sessionNonce: data.sessionNonce, type: data.type };
  if (data.requestId !== undefined) out.requestId = data.requestId;
  if (data.payload !== undefined) out.payload = data.payload;
  return out;
}

function ids(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length > MAX_IDS) return null;
  for (const x of v) if (typeof x !== "number" || !Number.isSafeInteger(x) || x <= 0) return null;
  return v as number[];
}

/** Validates the payload of a command envelope. */
export function validateCommand(env: BridgeEnvelope): BridgeCommand | null {
  const p = env.payload;
  switch (env.type) {
    case "load": {
      if (!isRecord(p) || typeof p.url !== "string" || p.url.length > 8192) return null;
      if (!/^https?:\/\//i.test(p.url)) return null;
      return { type: "load", payload: { url: p.url } };
    }
    case "unload":
    case "clearSelection":
    case "showAll":
      return { type: env.type } as BridgeCommand;
    case "select": {
      if (!isRecord(p)) return null;
      const list = ids(p.ids);
      if (!list) return null;
      if (p.fit !== undefined && typeof p.fit !== "boolean") return null;
      if (p.mode !== undefined && p.mode !== "replace" && p.mode !== "add" && p.mode !== "toggle") return null;
      return { type: "select", payload: { ids: list, ...(p.fit !== undefined ? { fit: p.fit } : {}), ...(p.mode !== undefined ? { mode: p.mode } : {}) } };
    }
    case "hide":
    case "show":
    case "isolate": {
      if (!isRecord(p)) return null;
      const list = ids(p.ids);
      return list ? ({ type: env.type, payload: { ids: list } } as BridgeCommand) : null;
    }
    case "fit": {
      if (p === undefined) return { type: "fit" };
      if (!isRecord(p)) return null;
      if (p.ids === undefined) return { type: "fit", payload: {} };
      const list = ids(p.ids);
      return list ? { type: "fit", payload: { ids: list } } : null;
    }
    case "setClipPlane": {
      if (!isRecord(p)) return null;
      if (p.plane === null) return { type: "setClipPlane", payload: { plane: null } };
      if (!isRecord(p.plane) || !Array.isArray(p.plane.normal) || p.plane.normal.length !== 3) return null;
      const n = p.plane.normal;
      if (!n.every((x) => typeof x === "number" && Number.isFinite(x)) || typeof p.plane.distance !== "number" || !Number.isFinite(p.plane.distance)) return null;
      return { type: "setClipPlane", payload: { plane: { normal: [n[0], n[1], n[2]] as [number, number, number], distance: p.plane.distance } } };
    }
    case "getProperties": {
      if (!isRecord(p) || typeof p.id !== "number" || !Number.isSafeInteger(p.id) || p.id <= 0) return null;
      return { type: "getProperties", payload: { id: p.id } };
    }
    default:
      return null;
  }
}

/** Exact origin string or throws (no wildcards). */
export function exactOrigin(origin: string): string {
  const u = new URL(origin);
  if (u.origin === "null" || (u.protocol !== "https:" && u.protocol !== "http:")) throw new TypeError(`Invalid bridge origin: ${origin}`);
  return u.origin;
}

export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
