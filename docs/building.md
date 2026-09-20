# Building, testing and releasing

Working on the repository day to day: [AGENTS.md](../AGENTS.md). Requirements: Node.js ≥ 22.18 (tests run TypeScript directly through Node's type stripping) and git (to fetch the test corpus).

```sh
npm ci
npx playwright install --with-deps chromium   # browser tests
```

| Command | What it does |
|---|---|
| `npm run build` | `tsc` compiles `src/` to `dist/` (ES2022 modules, declarations and source maps), then copies the iframe page |
| `npm run typecheck` | Strict type check of sources, tests and scripts |
| `npm run lint` | SPDX headers, no placeholders or stray console output, whitespace hygiene |
| `npm run test:unit` | Parser, model, geometry, CSG, triangulation, engine, session, bridge, boundaries, fuzzing (`node --test`) |
| `npm run corpus:fetch` | Clones buildingSMART Certification-datasets at the pinned commit into `~/.cache/ifc-lens` (override with `IFC_CORPUS_DIR`) |
| `npm run test:corpus` | Every corpus file through the full pipeline in Node, regression-checked against `tests/corpus/results.json` |
| `npm run test:browser` | Playwright integration and visual tests in Chromium (`test:browser:all` adds Firefox and WebKit) |
| `npm run test:corpus:browser` | Every corpus file in the real `<ifc-viewer>` in Chromium |
| `npm run audit:licenses` | Artifact provenance and license gate; writes `dist/build-provenance.json` and `COMPLIANCE.json` |
| `npm run sbom` | Writes `sbom.cdx.json` (CycloneDX 1.5) |
| `npm run verify:package` | `npm pack`, unpack into a clean directory, re-run the audit on the tarball |
| `npm run docs` | Regenerates `docs/ifc-support.md`, `docs/api.md` and `docs/compatibility.md` |
| `npm run fixtures` | Regenerates the Apache-2.0 test fixtures and the demo model |
| `npm run docs:images` | Re-captures the README screenshots in `docs/images/` (needs `dist/`, Chromium and the corpus; run by hand, not part of `npm run docs`) |
| `npm run benchmark -- small` | Pipeline benchmark (see performance.md) |
| `npm run serve` / `npm run demo` | Static server on :8080 (`/demo/`, `/examples/…`) |
| `npm run verify` | Everything above, in release order |

## Updating recorded results

- Corpus results: `UPDATE_CORPUS_RESULTS=1 npm run test:corpus`. Review the diff of `tests/corpus/results.json`; the suite never allows skipping a file.
- Visual goldens: `UPDATE_GOLDEN=1 npm run test:browser -- tests/browser/visual.spec.ts`.

## Headless WebGL

Playwright's Chromium renders WebGL through SwiftShader by default, which works on the CI runners. On hosts where the bundled SwiftShader cannot rasterise (observed on RHEL 9, where the GPU process crashes on the first draw), select ANGLE's GL backend:

```sh
IFC_LENS_ANGLE=gl-egl npm run test:browser
```

The suites run three Chromium workers. On a loaded machine the browsers can take longer than the 60 s
setup timeout to start, which fails the first tests scheduled with `Test timeout … while setting up "page"`.
That is contention, not a product failure: re-run the suite on an idle machine, or lower the worker count
(`npx playwright test --project=chromium --workers=1`). Retries stay at zero so a real flake is never hidden.

## Release

CI (`.github/workflows/ci.yml`) runs lint → typecheck → unit tests → build → license audit → SBOM → package verification → docs freshness → corpus (Node) → browser tests (Chromium; Firefox and WebKit in a matrix) → corpus (browser) → benchmark smoke, on pushes to `main`, on pull requests and on demand.

A release is a tag. `.github/workflows/release.yml` fires on `v*`, checks the tag against `version` in `package.json`, runs the whole `npm run verify` gate, packs the tarball, uploads it together with `COMPLIANCE.json`, `sbom.cdx.json` and `dist/build-provenance.json`, and publishes with `npm publish --provenance`. Publishing needs the `NPM_TOKEN` repository secret; provenance attestation additionally needs the repository to be public. Running the workflow by hand (`workflow_dispatch`) builds and verifies without publishing unless the *publish* input is set.

```sh
npm version 1.1.0          # commits and tags
git push origin main --follow-tags
```

`npm pack` and `npm publish` run `prepack`, which rebuilds `dist/` and regenerates `dist/build-provenance.json`, so a tarball can never carry a stale build or an unaudited artifact.
