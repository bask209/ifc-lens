// SPDX-License-Identifier: Apache-2.0
/**
 * Model worker entry point. One worker serves one viewer; a new load cancels
 * the previous one. Geometry buffers are transferred, never copied.
 */

import { batchTransferables, type MainToWorker, type WorkerToMain } from "../protocol/messages.ts";
import { LoadSession, serializeError } from "./session.ts";

interface WorkerScope {
  postMessage(message: WorkerToMain, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<MainToWorker>) => void): void;
  close(): void;
}

const scope = globalThis as unknown as WorkerScope;
let active: { requestId: number; session: LoadSession } | undefined;

function post(message: WorkerToMain, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

async function load(requestId: number, message: Extract<MainToWorker, { type: "load" }>): Promise<void> {
  active?.session.cancel();
  const session = new LoadSession(
    {
      progress: (phase, completed, total) => post({ type: "progress", requestId, phase, completed, ...(total !== undefined ? { total } : {}) }),
      metadata: (metadata) => post({ type: "metadata", requestId, metadata }, [metadata.geometryProducts.buffer as ArrayBuffer]),
      geometry: (batch) => post({ type: "geometry", requestId, batch }, batchTransferables(batch)),
      diagnostic: (diagnostic) => post({ type: "diagnostic", requestId, diagnostic }),
      resourceLimit: (detail) => post({ type: "resource-limit", requestId, detail }),
    },
    message.limits,
  );
  active = { requestId, session };
  try {
    const stats = await session.run(message.source);
    if (active?.session === session) post({ type: "complete", requestId, stats });
  } catch (e) {
    const error = serializeError(e);
    if (error.resource) post({ type: "resource-limit", requestId, detail: error.resource });
    post({ type: "error", requestId, error });
  }
}

scope.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || typeof message !== "object") return;
  switch (message.type) {
    case "load":
      void load(message.requestId, message);
      break;
    case "cancel":
      if (active && active.requestId === message.requestId) active.session.cancel();
      break;
    case "properties": {
      let groups: ReturnType<LoadSession["properties"]> = [];
      try {
        groups = active?.session.properties(message.id) ?? [];
      } catch (e) {
        post({ type: "error", requestId: message.requestId, error: serializeError(e) });
        return;
      }
      post({ type: "properties", requestId: message.requestId, groups });
      break;
    }
    case "entity": {
      const result = active?.session.entity(message.id) ?? { summary: null, attributes: [] };
      post({ type: "entity", requestId: message.requestId, ...result });
      break;
    }
    case "dispose":
      active?.session.cancel();
      active = undefined;
      scope.close();
      break;
    default:
      break;
  }
});
