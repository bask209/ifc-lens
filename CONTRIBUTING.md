# Contributing

Thank you for helping. A few rules keep the project shippable under its license policy and quality bar.
[AGENTS.md](AGENTS.md) is the working brief for the repository — commands, layer map, generated files and the
conventions the suites enforce. This page covers the terms your contribution is accepted under.

## License of contributions

By contributing you agree that your work is licensed under the Apache License 2.0. Every new source file starts with:

```ts
// SPDX-License-Identifier: Apache-2.0
```

Do not copy code, tables or text from other viewers or IFC toolkits (in particular web-ifc, IFC.js/That Open, IfcOpenShell, xeokit), from the buildingSMART schema files, or from packages under other licenses. Implement from the public IFC specification semantics and your own understanding. **No runtime dependencies**: the published package must keep `"dependencies": {}`. Development dependencies should be Apache-2.0; any exception must be justified in docs/license-compliance.md and added to the audit's exception list.

## Reporting and proposing

Bugs, IFC files that do not open, and feature or coverage requests all go to
[GitHub issues](https://github.com/bask209/ifc-lens/issues) — the templates ask for the model, schema, browser
and diagnostics, which is what triage needs. Security issues follow [SECURITY.md](SECURITY.md) instead. For a
change of any size, open an issue before the pull request so the approach can be agreed first.

Pull requests branch off `main`, keep to one topic, and come with the checklist in the PR template filled in.
CI runs the same gate as `npm run verify`, plus Firefox and WebKit.

## Workflow

```sh
npm ci
npm run corpus:fetch
npm run verify            # lint, typecheck, unit, build, audit, sbom, package, corpus, browser suites
```

- Keep layer boundaries (`tests/unit/boundaries.test.ts`): the STEP parser knows nothing of IFC, geometry knows nothing of WebGL, the renderer knows nothing of IFC, and the core viewer never imports the element.
- New geometry support needs: a unit test with an analytic expectation (volume, bounds, closedness), an entry in `src/ifc/support.ts` (then `npm run docs:support`), and a visual case in `tests/browser/visual.spec.ts` when it renders something new.
- Parser changes need chunk-split invariance tests.
- Unsupported input must degrade per item with a structured diagnostic, never an exception that fails the model.
- Never skip, whitelist or mark corpus files as expected failures. If a change alters recorded corpus results, re-record them (`UPDATE_CORPUS_RESULTS=1 npm run test:corpus`) and explain the change in the pull request.
- Model text reaches the DOM only through `textContent`.

## Style

Strict TypeScript with erasable syntax only (no enums, namespaces or parameter properties), since tests run through Node's type stripping. Prefer typed arrays in hot paths, and no placeholder comments. `npm run lint` enforces the basics.
