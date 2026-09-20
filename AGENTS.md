# Working on ifc-lens

Orientation for coding agents and new contributors: what the project refuses to do, how to run it, and the
conventions the test suite enforces. Read this first, then [docs/architecture.md](docs/architecture.md) for how
the pipeline fits together. [blueprint.md](blueprint.md) is the original brief and is kept for reference only;
where it and the code disagree, the code and the docs win.

## What this is

An embeddable IFC viewer for the browser: an independent STEP Part 21 parser, an IFC model layer, a geometry
engine (including a project-owned mesh CSG), a WebGL2 renderer, and a Shadow-DOM `<ifc-viewer>` custom element.
TypeScript with no bundler and **no runtime dependencies** — `tsc` compiles `src/` to `dist/` and that is the
shipped artifact.

## Non-negotiables

These are project rules, not preferences. A change that breaks one of them is not mergeable.

- **Apache-2.0 only.** The package keeps `"dependencies": {}`. Dev dependencies should be Apache-2.0; exceptions
  must be justified in [docs/license-compliance.md](docs/license-compliance.md) and listed in the audit.
  `npm run audit:licenses` traces every byte of `dist/` back to this repository's sources through source maps.
- **Independent implementation.** Never copy code, tables or prose from other IFC toolkits or viewers — web-ifc,
  IFC.js / That Open, IfcOpenShell, xeokit — or from the buildingSMART schema files. Work from the public
  specification semantics.
- **The corpus is never trimmed.** Every file in the buildingSMART Certification-datasets must open and produce a
  usable view, in Node and in the browser. Do not skip, whitelist or mark files as expected failures. The dataset
  is fetched at a pinned commit, never vendored into this repository.
- **IFC input is untrusted.** Never execute it. Validate, bound it with the resource limits, and fail per item:
  a broken entity becomes a structured diagnostic (`src/diagnostics.ts`) and its siblings still render.
- **No placeholders.** No stub functions, dead code, mock-only tests, or comments promising later work. `npm run
  lint` rejects placeholder markers outright.

## Setup

Node.js ≥ 22.18 — tests execute `.ts` directly through Node's type stripping, so there is no build step for them.

```sh
npm ci
npx playwright install --with-deps chromium    # browser suites
npm run corpus:fetch                           # clones the pinned corpus into ~/.cache/ifc-lens (IFC_CORPUS_DIR overrides)
```

If the browser suites render black or the GPU process dies on the first draw (seen on RHEL 9, where Chromium's
bundled SwiftShader cannot rasterise), run them through ANGLE's GL backend:

```sh
IFC_LENS_ANGLE=gl-egl npm run test:browser
```

## The loop

While editing, `npm run typecheck` plus the tests nearest the change:

```sh
node --test tests/unit/csg.test.ts                               # one unit file
node --test --test-name-pattern "swept disk" tests/unit/*.test.ts # one case
npx playwright test --project=chromium -g "section tool"          # one browser test
node --test --test-name-pattern "Infra-Bridge" tests/corpus/corpus.test.ts
```

Before calling a change done, run the whole gate — it takes a few minutes and is exactly what CI runs:

```sh
npm run verify        # lint, typecheck, unit, build, license audit, SBOM, package, corpus (Node), browser, corpus (browser)
npm run docs          # CI fails on a dirty docs/ diff, so regenerate whenever behaviour or public API changes
```

## Where code lives

