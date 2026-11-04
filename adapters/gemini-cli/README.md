# Integration Verifier for Gemini CLI

A Gemini CLI extension. Install with `iv install --gemini-cli` (copies this folder to
`~/.gemini/extensions/integration-verifier`), or `gemini extensions install
<repo>/adapters/gemini-cli`. The `iv` CLI must be installed; `scripts/iv-launch.mjs` finds it.

| File | Does |
|---|---|
| `gemini-extension.json` | Manifest: the `integration-verifier` MCP server for `${workspacePath}`, and `GEMINI.md` as context |
| `GEMINI.md` | Short instruction pointer loaded as context |
| `skills/integration-verifier/SKILL.md` | Same skill as the other adapters |
| `hooks/hooks.json` | `AfterTool` on `write_file\|replace`: fast check, returned as `additionalContext`. `AfterAgent`: the full gate; `decision: "deny"` sends the findings back as a new prompt, once per distinct set of blocking findings |
| `scripts/iv-launch.mjs` | Copy of `adapters/shared/iv-launch.mjs` |

Paths use `${extensionPath}` and `${/}`, which Gemini CLI expands, so the copy works on every OS
without rewriting. Timeouts are in milliseconds, as Gemini CLI expects.

Note: Google says Gemini CLI was replaced by Antigravity CLI on 18 June 2026 for unpaid and
Google One users; this adapter targets Gemini CLI as documented at geminicli.com.
