// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { createServer } from "@integration-verifier/mcp";
import { installCodex } from "../../packages/cli/src/install.js";

const ROOT = join(import.meta.dirname, "..", "..");
const SHARED = join(ROOT, "adapters", "shared");
const skills = readdirSync(join(SHARED, "skills"));
const agents = readdirSync(join(SHARED, "agents")).map((f) => f.replace(/\.md$/, ""));

function frontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) throw new Error("no frontmatter");
  return parse(m[1]!) as Record<string, string>;
}

async function toolNames(): Promise<Set<string>> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(ROOT).connect(a);
  const c = new Client({ name: "t", version: "0" });
  await c.connect(b);
  const names = new Set((await c.listTools()).tools.map((t) => t.name));
  await c.close();
  return names;
}

describe("shared skills and agents", () => {
  it("every adapter is in sync with adapters/shared", () => {
    expect(execFileSync(process.execPath, [join(ROOT, "scripts", "sync-adapters.mjs"), "--check"], { encoding: "utf8" })).toContain("match adapters/shared");
  });

  it("ships the planned skills and subagents", () => {
    expect(skills.sort()).toEqual(["audit-data-leaks", "integration-verifier", "runtime-verification", "setup-integration-verifier", "triage-findings", "verify-integration"]);
    expect(agents.sort()).toEqual(["fix-verifier", "integration-reviewer", "leak-auditor"]);
  });

  it.each(skills)("skill %s has valid frontmatter and a 'Use when' description", (s) => {
    const fm = frontmatter(readFileSync(join(SHARED, "skills", s, "SKILL.md"), "utf8"));
    expect(fm.name).toBe(s);
    expect(fm.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(fm.description!.length).toBeLessThanOrEqual(1024);
    expect(fm.description).toMatch(/Use (when|after|before|proactively)/);
  });

  it("skills and agents only mention tools the MCP server has, and skills that exist", async () => {
    const tools = await toolNames();
    const files = [...skills.map((s) => join(SHARED, "skills", s, "SKILL.md")), ...agents.map((a) => join(SHARED, "agents", `${a}.md`))];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const t of new Set(text.match(/\biv_[a-z_]+/g) ?? [])) expect(tools.has(t), `${f} mentions ${t}`).toBe(true);
      for (const ref of new Set([...text.matchAll(/`([a-z]+(?:-[a-z]+)+)` skill/g)].map((m) => m[1]!))) expect(skills, `${f} refers to skill ${ref}`).toContain(ref);
    }
  });

  it.each(agents)("agent %s is read-only in every harness's format", (a) => {
    const claude = frontmatter(readFileSync(join(ROOT, "adapters", "claude-code", "agents", `${a}.md`), "utf8"));
    expect(claude).toMatchObject({ name: a, disallowedTools: "Write, Edit, MultiEdit, NotebookEdit" });
    const gemini = frontmatter(readFileSync(join(ROOT, "adapters", "gemini-cli", "agents", `${a}.md`), "utf8"));
    expect(gemini).toMatchObject({ name: a, kind: "local" });
    const codex = readFileSync(join(ROOT, "adapters", "codex", "agents", `${a}.toml`), "utf8");
    expect(codex).toMatch(new RegExp(`^name = "${a}"$`, "m"));
    expect(codex).toMatch(/^description = ".+"$/m);
    expect(codex).toMatch(/^developer_instructions = '''\n[\s\S]+'''\n$/m);
    expect(readFileSync(join(SHARED, "agents", `${a}.md`), "utf8")).toMatch(/do not edit\s+any file/);
  });

  it("iv install --codex puts the agents where Codex reads them, not in the plugin", () => {
    const home = mkdtempSync(join(tmpdir(), "iv-agents-"));
    installCodex({ home });
    for (const a of agents) expect(existsSync(join(home, ".codex", "agents", `${a}.toml`))).toBe(true);
    expect(existsSync(join(home, ".codex", "plugins", "integration-verifier", "agents"))).toBe(false);
    for (const s of skills) expect(existsSync(join(home, ".codex", "plugins", "integration-verifier", "skills", s, "SKILL.md"))).toBe(true);
  });
});
