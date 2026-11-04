# Third-party notices

Integration Verifier is licensed under Apache-2.0 (see `LICENSE`). It uses the
components below, each under its own license. `npm run licenses` checks every
installed package against the approved list and fails on anything else.

## Runtime dependencies (shipped)

| Package | Version | License | Used by |
|---|---|---|---|
| [commander](https://github.com/tj/commander.js) | 15.0.0 | MIT | `packages/cli` |
| [yaml](https://github.com/eemeli/yaml) | 2.9.1 | ISC | `packages/core` |
| [zod](https://github.com/colinhacks/zod) | 4.6.7 | MIT | `packages/core` |

## Development dependencies (not shipped)

| Package | Version | License |
|---|---|---|
| [typescript](https://github.com/microsoft/TypeScript) | 5.9.3 | Apache-2.0 |
| [vitest](https://github.com/vitest-dev/vitest) | 5.1.0 | MIT |
| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped) | 24.19.2 | MIT |

Reviewed exception: `lightningcss` (MPL-2.0) is installed transitively by
vitest → vite. It is used only during development, is never modified and is not
distributed with Integration Verifier.

## External tools (called, never bundled)

These are run from the user's own installation as separate processes.
Integration Verifier ships only its own rule files for them.

| Tool | License | Purpose |
|---|---|---|
| [Semgrep CE](https://github.com/semgrep/semgrep) | LGPL-2.1 | Pattern and secret scanning (PR 4) |
| [Opengrep](https://github.com/opengrep/opengrep) | LGPL-2.1 | Alternative scanning engine (PR 4) |
| [Schemathesis](https://github.com/schemathesis/schemathesis) | MIT | Optional API fuzzing (PR 5) |

Semgrep-maintained registry rules (Semgrep Rules License v1.0) and AGPL rule
sets are **not** used or redistributed.

## Planned

Recorded here as they are added: Playwright (Apache-2.0, with its NOTICE text),
web-tree-sitter and grammars (MIT), @modelcontextprotocol/sdk (MIT), fast-glob (MIT).
