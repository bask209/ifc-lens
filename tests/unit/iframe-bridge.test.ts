// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BridgeHost, type BridgeTarget } from "../../src/iframe/host.ts";
import { BRIDGE_CHANNEL, BRIDGE_VERSION, exactOrigin, validateCommand, validateEnvelope } from "../../src/iframe/protocol.ts";

const NONCE = "0123456789abcdef";
const PARENT_ORIGIN = "https://host.example";

function env(type: string, payload?: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { channel: BRIDGE_CHANNEL, version: BRIDGE_VERSION, sessionNonce: NONCE, requestId: "r1", type, ...(payload !== undefined ? { payload } : {}), ...extra };
}

class FakeTarget extends EventTarget implements BridgeTarget {
  calls: string[] = [];
  async load(s: string): Promise<unknown> { this.calls.push(`load ${s}`); return {}; }
  async unload(): Promise<void> { this.calls.push("unload"); }
  select(ids: number[], o?: { fit?: boolean }): void { this.calls.push(`select ${ids.join(",")} ${o?.fit ?? false}`); }
  clearSelection(): void { this.calls.push("clear"); }
  hide(ids: number[]): void { this.calls.push(`hide ${ids}`); }
  show(ids: number[]): void { this.calls.push(`show ${ids}`); }
  isolate(ids: number[]): void { this.calls.push(`isolate ${ids}`); }
  showAll(): void { this.calls.push("showAll"); }
  async fit(ids?: number[]): Promise<void> { this.calls.push(`fit ${ids ?? "all"}`); }
  setClipPlane(p: unknown): void { this.calls.push(`clip ${JSON.stringify(p)}`); }
  async getProperties(id: number): Promise<unknown> { return [{ name: "Attributes", properties: [{ name: "Express ID", value: id }] }]; }
}

function setup() {
  const posted: { message: Record<string, unknown>; origin: string }[] = [];
  const parent = { postMessage: (message: unknown, origin: string) => posted.push({ message: message as Record<string, unknown>, origin }) };
  const listeners: ((e: MessageEvent) => void)[] = [];
  const receiver = { addEventListener: (_: "message", l: (e: MessageEvent) => void) => listeners.push(l), removeEventListener: () => undefined };
  const target = new FakeTarget();
  const host = new BridgeHost({ target, parentOrigin: PARENT_ORIGIN, sessionNonce: NONCE, parent, receiver });
  const deliver = (data: unknown, origin = PARENT_ORIGIN, source: unknown = parent): Promise<boolean> =>
    host.onMessage({ data, origin, source } as unknown as MessageEvent);
  return { posted, target, deliver, host };
}

describe("iframe bridge protocol", () => {
  it("validates envelopes structurally", () => {
    assert.ok(validateEnvelope(env("showAll")));
    assert.equal(validateEnvelope(null), null);
    assert.equal(validateEnvelope("string"), null);
    assert.equal(validateEnvelope({ ...env("showAll"), channel: "other" }), null);
    assert.equal(validateEnvelope({ ...env("showAll"), version: 2 }), null);
    assert.equal(validateEnvelope({ ...env("showAll"), sessionNonce: "short" }), null);
    assert.equal(validateEnvelope({ ...env("x".repeat(100)) }), null);
  });

  it("validates command payloads", () => {
    const cmd = (type: string, payload?: unknown) => validateCommand(validateEnvelope(env(type, payload))!);
    assert.ok(cmd("select", { ids: [1, 2], fit: true }));
    assert.equal(cmd("select", { ids: [1, "2"] }), null);
    assert.equal(cmd("select", { ids: [1.5] }), null);
    assert.equal(cmd("select", { ids: [-1] }), null);
    assert.equal(cmd("load", { url: "javascript:alert(1)" }), null);
    assert.ok(cmd("load", { url: "https://x.example/a.ifc" }));
    assert.equal(cmd("setClipPlane", { plane: { normal: [0, 0, 1], distance: Infinity } }), null);
    assert.ok(cmd("setClipPlane", { plane: null }));
    assert.equal(cmd("eval", { code: "1" }), null);
  });

  it("rejects wildcard or opaque origins", () => {
    assert.throws(() => exactOrigin("*"));
    assert.throws(() => exactOrigin("null"));
    assert.equal(exactOrigin("https://a.example/path?x"), "https://a.example");
  });

  it("announces readiness to the exact parent origin", () => {
    const { posted } = setup();
    assert.equal(posted[0]!.message.type, "ready");
    assert.equal(posted[0]!.origin, PARENT_ORIGIN);
  });

  it("executes valid commands and replies with the exact target origin", async () => {
    const { posted, target, deliver } = setup();
    assert.equal(await deliver(env("select", { ids: [5], fit: true })), true);
    assert.deepEqual(target.calls, ["select 5 true"]);
    const reply = posted.at(-1)!;
    assert.equal(reply.origin, PARENT_ORIGIN);
    assert.equal(reply.message.type, "response");
    assert.deepEqual(reply.message.payload, { ok: true, result: null });
    await deliver(env("getProperties", { id: 7 }, { requestId: "r2" }));
    assert.deepEqual((posted.at(-1)!.message.payload as { result: unknown }).result, [{ name: "Attributes", properties: [{ name: "Express ID", value: 7 }] }]);
  });

  it("ignores messages from a bad origin, a wrong window or with a wrong nonce", async () => {
    const { target, deliver, posted } = setup();
    const before = posted.length;
    assert.equal(await deliver(env("showAll"), "https://evil.example"), false);
    assert.equal(await deliver(env("showAll"), PARENT_ORIGIN, { postMessage() {} }), false);
    assert.equal(await deliver({ ...env("showAll"), sessionNonce: "ffffffffffffffff" }), false);
    assert.deepEqual(target.calls, []);
    assert.equal(posted.length, before, "no replies to rejected senders");
  });

  it("ignores malformed payloads and reports invalid commands only to the verified parent", async () => {
    const { target, deliver, posted } = setup();
    assert.equal(await deliver({ hello: "world" }), false);
    assert.equal(await deliver(env("select", { ids: "1; drop" })), false);
    assert.deepEqual(target.calls, []);
    const reply = posted.at(-1)!;
    assert.deepEqual(reply.message.payload, { ok: false, error: 'invalid command "select"' });
    assert.equal(reply.origin, PARENT_ORIGIN);
  });

  it("forwards viewer events with serialisable details", () => {
    const { target, posted } = setup();
    target.dispatchEvent(new CustomEvent("ifc-selection-change", { detail: { selectedIds: [3, 4] } }));
    target.dispatchEvent(new CustomEvent("ifc-error", { detail: { fatal: true, error: new Error("boom") } }));
    const events = posted.filter((p) => p.message.type === "event").map((p) => p.message.payload);
    assert.deepEqual(events[0], { name: "ifc-selection-change", detail: { selectedIds: [3, 4] } });
    assert.deepEqual(events[1], { name: "ifc-error", detail: { fatal: true, error: { name: "Error", message: "boom" } } });
  });
});
