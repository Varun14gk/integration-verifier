---
name: integration-verifier
description: Overview of the Integration Verifier tools (iv_detect, iv_map, iv_flow, iv_check, iv_report, iv_runtime_plan, iv_runtime, iv_dismiss) and the rules for using them. Use when the user mentions Integration Verifier or asks to check how a frontend and backend fit together, and before using any iv_* tool for the first time in a session.
---

# Integration Verifier

The `integration-verifier` MCP server checks how this project's frontends and backends fit
together and whether sensitive data leaks between them. It **reports**; it never changes
application code. You decide what to change, and the user decides anything that needs their
judgment.

## Tools

| Tool | Use it to |
|---|---|
| `iv_detect` | See the stack: apps, frameworks, HTTP clients, base URLs, proxies, rewrites, data stores |
| `iv_map` | Find frontend calls that don't reach a backend route, or reach it with the wrong method, params or fields. Each comes with ranked suggestions and a confidence |
| `iv_flow` | Follow fields from form input to backend model to data store, and back to the UI |
| `iv_check` | Run everything, including the leak checks. Pass `files` for a quick check of what you just changed |
| `iv_report` | Write `.iv/report.md` and `.iv/report.sarif` |
| `iv_runtime_plan` / `iv_runtime` | Optional: start the app and drive it with Playwright to confirm findings |
| `iv_dismiss` | Record a finding the **user** accepted, with their reason |

## Rules

1. Pass the project directory as `root` to every tool, unless the server was started for it.
2. Every finding has evidence (file:line, a captured request, or an observation) and a
   confidence. Don't report problems the tool did not find. If you disagree with a finding,
   say so and why; don't silently ignore it.
3. Suggestions are starting points, not orders. Read the evidence first and fix the side that
   is actually wrong, the way the codebase already does things.
4. Runtime checks start processes and a browser: show the plan to the user and run only the
   steps they approve (see the `runtime-verification` skill).
5. Never dismiss a finding on your own (see the `triage-findings` skill).

## Related skills

`verify-integration`, `audit-data-leaks`, `runtime-verification`, `triage-findings`,
`setup-integration-verifier`.
