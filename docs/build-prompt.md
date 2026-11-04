# Build prompt: Integration Verifier plugin (for Claude Code)

Paste everything below the line into Claude Code, run from the root of a new, empty repository.

---

You are building **Integration Verifier**, a plugin for AI coding harnesses (Claude Code, Codex, Gemini CLI first, others later). It checks that an application's frontend, backend and APIs are actually connected correctly and that no data leaks across those boundaries. Cloud and deployment are out of scope.

## Product rules (do not break these)

1. **Inform, don't rewire.** The plugin never changes the user's application code on its own. It reports what is connected, what is not, and what the likely correct connection is, with evidence and a confidence level. The coder (human or agent) decides.
2. **Deterministic first.** Every finding must come from code analysis or an observed runtime event, with a file and line or a captured request as evidence. Agent reasoning may explain or rank findings, never invent them.
3. **One core, thin adapters.** All logic lives in one engine exposed as a CLI and an MCP server. Harness adapters only install skills, instruction pointers and hooks.
4. **Ask before every step that needs a running app.** Static checks run anywhere; runtime checks with Playwright are opt-in.

## Language and layout

Write the core in TypeScript (Node LTS): Playwright, tree-sitter bindings and the MCP SDK are all first-class there. Use a monorepo:

- `packages/core` — detection, mapping, data-flow and leak checks
- `packages/runtime` — Playwright-based runtime verification
- `packages/cli` — `iv detect | map | flow | check | runtime | report | install`
- `packages/mcp` — MCP server exposing the same commands as tools
- `adapters/claude-code`, `adapters/codex`, `adapters/gemini-cli` — plugin/extension manifests, skills, hooks, instruction pointers
- `fixtures/` — small sample apps with deliberately broken integrations, used as tests

## Phase 0 — Detect the stack (`iv detect`)

Before any checking, identify what the project is made of and write `.iv/stack.json`:

- Languages and package managers per folder (handle monorepos and separate frontend/backend repos).
- Frontend framework and HTTP client: React, Next.js, Angular, Vue, Svelte; fetch, axios, RTK Query, React Query, Angular HttpClient, generated OpenAPI clients, GraphQL clients.
- Backend framework: FastAPI, Flask, Django/DRF, Express, NestJS, Spring Boot, ASP.NET Core, Go (gin, echo, net/http).
- API style: REST, OpenAPI present or not, GraphQL, gRPC, tRPC, WebSocket/SSE.
- Schema sources: OpenAPI files, Pydantic models, DTOs, TypeScript types, Zod schemas.
- Base URLs, proxies and env variables that join the two sides (e.g. `VITE_API_URL`, Next.js rewrites, dev proxy config).
- Data stores and outbound APIs the backend calls.

Print a short human summary and list anything detected with low confidence. Unsupported stacks are reported as unsupported, never guessed.

## Phase 1 — Integration map (`iv map`)

Build `.iv/map.json`, a graph of: frontend call site → (method, normalized path) → backend route → handler → data store or outbound API.

Classify every edge:

- **connected** — method, path, params and body/response shape all match
- **not connected** — frontend calls a route the backend does not expose
- **mismatched** — route exists but method, path params, query params, request fields or response fields differ (report each field)
- **unverifiable** — URL built dynamically; show the expression
- **orphan** — backend route no frontend calls

For every **not connected** or **mismatched** edge, suggest the most likely intended target, ranked by path similarity, method, and request/response field overlap, with a confidence score and the reason. Present it as a suggestion only.

Evaluate the existing open-source tool `tieline` (MIT) for route extraction; reuse it via its public interface if it covers a stack well, otherwise write extractors with tree-sitter. Do not copy its source without keeping its license notice.

## Phase 2 — Data flow and leaks (`iv flow`, `iv check`)

Trace fields, not just routes:

- Request: form/input field → API body → backend model/param → store or outbound call.
- Response: store → model → response → which fields the UI actually uses.

Classify fields as sensitive using names, types and annotations (passwords, tokens, keys, emails, phone, national IDs, payment data), configurable in `.iv/config.yaml`.

Report:

- Sensitive fields returned but never used by the UI (over-exposure).
- Sensitive values in logs, URLs/query strings, client storage (localStorage, sessionStorage, cookies without secure flags), or error messages.
- Hardcoded secrets.
- Outbound calls to hosts not on the project's allowlist.
- Routes with no input validation (no schema/model/validator on the request).
- Routes without logging or tracing, and logs that include sensitive fields.

For pattern and secret scanning, call an engine installed on the user's machine (Opengrep or Semgrep CE) with **our own rule files**. Do not bundle or redistribute Semgrep-maintained registry rules (Semgrep Rules License v1.0 restricts them to internal use) or AGPL-licensed rule sets. Make the engine pluggable.

## Phase 3 — Runtime verification with Playwright (`iv runtime`, opt-in)

When the user confirms the app can be started locally:

- Start frontend and backend from commands in `.iv/config.yaml`.
- Drive the main user flows (from existing Playwright tests if present, otherwise a crawl of reachable pages and forms using test data the user supplies).
- Capture all network traffic. Compare observed requests with `map.json`: confirm connected edges, flag requests that hit unmapped routes, failed calls (4xx/5xx), and responses that violate the schema.
- Check captured responses, console output and browser storage for sensitive values.
- Optionally run Schemathesis against the backend when an OpenAPI schema exists.

Use Playwright as a dependency under its Apache-2.0 license. Keep its license and NOTICE text in our `THIRD_PARTY_NOTICES.md`.

## Output

Every command writes JSON, plus `iv report` producing Markdown for humans and SARIF for code-scanning tools. Each finding has: id, category, severity, evidence (file:line or captured request), explanation, suggested fix, confidence.

## Enforcement and adapters

- Fast checks (map + leak rules on changed files) run on post-write hooks; the full gate runs on the Stop hook and blocks finishing while high-severity findings are open, unless the user dismisses them with a recorded reason.
- `iv install --all` detects installed harnesses and writes each one's files. Tier 1: Claude Code plugin, Codex plugin, Gemini CLI extension. Read each harness's current official docs for manifest, skills, hooks and MCP formats before writing its adapter; these change often. Add one test per adapter.
- Ship a git pre-commit hook and a GitHub Actions workflow that run the same gate, so harnesses without hooks are still covered.

## Licensing and ownership

- Add our own LICENSE (owner to be confirmed by me before the first release) and copyright headers on our files only.
- Create `THIRD_PARTY_NOTICES.md` listing every dependency and reused tool with its license.
- Before adding any dependency, record its license and stop to ask me if it is GPL/AGPL, source-available, or has use restrictions.

## Delivery

Work as stacked pull requests, each with tests passing against the fixtures:

1. Repo skeleton, CLI, config, fixtures (React + FastAPI, Angular + Spring Boot, Next.js + Express, each with planted breaks and leaks)
2. Phase 0 detection
3. Phase 1 map and suggestions
4. Phase 2 data flow and leak checks
5. Phase 3 Playwright runtime
6. MCP server
7. Claude Code adapter
8. Codex adapter
9. Gemini CLI adapter
10. Pre-commit hook and CI workflow

Before writing code, show me a short plan for PR 1 and the list of dependencies with licenses, then wait for my approval.
