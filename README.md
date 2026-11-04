# Integration Verifier

A plugin for AI coding harnesses (Claude Code, Codex, Gemini CLI) that checks whether an
application's frontend, backend and APIs are actually connected correctly, and that no
sensitive data leaks across those boundaries.

It **informs, it doesn't rewire**: it reports what is connected, what is not, and the likely
correct connection, with evidence and a confidence level. You decide what to change.

> Status: early development. See the roadmap for what is done.

## Quick start

```sh
npm install
npm run build
npm run iv -- --help
npm run iv -- config init --root path/to/your/app
npm run iv -- config validate --root path/to/your/app
```

## Commands

| Command | What it does | Status |
|---|---|---|
| `iv detect` | Identify languages, frameworks, HTTP clients, API style → `.iv/stack.json` | ✅ |
| `iv map` | Frontend call → route → handler graph, with fix suggestions → `.iv/map.json` | ✅ |
| `iv flow` | Trace request and response fields end to end | PR 4 |
| `iv check` | Leak, secret, outbound-host and validation checks | PR 4 |
| `iv runtime` | Opt-in: verify against the running app with Playwright | PR 5 |
| `iv report` | Markdown and SARIF reports | PR 4 |
| `iv install` | Install harness adapters | PR 7 |
| `iv config init \| validate` | Create or check `.iv/config.yaml` | ✅ |

Exit codes: `0` OK, `1` findings at or above the gate severity, `2` usage or config error,
`3` not implemented yet.

## Layout

```
packages/core      detection, mapping, data-flow and leak checks
packages/runtime   Playwright runtime verification
packages/cli       the `iv` command
packages/mcp       MCP server exposing the same commands
adapters/          Claude Code, Codex, Gemini CLI integration files
fixtures/          sample apps with planted breaks and leaks (test ground truth)
```

## Roadmap

1. Repo skeleton, CLI, config, fixtures
2. Phase 0: stack detection
3. Phase 1: integration map and suggestions
4. Phase 2: data flow and leak checks
5. Phase 3: Playwright runtime verification
6. MCP server
7. Claude Code adapter
8. Codex adapter
9. Gemini CLI adapter
10. Pre-commit hook and CI gate

## License

Apache-2.0. See [LICENSE](LICENSE), [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Maintainers: [@Varun14gk](https://github.com/Varun14gk), [@srijansahay](https://github.com/srijansahay)
