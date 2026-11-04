// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION } from "@integration-verifier/core";
import { installGeminiCli } from "../../packages/cli/src/install.js";

const ROOT = join(import.meta.dirname, "..", "..");
const EXT = join(ROOT, "adapters", "gemini-cli");
const CLI = join(ROOT, "packages", "cli", "dist", "index.js");
const FIXTURE = join(ROOT, "fixtures", "nextjs-express");
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));

/** What Gemini CLI does to ${...} variables in gemini-extension.json and hooks/hooks.json. */
function expand(s: string, extensionPath: string, workspacePath: string): string {
  return s.split("${extensionPath}").join(extensionPath).split("${workspacePath}").join(workspacePath).split("${/}").join(sep);
}

function runHook(event: "AfterTool" | "AfterAgent", input: object) {
  const h = json(join(EXT, "hooks", "hooks.json")).hooks[event][0].hooks[0];
  const r = spawnSync(expand(h.command, EXT, FIXTURE), {
    shell: true, input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, IV_CLI: CLI }, timeout: h.timeout,
  });
  return { code: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout) : null };
}

describe("Gemini CLI extension files", () => {
  it("has a manifest whose name matches the extension directory", () => {
    const m = json(join(EXT, "gemini-extension.json"));
    expect(m.name).toBe("integration-verifier");
    expect(m.version).toBe(VERSION);
    expect(m.contextFileName).toBe("GEMINI.md");
    expect(existsSync(join(EXT, m.contextFileName))).toBe(true);
    expect(m.mcpServers["integration-verifier"]).toEqual({
      command: "node",
      args: ["${extensionPath}${/}scripts${/}iv-launch.mjs", "mcp", "--root", "${workspacePath}"],
      cwd: "${workspacePath}",
    });
  });

  it("hooks AfterTool on write_file|replace and AfterAgent, timeouts in ms", () => {
    const h = json(join(EXT, "hooks", "hooks.json")).hooks;
    expect(h.AfterTool[0].matcher).toBe("write_file|replace");
    expect(h.AfterTool[0].hooks[0].timeout).toBe(60000);
    expect(h.AfterAgent[0].hooks[0].command).toContain("hook gemini-cli stop");
  });

  it("ships the shared skill and launcher", () => {
    expect(readFileSync(join(EXT, "scripts", "iv-launch.mjs"), "utf8")).toBe(readFileSync(join(ROOT, "adapters", "shared", "iv-launch.mjs"), "utf8"));
    expect(readFileSync(join(EXT, "skills", "integration-verifier", "SKILL.md"), "utf8")).toBe(readFileSync(join(ROOT, "adapters", "claude-code", "skills", "integration-verifier", "SKILL.md"), "utf8"));
  });
});

describe("Gemini CLI hooks (commands as Gemini CLI expands them)", () => {
  it("AfterTool returns context for the written file", () => {
    const { code, out } = runHook("AfterTool", { cwd: FIXTURE, hook_event_name: "AfterTool", tool_name: "write_file", tool_input: { file_path: join(FIXTURE, "backend", "src", "server.js"), content: "x" } });
    expect(code).toBe(0);
    expect(out.hookSpecificOutput.additionalContext).toContain("missing-validation backend/src/server.js:21");
  }, 240_000);

  it("AfterAgent denies once per distinct set of blocking findings", () => {
    const first = runHook("AfterAgent", { cwd: FIXTURE, hook_event_name: "AfterAgent", prompt: "x", prompt_response: "done", stop_hook_active: false });
    expect(first.out).toMatchObject({ decision: "deny" });
    expect(first.out.reason).toContain("Integration Verifier gate");
    const again = runHook("AfterAgent", { cwd: FIXTURE, stop_hook_active: true });
    expect(again.out.decision).toBeUndefined();
  }, 300_000);
});

describe("iv install --gemini-cli", () => {
  it("copies the extension into ~/.gemini/extensions/integration-verifier unchanged", () => {
    const home = mkdtempSync(join(tmpdir(), "iv-gemini-"));
    const r = installGeminiCli({ home });
    const dir = join(home, ".gemini", "extensions", "integration-verifier");
    expect(r.changes.every((c) => c.action === "create")).toBe(true);
    expect(readFileSync(join(dir, "gemini-extension.json"), "utf8")).toBe(readFileSync(join(EXT, "gemini-extension.json"), "utf8"));
    expect(existsSync(join(dir, "hooks", "hooks.json"))).toBe(true);
    expect(existsSync(join(dir, "skills", "integration-verifier", "SKILL.md"))).toBe(true);
    expect(installGeminiCli({ home }).changes.every((c) => c.action === "unchanged")).toBe(true);
  });
});
