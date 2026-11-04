// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "@integration-verifier/core";
import type { Harness } from "./hooks.js";

/** Repository root of this installation (packages/cli/dist -> repo). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** The CLI entry point that adapters launch. */
export const CLI_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "index.js");

export interface InstallOptions {
  /** Home directory to install into (tests pass a temp dir). */
  home?: string;
  /** user: harness-wide; project: only for `projectDir`. */
  scope?: "user" | "project";
  projectDir?: string;
  dryRun?: boolean;
}

export interface FileChange {
  path: string;
  action: "create" | "update" | "unchanged";
  note?: string;
}

export interface InstallResult {
  harness: Harness | "launcher";
  changes: FileChange[];
  nextSteps: string[];
}

function homeOf(opts: InstallOptions): string {
  return opts.home ?? process.env.IV_HOME ?? homedir();
}

/** Writes `content` to `path` unless identical; backs up an existing file once. */
function writeFile(path: string, content: string, opts: InstallOptions, changes: FileChange[], note?: string): void {
  const exists = existsSync(path);
  const same = exists && readFileSync(path, "utf8") === content;
  changes.push({ path, action: same ? "unchanged" : exists ? "update" : "create", ...(note ? { note } : {}) });
  if (same || opts.dryRun) return;
  mkdirSync(dirname(path), { recursive: true });
  if (exists && !existsSync(`${path}.iv-backup`)) copyFileSync(path, `${path}.iv-backup`);
  writeFileSync(path, content, "utf8");
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8").trim();
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object; not changing it`);
  return parsed as Record<string, unknown>;
}

/** Records where the CLI lives, so every adapter's launcher can find it. */
export function installLauncher(opts: InstallOptions): InstallResult {
  const changes: FileChange[] = [];
  const path = join(homeOf(opts), ".integration-verifier", "cli.json");
  const content = JSON.stringify({ node: process.execPath, cli: CLI_ENTRY, root: REPO_ROOT, version: VERSION }, null, 2) + "\n";
  writeFile(path, content, opts, changes, "tells the adapters where the iv CLI is");
  return { harness: "launcher", changes, nextSteps: [] };
}

export const MARKETPLACE = "integration-verifier";
export const PLUGIN = "integration-verifier";

/** Claude Code: registers this repo as a local marketplace and enables the plugin. */
export function installClaudeCode(opts: InstallOptions): InstallResult {
  const changes: FileChange[] = [];
  const settingsPath = opts.scope === "project"
    ? join(resolve(opts.projectDir ?? "."), ".claude", "settings.json")
    : join(homeOf(opts), ".claude", "settings.json");
  const settings = readJson(settingsPath);
  const markets = (settings.extraKnownMarketplaces as Record<string, unknown> | undefined) ?? {};
  const enabled = (settings.enabledPlugins as Record<string, unknown> | undefined) ?? {};
  const next = {
    ...settings,
    extraKnownMarketplaces: { ...markets, [MARKETPLACE]: { source: { source: "directory", path: REPO_ROOT } } },
    enabledPlugins: { ...enabled, [`${PLUGIN}@${MARKETPLACE}`]: true },
  };
  writeFile(settingsPath, JSON.stringify(next, null, 2) + "\n", opts, changes, "adds the integration-verifier marketplace and enables the plugin");
  return {
    harness: "claude-code",
    changes,
    nextSteps: [
      "Restart Claude Code (or run /plugin) so it loads the integration-verifier plugin.",
      "From GitHub instead: /plugin marketplace add Varun14gk/integration-verifier, then /plugin install integration-verifier@integration-verifier",
    ],
  };
}

const POINTER_START = "<!-- integration-verifier:start -->";
const POINTER_END = "<!-- integration-verifier:end -->";

/** Short instruction pointer for a harness's context file (AGENTS.md, GEMINI.md). */
export const INSTRUCTION_POINTER = `${POINTER_START}
## Integration Verifier

This project is checked by Integration Verifier (MCP server \`integration-verifier\`, skill
\`integration-verifier\`). After changing API calls, routes or request/response models, run
\`iv_check\` with the project directory as \`root\` (add \`files\` for a quick check). It reports;
you decide what to change. Ask the user before any \`iv_runtime\` step, and never dismiss a
finding unless the user gives a reason.
${POINTER_END}
`;

/** Adds or replaces our marked block in a Markdown file, leaving the rest untouched. */
function upsertBlock(path: string, block: string, opts: InstallOptions, changes: FileChange[], note: string): void {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const start = current.indexOf(POINTER_START);
  const end = current.indexOf(POINTER_END);
  const next = start >= 0 && end > start
    ? current.slice(0, start) + block.trimEnd() + current.slice(end + POINTER_END.length)
    : current + (current && !current.endsWith("\n\n") ? (current.endsWith("\n") ? "\n" : "\n\n") : "") + block;
  writeFile(path, next, opts, changes, note);
}

/** Copies an adapter folder, rewriting text files with `transform`. */
function copyAdapter(from: string, to: string, transform: (rel: string, text: string) => string, opts: InstallOptions, changes: FileChange[]): void {
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else writeFile(join(to, r), transform(r, readFileSync(join(dir, e.name), "utf8")), opts, changes);
    }
  };
  walk(from, "");
}

