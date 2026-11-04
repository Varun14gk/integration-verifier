# Integration Verifier

A plugin for AI coding harnesses (Claude Code, Codex, Gemini CLI) that checks whether an
application's frontend, backend and APIs are actually connected correctly, and that no
sensitive data leaks across those boundaries.

It **informs, it doesn't rewire**: it reports what is connected, what is not, and the likely
correct connection, with evidence and a confidence level. You decide what to change.

> Status: all ten roadmap items are implemented; pre-release (0.1.0), not yet published to npm or the harness marketplaces.

## Quick start

```sh
npm install
npm run build
npm run iv -- --help
npm run iv -- config init --root path/to/your/app
npm run iv -- config validate --root path/to/your/app
```

## Install into your coding agent

```sh
git clone https://github.com/Varun14gk/integration-verifier && cd integration-verifier
npm ci && npm run build
node packages/cli/dist/index.js install --all      # or --claude-code / --codex / --gemini-cli; --dry-run first if you like
```

`iv install` records where the CLI lives (`~/.integration-verifier/cli.json`) and writes each
harness's own files, backing up any file it changes (`*.iv-backup`).

- **Claude Code**: registers this repo as a plugin marketplace and enables the
  `integration-verifier` plugin. You can also add it from inside Claude Code with
  `/plugin marketplace add Varun14gk/integration-verifier` and
  `/plugin install integration-verifier@integration-verifier` (the CLI must still be installed as
  above). The plugin adds a skill, the MCP tools, a fast check after every file write and the full
  gate before Claude finishes.
- **Codex**: installs the plugin into `~/.codex/plugins/integration-verifier`, lists it in the
  personal marketplace, enables it in `config.toml` and adds a pointer to `AGENTS.md`. Restart
  Codex and trust the hooks with `/hooks`.
- **Gemini CLI**: copies the extension to `~/.gemini/extensions/integration-verifier` (MCP server,
  `GEMINI.md` context, skill, `AfterTool` fast check and `AfterAgent` gate).

## Without a coding agent: git hook and CI

The same gate runs outside harnesses:

```sh
iv install --git-hook --root path/to/project      # pre-commit: iv check --staged
iv install --github-action --root path/to/project  # .github/workflows/integration-verifier.yml
```

- **Pre-commit** blocks the commit while findings at or above `gate.failOn` are open in staged
  files (`git commit --no-verify` skips it once). It never replaces a hook it didn't write. With
  the [pre-commit framework](https://pre-commit.com), use the `integration-verifier` hook from
  `.pre-commit-hooks.yaml`.
- **GitHub Actions**: `uses: Varun14gk/integration-verifier@main` (inputs `root`, `engine`,
  `fail-on-findings`, `sarif`). The generated workflow uploads SARIF to code scanning and writes
  the Markdown report to the job summary.

## Pattern engine (for leak checks)

Five checks (sensitive values in logs, browser storage and error responses; insecure
cookies; hardcoded secrets) run our own rules (`packages/core/rules/iv-rules.yaml`) on a
pattern engine **installed on your machine**. Install one:

```sh
pip install semgrep          # Semgrep CE, LGPL-2.1
# or Opengrep: https://github.com/opengrep/opengrep#installation
```

Without an engine those checks are skipped and listed as skipped; everything else still runs.
Set `scanner.engine` / `scanner.command` in `.iv/config.yaml` to pick one explicitly.

## Runtime verification (opt-in)

`iv runtime` needs the app running, so it **asks before every step** (start backend, start
frontend, open the browser, submit forms, run Schemathesis). `--plan` only lists the steps;
`--yes` approves them all and is meant for agents that have already asked the user.

```yaml
# .iv/config.yaml
runtime:
  backend:  { command: "uvicorn app.main:app --port 8000", cwd: backend, url: "http://localhost:8000/docs" }
  frontend: { command: "npm run dev", cwd: frontend, url: "http://localhost:5173" }
  testData: .iv/testdata.yaml          # form values; sensitive ones are watched for leaks
  # playwrightTests: { cwd: frontend } # use your Playwright tests instead of a crawl
  # openapi: backend/openapi.json      # for --schemathesis
```

```yaml
# .iv/testdata.yaml
fields: { email: tester@example.com, password: "Test-Only-Pa55!" }
submitForms: true   # off by default
maxPages: 20
```

It drives your Playwright tests (with tracing) when a `playwright.config.*` exists, otherwise
it crawls same-origin pages and fills forms. It then reports requests to unmapped routes,
failed calls, responses that lack declared fields, and test values that show up in the
console, Web Storage, cookies, URLs, other responses or **the server's own log output**.
Needs a browser once: `npx playwright install chromium`. Schemathesis (`pip install
schemathesis`) is optional.

## MCP server

`iv mcp` (or `node packages/mcp/dist/index.js`) serves the same commands as MCP tools over
stdio: `iv_detect`, `iv_map`, `iv_flow`, `iv_check`, `iv_report`, `iv_runtime_plan`,
`iv_runtime` and `iv_dismiss`. `iv_runtime` only runs the steps passed in `approvedSteps`, so
an agent has to show the plan to the user first. `iv_dismiss` records the user's reason in
`.iv/config.yaml`. No tool edits application code.

## Commands

| Command | What it does | Status |
|---|---|---|
| `iv detect` | Identify languages, frameworks, HTTP clients, API style → `.iv/stack.json` | ✅ |
| `iv map` | Frontend call → route → handler graph, with fix suggestions → `.iv/map.json` | ✅ |
| `iv flow` | Trace request and response fields end to end → `.iv/flow.json` | ✅ |
| `iv check` | Map + leak, secret, outbound-host, validation and logging checks; applies the gate → `.iv/check.json` | ✅ |
| `iv runtime` | Opt-in: start the app, drive it with Playwright, compare real traffic with the map → `.iv/runtime.json` | ✅ |
| `iv report` | Markdown and SARIF reports from the last check (and runtime run) | ✅ |
| `iv install` | Install harness adapters | PR 7 |
| `iv config init \| validate` | Create or check `.iv/config.yaml` | ✅ |
| `iv dismiss <id> --reason …` | Accept a finding, with the reason recorded in config | ✅ |
| `iv mcp` | Serve the tools over MCP (stdio) | ✅ |

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
