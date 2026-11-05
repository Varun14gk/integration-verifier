// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { filesOf, projectRoot, runHook } from "../src/hooks.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures");
const NO_ENV = {} as NodeJS.ProcessEnv;

/** A git repository holding a copy of the react-fastapi fixture, with `config` committed. */
function repo(config = "version: 1\nscanner:\n  engine: none\n"): string {
  const dir = mkdtempSync(join(tmpdir(), "iv-hooks-"));
  cpSync(join(FIXTURES, "react-fastapi"), dir, { recursive: true });
  writeFileSync(join(dir, ".iv", "config.yaml"), config);
  const git = (...a: string[]) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@e.st", "-c", "user.name=t", "add", "-A");
  git("-c", "user.email=t@e.st", "-c", "user.name=t", "commit", "-q", "-m", "init");
  return dir;
}

const stop = (dir: string, extra: object = {}, env = NO_ENV) => runHook("claude-code", "stop", JSON.stringify({ cwd: dir, session_id: "s1", ...extra }), env);
const decision = (o: { stdout: string }) => (o.stdout ? JSON.parse(o.stdout) : null);

describe("pre-write protects .iv/", () => {
  const root = mkdtempSync(join(tmpdir(), "iv-pre-"));
  const pre = (input: object) => runHook("claude-code", "pre-write", JSON.stringify({ cwd: root, ...input }), NO_ENV);

  it("denies direct writes, patches and shell commands that touch .iv/", async () => {
    for (const input of [
      { tool_name: "Write", tool_input: { file_path: join(root, ".iv", "config.yaml") } },
      { tool_name: "Edit", tool_input: { file_path: ".iv/gate-state.json" } },
      { tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** Update File: .iv/config.yaml\n@@\n-x\n+y\n*** End Patch" } },
      { tool_name: "Bash", tool_input: { command: "sed -i 's/high/critical/' .iv/config.yaml" } },
      { tool_name: "Bash", tool_input: { command: "echo 'gate: {}' > .iv\\config.yaml" } },
    ]) {
      const out = await pre(input);
      expect(out.code, JSON.stringify(input)).toBe(2);
      expect(out.stderr).toContain("can only be changed by the user");
    }
  });

  it("allows ordinary writes and reading .iv/", async () => {
    expect((await pre({ tool_name: "Write", tool_input: { file_path: join(root, "src", "a.ts") } })).code).toBe(0);
    expect((await pre({ tool_name: "Bash", tool_input: { command: "cat .iv/report.md" } })).code).toBe(0);
  });
});

describe("the Stop gate fails closed", () => {
  it("blocks on an invalid config instead of skipping the checks", async () => {
    const dir = repo();
    writeFileSync(join(dir, ".iv", "config.yaml"), "gate: [not, valid");
    const out = decision(await stop(dir));
    expect(out.decision).toBe("block");
    expect(out.reason).toMatch(/invalid/);
  });

  it("enforces the committed policy, not uncommitted edits", async () => {
    const dir = repo("version: 1\nscanner:\n  engine: none\ngate:\n  failOn: high\n");
    writeFileSync(join(dir, ".iv", "config.yaml"), "version: 1\nscanner:\n  engine: none\ngate:\n  failOn: critical\n");
    const out = decision(await stop(dir));
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("uncommitted changes to .iv/config.yaml are ignored");
  }, 60_000);

  it("blocks when the check runs out of time", async () => {
    // The budget fires while the check waits on I/O; here, starting the pattern engine.
    const dir = repo("version: 1\n");
    const out = decision(await stop(dir, {}, { IV_HOOK_BUDGET_MS: "1" } as NodeJS.ProcessEnv));
    expect(out.decision).toBe("block");
    expect(out.reason).toMatch(/did not finish/);
  }, 60_000);

  it("keeps blocking up to maxStopBlocks, then records the override", async () => {
    const dir = repo("version: 1\nscanner:\n  engine: none\ngate:\n  maxStopBlocks: 2\n");
    expect(decision(await stop(dir, { stop_hook_active: false })).decision).toBe("block");
    expect(decision(await stop(dir, { stop_hook_active: true })).decision).toBe("block");
    const third = decision(await stop(dir, { stop_hook_active: true }));
    expect(third.decision).toBeUndefined();
    expect(third.systemMessage).toMatch(/after 2 blocked attempts/);
    const log = readFileSync(join(dir, ".iv", "gate-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log).toEqual([expect.objectContaining({ event: "stop-override", session: "s1", blocks: 2 })]);
  }, 120_000);

  it("keeps each session's count separate and survives a corrupt state file", async () => {
    const dir = repo("version: 1\nscanner:\n  engine: none\ngate:\n  maxStopBlocks: 1\n");
    expect(decision(await stop(dir)).decision).toBe("block");
    writeFileSync(join(dir, ".iv", "gate-state.json"), "{ not json");
    expect(decision(await stop(dir, { stop_hook_active: true })).decision).toBe("block");
    expect(decision(await stop(dir, { session_id: "s2", stop_hook_active: true })).decision).toBe("block");
  }, 120_000);
});

describe("project root and written files", () => {
  it("prefers the harness project dir, else walks up to .iv or .git", () => {
    const top = mkdtempSync(join(tmpdir(), "iv-root-"));
    mkdirSync(join(top, ".iv"));
    mkdirSync(join(top, "a", "b"), { recursive: true });
    expect(projectRoot({ cwd: join(top, "a", "b") }, NO_ENV)).toBe(top);
    expect(projectRoot({ cwd: join(top, "a", "b") }, { CLAUDE_PROJECT_DIR: join(top, "a") } as NodeJS.ProcessEnv)).toBe(join(top, "a"));
  });

  it("reads notebook paths and deleted files from patches", () => {
    expect(filesOf({ tool_input: { notebook_path: "n.ipynb" } })).toEqual(["n.ipynb"]);
    expect(filesOf({ tool_input: { command: "*** Begin Patch\n*** Delete File: api/routes.py\n*** End Patch" } })).toEqual(["api/routes.py"]);
  });
});
