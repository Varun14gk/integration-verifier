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

**What would be needed for a listing:** OpenAI partner allowlisting for a local MCP server, plus
a hook-free variant (skills and MCP tools only, losing the automatic gate). A listing also needs
a demo video, five positive and three negative test cases, and a verified developer
organisation. The manifest already has the listing fields (`interface` with icon, links,
category, capabilities and prompts within the length limits), checked by the same preflight test.

## Gemini CLI

Extensions install from a GitHub repository or a local path
(`gemini extensions install <repo>/adapters/gemini-cli`, or `iv install --gemini-cli`); there's
no review step. Note that Google replaced Gemini CLI with Antigravity CLI for unpaid and Google
One users on 2026-06-18.

## npm (optional, recommended next)

Publishing `integration-verifier` to npm would let users skip the clone-and-build step, and let
the plugins launch a pinned version (`npx integration-verifier@<version>`). That is a one-way public
step, so it needs the maintainers' decision.
