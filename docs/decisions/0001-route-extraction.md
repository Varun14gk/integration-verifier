# 0001: Route extraction: own tree-sitter extractors, not tieline

Date: 2026-11-04 · Status: accepted

## Context

The spec asks us to evaluate [`tieline`](https://github.com/nugehs/tieline) (MIT,
published as `@nugehs/tieline`) for route extraction and reuse it through its public
interface where it covers a stack well.

## What tieline does

- Static frontend↔backend check, joined on `(METHOD, normalised path)`.
- Results: matched, drift, unverifiable, dead.
- Client adapters: axios, rtk-query, Angular. Server adapters: Express, NestJS,
  Fastify, Next.js, FastAPI, Flask, Spring, OpenAPI.
- Zero dependencies, its own config file (`tieline.config.json`), a CLI and an MCP server.
- At evaluation time: a single maintainer, no stars, last push 2026-06-10.

## What we need that it does not cover

| Need (spec, Phase 1) | tieline |
|---|---|
| Method + path match | yes |
| Path, query param, request and response **field** comparison | no |
| Ranked suggestions with confidence and reason | partial ("did you mean") |
| Route → handler → data store / outbound API | no |
| Field data for Phase 2 (over-exposure, validation) | no |
| Django, ASP.NET Core, Go | no |

Reusing it would mean running a second tool with its own config for the one part we
need anyway (method + path), then parsing every file again for fields.

## Decision

Write our own extractors on tree-sitter, using `@vscode/tree-sitter-wasm` (MIT,
Microsoft): prebuilt WASM grammars for TypeScript, TSX, JavaScript, Python, Java, C#
and Go, so nothing is compiled on install.

No tieline source was copied. If it is reused later, its MIT notice must be kept and
it must be listed in `THIRD_PARTY_NOTICES.md`.
