# Integration Verifier for Claude Code

A Claude Code plugin. Install with `iv install --claude-code`, or inside Claude Code:

```
/plugin marketplace add Varun14gk/integration-verifier
/plugin install integration-verifier@integration-verifier
```

The `iv` CLI must be installed (see the main README); `scripts/iv-launch.mjs` finds it.

| File | Does |
|---|---|
| `.claude-plugin/plugin.json` | Manifest |
| `skills/*/SKILL.md` | Six skills, loaded when the task matches: `integration-verifier` (overview and rules), `verify-integration`, `audit-data-leaks`, `runtime-verification`, `triage-findings`, `setup-integration-verifier` |
| `agents/*.md` | Three read-only subagents: `integration-reviewer`, `leak-auditor`, `fix-verifier` (file-editing tools denied) |
| `.mcp.json` | The `integration-verifier` MCP server (`iv mcp`) for the project directory |
| `hooks/hooks.json` | `SessionStart`: checks the CLI is installed and the same version. `PreToolUse` on Write/Edit/MultiEdit/NotebookEdit/Bash: refuses edits to `.iv/`. `PostToolUse` on Write/Edit/MultiEdit/NotebookEdit: fast check of the written file, fed back as context. `Stop`: the full gate; fails closed and blocks while findings at or above `gate.failOn` are open, up to `gate.maxStopBlocks` times |
| `scripts/iv-launch.mjs` | Copy of `adapters/shared/iv-launch.mjs` |

All logic is in the CLI (`iv hook claude-code <session-start|pre-write|post-write|stop>`); this folder only wires it in.

<!-- disclosure:start -->
## What this plugin runs, writes and sends

Everything runs **on your machine**. There is no server, no account and no telemetry
([privacy policy](https://github.com/Varun14gk/integration-verifier/blob/main/PRIVACY.md)).

- **Runs:** `scripts/iv-launch.mjs` (readable source, in this folder) starts the Integration
  Verifier CLI that you installed (`npm install -g integration-verifier`; source at
  https://github.com/Varun14gk/integration-verifier). It finds
  it through `~/.integration-verifier/cli.json`, written by `iv install`, or `iv` on your PATH.
  The plugin does not download or install anything itself. If the CLI is missing, the session
  starts with a message saying how to install it, and the checks report that they couldn't run.
- **The CLI may start:** `git` (to read the committed `.iv/config.yaml` and staged files), and
  Semgrep CE or Opengrep if you installed one (run with metrics off). Only with your approval for
  each step, `iv runtime` starts your app's own commands, a local headless browser and,
  optionally, Schemathesis.
- **Reads:** the project's source, configuration and API schema files.
- **Writes:** only `.iv/` in the project (results, reports, gate state, an audit log). It never
  edits application code. Its hooks *refuse* agent edits to `.iv/`, so the gate's rules stay
  yours.
- **Sends:** nothing over the network. Findings go to the agent in your session as tool output.
- **Hooks:** at session start (setup check), before a write (protects `.iv/`), after a write
  (quick check of that file), and when the agent finishes (the gate). Every hook only reports
  or blocks; none changes your files.
<!-- disclosure:end -->
