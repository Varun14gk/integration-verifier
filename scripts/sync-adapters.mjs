#!/usr/bin/env node
// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

// Generates each adapter's skills, subagents and launcher from adapters/shared, in the
// format that harness expects:
//   skills/<name>/SKILL.md                 every harness (same Agent Skills format)
//   Claude Code  agents/<name>.md          Markdown + YAML, edit tools denied
//   Gemini CLI   agents/<name>.md          Markdown + YAML
//   Codex        agents/<name>.toml        TOML (iv install --codex writes them to ~/.codex/agents)
// and adapters/claude-code-directory: the Claude Code plugin's directory edition (skills and
// agents only; see scripts/directory-edition.mjs).
// Usage: node scripts/sync-adapters.mjs          write the files
//        node scripts/sync-adapters.mjs --check  exit 1 if any adapter is out of date

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { directoryAgentBody, directorySkill } from "./directory-edition.mjs";

const ROOT = join(import.meta.dirname, "..");
const SHARED = join(ROOT, "adapters", "shared");
const ADAPTERS = ["claude-code", "codex", "gemini-cli"];
/** The directory edition of the Claude Code plugin, submitted to Anthropic's directory. */
const CLAUDE_DIRECTORY = join("adapters", "claude-code-directory");
const check = process.argv.includes("--check");

/** Splits `---` frontmatter (name and description, one line each) from the body. */
export function parseAgent(text) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) throw new Error("agent file needs --- frontmatter ---");
  const meta = Object.fromEntries(m[1].split("\n").map((l) => /^(\w+):\s*(.*)$/.exec(l)).filter(Boolean).map((x) => [x[1], x[2]]));
  if (!meta.name || !meta.description) throw new Error("agent frontmatter needs name and description");
  return { name: meta.name, description: meta.description, body: m[2].trim() + "\n" };
}

const tomlString = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

function claudeAgent(a) {
  return `---\nname: ${a.name}\ndescription: ${a.description}\ndisallowedTools: Write, Edit, MultiEdit, NotebookEdit\nmodel: inherit\n---\n\n${a.body}`;
}

function geminiAgent(a) {
  return `---\nname: ${a.name}\ndescription: ${a.description}\nkind: local\n---\n\n${a.body}`;
}

function codexAgent(a) {
  if (a.body.includes("'''")) throw new Error(`${a.name}: body must not contain '''`);
  return `# Generated from adapters/shared/agents/${a.name}.md by scripts/sync-adapters.mjs\nname = ${tomlString(a.name)}\ndescription = ${tomlString(a.description)}\ndeveloper_instructions = '''\n${a.body}'''\n`;
}

/** The release version, from packages/core (the single source of truth). */
const VERSION = /export const VERSION = "([^"]+)"/.exec(readFileSync(join(ROOT, "packages", "core", "src", "version.ts"), "utf8"))[1];

/** Manifests whose "version" must equal the core version. */
const MANIFESTS = [
  join("adapters", "claude-code", ".claude-plugin", "plugin.json"),
  join("adapters", "codex", "plugin.json"),
  join("adapters", "codex", ".codex-plugin", "plugin.json"),
  join("adapters", "gemini-cli", "gemini-extension.json"),
];

