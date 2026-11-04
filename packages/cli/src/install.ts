// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
};
