# Distribution: plugin directories

Status as of 2026-11-20, checked against each directory's published rules. Re-check them
before submitting; they change.

## Claude Code: Anthropic's plugin directory

**Ready to submit, expect a manual review.**

| Rule | Status |
|---|---|
| `claude plugin validate --strict` on the plugin and the marketplace | ✅ passes (Claude Code 2.1.289) |
| Name `integration-verifier`: lowercase-hyphen, ≤ 64, not a reserved word | ✅ |
| README ≥ 40 words, describing everything the plugin runs, writes and sends | ✅ (`What this plugin runs, writes and sends`) |
| License (`plugin.json` `license: Apache-2.0`) | ✅ |
| Text/SVG files only, each < 256 KiB, ≤ 512 files, no symlinks, portable names | ✅ |
| Hook and MCP commands start a file in the plugin with `${CLAUDE_PLUGIN_ROOT}`, no other variables | ✅ (PR 17 removed `${CLAUDE_PROJECT_DIR}` from `.mcp.json`) |
| Skills and agents have YAML frontmatter with a text `description` | ✅ |
| Listing fields: `icon`, `documentationUrl`, `supportUrl`, `privacyPolicyUrl`, `termsOfServiceUrl` | ✅ |
| Readable source (no minified code) | ✅ |

`tests/adapters/directory-preflight.test.ts` checks all of the above on every PR.

**Verified install from GitHub** (2026-11-20, isolated Claude Code config): `claude plugin
marketplace add Varun14gk/integration-verifier` and `claude plugin install
integration-verifier@integration-verifier` install and enable v0.1.0, with 6 skills, 3 agents,
4 hooks (SessionStart, PreToolUse, PostToolUse, Stop) and the MCP server. About 970 tokens are
added to each session; skills and agents cost more only when used.

**Expected hold:** the plugin's launcher starts the Integration Verifier CLI, which users install
separately from this repository. The rules don't forbid that, but scripts that start other
programs are held for a reviewer. The README discloses it. To remove the hold later, publish
the CLI to npm and launch a pinned version, or bundle the engine into the plugin. Bundling is
blocked today by the directory's 256 KiB-per-file and binary-file limits, because the engine
ships WebAssembly grammars.

**How to submit**
1. The repository must be public on github.com (it is).
2. On a paid claude.ai plan, connect GitHub, then go to https://claude.ai/directory/manage →
   **Submit new** → **Plugin bundle**.
3. Source: `Varun14gk/integration-verifier`, plugin path `adapters/claude-code`, branch `main`.
   **Validate**, then fix anything marked *Blocks*.
4. Data handling: it reads the user's project locally, sends nothing, keeps nothing beyond
   `.iv/` in the project, and is not aimed at people under 18.
5. Add a contact email, accept the acknowledgements, and submit.

## Codex: OpenAI's public plugin directory

**Not eligible as designed. Distribute it by manual install instead (`iv install --codex`).**

The published rules exclude it on two counts:

1. *"Plugins containing lifecycle hooks aren't eligible for the public plugin directory."*
   The hooks are how the gate protects `.iv/` and blocks finishing, which is the core of the product.
2. Local (stdio) MCP servers, and plugins that call local programs, are *"limited to approved
   partners"* and appear as *Desktop only*. Integration Verifier has to read your local code, so
   it can't be a remote HTTPS service.

**What can be submitted: the directory edition.** `npm run package:codex` builds
`dist/integration-verifier-codex-directory-<version>.zip` (it's also attached to each GitHub
release):

- skills only: **no hooks and no MCP server**, so the portal's hook check passes;
- each skill starts with a note mapping the tools to `iv` CLI commands, because there's no MCP server;
- the manifest keeps the listing fields and sets `extensions.com.openai.requires_local_executor: true`,
  because the skills run a local program.

It has **no automatic gate**: the agent runs `iv check` itself. OpenAI says local-execution
plugins can be rejected unless the organisation has that access, so this may still need OpenAI's
approval. `tests/adapters/codex-directory.test.ts` checks the package on every PR.

**How to submit the directory edition**
1. platform.openai.com → organisation settings: complete individual or business **verification**.
   An organisation owner (or a member with "Apps Management Write") submits.
2. platform.openai.com/plugins → **Upload new or existing plugin** → choose the verified developer
   identity → upload the ZIP.
3. Fix anything the automated checks flag under *Metadata & Skills*, rebuild the ZIP and re-upload.
   Wait for the required skill scans to finish.
4. Fill in the review information, submit with the policy attestations, and publish when approved.
   Rejections arrive by email; reply to appeal.
5. If the portal refuses local execution, ask OpenAI about partner access for local plugins. Your
   organisation ID is in the platform settings.

**The full Codex plugin** (hooks + MCP: the automatic gate) remains manual install:
`iv install --codex`.

## Gemini CLI

Extensions install from a GitHub repository or a local path
(`gemini extensions install <repo>/adapters/gemini-cli`, or `iv install --gemini-cli`); there's
no review step. Note that Google replaced Gemini CLI with Antigravity CLI for unpaid and Google
One users on 2026-06-18.

## npm

Four packages, published together at the same version: `integration-verifier` (the `iv` CLI;
it ships the harness adapters, so `iv install` works from an npm install) and the internal
`@integration-verifier/core`, `@integration-verifier/runtime` and `@integration-verifier/mcp`.
`npm run smoke:npm` (also a CI job) packs them, installs the tarballs into an empty project and
runs the installed CLI, checks, installer dry runs, a hook and the MCP server.

**Publish a version** (maintainers):
1. Once: an npmjs.com account with two-factor authentication, and a free npm organisation
   named `integration-verifier` (npmjs.com → Add Organization). The `@integration-verifier/*`
   names can only be published by that organisation's members.
2. `npm login`
3. From a clean `main` at the release tag: `npm ci && npm run build && npm run smoke:npm`
4. `npm publish --workspaces` (add `--otp <code>` if npm asks). It publishes core, runtime, mcp
   and then the CLI. A published version can't be replaced, only deprecated, so bump the version
   for any fix.
5. Check: `npm view integration-verifier version` and `npx integration-verifier@<version> --version`.
