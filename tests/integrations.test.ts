// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { githubWorkflow, installGitHook, installGitHubAction, uninstallGitHook } from "../packages/cli/src/install.js";

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
  return spawnSync("git", ["commit", "-q", "-m", message], { cwd: dir, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "", GEMINI_PROJECT_DIR: "", IV_CLI: CLI } });
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
    expect(Object.keys(action.inputs)).toEqual(["root", "engine", "semgrep-version", "fail-on-findings", "sarif"]);
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
    expect(readFileSync(path, "utf8")).toBe(githubWorkflow());
    const steps = wf.jobs["integration-verifier"].steps;
    expect(steps.map((s: { uses?: string }) => s.uses)).toEqual(["actions/checkout@v7", expect.stringMatching(/^Varun14gk\/integration-verifier@[0-9a-f]{40}$/), "github/codeql-action/upload-sarif@v4"]);
    expect(wf.permissions).toEqual({ contents: "read", "security-events": "write" });
  });
});

describe("pre-commit framework hook", () => {
  it("declares the gate on staged files", () => {
    const hooks = parse(readFileSync(join(ROOT, ".pre-commit-hooks.yaml"), "utf8"));
    expect(hooks[0]).toMatchObject({ id: "integration-verifier", entry: "iv check --staged", language: "system", pass_filenames: false });
  });
});

describe("--staged checks what is committed, including breaks elsewhere", () => {
  it("blocks deleting a backend route that an unstaged frontend file still calls", () => {
    const dir = repoFromFixture("critical");
    spawnSync("git", ["add", "-A"], { cwd: dir });
    expect(commit(dir, "base").status).toBe(0);
    writeFileSync(join(dir, ".iv", "config.yaml"), "version: 1\nscanner:\n  engine: none\ngate:\n  failOn: high\n");
    spawnSync("git", ["add", ".iv/config.yaml"], { cwd: dir });
    spawnSync("git", ["commit", "-q", "--no-verify", "-m", "gate on high"], { cwd: dir });
    installGitHook({ projectDir: dir });
    // Delete the GET /api/users/{user_id} route; only the backend file is staged.
    const routes = join(dir, "backend", "app", "routes", "users.py");
    writeFileSync(routes, readFileSync(routes, "utf8").replace(/@router\.get\("\/\{user_id\}"[\s\S]*?\n\n\n/, ""));
    spawnSync("git", ["add", "backend/app/routes/users.py"], { cwd: dir });
    const blocked = commit(dir, "remove route");
    expect(blocked.status).not.toBe(0);
    // The frontend call to the deleted route (getUser) is reported, though users.ts is not staged.
    const expected = JSON.parse(readFileSync(join(ROOT, "fixtures", "react-fastapi", "expected.json"), "utf8"));
    const getUser = expected.connected.find((c: { path: string; method: string }) => c.method === "GET" && c.path === "/api/users/{}").frontend;
    expect(blocked.stdout + blocked.stderr).toContain(`${getUser.file}:${getUser.line}`);
  }, 300_000);

  it("analyses the staged content, not unstaged edits", () => {
    const dir = repoFromFixture("high");
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync("git", ["commit", "-q", "--no-verify", "-m", "base"], { cwd: dir });
    writeFileSync(join(dir, "notes.txt"), "x\n");
    spawnSync("git", ["add", "notes.txt"], { cwd: dir });
    // An unstaged edit that would break a call must not affect this commit's check.
    const api = join(dir, "frontend", "src", "api", "users.ts");
    writeFileSync(api, readFileSync(api, "utf8").replace('"/api/users"', '"/api/nope"'));
    const r = spawnSync(process.execPath, [CLI, "check", "--root", dir, "--staged"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("0 open findings");
  }, 240_000);
});

describe("git hook install", () => {
  it("checks the project at --root, supports several projects, and uninstalls one at a time", () => {
    const top = mkdtempSync(join(tmpdir(), "iv-mono-"));
    spawnSync("git", ["init", "-q"], { cwd: top });
    for (const app of ["apps/web", "apps/admin"]) {
      cpSync(join(ROOT, "fixtures", "react-fastapi"), join(top, app), { recursive: true });
      installGitHook({ projectDir: join(top, app) });
    }
    const hookPath = join(top, ".git", "hooks", "pre-commit");
    const hook = readFileSync(hookPath, "utf8");
    expect(hook).toContain('--root "$TOP/apps/admin" --staged');
    expect(hook).toContain('--root "$TOP/apps/web" --staged');
    expect(hook).toContain('NODE="$(command -v node 2>/dev/null)"');
    uninstallGitHook({ projectDir: join(top, "apps/web") });
    expect(readFileSync(hookPath, "utf8")).not.toContain("apps/web");
    uninstallGitHook({ projectDir: join(top, "apps/admin") });
    expect(existsSync(hookPath)).toBe(false);
  });
});

describe("the action's gate step", () => {
  const action = parse(readFileSync(join(ROOT, "action.yml"), "utf8"));
  const gate = action.runs.steps.find((s: { name?: string }) => s.name === "Gate");
  const runGate = (code: string, failOnFindings: string) =>
    spawnSync("bash", ["-c", gate.run], { encoding: "utf8", env: { ...process.env, IV_CODE: code, IV_FAIL_ON_FINDINGS: failOnFindings } }).status;

  it.skipIf(spawnSync("bash", ["--version"]).status !== 0)("passes on 0, honours fail-on-findings for 1, and always fails on errors", () => {
    expect(runGate("0", "true")).toBe(0);
    expect(runGate("1", "true")).toBe(1);
    expect(runGate("1", "false")).toBe(0);
    expect(runGate("2", "false")).toBe(1);
    expect(runGate("4", "false")).toBe(1);
    expect(runGate("", "false")).toBe(1);
  });

  it("pins Semgrep and only reports when check wrote results", () => {
    const install = action.runs.steps.find((s: { name?: string }) => s.name === "Install Semgrep CE");
    expect(install.run).toContain('"semgrep==$IV_SEMGREP_VERSION"');
    const report = action.runs.steps.find((s: { id?: string }) => s.id === "report");
    expect(report.run).toContain(".iv/check.json");
    expect(report.run).toContain("mkdir -p");
  });
});

describe("GitHub workflow install", () => {
  it("never replaces a workflow it did not write, and skips SARIF upload on fork PRs", () => {
    const dir = mkdtempSync(join(tmpdir(), "iv-gha-"));
    installGitHubAction({ projectDir: dir });
    const wf = readFileSync(join(dir, ".github", "workflows", "integration-verifier.yml"), "utf8");
    expect(wf).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(wf).toContain('semgrep-version: "1.183.0"');
    writeFileSync(join(dir, ".github", "workflows", "integration-verifier.yml"), "name: mine\n");
    expect(() => installGitHubAction({ projectDir: dir })).toThrow(/not written by Integration Verifier/);
  });
});
