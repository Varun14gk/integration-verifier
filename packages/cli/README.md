# Integration Verifier (`iv`)

Checks whether an application's frontend, backend and APIs are actually connected correctly,
and that no sensitive data leaks across those boundaries. It works as a CLI, in CI, and as a
plugin for AI coding agents (Claude Code, Codex, Gemini CLI).

It **informs, it doesn't rewire**: it reports what is connected, what isn't, and the likely
correct connection, with evidence and a confidence level. You decide what to change.

## Install

Requires Node.js 22 or newer.

```sh
npm install -g integration-verifier
iv --version
iv doctor            # checks the setup and says what is missing
```

Optional:
- a pattern engine for five of the leak checks (logs, browser storage, error responses,
  cookies, hardcoded secrets): `pip install semgrep` or [Opengrep](https://github.com/opengrep/opengrep#installation).
  Without one, those checks are skipped and reported as skipped.
- for `iv runtime`, a browser once: `npx playwright install chromium`

## Use it

```sh
iv detect    # which frontends, backends and API specs are in the project
iv map       # every frontend call matched to a backend route (or not)
iv flow      # how data moves from routes to responses, logs and storage
iv check     # the full check; exit code 1 when there are findings
iv report    # a Markdown report of the last check
iv check --staged   # only what you're about to commit
```

Results are written to `.iv/` in the project. Exit codes: 0 OK, 1 findings, 2 usage or
configuration error, 4 internal error.

## Connect it to your coding agent

```sh
iv install --all --dry-run   # shows every file it would create or change
iv install --all             # every agent found on this machine
iv install --claude-code     # or one at a time: --codex, --gemini-cli
iv install --git-hook        # pre-commit gate
iv install --github-action   # CI workflow with SARIF upload
```

Each agent gets skills, read-only subagents, the MCP tools, a quick check after each file the
agent writes, and a gate before it finishes. In Claude Code you can also install the plugin from
inside the app; it uses this CLI:

```
/plugin marketplace add Varun14gk/integration-verifier
/plugin install integration-verifier@integration-verifier
```

## Privacy

Everything runs locally. It reads your project, writes only to `.iv/` (and, when you run
`iv install`, the agent configuration it lists first), and sends nothing anywhere.
`iv runtime` drives a local browser only after you approve each step.

## More

Supported stacks, every check, configuration and the full install guide:
https://github.com/Varun14gk/integration-verifier

License: Apache-2.0.
