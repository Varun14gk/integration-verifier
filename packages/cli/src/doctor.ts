// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectStack, findEngine, loadPolicy, VERSION } from "@integration-verifier/core";
import { CLI_ENTRY } from "./install.js";

export type Status = "ok" | "warn" | "fail";

export interface Check {
  area: "machine" | "project" | "agents";
  name: string;
  status: Status;
  detail: string;
  /** What to do about it, when not ok. */
  fix?: string;
}

const MIN_NODE = 22;

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Checks the machine, one project and the agent installs. Never changes anything. */
export async function doctor(root: string, home = process.env.IV_HOME || homedir()): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  // ---- machine
  const major = Number(process.versions.node.split(".")[0]);
  add(major >= MIN_NODE
    ? { area: "machine", name: "Node.js", status: "ok", detail: process.versions.node }
    : { area: "machine", name: "Node.js", status: "fail", detail: `${process.versions.node} is too old`, fix: `Install Node.js ${MIN_NODE} or newer.` });

  const cfg = readJson(join(home, ".integration-verifier", "cli.json"));
  if (!cfg) {
    add({ area: "machine", name: "Agent launcher", status: "warn", detail: "~/.integration-verifier/cli.json is missing, so agent plugins can't find the CLI", fix: "Run `iv install --all` (or the agent you use)." });
  } else if (cfg.cli !== CLI_ENTRY || cfg.version !== VERSION) {
    add({ area: "machine", name: "Agent launcher", status: "warn", detail: `points at ${String(cfg.cli)} (v${String(cfg.version)}), not this CLI (v${VERSION})`, fix: "Run `iv install --all` from this clone to point the agents here." });
  } else {
    add({ area: "machine", name: "Agent launcher", status: "ok", detail: `agents use this CLI (v${VERSION})` });
  }

  const engine = await findEngine("auto");
  add(engine
    ? { area: "machine", name: "Pattern engine", status: "ok", detail: `${engine.name} ${engine.version}` }
    : { area: "machine", name: "Pattern engine", status: "warn", detail: "no Opengrep or Semgrep CE found: five leak checks will be skipped", fix: "`pip install semgrep` (then open a new terminal), or set scanner.command in .iv/config.yaml." });

  try {
    const { chromium } = await import("playwright");
    const exe = chromium.executablePath();
    add(existsSync(exe)
      ? { area: "machine", name: "Browser for iv runtime", status: "ok", detail: "Chromium installed" }
      : { area: "machine", name: "Browser for iv runtime", status: "warn", detail: "Chromium is not installed (only needed for iv runtime)", fix: "`npx playwright install chromium`" });
  } catch {
    add({ area: "machine", name: "Browser for iv runtime", status: "warn", detail: "Playwright could not be loaded (only needed for iv runtime)", fix: "Run `npm ci` in the clone." });
  }

  // ---- project
  const policy = loadPolicy(root);
  if (!policy.ok) {
    add({ area: "project", name: "Config", status: "fail", detail: `${policy.source} is invalid: ${policy.issues.map((i) => i.message).join("; ")}`, fix: "`iv config validate` shows the line; the gate blocks until it is fixed." });
  } else {
    add({
      area: "project", name: "Config", status: policy.uncommittedChanges ? "warn" : "ok",
      detail: `${policy.source === "defaults" ? "no .iv/config.yaml (defaults)" : `${policy.source} .iv/config.yaml`}, gate fails on ${policy.config.gate.failOn}`,
      ...(policy.uncommittedChanges ? { fix: "Commit .iv/config.yaml: the gate enforces the committed version." } : {}),
    });
  }
  const stack = detectStack([root]);
  const apps = stack.units.filter((u) => u.role !== "unknown");
  add(apps.length
    ? { area: "project", name: "Stack", status: stack.unsupported.length ? "warn" : "ok", detail: apps.map((u) => `${u.dir} (${u.role}: ${u.framework ?? u.language})`).join(", ") + (stack.unsupported.length ? `; unsupported: ${stack.unsupported.map((u) => u.dir).join(", ")}` : ""), ...(stack.unsupported.length ? { fix: "Unsupported parts are checked only through OpenAPI/GraphQL/.proto schemas and iv runtime." } : {}) }
    : { area: "project", name: "Stack", status: "warn", detail: "no frontend or backend detected here; hooks will stay silent", fix: "Point --root at the project folder (or pass --also for a separate backend)." });

  const git = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-commit"], { cwd: root, encoding: "utf8", windowsHide: true });
  if (git.status !== 0) {
    add({ area: "project", name: "Git", status: "warn", detail: "not a git repository: the gate can't use a committed policy, and there is no pre-commit gate", fix: "Use git, then `iv install --git-hook`." });
  } else {
    const hook = git.stdout.trim();
    const ours = existsSync(hook) && readFileSync(hook, "utf8").includes("integration-verifier: pre-commit gate");
    add(ours
      ? { area: "project", name: "Pre-commit gate", status: "ok", detail: "installed" }
      : { area: "project", name: "Pre-commit gate", status: "warn", detail: "not installed", fix: "`iv install --git-hook --root <project>`" });
  }

  // ---- agents
  const claude = readJson(join(home, ".claude", "settings.json"));
  const claudeOn = (claude?.enabledPlugins as Record<string, unknown> | undefined)?.["integration-verifier@integration-verifier"] === true;
  if (existsSync(join(home, ".claude"))) {
    add(claudeOn
      ? { area: "agents", name: "Claude Code", status: "ok", detail: "plugin enabled (user settings)" }
      : { area: "agents", name: "Claude Code", status: "warn", detail: "plugin not enabled in ~/.claude/settings.json (it may be enabled per project or via /plugin)", fix: "`iv install --claude-code`" });
  }
  if (existsSync(join(home, ".codex"))) {
    const dir = join(home, ".codex", "plugins", "integration-verifier");
    const v = (readJson(join(dir, ".codex-plugin", "plugin.json"))?.version as string | undefined) ?? null;
    add(!v
      ? { area: "agents", name: "Codex", status: "warn", detail: "plugin not installed", fix: "`iv install --codex`" }
      : v !== VERSION
        ? { area: "agents", name: "Codex", status: "warn", detail: `installed plugin is v${v}, CLI is v${VERSION}`, fix: "`iv install --codex` to update it." }
        : { area: "agents", name: "Codex", status: "ok", detail: `plugin v${v} installed (trust its hooks with /hooks)` });
  }
  if (existsSync(join(home, ".gemini"))) {
    const v = (readJson(join(home, ".gemini", "extensions", "integration-verifier", "gemini-extension.json"))?.version as string | undefined) ?? null;
    add(!v
      ? { area: "agents", name: "Gemini CLI", status: "warn", detail: "extension not installed", fix: "`iv install --gemini-cli`" }
      : v !== VERSION
        ? { area: "agents", name: "Gemini CLI", status: "warn", detail: `installed extension is v${v}, CLI is v${VERSION}`, fix: "`iv install --gemini-cli` to update it." }
        : { area: "agents", name: "Gemini CLI", status: "ok", detail: `extension v${v} installed` });
  }
  return checks;
}

const ICON: Record<Status, string> = { ok: "ok  ", warn: "warn", fail: "FAIL" };

export function formatDoctor(checks: Check[]): string {
  const lines: string[] = [];
  for (const area of ["machine", "project", "agents"] as const) {
    const items = checks.filter((c) => c.area === area);
    if (!items.length) continue;
    lines.push(area === "machine" ? "Machine" : area === "project" ? "Project" : "Agents");
    for (const c of items) {
      lines.push(`  [${ICON[c.status]}] ${c.name}: ${c.detail}`);
      if (c.fix) lines.push(`         fix: ${c.fix}`);
    }
  }
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  lines.push(fails ? `${fails} problem(s) to fix, ${warns} warning(s).` : warns ? `Ready, with ${warns} warning(s).` : "Everything is ready.");
  return lines.join("\n") + "\n";
}
