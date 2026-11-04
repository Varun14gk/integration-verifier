#!/usr/bin/env node
// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

// Generates each adapter's skills, subagents and launcher from adapters/shared, in the
// format that harness expects:
//   skills/<name>/SKILL.md                 every harness (same Agent Skills format)
//   Claude Code  agents/<name>.md          Markdown + YAML, edit tools denied
//   Gemini CLI   agents/<name>.md          Markdown + YAML
//   Codex        agents/<name>.toml        TOML (iv install --codex writes them to ~/.codex/agents)
// Usage: node scripts/sync-adapters.mjs          write the files
//        node scripts/sync-adapters.mjs --check  exit 1 if any adapter is out of date

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SHARED = join(ROOT, "adapters", "shared");
const ADAPTERS = ["claude-code", "codex", "gemini-cli"];
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

/** Every file each adapter should contain, as path -> content. */
export function expectedFiles() {
  const files = new Map();
  const launcher = readFileSync(join(SHARED, "iv-launch.mjs"), "utf8");
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
  return files;
}

/** Generated files present in an adapter that no longer come from the shared source. */
function staleFiles(expected) {
  const stale = [];
  for (const adapter of ADAPTERS) {
    for (const sub of ["skills", "agents"]) {
      const dir = join(ROOT, "adapters", adapter, sub);
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
