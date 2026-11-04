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
| `hooks/hooks.json` | `PostToolUse` on Write/Edit/MultiEdit: fast check of the written file, fed back as context. `Stop`: the full gate; blocks while findings at or above `gate.failOn` are open, once per distinct set of findings |
| `scripts/iv-launch.mjs` | Copy of `adapters/shared/iv-launch.mjs` |

All logic is in the CLI (`iv hook claude-code <post-write|stop>`); this folder only wires it in.
