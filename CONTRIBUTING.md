# Contributing

## Product rules

Read [docs/build-prompt.md](docs/build-prompt.md) first. In short:

1. **Inform, don't rewire.** The tool never edits the user's application code. It only writes under `.iv/`.
2. **Deterministic first.** Every finding needs evidence: a file and line, or a captured request.
3. **One core, thin adapters.** Logic lives in `packages/core`. Adapters only install files.
4. **Runtime checks are opt-in.**

## Setup

```sh
npm install
npm test          # builds, then runs all tests
npm run iv -- --help
```

Requires Node 22 or newer.

## Fixtures

`fixtures/*/expected.json` lists every planted break and leak with its file and
line. If you edit a fixture, update `expected.json` too; `tests/fixtures.test.ts`
fails if a line number no longer matches.

## Licensing

- New files need the header:
  ```
  // Copyright 2026 The Integration Verifier Authors
  // SPDX-License-Identifier: Apache-2.0
  ```
- Before adding a dependency, record its license in `THIRD_PARTY_NOTICES.md`.
  GPL/AGPL, source-available, or use-restricted licenses need maintainer approval
  first. `npm run licenses` enforces this.
- By submitting a pull request you agree your contribution is licensed under
  Apache-2.0 (section 5 of the license). Sign off each commit (`git commit -s`) to
  certify the [Developer Certificate of Origin](https://developercertificate.org/).

## Pull requests

Work lands as stacked PRs (`pr/01-skeleton`, `pr/02-detect`, ...), each with
passing tests. See the roadmap in [README.md](README.md).
