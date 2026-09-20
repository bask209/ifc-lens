## What this changes

<!-- The behaviour before and after, and why. Link the issue it closes. -->

## Checks

- [ ] `npm run verify` passes (lint, typecheck, unit, build, license audit, SBOM, package, corpus in Node and the browser)
- [ ] `npm run docs` leaves `docs/` unchanged, or the regenerated files are part of this PR
- [ ] New behaviour has tests; new geometry support has an analytic unit test and a `src/ifc/support.ts` entry
- [ ] No new runtime dependencies (the package keeps `"dependencies": {}`)
- [ ] Corpus results are unchanged, or re-recorded with `UPDATE_CORPUS_RESULTS=1 npm run test:corpus` and explained below

<!-- Contributions are licensed under Apache-2.0; see CONTRIBUTING.md. -->
