// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { GITHUB_WORKFLOW, installGitHook, installGitHubAction } from "../packages/cli/src/install.js";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "packages", "cli", "dist", "index.js");

function repoFromFixture(failOn: string): string {
  const dir = mkdtempSync(join(tmpdir(), "iv-git-"));
  cpSync(join(ROOT, "fixtures", "react-fastapi"), dir, { recursive: true });
  writeFileSync(join(dir, ".iv", "config.yaml"), `version: 1\nscanner:\n  engine: none\ngate:\n  failOn: ${failOn}\n`);
  const git = (...a: string[]) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  return dir;
}

function commit(dir: string, message: string) {
  return spawnSync("git", ["commit", "-q", "-m", message], { cwd: dir, encoding: "utf8", env: { ...process.env, IV_CLI: CLI } });
}

describe("git pre-commit hook", () => {
  it("blocks a commit with blocking findings in staged files, and lets it through otherwise", () => {
    const dir = repoFromFixture("high");
    installGitHook({ projectDir: dir });
    const hook = readFileSync(join(dir, ".git", "hooks", "pre-commit"), "utf8");
    expect(hook).toContain("# integration-verifier: pre-commit gate");
    expect(hook).toContain("--staged");

    spawnSync("git", ["add", "-A"], { cwd: dir });
    const blocked = commit(dir, "broken integration");
    expect(blocked.status).not.toBe(0);
    expect(blocked.stdout + blocked.stderr).toContain("Gate: FAILED");
    expect(blocked.stdout + blocked.stderr).toContain("not-connected frontend/src/api/users.ts:40");

    writeFileSync(join(dir, ".iv", "config.yaml"), "version: 1\nscanner:\n  engine: none\ngate:\n  failOn: critical\n");
    spawnSync("git", ["add", "-A"], { cwd: dir });
    expect(commit(dir, "now allowed").status).toBe(0);
  }, 240_000);

  it("only reports findings in staged files", () => {
    const dir = repoFromFixture("high");
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    writeFileSync(join(dir, "notes.txt"), "hello\n");
    spawnSync("git", ["add", "notes.txt"], { cwd: dir });
    const r = spawnSync(process.execPath, [CLI, "check", "--root", dir, "--staged"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("0 open findings");
  }, 240_000);

  it("never replaces a hook it did not write", () => {
    const dir = repoFromFixture("high");
    writeFileSync(join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\nnpm run lint\n");
    expect(() => installGitHook({ projectDir: dir })).toThrow(/not written by Integration Verifier/);
    expect(readFileSync(join(dir, ".git", "hooks", "pre-commit"), "utf8")).toBe("#!/bin/sh\nnpm run lint\n");
  });
});

describe("GitHub Action", () => {
  const action = parse(readFileSync(join(ROOT, "action.yml"), "utf8"));

  it("is a composite action with the documented inputs and outputs", () => {
    expect(action.runs.using).toBe("composite");
    expect(Object.keys(action.inputs)).toEqual(["root", "engine", "fail-on-findings", "sarif"]);
    expect(Object.keys(action.outputs)).toEqual(["sarif", "exit-code"]);
  });

  it("never interpolates inputs into shell scripts (passes them through env)", () => {
    for (const step of action.runs.steps) {
      if (step.run) expect(step.run, step.name).not.toMatch(/\$\{\{/);
    }
  });

  it("installs a workflow that uses the action and uploads SARIF", () => {
    const dir = mkdtempSync(join(tmpdir(), "iv-gha-"));
    installGitHubAction({ projectDir: dir });
    const path = join(dir, ".github", "workflows", "integration-verifier.yml");
    expect(existsSync(path)).toBe(true);
    const wf = parse(readFileSync(path, "utf8"));
    expect(readFileSync(path, "utf8")).toBe(GITHUB_WORKFLOW);
    const steps = wf.jobs["integration-verifier"].steps;
    expect(steps.map((s: { uses?: string }) => s.uses)).toEqual(["actions/checkout@v7", "Varun14gk/integration-verifier@main", "github/codeql-action/upload-sarif@v4"]);
    expect(wf.permissions).toEqual({ contents: "read", "security-events": "write" });
  });
});

describe("pre-commit framework hook", () => {
  it("declares the gate on staged files", () => {
    const hooks = parse(readFileSync(join(ROOT, ".pre-commit-hooks.yaml"), "utf8"));
    expect(hooks[0]).toMatchObject({ id: "integration-verifier", entry: "iv check --staged", language: "system", pass_filenames: false });
  });
});
