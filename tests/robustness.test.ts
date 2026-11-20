// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION } from "@integration-verifier/core";
import { defaultMcpRoot } from "@integration-verifier/mcp";
import { doctor, formatDoctor } from "../packages/cli/src/doctor.js";

const ROOT = join(import.meta.dirname, "..");
const LAUNCHER = join(ROOT, "adapters", "shared", "iv-launch.mjs");
const CLI = join(ROOT, "packages", "cli", "dist", "index.js");

function sessionStart(env: Record<string, string>, harness = "claude-code") {
  const r = spawnSync(process.execPath, [LAUNCHER, "hook", harness, "session-start"], {
    input: "{}", encoding: "utf8", env: { ...process.env, IV_CLI: "", PATH: "", ...env },
  });
  return { code: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout) : null };
}

describe("session start check", () => {
  it("says how to install when the CLI is missing, without blocking the session", () => {
    const { code, out } = sessionStart({ IV_HOME: mkdtempSync(join(tmpdir(), "iv-h-")) });
    expect(code).toBe(0);
    expect(out.systemMessage).toMatch(/not installed/);
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: "SessionStart" });
  });

  it("warns when the installed CLI is a different version from the plugin", () => {
    const home = mkdtempSync(join(tmpdir(), "iv-h-"));
    mkdirSync(join(home, ".integration-verifier"));
    writeFileSync(join(home, ".integration-verifier", "cli.json"), JSON.stringify({ cli: CLI, node: process.execPath, version: "0.0.1" }));
    const { out } = sessionStart({ IV_HOME: home });
    expect(out.systemMessage).toContain(`version 0.0.1 but this plugin is ${VERSION}`);
  });

  it("is silent when everything matches", () => {
    const home = mkdtempSync(join(tmpdir(), "iv-h-"));
    mkdirSync(join(home, ".integration-verifier"));
    writeFileSync(join(home, ".integration-verifier", "cli.json"), JSON.stringify({ cli: CLI, node: process.execPath, version: VERSION }));
    expect(sessionStart({ IV_HOME: home })).toEqual({ code: 0, out: null });
  });

  it("Codex gets context only (no systemMessage)", () => {
    const { out } = sessionStart({ IV_HOME: mkdtempSync(join(tmpdir(), "iv-h-")) }, "codex");
    expect(out.systemMessage).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toMatch(/not installed/);
  });
});

describe("MCP default root", () => {
  it("uses the agent's project directory, then the working directory", () => {
    expect(defaultMcpRoot({ CLAUDE_PROJECT_DIR: "/p/claude" } as NodeJS.ProcessEnv)).toBe("/p/claude");
    expect(defaultMcpRoot({ IV_ROOT: "/p/iv", CLAUDE_PROJECT_DIR: "/p/claude" } as NodeJS.ProcessEnv)).toBe("/p/iv");
    expect(defaultMcpRoot({} as NodeJS.ProcessEnv)).toBe(process.cwd());
  });
});

describe("iv doctor", () => {
  it("reports each area, explains what to fix, and fails only on real problems", async () => {
    const home = mkdtempSync(join(tmpdir(), "iv-h-"));
    const project = mkdtempSync(join(tmpdir(), "iv-p-"));
    mkdirSync(join(project, ".iv"));
    writeFileSync(join(project, ".iv", "config.yaml"), "gate: [broken");
    const checks = await doctor(project, home);
    const by = (n: string) => checks.find((c) => c.name === n)!;
    expect(by("Node.js").status).toBe("ok");
    expect(by("Agent launcher")).toMatchObject({ status: "warn", fix: expect.stringContaining("iv install") });
    expect(by("Config")).toMatchObject({ status: "fail" });
    expect(by("Git").status).toBe("warn");
    const text = formatDoctor(checks);
    expect(text).toMatch(/Machine[\s\S]*Project/);
    expect(text).toMatch(/1 problem\(s\) to fix/);
  }, 120_000);
});
