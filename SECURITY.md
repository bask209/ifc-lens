# Security policy

## Supported versions

Security fixes are made on the latest release of the current major version (1.x).

## Reporting a vulnerability

Report it through [GitHub issues](https://github.com/bask209/ifc-lens/issues) with the **security** label. Once
this repository is public, use private vulnerability reporting instead — the *Report a vulnerability* button
under the Security tab — so the report stays confidential until a fix ships.

Include:

- what the issue is and what it lets an attacker do,
- a minimal IFC file or steps that reproduce it (malicious test files are welcome; please mark them clearly),
- the browser and version, and the viewer version.

Reports are acknowledged and triaged as time allows; expect a first response within a week. Fixed issues are
credited in [CHANGELOG.md](CHANGELOG.md) unless you ask otherwise.

## What counts

The viewer treats every IFC file as untrusted input. Parser crashes, hangs, unbounded memory growth, escapes
from the Shadow DOM or the iframe bridge, and anything that turns model content into executed script are all
security issues — see [docs/security.md](docs/security.md) for the threat model, the resource limits and the
origin checks the iframe protocol performs.
