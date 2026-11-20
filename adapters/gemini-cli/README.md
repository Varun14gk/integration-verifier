# Integration Verifier for Gemini CLI

A Gemini CLI extension. Install with `iv install --gemini-cli` (copies this folder to
`~/.gemini/extensions/integration-verifier`), or `gemini extensions install
<repo>/adapters/gemini-cli`. The `iv` CLI must be installed; `scripts/iv-launch.mjs` finds it.

| File | Does |
|---|---|
| `gemini-extension.json` | Manifest: the `integration-verifier` MCP server for `${workspacePath}`, and `GEMINI.md` as context |
| `GEMINI.md` | Short instruction pointer loaded as context |
| `skills/*/SKILL.md` | The six shared skills |
| `agents/*.md` | The three read-only subagents (Gemini CLI subagents are a preview feature) |
| `hooks/hooks.json` | `SessionStart`: checks the CLI is installed and the same version. `AfterTool` on `write_file\|replace`: fast check, returned as `additionalContext`. `AfterAgent`: the full gate; `decision: "deny"` sends the findings back as a new prompt, up to `gate.maxStopBlocks` times. `BeforeTool`: refuses edits to `.iv/` |
| `scripts/iv-launch.mjs` | Copy of `adapters/shared/iv-launch.mjs` |

Paths use `${extensionPath}` and `${/}`, which Gemini CLI expands, so the copy works on every OS
without rewriting. Timeouts are in milliseconds, as Gemini CLI expects.

Note: Google says Gemini CLI was replaced by Antigravity CLI on 18 June 2026 for unpaid and
Google One users; this adapter targets Gemini CLI as documented at geminicli.com.

<!-- disclosure:start -->
## What this plugin runs, writes and sends

Everything runs **on your machine**. There is no server, no account and no telemetry
([privacy policy](https://github.com/Varun14gk/integration-verifier/blob/main/PRIVACY.md)).

- **Runs:** `scripts/iv-launch.mjs` (readable source, in this folder) starts the Integration
  Verifier CLI that you installed from https://github.com/Varun14gk/integration-verifier. It finds
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