/** Every file each adapter should contain, as path -> content. */
export function expectedFiles() {
  const files = new Map();
  for (const m of MANIFESTS) {
    const text = readFileSync(join(ROOT, m), "utf8");
    if (!/"version"\s*:\s*"/.test(text)) throw new Error(`${m} has no "version" field`);
    files.set(m, text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${VERSION}$2`));
  }
  // The launcher reports version skew between plugin and CLI, so it carries the version too.
  const launcherSrc = readFileSync(join(SHARED, "iv-launch.mjs"), "utf8");
  if (!/^const PLUGIN_VERSION = "[^"]*";$/m.test(launcherSrc)) throw new Error("iv-launch.mjs has no PLUGIN_VERSION line");
  const launcher = launcherSrc.replace(/^const PLUGIN_VERSION = "[^"]*";$/m, `const PLUGIN_VERSION = "${VERSION}";`);
  files.set(join("adapters", "shared", "iv-launch.mjs"), launcher);
  // Listing icon for the plugins that have one (Claude Code directory, Codex interface).
  const icon = readFileSync(join(SHARED, "assets", "icon.svg"), "utf8");
  files.set(join("adapters", "claude-code", "assets", "icon.svg"), icon);
  files.set(join("adapters", "codex", "assets", "icon.svg"), icon);
  // The same "what this plugin runs, writes and sends" section in every plugin README.
  const disclosure = readFileSync(join(SHARED, "DISCLOSURE.md"), "utf8").trim();
  for (const adapter of ADAPTERS) {
    const readme = join("adapters", adapter, "README.md");
    const text = readFileSync(join(ROOT, readme), "utf8");
    const m = /<!-- disclosure:start -->[\s\S]*?<!-- disclosure:end -->/.exec(text);
    if (!m) throw new Error(`${readme} has no disclosure markers`);
    // A function replacement, so `$` in the text is never treated as a pattern.
    files.set(readme, text.replace(m[0], () => `<!-- disclosure:start -->\n${disclosure}\n<!-- disclosure:end -->`));
  }
  const skills = readdirSync(join(SHARED, "skills"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const agents = readdirSync(join(SHARED, "agents")).filter((f) => f.endsWith(".md")).sort().map((f) => parseAgent(readFileSync(join(SHARED, "agents", f), "utf8")));
  for (const adapter of ADAPTERS) {
    const base = join("adapters", adapter);
    files.set(join(base, "scripts", "iv-launch.mjs"), launcher);
    for (const s of skills) files.set(join(base, "skills", s, "SKILL.md"), readFileSync(join(SHARED, "skills", s, "SKILL.md"), "utf8"));
    for (const a of agents) {
      if (adapter === "claude-code") files.set(join(base, "agents", `${a.name}.md`), claudeAgent(a));
      if (adapter === "gemini-cli") files.set(join(base, "agents", `${a.name}.md`), geminiAgent(a));
      if (adapter === "codex") files.set(join(base, "agents", `${a.name}.toml`), codexAgent(a));
    }
  }
  for (const [path, content] of claudeDirectoryFiles(files, skills, agents)) files.set(path, content);
  return files;
}

/**
 * The Claude Code directory edition, generated whole: the plugin's manifest and listing
 * fields, the skills and agents with the edition note, the icon and a README. No hooks, no
 * MCP server, no scripts, which the directory refuses from unverified publishers.
 */
function claudeDirectoryFiles(files, skills, agents) {
  const out = new Map();
  const manifest = JSON.parse(files.get(join("adapters", "claude-code", ".claude-plugin", "plugin.json")));
  manifest.description =
    "Checks that your frontend, backend and APIs are actually connected, and that no sensitive data leaks across them. " +
    "Skills and read-only agents that run the Integration Verifier CLI (npm install -g integration-verifier); reports with evidence and never rewires your code.";
  out.set(join(CLAUDE_DIRECTORY, ".claude-plugin", "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
  out.set(join(CLAUDE_DIRECTORY, "assets", "icon.svg"), files.get(join("adapters", "claude-code", "assets", "icon.svg")));
  for (const s of skills) out.set(join(CLAUDE_DIRECTORY, "skills", s, "SKILL.md"), directorySkill(readFileSync(join(SHARED, "skills", s, "SKILL.md"), "utf8")));
  for (const a of agents) out.set(join(CLAUDE_DIRECTORY, "agents", `${a.name}.md`), claudeAgent({ ...a, body: directoryAgentBody(a.body) }));
  out.set(join(CLAUDE_DIRECTORY, "README.md"), `<!-- Generated by scripts/sync-adapters.mjs. Edit adapters/shared and the script instead. -->

# Integration Verifier for Claude Code (directory edition)

Integration Verifier checks whether an application's frontend, backend and APIs are actually
connected correctly, and that no sensitive data leaks across those boundaries. It reports what is
connected, what isn't, and the likely correct connection, with evidence and a confidence level.
It never rewires your code: you decide what to change.

This edition contains **skills and read-only agents only**. They tell Claude to run the
Integration Verifier CLI, which you install once:

\`\`\`sh
npm install -g integration-verifier
\`\`\`

| Path | What it is |
|---|---|
| \`skills/\` | ${skills.length} skills, each loaded only when the task matches: ${skills.map((s) => `\`${s}\``).join(", ")} |
| \`agents/\` | ${agents.length} read-only subagents (file edits denied): ${agents.map((a) => `\`${a.name}\``).join(", ")} |
| \`assets/icon.svg\` | the listing icon |

The full plugin, with a fast check after every file Claude writes and a gate before Claude
finishes, is installed from the repository: \`iv install --claude-code\`, or
\`/plugin marketplace add Varun14gk/integration-verifier\`. See
https://github.com/Varun14gk/integration-verifier.

## What this plugin runs, writes and sends

- **Runs:** nothing by itself. It has no hooks, no MCP server and no scripts. The skills ask
  Claude to run \`iv\` commands (\`iv detect\`, \`iv map\`, \`iv check\`, ...) in your
  terminal, through Claude's normal Bash tool and its permission prompts. \`iv\` may start
  \`git\` and, if you installed one, Semgrep or Opengrep. \`iv runtime\` starts your app and a
  local browser only after you approve each step.
- **Writes:** \`iv\` writes its results to \`.iv/\` in your project. Nothing else.
- **Sends:** nothing. Everything runs on your machine; there is no telemetry.
- **Privacy:** https://github.com/Varun14gk/integration-verifier/blob/main/PRIVACY.md

License: Apache-2.0.
`);
  return out;
}

