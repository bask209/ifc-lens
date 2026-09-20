// SPDX-License-Identifier: Apache-2.0
/**
 * Script of the shipped iframe page (dist/iframe/index.html). Configuration:
 *   ?parentOrigin=<exact origin>&src=<optional model URL>#nonce=<session nonce>
 * Without a valid parentOrigin and nonce the bridge stays disabled.
 */

import "../ifc-viewer.ts";
import { BridgeHost } from "./host.ts";

const params = new URLSearchParams(location.search);
const hash = new URLSearchParams(location.hash.slice(1));
const viewer = document.querySelector("ifc-viewer")!;
const parentOrigin = params.get("parentOrigin");
const nonce = hash.get("nonce");
const src = params.get("src");
if (src && /^https?:\/\//i.test(src)) viewer.setAttribute("src", src);
if (parentOrigin && nonce && window.parent !== window) {
  try {
    new BridgeHost({ target: viewer as never, parentOrigin, sessionNonce: nonce, parent: window.parent, receiver: window });
  } catch (e) {
    console.error("ifc-viewer bridge disabled:", e);
  }
}
