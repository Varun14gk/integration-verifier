# Distribution: plugin directories

Status as of 2026-11-20, checked against each directory's published rules. Re-check them
before submitting; they change.

## Claude Code: Anthropic's plugin directory

**Submit the directory edition: `adapters/claude-code-directory`.**

The directory's validator (run on `main` @ f51b7a4, 2026-11-21) refused the full plugin
(`adapters/claude-code`) with three blocking findings. All three apply because the publishing
organisation isn't *Verified*:

1. command hooks (of any type) are accepted only from Verified organisations;
2. MCP servers that run on the user's computer are accepted only from Verified organisations;
3. scripts, programs and other restricted files (our `scripts/iv-launch.mjs`) likewise.

So, as for Codex, there are two editions:

| | Full plugin `adapters/claude-code` | Directory edition `adapters/claude-code-directory` |
|---|---|---|
| Skills (6) and read-only agents (3) | ✅ | ✅, with a note mapping the tools to `iv` CLI commands |
| MCP tools | ✅ | ❌, Claude runs `iv` through its Bash tool instead |
| Fast check after each write, `.iv/` protection, gate before finishing | ✅ (hooks) | ❌, the skills tell Claude to run `iv check` itself |
| Installed by | `iv install --claude-code` or `/plugin marketplace add Varun14gk/integration-verifier` | the plugin directory |

`scripts/sync-adapters.mjs` generates the directory edition from `adapters/shared`, so the two
never drift. `tests/adapters/directory-preflight.test.ts` checks that it has no hooks, MCP
server, scripts or inline shell, and only Markdown, JSON and the listing icon;
`claude plugin validate --strict adapters/claude-code-directory` passes.

The validator's other notes, for the record:
- **held for review:** the name "integration-verifier" is close to the existing "certifier"
  connector. Nothing to change; a reviewer looks at it.
- warnings only: it couldn't inspect the full plugin's hook commands, which don't exist in the
  directory edition; the `icon` field is read by the directory only; and one manifest field it
  doesn't recognise (all our extra fields are listing fields: `displayName`, `icon`,
  `documentationUrl`, `supportUrl`, `privacyPolicyUrl`, `termsOfServiceUrl`).

**To list the full plugin later:** get the organisation Verified. A Verified organisation can
ship hooks and a local MCP server whose commands are plain shell scripts at literal
`${CLAUDE_PLUGIN_ROOT}` paths, with no package launcher (npx and the like), no package installs
and no variables other than `CLAUDE_PLUGIN_ROOT`. The current hooks run `node`, so that
submission would need small shell wrappers, and it can still be held for review.

**Other rules, all met:** lowercase-hyphen name of at most 64 characters, a README of at least
40 words disclosing what the plugin runs, writes and sends, a license, text files under
256 KiB, YAML frontmatter on skills and agents, https listing URLs.

**How to submit**
1. On a paid claude.ai plan, connect GitHub, then go to https://claude.ai/directory/manage →
   **Submit new** → **Plugin bundle**.
2. Source: `Varun14gk/integration-verifier`, plugin path **`adapters/claude-code-directory`**,
   branch `main`. **Validate**, then fix anything marked *Blocks*.
3. Data handling: it reads the user's project locally, sends nothing, keeps nothing beyond
   `.iv/` in the project, and is not aimed at people under 18.
4. Add a contact email, accept the acknowledgements, and submit.

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
