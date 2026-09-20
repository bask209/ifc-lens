# Security

## Threat model

Every IFC file is treated as attacker-controlled structured input. A file can carry huge counts, deeply nested aggregates, enormous numbers, pathological polygons, cyclic references, hostile strings and expensive Boolean trees. It never contains code: nothing in a model is evaluated, used to construct code, or inserted as markup.

| Risk | Mitigation | Test |
|---|---|---|
| Code execution / injection | No `eval`/`Function`. Model text is only ever set via `textContent`, and `innerHTML` is used solely for static, project-authored markup (checked by a unit test) | `boundaries.test.ts`, "hostile names render as text" |
| Parser stack exhaustion | Iterative parser with `maxAggregateDepth` (default 64) | "enforces the aggregate nesting limit" |
| Memory exhaustion | `maxFileBytes`, `maxEntities`, `maxStringBytes`, `maxTokenBytes`, `maxTriangles`, `maxGeometryBytes`, `maxVerticesPerProduct` | parser, session and browser limit tests |
| Out-of-bounds indices | Every one-based index is validated before use, including `PnIndex` indirection; values like 2³¹−1 are rejected | "rejects enormous or zero indices" |
| Reference cycles | Traversal guards on placements, representation items, curves and mapped items (`IfcCycleError`) | placement and mapped-item cycle tests |
| Runaway geometry | `maxCurveSegments`, `maxBooleanDepth`, `maxBooleanTriangles`, per-product time budget (`maxProductMillis`), CSG pair/segment caps | CSG depth test, fuzzing |
| Non-finite numbers | Non-finite coordinates are rejected when decoded; CSG refuses non-finite operands | unit tests |
| Hangs | Parsing and geometry run in a worker that yields every ~24 ms; `AbortSignal` cancellation; a watchdog terminates a worker that is silent for `workerTimeoutMs` (default 120 s) | "cancels promptly", "hanging worker" |
| Hostile URLs | Only `http:`, `https:` and `blob:` sources are fetched; `javascript:`, `data:`, `file:` are rejected | "javascript: and data: sources are rejected" |

The fuzz suite (`tests/unit/fuzz.test.ts`) mutates a rich model with deletions, nesting bombs, byte flips, truncation, dangling references, huge numbers, broken escapes, hostile indices and reference swaps. Every outcome must be a completed load or a structured error (`StepFormatError`, `IfcResourceLimitError`). Any other exception fails the suite.

When a budget is exceeded, the viewer emits `ifc-resource-limit` with `{resource, actual, limit, productId?}`. Per-product limits skip that product; global file/entity limits stop the load with a fatal `ifc-error`.

## Local files

`File` and `Blob` sources are read in the browser and never uploaded anywhere.

## Remote files

URL sources are fetched by the worker with the credentials mode you choose (`same-origin` by default). Cross-origin files require CORS headers from their server. Failed requests are reported with the HTTP status, or as a CORS/network error with guidance.

## Iframe bridge

The iframe page (`dist/iframe/index.html`) ships with a restrictive CSP (`default-src 'none'`; scripts and workers from its own origin only). The host and the frame exchange versioned envelopes:

```ts
{ channel: "ifc-viewer", version: 1, sessionNonce, requestId?, type, payload? }
```

The frame accepts a message only if all of the following hold:

1. `event.origin` exactly equals the `parentOrigin` from its URL (no wildcards, no `null` origins),
2. `event.source === window.parent`,
3. the envelope passes structural validation,
4. the nonce matches the one passed in the URL fragment, and
5. the command payload passes its schema (positive safe-integer ids, http(s) URLs, finite plane values).

Replies and events go to `parent.postMessage(…, parentOrigin)` with the exact origin, never `"*"`. The host-side client applies the same checks (origin, `frame.contentWindow`, nonce) and times out requests. Unit tests cover bad origins, foreign windows, wrong nonces and malformed payloads. A browser test drives a real cross-origin frame.

## WebAssembly

None. The CSG engine is TypeScript running in the worker under the same budgets.

## Reporting vulnerabilities

See [SECURITY.md](../SECURITY.md).
