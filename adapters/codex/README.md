# Integration Verifier for Codex

A Codex plugin. Install with `iv install --codex` (add `--scope project` for one project).

That copies this folder to `~/.codex/plugins/integration-verifier` with **absolute launcher
paths** (hook commands run in whatever shell Codex uses, so no `$PLUGIN_ROOT` expansion is
relied on), lists it in the personal marketplace `~/.agents/plugins/marketplace.json`, enables
it in `config.toml` and adds a short pointer to `AGENTS.md`. Then restart Codex, install it from
`/plugins` if needed, and trust its hooks with `/hooks`.

| File | Does |
|---|---|
| `plugin.json` | Portable manifest ([Agent Plugins schema](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json)) |
| `.codex-plugin/plugin.json` | Codex fallback manifest pointing at `skills/`, `mcp.json` and `hooks/hooks.json` |
| `skills/*/SKILL.md` | The six shared skills |
| `agents/*.toml` | The three read-only custom agents. Codex plugins can't carry agents, so `iv install --codex` writes them to `~/.codex/agents/` (or `.codex/agents/` with `--scope project`) |
| `mcp.json` | The `integration-verifier` MCP server (stdio) |
| `hooks/hooks.json` | `PostToolUse` on `apply_patch\|Edit\|Write`: fast check of the patched files as `additionalContext`. `Stop`: the full gate (`decision: block`), once per distinct set of blocking findings |
| `scripts/iv-launch.mjs` | Copy of `adapters/shared/iv-launch.mjs` |

Codex reports file edits as `apply_patch`; `iv hook codex post-write` reads the file paths from
the patch text.
