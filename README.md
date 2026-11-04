# Integration Verifier

A plugin for AI coding harnesses (Claude Code, Codex, Gemini CLI) that checks whether an
application's frontend, backend and APIs are actually connected correctly, and that no
sensitive data leaks across those boundaries.

It **informs, it doesn't rewire**: it reports what is connected, what is not, and the likely
correct connection, with evidence and a confidence level. You decide what to change.

> Status: pre-release 0.1.0. Everything on the roadmap is implemented; it is not yet published
> to npm or the agents' public plugin directories, so you install it from this repository.

## Installation

Installing has two parts: **(1)** set up the `iv` CLI once on your machine, and **(2)** connect
it to the coding agent(s) you use. Each agent gets the same things: a skill that tells the agent
how to use the tool, the MCP tools, a fast check after every file the agent writes, and the full
gate before the agent finishes.

### Prerequisites

- **Node.js 22 or newer** and **git**
- **Optional, recommended:** a pattern engine for five of the leak checks (logs, browser storage,
  error responses, cookies, hardcoded secrets):
  `pip install semgrep` (Semgrep CE), or [Opengrep](https://github.com/opengrep/opengrep#installation).
  Without one, those checks are skipped and reported as skipped.
- **Optional:** for `iv runtime`, a browser once: `npx playwright install chromium`

### Step 1: Set up the CLI (once per machine)

```sh
git clone https://github.com/Varun14gk/integration-verifier
cd integration-verifier
npm ci
npm run build
node packages/cli/dist/index.js --version     # prints 0.1.0
```

Keep this folder: the agents run the CLI from here. In the commands below, `iv` means
`node <path-to>/integration-verifier/packages/cli/dist/index.js`. To type `iv` directly, run
`npm link` in `packages/cli`.

To set up every agent found on this machine (`~/.claude`, `~/.codex`, `~/.gemini`) at once:

```sh
iv install --all --dry-run    # shows every file it would create or change
iv install --all
```

Or use the agent-specific steps below. `iv install` backs up every file it changes once
(`<file>.iv-backup`) and is safe to run again.

### Step 2a: Claude Code

**Option A: from the CLI** (uses your local copy)

```sh
iv install --claude-code                 # for your user
iv install --claude-code --scope project --root path/to/project   # only for one project
```

This registers the repository as a plugin marketplace in `~/.claude/settings.json` (or
`<project>/.claude/settings.json`) and enables the `integration-verifier` plugin.

**Option B: from inside Claude Code** (downloads from GitHub). Do Step 1 first anyway, because the
plugin needs the CLI.

```
/plugin marketplace add Varun14gk/integration-verifier
/plugin install integration-verifier@integration-verifier
```

**Then:** restart Claude Code. **Check it works:**
- `/plugin` lists **integration-verifier** as enabled.
- `/mcp` shows the **integration-verifier** server, with tools such as `iv_check` and `iv_map`.
- Ask: *"Use integration-verifier to check this project's frontend–backend integration."*

### Step 2b: Codex

```sh
iv install --codex                       # for your user
iv install --codex --scope project --root path/to/project   # config.toml and AGENTS.md in the project
```

This copies the plugin to `~/.codex/plugins/integration-verifier`, adds it to your personal
marketplace (`~/.agents/plugins/marketplace.json`), enables it in `config.toml`, and adds a short
Integration Verifier section to `AGENTS.md`.

**Then:**
1. Restart Codex (CLI or desktop app).
2. Open `/plugins`. If **integration-verifier** isn't active yet, install it from the
   **personal** marketplace.
3. Run `/hooks` and **trust** the integration-verifier hooks. Codex doesn't run plugin hooks you
   haven't reviewed.

**Check it works:** `/mcp` lists **integration-verifier**. Then ask Codex to run `iv_check` on the
project.

### Step 2c: Gemini CLI

```sh
iv install --gemini-cli
```

This copies the extension to `~/.gemini/extensions/integration-verifier`. You can also install it
with Gemini's own command: `gemini extensions install <path-to>/integration-verifier/adapters/gemini-cli`.
Gemini extensions are installed per user, not per project.

**Then:** restart Gemini CLI. **Check it works:**
- `gemini extensions list` shows **integration-verifier**.
- `/mcp` inside Gemini CLI lists the **integration-verifier** server and its tools.

### Step 3: Set up each project (optional)

Everything works with defaults. To change them, create a config in the project you want to check:

```sh
cd path/to/your/app
iv config init        # writes .iv/config.yaml with comments
iv check              # first full run: prints findings, writes .iv/check.json
iv report             # .iv/report.md and .iv/report.sarif
```

In `.iv/config.yaml` you can set `outbound.allowlist` (hosts your backend may call), extra
sensitive field names, the gate severity (`gate.failOn`, default `high`) and, for `iv runtime`,
how to start the app. Commit `.iv/config.yaml`; the other files in `.iv/` are generated.

### What happens while you work

- **After each file the agent writes:** a quick check of that file, without Semgrep, in about a
  second. Findings go back to the agent as information; nothing is blocked or changed.
- **When the agent tries to finish:** the full gate runs. If findings at or above `gate.failOn` are
  open, the agent is asked to fix them, or to ask **you** whether to accept them. It's asked once
  per set of findings, so it can't loop.
- **Accepting a finding** is your decision: `iv dismiss <finding-id> --reason "why"`, or tell the
  agent to dismiss it with your reason. The reason is recorded in `.iv/config.yaml`.
- **Runtime checks** (`iv runtime`) start your app and a browser, so the agent must show you the
  steps and get your approval first.

### Uninstall

| Agent | Remove |
|---|---|
| Claude Code | `/plugin uninstall integration-verifier@integration-verifier` and `/plugin marketplace remove integration-verifier`, or restore `~/.claude/settings.json.iv-backup` |
| Codex | Delete `~/.codex/plugins/integration-verifier`, its entry in `~/.agents/plugins/marketplace.json`, the `[plugins."integration-verifier@personal"]` section in `config.toml`, and the block between `<!-- integration-verifier:start -->` and `<!-- integration-verifier:end -->` in `AGENTS.md` |
| Gemini CLI | `gemini extensions uninstall integration-verifier`, or delete `~/.gemini/extensions/integration-verifier` |
| All | Delete `~/.integration-verifier/` |

### Troubleshooting

- **"Integration Verifier CLI not found"** in agent output: Step 1 wasn't run on this machine, or
  the clone was moved. Run `iv install --all` again from the clone; it updates
  `~/.integration-verifier/cli.json`.
- **Leak checks listed as "skipped":** no pattern engine was found. `pip install semgrep`, then
  open a new terminal. If it still isn't found, set `scanner.command` in `.iv/config.yaml` to the
  full path of the `semgrep` executable.
- **The gate blocks on something you accept:** dismiss it with a reason (see above), or raise
  `gate.failOn` to `critical`.
- **Codex hooks don't run:** trust them with `/hooks`.

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
| `iv install` | Connect Claude Code, Codex, Gemini CLI, a git hook or GitHub Actions | ✅ |
| `iv hook <harness> <event>` | Used by the agent hooks (reads the hook's JSON from stdin) | ✅ |
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
