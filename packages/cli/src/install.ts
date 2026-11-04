// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
  harness: Harness | "launcher" | "git-hook" | "github-action";
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

/** Copies an adapter folder, rewriting text files with `transform` (null skips the file). */
function copyAdapter(from: string, to: string, transform: (rel: string, text: string) => string | null, opts: InstallOptions, changes: FileChange[]): void {
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else {
        const text = transform(r, readFileSync(join(dir, e.name), "utf8"));
        if (text !== null) writeFile(join(to, r), text, opts, changes);
      }
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
    // Codex plugins cannot carry custom agents; they are installed below, where Codex reads them.
    if (rel.startsWith("agents/")) return null;
    if (rel === "hooks/hooks.json") return text.split("$PLUGIN_ROOT/scripts/iv-launch.mjs").join(launcher);
    if (rel === "mcp.json") {
      const j = JSON.parse(text) as { mcpServers: Record<string, { args: string[] }> };
      const s = j.mcpServers[PLUGIN]!;
      s.args = [launcher, "mcp", ...(opts.scope === "project" ? ["--root", fwd(resolve(opts.projectDir ?? "."))] : [])];
      return JSON.stringify(j, null, 2) + "\n";
    }
    return text;
  }, opts, changes);

  const agentsDir = opts.scope === "project" ? join(resolve(opts.projectDir ?? "."), ".codex", "agents") : join(home, ".codex", "agents");
  const agentsSrc = join(REPO_ROOT, "adapters", "codex", "agents");
  for (const f of readdirSync(agentsSrc).filter((x) => x.endsWith(".toml"))) {
    writeFile(join(agentsDir, f), readFileSync(join(agentsSrc, f), "utf8"), opts, changes, "custom agent");
  }

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

/**
 * Gemini CLI: copies the extension into ~/.gemini/extensions/integration-verifier, which
 * is what `gemini extensions install <path>` does. Paths inside use ${extensionPath},
 * which Gemini CLI expands, so the copy needs no rewriting. Extensions are user-wide.
 */
export function installGeminiCli(opts: InstallOptions): InstallResult {
  const changes: FileChange[] = [];
  const dir = join(homeOf(opts), ".gemini", "extensions", PLUGIN);
  copyAdapter(join(REPO_ROOT, "adapters", "gemini-cli"), dir, (_rel, text) => text, opts, changes);
  return {
    harness: "gemini-cli",
    changes,
    nextSteps: [
      ...(opts.scope === "project" ? ["Gemini CLI extensions are user-wide; installed for your user, not only this project."] : []),
      "Restart Gemini CLI; `gemini extensions list` should show integration-verifier. Alternative: gemini extensions install <repo>/adapters/gemini-cli",
    ],
  };
}

const HOOK_MARKER = "# integration-verifier: pre-commit gate";

/** Path of the pre-commit hook git will run for `projectDir` (honours core.hooksPath). */
function preCommitPath(projectDir: string): string {
  const r = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-commit"], { cwd: projectDir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${projectDir} is not a git repository`);
  return r.stdout.trim();
}

/**
 * Git pre-commit hook: runs the same gate as the harness Stop hooks, limited to
 * findings in staged files. Never replaces a hook it did not write.
 */
export function installGitHook(opts: InstallOptions): InstallResult {
  const changes: FileChange[] = [];
  const project = resolve(opts.projectDir ?? ".");
  const path = preCommitPath(project);
  if (existsSync(path) && !readFileSync(path, "utf8").includes(HOOK_MARKER)) {
    throw new Error(`${path} already exists and was not written by Integration Verifier. Add this line to it instead:\n  ${hookCommand()}`);
  }
  const script = `#!/bin/sh\n${HOOK_MARKER} (installed by \`iv install --git-hook\`)\n# Blocks the commit while findings at or above gate.failOn are open in staged files.\n# Skip once with: git commit --no-verify\n${hookCommand()}\n`;
  writeFile(path, script, opts, changes, "pre-commit gate");
  if (!opts.dryRun) chmodSync(path, 0o755);
  return { harness: "git-hook", changes, nextSteps: ["Commits now run `iv check --staged`; `git commit --no-verify` skips it once."] };
}

function hookCommand(): string {
  return `"${fwd(process.execPath)}" "${fwd(join(REPO_ROOT, "adapters", "shared", "iv-launch.mjs"))}" check --root "$(git rev-parse --show-toplevel)" --staged`;
}

/** GitHub Actions workflow that runs the gate on pushes and pull requests and uploads SARIF. */
export const GITHUB_WORKFLOW = `# Integration Verifier gate (installed by \`iv install --github-action\`).
# Runs the same checks as the editor hooks and uploads the findings to code scanning.
name: Integration Verifier

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read
  security-events: write

jobs:
  integration-verifier:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - id: iv
        uses: Varun14gk/integration-verifier@main
        with:
          root: "."
          engine: semgrep
      - if: always() && steps.iv.outputs.sarif != ''
        uses: github/codeql-action/upload-sarif@v4
        with:
          sarif_file: \${{ steps.iv.outputs.sarif }}
          category: integration-verifier
`;

export function installGitHubAction(opts: InstallOptions): InstallResult {
  const changes: FileChange[] = [];
  const path = join(resolve(opts.projectDir ?? "."), ".github", "workflows", "integration-verifier.yml");
  writeFile(path, GITHUB_WORKFLOW, opts, changes, "CI gate with SARIF upload");
  return { harness: "github-action", changes, nextSteps: ["Commit the workflow; findings appear under Security > Code scanning and the job fails on blocking findings."] };
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
  "gemini-cli": installGeminiCli,
};
