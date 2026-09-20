# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## 1.0.0 — unreleased

First release.

### Viewer

- `<ifc-viewer>` custom element in Shadow DOM: tool rail, spatial tree, property inspector, section plane,
  orientation cube, help panel, status strip with progress, drag-and-drop, light/dark themes, and keyboard
  shortcuts scoped to the focused canvas.
- `IfcViewer` for use without the element: load, select, hide/show/isolate, fit, camera presets and `viewFrom`,
  clip planes, property queries, picking, snapshots and an orbit-anchor callback.
- Versioned iframe bridge with exact-origin, source and nonce validation, served from a page with a
  restrictive CSP.

### Format and geometry

- Independent streaming ISO 10303-21 parser: chunk-split-safe tokenizer, packed value arena, lazy references,
  error recovery, and resource limits on file size, entities, tokens, strings, depth, triangles and memory.
- IFC2X3, IFC4 and IFC4X3 semantics: units, spatial tree, reverse relationship indexes, property and quantity
  sets, type properties, materials, classifications and styles.
- Geometry: placements, curves (including B-splines), profiles, extrusions, revolutions, sweeps, swept disks,
  tessellated and polygonal face sets, faceted and advanced BReps, half-spaces, semantic openings, and GPU
  instancing of representation maps.
- Project-owned mesh CSG (BVH, exact triangle intersection, planar arrangement splitting, winding-number
  classification, T-junction stitching) — no third-party geometry kernel.

### Rendering

- WebGL2 renderer with one instanced pipeline, a per-object state texture for hide/select, GPU ID-buffer
  picking, clip planes, frustum culling, budgeted uploads and context-loss recovery.

### Project

- Zero runtime dependencies; every file in `dist/` is traced back to this repository's Apache-2.0 sources by
  the provenance audit, with a CycloneDX SBOM and a re-audit of the packed tarball.
- All 35 files of the buildingSMART Certification-datasets open in both the Node and the browser suites, with
  per-file results recorded in `docs/compatibility.md`.
