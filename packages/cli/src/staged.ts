// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyGate, loadConfig, runCheck, type Finding } from "@integration-verifier/core";

type CheckResult = Awaited<ReturnType<typeof runCheck>>;

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...env } });
}

const fwd = (p: string) => p.replace(/\\/g, "/");

/** Every staged path (any status, deletions included), relative to `root`; null outside git. */
export function stagedPaths(root: string): string[] | null {
  const r = git(root, ["diff", "--cached", "--name-only", "--relative", "-z"]);
  return r.status === 0 ? r.stdout.split("\0").filter(Boolean) : null;
}

/**
 * Writes a tree of the repository into `dir`: the staged index, or HEAD. A temporary
 * index file is used for HEAD, so the user's own index and working tree are never touched.
 */
function exportTree(repoCwd: string, what: "index" | "HEAD", dir: string, scratch: string): boolean {
  const prefix = `${fwd(dir)}/`;
  if (what === "index") return git(repoCwd, ["checkout-index", "--all", "--force", `--prefix=${prefix}`]).status === 0;
  const env = { GIT_INDEX_FILE: join(scratch, "head.index") };
  if (git(repoCwd, ["read-tree", "HEAD"], env).status !== 0) return false;
  return git(repoCwd, ["checkout-index", "--all", "--force", `--prefix=${prefix}`], env).status === 0;
}

/** Identity of a finding that survives line shifts between two versions of the code. */
function findingKey(f: Finding): string {
  const e = f.evidence[0]!;
  const where = e.kind === "code" ? e.file : e.kind === "request" ? `${e.method} ${e.url}` : `${e.source} ${e.location}`;
  const what = (e.kind === "code" && e.snippet) || f.explanation.replace(/:\d+/g, "");
  return `${f.category}|${where}|${what}`;
}

export interface StagedCheck {
  result: CheckResult;
  staged: string[];
  /** How many reported findings are new in this commit outside the staged files. */
  newElsewhere: number;
  notes: string[];
}

/**
 * Checks what is about to be committed. Both the staged index and HEAD are analysed in
 * full, and the report holds the findings in staged files plus every finding that is new
 * in this commit anywhere in the project: deleting a backend route reports the frontend
 * call it breaks, even though that file is not staged.
 */
export async function checkStaged(root: string, opts: { engine: boolean; also?: string[] }): Promise<StagedCheck | { error: string } | { nothing: true }> {
  const staged = stagedPaths(root);
  if (staged === null) return { error: "--staged needs a git repository." };
  if (!staged.length) return { nothing: true };
  const prefix = git(root, ["rev-parse", "--show-prefix"]).stdout.trim();
  const scratch = mkdtempSync(join(tmpdir(), "iv-staged-"));
  try {
    const indexDir = join(scratch, "index");
    if (!exportTree(root, "index", indexDir, scratch)) return { error: "could not export the staged files (git checkout-index failed)." };
    const indexRoot = join(indexDir, prefix);
    const notes: string[] = [];
    if (existsSync(join(root, ".iv", "config.yaml")) && !existsSync(join(indexRoot, ".iv", "config.yaml"))) {
      notes.push(".iv/config.yaml is not committed or staged, so defaults were used for this check.");
    }
    const loaded = loadConfig(indexRoot);
    if (!loaded.ok) return { error: `the staged .iv/config.yaml is invalid: ${loaded.issues.map((i) => i.message).join("; ")}` };
    const runOpts = { ...(opts.also ? { also: opts.also } : {}), ...(opts.engine ? {} : { engine: null }) };
    const result = await runCheck(indexRoot, loaded.config, runOpts);

    const headDir = join(scratch, "head");
    let headKeys: Set<string> | null = null;
    if (exportTree(root, "HEAD", headDir, scratch)) {
      const headRoot = join(headDir, prefix);
      if (existsSync(headRoot)) {
        const headLoaded = loadConfig(headRoot);
        const head = await runCheck(headRoot, headLoaded.ok ? headLoaded.config : loaded.config, runOpts);
        headKeys = new Set(head.report.findings.map(findingKey));
      }
    } else {
      notes.push("No previous commit: every finding counts as new.");
    }

    const stagedSet = new Set(staged);
    const inStaged = (f: Finding) => f.evidence.some((e) => e.kind === "code" && stagedSet.has(e.file));
    const isNew = (f: Finding) => headKeys === null || !headKeys.has(findingKey(f));
    const scoped = result.report.findings.filter((f) => inStaged(f) || isNew(f));
    result.report = { ...result.report, findings: scoped, gate: applyGate(scoped, loaded.config), scope: { files: staged } };
    return { result, staged, newElsewhere: scoped.filter((f) => !inStaged(f)).length, notes };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
