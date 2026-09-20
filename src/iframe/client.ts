// SPDX-License-Identifier: Apache-2.0
/**
 * Host-page side of the iframe bridge. Messages from the frame are accepted
 * only when they come from the frame's window, the exact viewer origin and
 * carry the session nonce; requests time out.
 */

import { BRIDGE_CHANNEL, BRIDGE_VERSION, createNonce, exactOrigin, validateEnvelope, type BridgeCommand } from "./protocol.ts";

export interface FrameClientOptions {
  /** Exact origin serving the viewer page. */
  viewerOrigin: string;
  /** Nonce also passed to the frame URL (#nonce=…); generated when omitted. */
  sessionNonce?: string;
  timeoutMs?: number;
}

type Listener = (detail: unknown) => void;

export class IfcViewerFrameClient {
  readonly sessionNonce: string;
  readonly ready: Promise<void>;
  private readonly frame: HTMLIFrameElement;
  private readonly origin: string;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly onMessage: (e: MessageEvent) => void;
  private resolveReady!: () => void;
  private counter = 0;

  constructor(frame: HTMLIFrameElement, options: FrameClientOptions) {
    this.frame = frame;
    this.origin = exactOrigin(options.viewerOrigin);
    this.sessionNonce = options.sessionNonce ?? createNonce();
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.ready = new Promise((r) => (this.resolveReady = r));
    this.onMessage = (e) => this.receive(e);
    window.addEventListener("message", this.onMessage);
  }

  /** URL for the frame's src: viewer page with parent origin and nonce. */
  static frameUrl(viewerPage: string, parentOrigin: string, nonce: string, src?: string): string {
    const u = new URL(viewerPage);
    u.searchParams.set("parentOrigin", exactOrigin(parentOrigin));
    if (src) u.searchParams.set("src", src);
    u.hash = `nonce=${encodeURIComponent(nonce)}`;
    return u.href;
  }

  private receive(e: MessageEvent): void {
    if (e.origin !== this.origin || e.source !== this.frame.contentWindow) return;
    const env = validateEnvelope(e.data);
    if (!env || env.sessionNonce !== this.sessionNonce) return;
    if (env.type === "ready") {
      this.resolveReady();
    } else if (env.type === "response" && env.requestId) {
      const p = this.pending.get(env.requestId);
      if (!p) return;
      this.pending.delete(env.requestId);
      clearTimeout(p.timer);
      const payload = env.payload as { ok?: boolean; result?: unknown; error?: string } | undefined;
      if (payload?.ok) p.resolve(payload.result);
      else p.reject(new Error(payload?.error ?? "viewer command failed"));
    } else if (env.type === "event") {
      const payload = env.payload as { name?: string; detail?: unknown } | undefined;
      if (payload?.name) for (const l of this.listeners.get(payload.name) ?? []) l(payload.detail);
    }
  }

  async call<T = unknown>(type: BridgeCommand["type"], payload?: unknown): Promise<T> {
    await this.ready;
    const requestId = `${Date.now().toString(36)}-${++this.counter}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`viewer command "${type}" timed out`));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.frame.contentWindow?.postMessage(
        { channel: BRIDGE_CHANNEL, version: BRIDGE_VERSION, sessionNonce: this.sessionNonce, requestId, type, ...(payload !== undefined ? { payload } : {}) },
        this.origin,
      );
    });
  }

  on(event: string, listener: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => set!.delete(listener);
  }

  dispose(): void {
    window.removeEventListener("message", this.onMessage);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("frame client disposed"));
    }
    this.pending.clear();
  }
}
