// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

// Encodes the plugin-directory rules we checked before submitting (Anthropic's plugin
// directory checklist and OpenAI's plugin submission page, read on 2026-11-20), so a later
// change can't quietly break a submission. Each rule names the check it mirrors.

import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const CLAUDE = join(ROOT, "adapters", "claude-code");
const CODEX = join(ROOT, "adapters", "codex");
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

/** Words in Markdown outside code blocks (the directory doesn't count code). */
function proseWords(md: string): number {
  return md.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ").split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length;
}

/** Every command string a hook or MCP server would run, as text. */
function commandsOf(dir: string): string[] {
  const out: string[] = [];
  const hooks = json(join(dir, "hooks", "hooks.json")).hooks as Record<string, { hooks: { command: string; args?: string[] }[] }[]>;
  for (const groups of Object.values(hooks)) for (const g of groups) for (const h of g.hooks) out.push([h.command, ...(h.args ?? [])].join(" "));
  return out;
}

describe("Claude Code plugin directory rules", () => {
  const files = walk(CLAUDE);

  it("name: lowercase-hyphen, at most 64 characters, not a reserved word", () => {
    const { name } = json(join(CLAUDE, ".claude-plugin", "plugin.json"));
    expect(name).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
    expect(["claude", "anthropic", "official", "plugin", "mcp", "test"]).not.toContain(name);
  });

  it("has description, author, version and a license", () => {
    const m = json(join(CLAUDE, ".claude-plugin", "plugin.json"));
    expect(m.description).toBeTruthy();
    expect(m.author?.name).toBeTruthy();
    expect(m.version).toBeTruthy();
    expect(m.license).toBe("Apache-2.0");
  });

  it("README has at least 40 words of prose and discloses what the plugin runs", () => {
    const readme = readFileSync(join(CLAUDE, "README.md"), "utf8");
    expect(proseWords(readme)).toBeGreaterThanOrEqual(40);
    expect(readme).toContain("What this plugin runs, writes and sends");
  });

  it("files: text or SVG only, each under 256 KiB, at most 512, no symlinks, portable names", () => {
    expect(files.length).toBeLessThanOrEqual(512);
    for (const f of files) {
      const rel = relative(CLAUDE, f);
      expect(lstatSync(f).isSymbolicLink(), rel).toBe(false);
      expect(statSync(f).size, rel).toBeLessThan(256 * 1024);
      expect(rel, rel).toMatch(/\.(md|json|mjs|svg)$/);
      for (const part of rel.split(/[\\/]/)) {
        expect(part, rel).toMatch(/^[A-Za-z0-9._-]+$/);
        expect(part, rel).not.toMatch(/[. ]$/);
      }
      expect(rel).not.toMatch(/(^|[\\/])(\.DS_Store|Thumbs\.db|desktop\.ini|__MACOSX)$/);
    }
  });

  it("hook and MCP commands use only ${CLAUDE_PLUGIN_ROOT} paths, no other variables, no '..'", () => {
    const mcp = json(join(CLAUDE, ".mcp.json")).mcpServers as Record<string, { command: string; args: string[] }>;
    const commands = [...commandsOf(CLAUDE), ...Object.values(mcp).map((s) => [s.command, ...s.args].join(" "))];
    expect(commands.length).toBeGreaterThan(0);
    for (const c of commands) {
      expect(c, c).toMatch(/^node \$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/iv-launch\.mjs /);
      expect(c.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, ""), c).not.toMatch(/\$\{|\$\(|`|\.\.|\*/);
    }
  });

  it("every skill and agent has YAML frontmatter with a text description", () => {
    for (const f of files.filter((x) => x.endsWith(".md") && /[\\/](skills|agents)[\\/]/.test(x))) {
      const m = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(f, "utf8").replace(/\r\n/g, "\n"));
      expect(m, f).not.toBeNull();
      expect(typeof (parse(m![1]!) as { description?: unknown }).description, f).toBe("string");
    }
  });

  it("does not list hooks/hooks.json in plugin.json (it loads automatically)", () => {
    expect(json(join(CLAUDE, ".claude-plugin", "plugin.json")).hooks).toBeUndefined();
  });

  it("the listing icon exists and every listing URL is https", () => {
    const m = json(join(CLAUDE, ".claude-plugin", "plugin.json"));
    expect(statSync(join(CLAUDE, m.icon)).isFile()).toBe(true);
    for (const k of ["documentationUrl", "supportUrl", "privacyPolicyUrl", "termsOfServiceUrl"]) expect(m[k], k).toMatch(/^https:\/\//);
  });
});

// What Anthropic's directory validator refused from an unverified organisation (2026-11-21):
// command hooks of any type, local MCP servers, and scripts or other restricted files. The
// directory edition must stay inside that.
describe("Claude Code directory edition (adapters/claude-code-directory)", () => {
  const DIR = join(ROOT, "adapters", "claude-code-directory");
  const files = walk(DIR).map((f) => relative(DIR, f).split("\\").join("/"));
  const m = json(join(DIR, ".claude-plugin", "plugin.json"));

  it("has no hooks, no MCP server and no scripts", () => {
    expect(files.filter((f) => /^(hooks|scripts|bin|commands|monitors)\//.test(f) || /(^|\/)\.?mcp\.json$/.test(f) || f === "settings.json")).toEqual([]);
    for (const k of ["hooks", "mcpServers", "commands", "monitors", "settings", "lspServers", "outputStyles"]) expect(m[k], k).toBeUndefined();
  });

  it("contains only Markdown, JSON and the listing icon", () => {
    for (const f of files) expect(f, f).toMatch(/\.(md|json)$|^assets\/icon\.svg$/);
    expect(m.icon).toBe("./assets/icon.svg");
  });

  it("no skill or agent uses inline shell (!`command`)", () => {
    for (const f of files.filter((x) => x.endsWith(".md"))) expect(readFileSync(join(DIR, f), "utf8"), f).not.toMatch(/!`/);
  });

  it("has every skill and agent, each telling the agent to use the iv CLI", () => {
    expect(files.filter((f) => f.endsWith("SKILL.md"))).toHaveLength(readdirSync(join(ROOT, "adapters", "shared", "skills")).length);
    expect(files.filter((f) => f.startsWith("agents/"))).toHaveLength(readdirSync(join(ROOT, "adapters", "shared", "agents")).length);
    for (const f of files.filter((x) => /^(skills|agents)\//.test(x))) {
      const text = readFileSync(join(DIR, f), "utf8");
      expect(text, f).toContain("**Directory edition.**");
      expect(text, f).toContain("npm install -g integration-verifier");
    }
  });

  it("same name, version and listing fields as the full plugin; README discloses what it runs", () => {
    const full = json(join(CLAUDE, ".claude-plugin", "plugin.json"));
    for (const k of ["name", "version", "license", "author", "homepage", "documentationUrl", "supportUrl", "privacyPolicyUrl", "termsOfServiceUrl"]) expect(m[k], k).toEqual(full[k]);
    const readme = readFileSync(join(DIR, "README.md"), "utf8");
    expect(proseWords(readme)).toBeGreaterThanOrEqual(40);
    expect(readme).toContain("What this plugin runs, writes and sends");
  });
});

describe("Codex plugin manifest rules", () => {
  const m = json(join(CODEX, ".codex-plugin", "plugin.json"));
  const i = m.interface;

  it("required fields and length limits", () => {
    expect(m.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(m.name.length).toBeLessThanOrEqual(64);
    expect(m.version).toBeTruthy();
    expect(m.author?.name).toBeTruthy();
    expect(m.description.length).toBeLessThanOrEqual(4000);
    expect(i.displayName.length).toBeLessThanOrEqual(30);
    expect(i.shortDescription.length).toBeLessThanOrEqual(30);
    expect(i.longDescription.length).toBeLessThanOrEqual(4000);
    expect(i.developerName.length).toBeLessThanOrEqual(80);
    expect(Array.isArray(i.capabilities)).toBe(true);
    expect(i.defaultPrompt.length).toBeLessThanOrEqual(3);
    for (const p of i.defaultPrompt) expect(p.length).toBeLessThanOrEqual(128);
  });

  it("icons exist at ./ paths inside the plugin, and links are https", () => {
    for (const k of ["logo", "composerIcon"]) {
      expect(i[k], k).toMatch(/^\.\//);
      expect(statSync(join(CODEX, i[k])).isFile(), k).toBe(true);
    }
    for (const k of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) expect(i[k], k).toMatch(/^https:\/\/.{1,1016}$/);
  });

  it("brand colour has at least 2:1 contrast against white", () => {
    const [r, g, b] = (i.brandColor.match(/[0-9a-f]{2}/gi) as string[]).map((h) => parseInt(h, 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    const lum = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    expect((1 + 0.05) / (lum + 0.05)).toBeGreaterThanOrEqual(2);
  });
});