| Path | Responsibility |
|---|---|
| `src/step` | ISO 10303-21 tokenizer, parser, packed value store, string decoding |
| `src/ifc` | Schema families, units, relationships, spatial tree, properties, styles, support matrix |
| `src/math`, `src/triangulation`, `src/csg` | Float64 geometry helpers, ear clipping, mesh Booleans |
| `src/geometry` | IFC representation items → renderer-neutral meshes |
| `src/worker`, `src/protocol` | Load session, GPU packing, the postMessage contract |
| `src/renderer` | WebGL2 renderer, orbit camera, navigation, GPU picking |
| `src/core` | `IfcViewer`: worker client plus selection, visibility, clipping and camera state |
| `src/element` | `<ifc-viewer>`: Shadow-DOM UI, tree, properties, cube, help panel, section tool |
| `src/iframe` | Versioned, origin-checked iframe bridge |
| `tests/unit` | Node test runner suites, including `boundaries.test.ts` |
| `tests/browser`, `tests/corpus` | Playwright suites and the corpus harness |
| `examples/`, `demo/` | Embedding samples and the demo page served by `npm run serve` |

Layering is enforced by `tests/unit/boundaries.test.ts`: the STEP parser knows nothing of IFC, geometry nothing of
WebGL, the renderer nothing of IFC, and `src/core` never imports the element. Add an import that crosses a layer
and that test fails by design — restructure rather than relax it.

## Generated files — never hand-edit

| File | Regenerate with |
|---|---|
| `dist/` | `npm run build` |
| `docs/api.md`, `docs/ifc-support.md`, `docs/compatibility.md` | `npm run docs` |
| `COMPLIANCE.json`, `dist/build-provenance.json` | `npm run audit:licenses` |
| `sbom.cdx.json` | `npm run sbom` |
| `tests/fixtures/generated/`, `demo/models/harbour-pavilion.ifc` | `npm run fixtures` |
| `docs/images/` (README screenshots) | `npm run docs:images` — by hand; renders differ between GPUs, so CI never regenerates them |
| `tests/corpus/results.json` | `UPDATE_CORPUS_RESULTS=1 npm run test:corpus` (review the diff, explain it) |
| `tests/browser/golden/` | `UPDATE_GOLDEN=1 npm run test:browser -- tests/browser/visual.spec.ts` |

## House rules the suites enforce

- **Erasable syntax only.** No enums, namespaces or parameter properties, and relative imports carry the `.ts`
  extension in source (`rewriteRelativeImportExtensions` maps them on build). Node runs the sources as written.
- **Every source file starts with** `// SPDX-License-Identifier: Apache-2.0`.
- **No `console.log`/`debug`/`info` in `src/`**, no breakpoint statements, no tabs or trailing whitespace.
- **DOM safety.** Model text reaches the DOM only through `textContent`; `innerHTML` is allowed only from the
  static templates and icon constants on the allowlist in `boundaries.test.ts`. No `eval` or `new Function`.
- **Failures are diagnostics, not exceptions.** Geometry and decode errors are reported per item and the rest of
  the model still loads; only a genuinely fatal condition rejects the load promise.
- **New geometry support needs** a unit test with an analytic expectation (volume, bounds, closedness), an entry
  in `src/ifc/support.ts` followed by `npm run docs:support`, and a visual case when it renders something new.
- **Parser changes need** chunk-split invariance tests: the tokenizer must survive a chunk boundary at every byte.
- **Public API changes need** a matching update to [docs/embedding.md](docs/embedding.md) and `npm run docs`.

## Releasing

Tags drive it: `npm version <x.y.z>` then push the tag, and `.github/workflows/release.yml` re-runs the whole
gate before publishing with provenance. `prepack` rebuilds `dist/` and its provenance report, so no tarball can
carry a stale build. Never publish from a working tree by hand.

## Where to read next

| Document | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Layer-by-layer design and the load pipeline |
| [docs/building.md](docs/building.md) | Every npm script, recorded results, release flow |
| [docs/embedding.md](docs/embedding.md) | Attributes, events, parts, navigation, iframe bridge, CSP |
| [docs/api.md](docs/api.md) | Public TypeScript surface, generated from the declarations |
| [docs/ifc-support.md](docs/ifc-support.md) | Entity support matrix and limitations |
| [docs/security.md](docs/security.md) | Threat model, resource limits, origin checks |
| [docs/performance.md](docs/performance.md) | Benchmarks, memory model, tuning knobs |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contribution terms and review expectations |
