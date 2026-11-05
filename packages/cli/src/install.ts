// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  action: "create" | "update" | "unchanged" | "remove";
  note?: string;
}

export type Target = Harness | "launcher" | "git-hook" | "github-action";

export interface InstallResult {
  harness: Target;
  changes: FileChange[];
  nextSteps: string[];
}

function homeOf(opts: InstallOptions): string {
  return opts.home ?? process.env.IV_HOME ?? homedir();
}

const fwd = (p: string) => p.replace(/\\/g, "/");
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");

/**
 * Writes `content` to `path` unless identical. Every change to an existing file first
 * saves a timestamped copy (`<file>.iv-backup-<time>`), so no backup is ever overwritten.
 */
function writeFile(path: string, content: string, opts: InstallOptions, changes: FileChange[], note?: string): void {
  const exists = existsSync(path);
  const same = exists && readFileSync(path, "utf8") === content;
  changes.push({ path, action: same ? "unchanged" : exists ? "update" : "create", ...(note ? { note } : {}) });
  if (same || opts.dryRun) return;
  mkdirSync(dirname(path), { recursive: true });
  if (exists) copyFileSync(path, `${path}.iv-backup-${stamp()}`);
  writeFileSync(path, content, "utf8");
}

function removePath(path: string, opts: InstallOptions, changes: FileChange[], note?: string): void {
  if (!existsSync(path)) return;
  changes.push({ path, action: "remove", ...(note ? { note } : {}) });
  if (!opts.dryRun) rmSync(path, { recursive: true, force: true });
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8").trim();
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object; not changing it`);
  return parsed as Record<string, unknown>;
}

const launcherConfig = (opts: InstallOptions) => join(homeOf(opts), ".integration-verifier", "cli.json");

/** Records where the CLI lives, so every adapter's launcher can find it. */
export function installLauncher(opts: InstallOptions): InstallResult {
  const changes: FileChange[] = [];
  const content = JSON.stringify({ node: process.execPath, cli: CLI_ENTRY, root: REPO_ROOT, version: VERSION }, null, 2) + "\n";
  writeFile(launcherConfig(opts), content, opts, changes, "tells the adapters where the iv CLI is");
  return { harness: "launcher", changes, nextSteps: [] };
}

export function uninstallLauncher(opts: InstallOptions): InstallResult {
  const changes: FileChange[] = [];
  removePath(launcherConfig(opts), opts, changes);
  return { harness: "launcher", changes, nextSteps: [] };
}

export const MARKETPLACE = "integration-verifier";
export const PLUGIN = "integration-verifier";
const PLUGIN_ID = `${PLUGIN}@${MARKETPLACE}`;

/**
 * Claude Code settings file. Project scope uses `settings.local.json`, which is personal
 * and not committed, because the marketplace path is this machine's clone.
 */
function claudeSettingsPath(opts: InstallOptions): string {
  return opts.scope === "project" ? join(resolve(opts.projectDir ?? "."), ".claude", "settings.local.json") : join(homeOf(opts), ".claude", "settings.json");
}

/** Claude Code: registers this repo as a local marketplace and enables the plugin. */
export function installClaudeCode(opts: InstallOptions): InstallResult {
  const changes: FileChange[] = [];
  const path = claudeSettingsPath(opts);
  const settings = readJson(path);
  const next = {
    ...settings,
    extraKnownMarketplaces: { ...(settings.extraKnownMarketplaces as object | undefined), [MARKETPLACE]: { source: { source: "directory", path: REPO_ROOT } } },
    enabledPlugins: { ...(settings.enabledPlugins as object | undefined), [PLUGIN_ID]: true },
  };
  writeFile(path, JSON.stringify(next, null, 2) + "\n", opts, changes, "adds the integration-verifier marketplace and enables the plugin");
  return {
    harness: "claude-code",
    changes,
    nextSteps: [
      "Restart Claude Code (or run /plugin) so it loads the integration-verifier plugin.",
      "Keep the integration-verifier MCP tool iv_dismiss on 'ask' (don't auto-allow it): that permission prompt is how you approve dismissals.",
    ],
  };
}

export function uninstallClaudeCode(opts: InstallOptions): InstallResult {
  const changes: FileChange[] = [];
  const path = claudeSettingsPath(opts);
  if (existsSync(path)) {
    const settings = readJson(path);
    const markets = { ...(settings.extraKnownMarketplaces as Record<string, unknown> | undefined) };
    const enabled = { ...(settings.enabledPlugins as Record<string, unknown> | undefined) };
    delete markets[MARKETPLACE];
    delete enabled[PLUGIN_ID];
    const next: Record<string, unknown> = { ...settings, extraKnownMarketplaces: markets, enabledPlugins: enabled };
    if (!Object.keys(markets).length) delete next.extraKnownMarketplaces;
    if (!Object.keys(enabled).length) delete next.enabledPlugins;
    writeFile(path, JSON.stringify(next, null, 2) + "\n", opts, changes, "removes the integration-verifier marketplace and plugin");
  }
  return { harness: "claude-code", changes, nextSteps: ["Restart Claude Code."] };
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
finding unless the user gives a reason. Files in \`.iv/\` belong to the user; don't edit them.
${POINTER_END}
`;

/** Our marked block's position in `text`; throws if only one marker is present. */
function blockRange(text: string, path: string): [number, number] | null {
  const start = text.indexOf(POINTER_START);
  const end = text.indexOf(POINTER_END);
  if (start < 0 && end < 0) return null;
  if (start < 0 || end < start) throw new Error(`${path} has a damaged Integration Verifier section (a start or end marker is missing); fix or remove it, then run this again`);
  return [start, end + POINTER_END.length];
}

/** Adds or replaces our marked block in a Markdown file, leaving the rest untouched. */
function upsertBlock(path: string, block: string, opts: InstallOptions, changes: FileChange[], note: string): void {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const range = blockRange(current, path);
  const next = range
    ? current.slice(0, range[0]) + block.trimEnd() + current.slice(range[1])
    : current + (current && !current.endsWith("\n\n") ? (current.endsWith("\n") ? "\n" : "\n\n") : "") + block;
  writeFile(path, next, opts, changes, note);
}

function removeBlock(path: string, opts: InstallOptions, changes: FileChange[]): void {
  if (!existsSync(path)) return;
  const current = readFileSync(path, "utf8");
  const range = blockRange(current, path);
  if (!range) return;
  // Drop the block and the blank line install put before it; keep the rest byte for byte.
  const before = current.slice(0, range[0]).replace(/\n+$/, "\n");
  const after = current.slice(range[1]).replace(/^\n+/, "");
  const next = before.trim() ? before + after : after;
  writeFile(path, next, opts, changes, "removes the instruction pointer");
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

const codexPaths = (opts: InstallOptions) => {
  const home = homeOf(opts);
  const project = resolve(opts.projectDir ?? ".");
  const scoped = opts.scope === "project";
  return {
    pluginDir: join(home, ".codex", "plugins", PLUGIN),
    market: join(home, ".agents", "plugins", "marketplace.json"),
    config: scoped ? join(project, ".codex", "config.toml") : join(home, ".codex", "config.toml"),
    agents: scoped ? join(project, ".codex", "agents") : join(home, ".codex", "agents"),
    agentsMd: scoped ? join(project, "AGENTS.md") : join(home, ".codex", "AGENTS.md"),
  };
};

/** Sets `enabled = true` in our config.toml section, adding the section if needed. */
export function enableTomlSection(toml: string, header: string): string {
  const at = toml.indexOf(header);
  if (at < 0) return `${toml}${toml && !toml.endsWith("\n") ? "\n" : ""}\n${header}\nenabled = true\n`;
  const bodyStart = at + header.length;
  const next = toml.slice(bodyStart).search(/^\[/m);
  const bodyEnd = next < 0 ? toml.length : bodyStart + next;
  let body = toml.slice(bodyStart, bodyEnd);
  body = /^\s*enabled\s*=.*$/m.test(body) ? body.replace(/^(\s*)enabled\s*=.*$/m, "$1enabled = true") : `\nenabled = true${body}`;
  return toml.slice(0, bodyStart) + body + toml.slice(bodyEnd);
}

function removeTomlSection(toml: string, header: string): string {
  const at = toml.indexOf(header);
  if (at < 0) return toml;
  const after = toml.slice(at + header.length).search(/^\[/m);
  const end = after < 0 ? toml.length : at + header.length + after;
  return (toml.slice(0, at).replace(/\n+$/, "\n") + toml.slice(end)).replace(/\n{3,}/g, "\n\n");
}

/**
 * Codex: copies the plugin to ~/.codex/plugins/integration-verifier with absolute
 * launcher paths (hook commands run in whatever shell Codex uses, so no env-var
 * expansion is relied on), lists it in the personal marketplace, enables it in
 * config.toml, installs the custom agents and adds the AGENTS.md pointer. The plugin
 * copy is shared by every project, so it holds no project path: the MCP tools take
 * `root` per call.
 */
export function installCodex(opts: InstallOptions): InstallResult {
  const changes: FileChange[] = [];
  const p = codexPaths(opts);
  const launcher = fwd(join(p.pluginDir, "scripts", "iv-launch.mjs"));
  copyAdapter(join(REPO_ROOT, "adapters", "codex"), p.pluginDir, (rel, text) => {
    // Codex plugins cannot carry custom agents; they are installed below, where Codex reads them.
    if (rel.startsWith("agents/")) return null;
    if (rel === "hooks/hooks.json") return text.split("$PLUGIN_ROOT/scripts/iv-launch.mjs").join(launcher);
    if (rel === "mcp.json") {
      const j = JSON.parse(text) as { mcpServers: Record<string, { args: string[] }> };
      j.mcpServers[PLUGIN]!.args = [launcher, "mcp"];
      return JSON.stringify(j, null, 2) + "\n";
    }
    return text;
  }, opts, changes);

  const agentsSrc = join(REPO_ROOT, "adapters", "codex", "agents");
  for (const f of readdirSync(agentsSrc).filter((x) => x.endsWith(".toml"))) {
    writeFile(join(p.agents, f), readFileSync(join(agentsSrc, f), "utf8"), opts, changes, "custom agent");
  }

  const market = readJson(p.market) as { name?: string; interface?: unknown; plugins?: { name: string }[] };
  const name = market.name ?? "personal";
  const entry = { name: PLUGIN, source: { source: "local", path: `./.codex/plugins/${PLUGIN}` }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Coding" };
  const plugins = (market.plugins ?? []).filter((x) => x.name !== PLUGIN);
  writeFile(p.market, JSON.stringify({ name, interface: market.interface ?? { displayName: "Personal plugins" }, ...market, plugins: [...plugins, entry] }, null, 2) + "\n", opts, changes, "personal Codex marketplace entry");

  const toml = existsSync(p.config) ? readFileSync(p.config, "utf8") : "";
  writeFile(p.config, enableTomlSection(toml, `[plugins."${PLUGIN}@${name}"]`), opts, changes, "enables the plugin");
  upsertBlock(p.agentsMd, INSTRUCTION_POINTER, opts, changes, "instruction pointer");
  return {
    harness: "codex",
    changes,
    nextSteps: ["Restart Codex, open /plugins and install integration-verifier from the personal marketplace if it is not active, then trust its hooks with /hooks."],
  };
}

export function uninstallCodex(opts: InstallOptions): InstallResult {
  const changes: FileChange[] = [];
  const p = codexPaths(opts);
  if (opts.scope !== "project") removePath(p.pluginDir, opts, changes, "plugin copy");
  for (const f of readdirSync(join(REPO_ROOT, "adapters", "codex", "agents")).filter((x) => x.endsWith(".toml"))) removePath(join(p.agents, f), opts, changes, "custom agent");
  let name = "personal";
  if (existsSync(p.market) && opts.scope !== "project") {
    const market = readJson(p.market) as { name?: string; plugins?: { name: string }[] };
    name = market.name ?? name;
    writeFile(p.market, JSON.stringify({ ...market, plugins: (market.plugins ?? []).filter((x) => x.name !== PLUGIN) }, null, 2) + "\n", opts, changes, "removes the marketplace entry");
  }
  if (existsSync(p.config)) writeFile(p.config, removeTomlSection(readFileSync(p.config, "utf8"), `[plugins."${PLUGIN}@${name}"]`), opts, changes, "removes the plugin section");
  removeBlock(p.agentsMd, opts, changes);
  return { harness: "codex", changes, nextSteps: ["Restart Codex."] };
}

/**
 * Gemini CLI: copies the extension into ~/.gemini/extensions/integration-verifier, which
 * is what `gemini extensions install <path>` does. Paths inside use ${extensionPath},
 * which Gemini CLI expands, so the copy needs no rewriting. Extensions are user-wide.
 */
export function installGeminiCli(opts: InstallOptions): InstallResult {
  const changes: FileChange[] = [];
  copyAdapter(join(REPO_ROOT, "adapters", "gemini-cli"), join(homeOf(opts), ".gemini", "extensions", PLUGIN), (_rel, text) => text, opts, changes);
  return {
    harness: "gemini-cli",
    changes,
    nextSteps: [
      ...(opts.scope === "project" ? ["Gemini CLI extensions are user-wide; installed for your user, not only this project."] : []),
      "Restart Gemini CLI; `gemini extensions list` should show integration-verifier. Alternative: gemini extensions install <repo>/adapters/gemini-cli",
    ],
  };
}

export function uninstallGeminiCli(opts: InstallOptions): InstallResult {
  const changes: FileChange[] = [];
  removePath(join(homeOf(opts), ".gemini", "extensions", PLUGIN), opts, changes, "extension");
  return { harness: "gemini-cli", changes, nextSteps: ["Restart Gemini CLI."] };
}

// ---- git pre-commit hook --------------------------------------------------------

const HOOK_MARKER = "# integration-verifier: pre-commit gate";
const ROOT_LINE = /^# iv-root: (.*)$/gm;

function git(cwd: string, args: string[]) {
  return spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

/** Path of the pre-commit hook git will run for `projectDir` (honours core.hooksPath). */
function preCommitPath(projectDir: string): string {
  const r = git(projectDir, ["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-commit"]);
  if (r.status !== 0) throw new Error(`${projectDir} is not a git repository`);
  return r.stdout.trim();
}

/** The project's folder inside the repository ("" for the top level). */
function repoRelative(projectDir: string): string {
  return git(projectDir, ["rev-parse", "--show-prefix"]).stdout.trim().replace(/\/$/, "");
}

/**
 * The hook script. Each project root in the repository gets one check line, so a monorepo
 * can gate several apps. `node` is looked up on PATH at commit time (it survives Node
 * upgrades through nvm or volta), with the installing Node as a fallback.
 */
function hookScript(roots: string[]): string {
  const launcher = fwd(join(REPO_ROOT, "adapters", "shared", "iv-launch.mjs"));
  const checks = roots
    .map((r) => `# iv-root: ${r}\n"$NODE" "${launcher}" check --root "$TOP${r ? `/${r}` : ""}" --staged || status=1`)
    .join("\n");
  return `#!/bin/sh
${HOOK_MARKER} (installed by \`iv install --git-hook\`)
# Blocks the commit while it adds findings at or above gate.failOn, or touches files that have them.
# Skip once with: git commit --no-verify
TOP="$(git rev-parse --show-toplevel)"
NODE="$(command -v node 2>/dev/null)"
[ -n "$NODE" ] || NODE="${fwd(process.execPath)}"
status=0
${checks}
exit $status
`;
}

function hookRoots(text: string): string[] {
  return [...text.matchAll(ROOT_LINE)].map((m) => m[1]!.trim());
}

/** Git pre-commit hook for the project at `projectDir`. Never replaces a hook it did not write. */
export function installGitHook(opts: InstallOptions): InstallResult {
  const changes: FileChange[] = [];
  const project = resolve(opts.projectDir ?? ".");
  const path = preCommitPath(project);
  const rel = repoRelative(project);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (existing !== null && !existing.includes(HOOK_MARKER)) {
    throw new Error(`${path} already exists and was not written by Integration Verifier. Add this line to it instead:\n  node "${fwd(join(REPO_ROOT, "adapters", "shared", "iv-launch.mjs"))}" check --root "$(git rev-parse --show-toplevel)${rel ? `/${rel}` : ""}" --staged`);
  }
  const roots = [...new Set([...(existing ? hookRoots(existing) : []), rel])].sort();
  writeFile(path, hookScript(roots), opts, changes, `pre-commit gate for ${rel || "the repository root"}`);
  if (!opts.dryRun) chmodSync(path, 0o755);
  return { harness: "git-hook", changes, nextSteps: ["Commits now run `iv check --staged`; `git commit --no-verify` skips it once."] };
}

export function uninstallGitHook(opts: InstallOptions): InstallResult {
  const changes: FileChange[] = [];
  const project = resolve(opts.projectDir ?? ".");
  const path = preCommitPath(project);
  if (!existsSync(path) || !readFileSync(path, "utf8").includes(HOOK_MARKER)) return { harness: "git-hook", changes, nextSteps: [] };
  const rel = repoRelative(project);
  const roots = hookRoots(readFileSync(path, "utf8")).filter((r) => r !== rel);
  if (roots.length) writeFile(path, hookScript(roots), opts, changes, `stops checking ${rel || "the repository root"}`);
  else removePath(path, opts, changes, "pre-commit gate");
  return { harness: "git-hook", changes, nextSteps: [] };
}

// ---- GitHub Actions ---------------------------------------------------------------

const WORKFLOW_MARKER = "installed by `iv install --github-action`";
/** Semgrep CE version the action installs; the one the rules are tested with. */
export const SEMGREP_VERSION = "1.183.0";

/**
 * The commit this clone is at, so the generated workflow pins the action to an exact
 * revision instead of a moving branch. Falls back to `main` outside a git checkout.
 */
function actionRef(): { ref: string; pinned: boolean } {
  const sha = git(REPO_ROOT, ["rev-parse", "HEAD"]).stdout.trim();
  return /^[0-9a-f]{40}$/.test(sha) ? { ref: sha, pinned: true } : { ref: "main", pinned: false };
}

/** GitHub Actions workflow that runs the gate on pushes and pull requests and uploads SARIF. */
export function githubWorkflow(ref = actionRef()): string {
  return `# Integration Verifier gate (${WORKFLOW_MARKER}).
# Runs the same checks as the editor hooks and uploads the findings to code scanning.
name: Integration Verifier

on:
  push:
    branches: [main, master]
  pull_request:
  workflow_dispatch:

permissions:
  contents: read
  security-events: write

jobs:
  integration-verifier:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - id: iv
        # Pinned to an exact commit${ref.pinned ? "" : " (none was available: pin this to a commit SHA)"}; update it deliberately.
        uses: Varun14gk/integration-verifier@${ref.ref}
        with:
          root: "."
          engine: semgrep
          semgrep-version: "${SEMGREP_VERSION}"
      # Pull requests from forks get a read-only token, so code-scanning upload is skipped there.
      - if: always() && steps.iv.outputs.sarif != '' && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)
        uses: github/codeql-action/upload-sarif@v4
        with:
          sarif_file: \${{ steps.iv.outputs.sarif }}
          category: integration-verifier
`;
}

const workflowPath = (opts: InstallOptions) => join(resolve(opts.projectDir ?? "."), ".github", "workflows", "integration-verifier.yml");

export function installGitHubAction(opts: InstallOptions): InstallResult {
  const changes: FileChange[] = [];
  const path = workflowPath(opts);
  if (existsSync(path) && !readFileSync(path, "utf8").includes(WORKFLOW_MARKER)) {
    throw new Error(`${path} already exists and was not written by Integration Verifier; not replacing it`);
  }
  const ref = actionRef();
  writeFile(path, githubWorkflow(ref), opts, changes, "CI gate with SARIF upload");
  return {
    harness: "github-action",
    changes,
    nextSteps: [
      ...(ref.pinned ? [`The action is pinned to ${ref.ref.slice(0, 12)}; that commit must be pushed to GitHub.`] : ["Pin the action to a commit SHA in the workflow before relying on it."]),
      "Commit the workflow; findings appear under Security > Code scanning and the job fails on blocking findings.",
    ],
  };
}

export function uninstallGitHubAction(opts: InstallOptions): InstallResult {
  const changes: FileChange[] = [];
  const path = workflowPath(opts);
  if (existsSync(path) && readFileSync(path, "utf8").includes(WORKFLOW_MARKER)) removePath(path, opts, changes, "CI gate");
  return { harness: "github-action", changes, nextSteps: [] };
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

export const INSTALLERS: Record<Harness, (opts: InstallOptions) => InstallResult> = {
  "claude-code": installClaudeCode,
  codex: installCodex,
  "gemini-cli": installGeminiCli,
};

export const UNINSTALLERS: Record<Harness, (opts: InstallOptions) => InstallResult> = {
  "claude-code": uninstallClaudeCode,
  codex: uninstallCodex,
  "gemini-cli": uninstallGeminiCli,
};
