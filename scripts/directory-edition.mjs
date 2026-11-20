// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

// The "directory edition" of a plugin: what the public plugin directories accept from an
// organisation that isn't verified. Both Anthropic's and OpenAI's directories refuse command
// hooks, local (stdio) MCP servers and bundled scripts from such publishers, so this edition is
// skills and agents only. They tell the agent to run the `iv` CLI (installed from npm) instead
// of calling the MCP tools, and there is no automatic gate: the agent runs `iv check` itself.
//
// Used by scripts/sync-adapters.mjs (adapters/claude-code-directory) and
// scripts/package-codex-directory.mjs (the Codex ZIP).

/** How each MCP tool is used from the CLI in this edition. */
export const TOOL_TO_CLI = [
  ["iv_detect", "iv detect --root <project>", ""],
  ["iv_map", "iv map --root <project>", ""],
  ["iv_flow", "iv flow --root <project>", ""],
  ["iv_check", "iv check --root <project>", "add --files <changed files> for a quick check"],
  ["iv_report", "iv report --root <project>", ""],
  ["iv_runtime_plan", "iv runtime --root <project> --plan", ""],
  ["iv_runtime", "iv runtime --root <project> --yes", "only after the user approved every listed step"],
  ["iv_dismiss", "iv dismiss <finding-id> --reason \"<the user's reason>\" --root <project>", ""],
];

export const EDITION_NOTE = `> **Directory edition.** In this edition the Integration Verifier tools are commands of the
> \`iv\` CLI, which the user installs with \`npm install -g integration-verifier\`. Run them
> in the project's terminal; read the output and the files they write under \`.iv/\`. If \`iv\` is not
> installed, tell the user how to install it (https://github.com/Varun14gk/integration-verifier) instead of guessing results.
>
> | Tool named below | Command |
> |---|---|
${TOOL_TO_CLI.map(([t, c, note]) => `> | \`${t}\` | \`${c}\`${note ? ` (${note})` : ""} |`).join("\n")}
>
> There is no automatic gate in this edition: run \`iv check\` yourself after changing API
> calls, routes or models, and before finishing.
`;

/** Puts the edition note right after a skill's frontmatter. */
export function directorySkill(text) {
  const m = /^(---\n[\s\S]*?\n---\n)([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) throw new Error("skill without frontmatter");
  return `${m[1]}\n${EDITION_NOTE}\n${m[2].replace(/^\n+/, "")}`;
}

/** An agent's instructions with the edition note in front. */
export function directoryAgentBody(body) {
  return `${EDITION_NOTE}\n${body}`;
}
