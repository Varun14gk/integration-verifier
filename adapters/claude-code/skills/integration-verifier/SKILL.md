---
name: integration-verifier
description: Check that a web app's frontend, backend and APIs are connected correctly and that no sensitive data leaks across them. Use when building or changing API calls, routes, request/response models, auth, logging or config; when a frontend call returns 404/405 or wrong data; before finishing work that touches both sides; or when the user asks to verify integration, API contracts or data leaks.
---

# Integration Verifier

The `integration-verifier` MCP server checks how this project's frontend and backend fit
together. It **reports**; it never changes application code. You decide what to change, and the
user decides anything that needs their judgment.

## Tools

| Tool | Use it to |
|---|---|
| `iv_detect` | See the stack: apps, frameworks, HTTP clients, base URLs, proxies, rewrites |
| `iv_map` | Find frontend calls that don't reach a backend route, or reach it with the wrong method, params or fields. Each comes with ranked suggestions and a confidence |
| `iv_flow` | Follow fields from form input to backend model to data store, and back to the UI |
| `iv_check` | Run everything, including leak checks: sensitive fields returned but unused, sensitive values in logs/URLs/browser storage/error responses, insecure cookies, hardcoded secrets, unknown outbound hosts, routes without validation or logging. Pass `files` for a quick check of what you just changed |
| `iv_report` | Write `.iv/report.md` and `.iv/report.sarif` |
| `iv_runtime_plan` / `iv_runtime` | Optional: start the app and drive it with Playwright to confirm what static analysis found |
| `iv_dismiss` | Record a finding the **user** accepted, with their reason |

## How to work with it

1. After changing API calls, routes or models, run `iv_check` (with `files` for speed) and fix
   real problems the way the codebase would. A suggestion is a starting point, not an order:
   check the evidence (file:line) first, and prefer fixing the side that is wrong.
2. Every finding has evidence and a confidence. Don't report problems the tool did not find,
   and say so when you disagree with a finding instead of silently ignoring it.
3. **Runtime checks start processes and a browser.** Call `iv_runtime_plan`, show the user the
   steps, ask which they allow, and pass only those ids in `approvedSteps`.
4. **Never dismiss a finding on your own.** If you think one is acceptable, explain why and ask
   the user. Only when they agree, call `iv_dismiss` with their reason.
5. Before you finish, a hook runs the full gate. If it blocks, fix the listed findings or ask the
   user about them as in step 4.

Configuration lives in `.iv/config.yaml` (sensitive field names, outbound allowlist, gate
severity, runtime commands); `iv config init` creates it.