const fwd = (p: string) => p.replace(/\\/g, "/");

/**
 * Codex: copies the plugin to ~/.codex/plugins/integration-verifier with absolute
 * launcher paths (hook commands run in whatever shell Codex uses, so no env-var
 * expansion is relied on), lists it in the personal marketplace, enables it in
 * config.toml and adds the AGENTS.md pointer.
 */
export function installCodex(opts: InstallOptions): InstallResult {
  const changes: FileChange[] = [];
  const home = homeOf(opts);
  const pluginDir = join(home, ".codex", "plugins", PLUGIN);
  const launcher = fwd(join(pluginDir, "scripts", "iv-launch.mjs"));
  copyAdapter(join(REPO_ROOT, "adapters", "codex"), pluginDir, (rel, text) => {
    if (rel === "hooks/hooks.json") return text.split("$PLUGIN_ROOT/scripts/iv-launch.mjs").join(launcher);
    if (rel === "mcp.json") {
      const j = JSON.parse(text) as { mcpServers: Record<string, { args: string[] }> };
      const s = j.mcpServers[PLUGIN]!;
      s.args = [launcher, "mcp", ...(opts.scope === "project" ? ["--root", fwd(resolve(opts.projectDir ?? "."))] : [])];
      return JSON.stringify(j, null, 2) + "\n";
    }
    return text;
  }, opts, changes);

  const marketPath = join(home, ".agents", "plugins", "marketplace.json");
  const market = readJson(marketPath) as { name?: string; interface?: unknown; plugins?: { name: string }[] };
  const name = market.name ?? "personal";
  const entry = { name: PLUGIN, source: { source: "local", path: `./.codex/plugins/${PLUGIN}` }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Coding" };
  const plugins = (market.plugins ?? []).filter((p) => p.name !== PLUGIN);
  writeFile(marketPath, JSON.stringify({ name, interface: market.interface ?? { displayName: "Personal plugins" }, ...market, plugins: [...plugins, entry] }, null, 2) + "\n", opts, changes, "personal Codex marketplace entry");

  const configPath = opts.scope === "project" ? join(resolve(opts.projectDir ?? "."), ".codex", "config.toml") : join(home, ".codex", "config.toml");
  const toml = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const header = `[plugins."${PLUGIN}@${name}"]`;
  const nextToml = toml.includes(header) ? toml : `${toml}${toml && !toml.endsWith("\n") ? "\n" : ""}\n${header}\nenabled = true\n`;
  writeFile(configPath, nextToml, opts, changes, "enables the plugin");

  const agentsPath = opts.scope === "project" ? join(resolve(opts.projectDir ?? "."), "AGENTS.md") : join(home, ".codex", "AGENTS.md");
  upsertBlock(agentsPath, INSTRUCTION_POINTER, opts, changes, "instruction pointer");
  return {
    harness: "codex",
    changes,
    nextSteps: ["Restart Codex, open /plugins and install integration-verifier from the personal marketplace if it is not active, then trust its hooks with /hooks."],
  };
}

/** Which harnesses look installed on this machine. */
export function detectHarnesses(opts: InstallOptions): Harness[] {
  const home = homeOf(opts);
  const found: Harness[] = [];
  if (existsSync(join(home, ".claude"))) found.push("claude-code");
  if (existsSync(join(home, ".codex"))) found.push("codex");
  if (existsSync(join(home, ".gemini"))) found.push("gemini-cli");
  return found;
}

export const INSTALLERS: Partial<Record<Harness, (opts: InstallOptions) => InstallResult>> = {
  "claude-code": installClaudeCode,
  codex: installCodex,
};
