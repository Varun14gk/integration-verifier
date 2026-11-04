// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { VERSION } from "@integration-verifier/core";
import { installClaudeCode, installLauncher, REPO_ROOT } from "../../packages/cli/src/install.js";

const ROOT = join(import.meta.dirname, "..", "..");
const PLUGIN = join(ROOT, "adapters", "claude-code");
const LAUNCHER = join(PLUGIN, "scripts", "iv-launch.mjs");
const CLI = join(ROOT, "packages", "cli", "dist", "index.js");
const FIXTURE = join(ROOT, "fixtures", "nextjs-express");
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));

function hook(event: string, input: object, extraEnv: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [LAUNCHER, "hook", "claude-code", event], {
    input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, IV_CLI: CLI, ...extraEnv }, timeout: 240_000,
  });
  return { code: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout) : null };
}

describe("Claude Code adapter files", () => {
  it("has a valid plugin manifest", () => {
    const m = json(join(PLUGIN, ".claude-plugin", "plugin.json"));
    expect(m.name).toBe("integration-verifier");
    expect(m.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(m.version).toBe(VERSION);
    expect(m.license).toBe("Apache-2.0");
  });

  it("is listed in the repository marketplace", () => {
    const mk = json(join(ROOT, ".claude-plugin", "marketplace.json"));
    expect(mk.plugins).toContainEqual(expect.objectContaining({ name: "integration-verifier", source: "./adapters/claude-code" }));
  });

  it("wires PostToolUse and Stop hooks through the launcher (exec form)", () => {
    const h = json(join(PLUGIN, "hooks", "hooks.json")).hooks;
    expect(h.PostToolUse[0].matcher).toBe("Write|Edit|MultiEdit");
    expect(h.PostToolUse[0].hooks[0]).toMatchObject({ type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/scripts/iv-launch.mjs", "hook", "claude-code", "post-write"] });
    expect(h.Stop[0].hooks[0].args.slice(1)).toEqual(["hook", "claude-code", "stop"]);
  });

  it("starts the MCP server through the launcher with the project dir", () => {
    const s = json(join(PLUGIN, ".mcp.json")).mcpServers["integration-verifier"];
    expect(s.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/scripts/iv-launch.mjs", "mcp", "--root", "${CLAUDE_PROJECT_DIR}"]);
  });

  it("ships a skill with frontmatter and the shared launcher", () => {
    const skill = readFileSync(join(PLUGIN, "skills", "integration-verifier", "SKILL.md"), "utf8");
    expect(skill).toMatch(/^---\nname: integration-verifier\ndescription: .+\n---\n/);
    expect(skill).toContain("Never dismiss a finding on your own");
    expect(readFileSync(LAUNCHER, "utf8")).toBe(readFileSync(join(ROOT, "adapters", "shared", "iv-launch.mjs"), "utf8"));
  });

  const hasClaude = spawnSync("claude", ["--version"], { encoding: "utf8", shell: process.platform === "win32" }).status === 0;
  it.skipIf(!hasClaude)("passes `claude plugin validate`", () => {
    for (const target of [PLUGIN, ROOT]) {
      const out = execFileSync("claude", ["plugin", "validate", target], { encoding: "utf8", shell: process.platform === "win32" });
      expect(out).toContain("Validation passed");
    }
  });
});

describe("Claude Code hooks", () => {
  it("post-write returns findings for the written file as context", () => {
    const { code, out } = hook("post-write", { cwd: FIXTURE, tool_name: "Write", tool_input: { file_path: join(FIXTURE, "backend", "src", "server.js") } });
    expect(code).toBe(0);
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(out.hookSpecificOutput.additionalContext).toContain("missing-validation backend/src/server.js:21");
  }, 240_000);

  it("post-write ignores files outside the project and non-source files", () => {
    expect(hook("post-write", { cwd: FIXTURE, tool_input: { file_path: join(FIXTURE, "README.md") } }).out).toBeNull();
    expect(hook("post-write", { cwd: FIXTURE, tool_input: { file_path: join(tmpdir(), "x.ts") } }).out).toBeNull();
  }, 240_000);

  it("stop blocks once per distinct set of blocking findings", () => {
    const first = hook("stop", { cwd: FIXTURE, stop_hook_active: false });
    expect(first.out.decision).toBe("block");
    expect(first.out.reason).toContain("Do not dismiss on your own");
    const again = hook("stop", { cwd: FIXTURE, stop_hook_active: true });
    expect(again.out.decision).toBeUndefined();
    expect(again.out.systemMessage).toContain("still open");
  }, 240_000);

  it("stays silent in projects without a frontend or backend", () => {
    const empty = mkdtempSync(join(tmpdir(), "iv-cc-"));
    expect(hook("stop", { cwd: empty })).toEqual({ code: 0, out: null });
  }, 240_000);

  it("passes (exit 0) with a hint when the CLI is not installed", () => {
    const r = spawnSync(process.execPath, [LAUNCHER, "hook", "claude-code", "stop"], {
      input: "{}", encoding: "utf8", env: { ...process.env, IV_CLI: "", IV_HOME: mkdtempSync(join(tmpdir(), "iv-home-")), PATH: "" },
    });
    expect(r.status).toBe(0);
  });

  it("serves MCP tools through the launcher", async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [LAUNCHER, "mcp", "--root", FIXTURE], env: { ...process.env, IV_CLI: CLI } as Record<string, string> });
    const c = new Client({ name: "cc-test", version: "0" });
    await c.connect(transport);
    try {
      expect((await c.listTools()).tools.map((t) => t.name)).toContain("iv_check");
    } finally {
      await c.close();
    }
  }, 60_000);
});

describe("iv install --claude-code", () => {
  it("registers the marketplace and enables the plugin, keeping existing settings", () => {
    const home = mkdtempSync(join(tmpdir(), "iv-home-"));
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark", enabledPlugins: { "other@x": true } }));
    const r = installClaudeCode({ home });
    expect(r.changes[0]!.action).toBe("update");
    const s = json(join(home, ".claude", "settings.json"));
    expect(s.theme).toBe("dark");
    expect(s.enabledPlugins).toEqual({ "other@x": true, "integration-verifier@integration-verifier": true });
    expect(s.extraKnownMarketplaces["integration-verifier"]).toEqual({ source: { source: "directory", path: REPO_ROOT } });
    expect(existsSync(join(home, ".claude", "settings.json.iv-backup"))).toBe(true);
    expect(installClaudeCode({ home }).changes[0]!.action).toBe("unchanged");
  });

  it("dry run writes nothing; the launcher config points at the CLI", () => {
    const home = mkdtempSync(join(tmpdir(), "iv-home-"));
    expect(installClaudeCode({ home, dryRun: true }).changes[0]!.action).toBe("create");
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
    installLauncher({ home });
    const cfg = json(join(home, ".integration-verifier", "cli.json"));
    expect(cfg.cli.endsWith(join("packages", "cli", "src", "index.js")) || cfg.cli.endsWith(join("packages", "cli", "dist", "index.js"))).toBe(true);
  });

  it("refuses to touch a settings file that is not a JSON object", () => {
    const home = mkdtempSync(join(tmpdir(), "iv-home-"));
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "settings.json"), "[1,2]");
    expect(() => installClaudeCode({ home })).toThrow(/not a JSON object/);
  });
});