/** Generated files present in an adapter that no longer come from the shared source. */
function staleFiles(expected) {
  const stale = [];
  const dirs = [...ADAPTERS.flatMap((a) => ["skills", "agents"].map((sub) => join("adapters", a, sub))), CLAUDE_DIRECTORY];
  {
    for (const rel of dirs) {
      const dir = join(ROOT, rel);
      if (!existsSync(dir)) continue;
      const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const full = join(d, e.name);
          if (e.isDirectory()) walk(full);
          else if (!expected.has(full.slice(ROOT.length + 1))) stale.push(full.slice(ROOT.length + 1));
        }
      };
      walk(dir);
    }
  }
  return stale;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/").replace(/^(?=[A-Za-z]:)/, "/")}` || process.argv[1]?.endsWith("sync-adapters.mjs")) {
  const expected = expectedFiles();
  const differing = [...expected].filter(([p, c]) => !existsSync(join(ROOT, p)) || readFileSync(join(ROOT, p), "utf8") !== c).map(([p]) => p);
  const stale = staleFiles(expected);
  if (check) {
    if (differing.length || stale.length) {
      console.error("Adapters are out of date with adapters/shared. Run: node scripts/sync-adapters.mjs");
      for (const p of differing) console.error(`  differs: ${p}`);
      for (const p of stale) console.error(`  stale:   ${p}`);
      process.exit(1);
    }
    console.log(`${expected.size} adapter files match adapters/shared.`);
  } else {
    for (const p of differing) {
      mkdirSync(dirname(join(ROOT, p)), { recursive: true });
      writeFileSync(join(ROOT, p), expected.get(p), "utf8");
    }
    for (const p of stale) rmSync(join(ROOT, p));
    console.log(`Wrote ${differing.length} file(s), removed ${stale.length} stale file(s).`);
  }
}
