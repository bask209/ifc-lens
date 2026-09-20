# Performance

## Benchmark

`npm run benchmark -- <small|medium|large> [--json out.json]` generates a synthetic tower (licensing is unambiguous: the model is produced by this repository). Each storey has 40 walls, each with an opening subtracted by the CSG engine, 64 GPU-instanced columns, 150 tessellated furniture items, a slab, and property sets. The pipeline is the real `LoadSession` used in the worker.

Measured on an AMD Ryzen 5 2600 (Node 24, single thread; the browser worker uses the same code and engine):

| Tier | Input | Entities | Products shown | Triangles | Metadata ready | First geometry | All geometry | Parse throughput | Heap |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| small | 1.5 MB | 25,846 | 3,060 | 126,768 | 0.15 s | 0.27 s | 1.0 s | 19 MB/s | 57 MB |
| medium | 7.8 MB | 127,894 | 15,300 | 633,840 | 0.56 s | 0.69 s | 4.4 s | 24 MB/s | 143 MB |
| large | 26.6 MB | 425,534 | 51,000 | 2,112,800 | 1.7 s | 1.8 s | 14.5 s | 28 MB/s | 343 MB |

These are engineering measurements on one machine, not guarantees; browsers and devices vary. Most of the geometry time in these models is the 40 Boolean openings per storey (8,000 CSG operations in the large tier). Tessellated and instanced content appears within the first second because it is scheduled first.

The Certification-datasets files (up to 2.3 MB) load in under 0.2 s each in Node and in 0.3–1.9 s each in headless Chromium, including the browser suite's per-product visibility checks.

## Memory model

The pipeline avoids holding several copies of the model at once:

1. **Input**: streamed in chunks. The source string is never materialised. Tokens are read in place from the current chunk.
2. **Entities**: kept in a packed arena of typed arrays, with no object per value. References stay integer ids. Strings are decoded once.
3. **Geometry**: built in Float64 per product and converted to Float32 after subtracting a chunk or render origin (this keeps precision for georeferenced coordinates). The typed arrays are then transferred to the main thread, and the worker keeps no reference to them.
4. **GPU**: uploads are drained within a per-frame budget (`uploadBudgetMs`, default 6 ms). CPU copies are released after upload. Unloading frees every buffer; a browser test checks `gpuBytes === 0` after repeated load/unload cycles.

The worker keeps the entity store (for property queries) and the geometry of instanced representation maps.

## Rendering

- Unique geometry is merged into per-colour chunks of up to 262k vertices. The draw-call count is roughly (number of colours × number of flushes), independent of the product count.
- Repeated representation maps are drawn with hardware instancing.
- Visibility and selection live in a per-object state texture, so `hide`/`isolate`/`select` on 100k products are single texture uploads.
- Frames are rendered on demand (camera changes, uploads, state changes). An idle viewer uses no GPU time.
- Picking renders a 1×1 scissored ID pass, which stays cheap for large scenes.

## Tuning

| Option | Where | Effect |
|---|---|---|
| `maxTriangles`, `maxGeometryBytes` | `load(src, {…})` | Cap total geometry; remaining products are skipped with a diagnostic |
| `maxBooleanTriangles`, `maxProductMillis` | `load(src, {…})` | Skip Booleans on huge operands or products that take too long (shown uncut, with a diagnostic) |
| `uploadBudgetMs` | `new IfcViewer({…})` | Trade upload speed for UI smoothness |
| `workerTimeoutMs` | `new IfcViewer({…})` | Watchdog for unresponsive workers |

## Design choices versus the blueprint

- **No product BVH on the main thread.** Picking uses an exact GPU ID pass, which returns the product and the world point in O(1) CPU work regardless of scene size. Culling is per chunk or instanced definition, and fit/selection bounds come from per-product bounds computed in the worker. A BVH would only add value for box selection and LOD scheduling, which are not implemented yet.
- **Static batching by colour instead of per-product meshes.** Per-object state lives in a texture, so batching costs no per-product control.

## Known limits and roadmap

- Geometry runs in one worker per viewer. Parallel geometry workers are the planned next step (the session design already produces independent per-product recipes).
- The parser is byte-level and allocation-light. It currently reaches 20–30 MB/s on dense files, limited by per-token dispatch, so a 300 MB file needs about 12 s to index.
- No level of detail or persistent geometry cache yet.
