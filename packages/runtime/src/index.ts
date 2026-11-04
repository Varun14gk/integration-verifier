// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { applyGate, buildMap, detectStack, indexUi, type Config } from "@integration-verifier/core";
import { analyze } from "./analyze.js";
import { crawl } from "./crawl.js";
import { startProcess, waitForUrl, type RunningProcess } from "./processes.js";
import { runSchemathesis } from "./schemathesis.js";
import { readTraces } from "./trace.js";
import type { Observation, RuntimeReport, Step, StepId, TestData } from "./types.js";

export * from "./types.js";
export { analyze, watchedValues } from "./analyze.js";
export { crawl } from "./crawl.js";
export { readTraces, readZip } from "./trace.js";
export { parseJunit, runSchemathesis } from "./schemathesis.js";
export { startProcess, waitForUrl } from "./processes.js";

export class RuntimeConfigError extends Error {}

export interface RuntimeOptions {
  /** Called before every step that needs the running app. Return false to skip it. */
  approve(step: Step): Promise<boolean>;
  /** false: the app is already running; do not start anything. */
  start?: boolean;
  /** Use existing Playwright tests, a crawl, or decide automatically. */
  mode?: "auto" | "crawl" | "tests";
  schemathesis?: boolean;
  maxPages?: number;
  log?: (message: string) => void;
}

/** Loads the test-data file named in config (YAML or JSON). */
export function loadTestData(root: string, config: Config): TestData {
  const file = config.runtime?.testData;
  const raw = file ? (parseYaml(readFileSync(resolve(root, file), "utf8")) as Partial<Record<string, unknown>> | null) ?? {} : {};
  const fields = Object.fromEntries(Object.entries((raw.fields as Record<string, unknown>) ?? {}).map(([k, v]) => [k, String(v)]));
  return {
    fields,
    sensitive: ((raw.sensitive as unknown[]) ?? []).map(String),
    submitForms: raw.submitForms === true,
    maxPages: typeof raw.maxPages === "number" ? raw.maxPages : 20,
    startPaths: ((raw.startPaths as unknown[]) ?? []).map(String),
  };
}

function findPlaywrightConfig(root: string, config: Config, frontendDirs: string[]): string | null {
  if (config.runtime?.playwrightTests) return resolve(root, config.runtime.playwrightTests.cwd);
  for (const d of [...frontendDirs, "."]) {
    const dir = resolve(root, d);
    if (["ts", "js", "mjs", "cjs"].some((e) => existsSync(join(dir, `playwright.config.${e}`)))) return dir;
  }
  return null;
}

/** The steps a run would take, so a caller can show and confirm them first. */
export function planSteps(root: string, config: Config, opts: Pick<RuntimeOptions, "start" | "mode" | "schemathesis"> = {}): Step[] {
  const rt = config.runtime;
  if (!rt || (!rt.backend && !rt.frontend && !rt.startUrl)) throw new RuntimeConfigError("No runtime section in .iv/config.yaml. Add runtime.backend / runtime.frontend (command, cwd, url).");
  const steps: Step[] = [];
  if (opts.start !== false && rt.backend) steps.push({ id: "start-backend", description: `Start the backend: \`${rt.backend.command}\` in ${rt.backend.cwd ?? "."}, wait for ${rt.backend.url}` });
  if (opts.start !== false && rt.frontend) steps.push({ id: "start-frontend", description: `Start the frontend: \`${rt.frontend.command}\` in ${rt.frontend.cwd ?? "."}, wait for ${rt.frontend.url}` });
  const stack = detectStack([root]);
  const testsDir = opts.mode === "crawl" ? null : findPlaywrightConfig(root, config, stack.units.filter((u) => u.role === "frontend").map((u) => u.dir));
  if (testsDir && opts.mode !== "crawl") {
    const cmd = config.runtime?.playwrightTests?.command ?? "npx playwright test";
    steps.push({ id: "run-playwright-tests", description: `Run the existing Playwright tests with tracing: \`${cmd} --trace on\` in ${testsDir}` });
  } else {
    if (opts.mode === "tests") throw new RuntimeConfigError("No playwright.config found and runtime.playwrightTests is not set.");
    const data = loadTestData(root, config);
    steps.push({ id: "browse", description: `Open a headless browser at ${rt.startUrl ?? rt.frontend?.url ?? rt.backend?.url} and visit up to ${data.maxPages} same-origin pages, filling forms with test data` });
    if (data.submitForms) steps.push({ id: "submit-forms", description: "Submit the filled-in forms (testData.submitForms is true)" });
  }
  if (opts.schemathesis) steps.push({ id: "schemathesis", description: "Run Schemathesis against the backend's OpenAPI schema (sends generated requests to the backend)" });
  return steps;
}

function runTests(cwd: string, command: string, outDir: string): Promise<number> {
  return new Promise((done) => {
    const child = spawn(`${command} --trace on --output "${outDir}" --reporter line`, { cwd, shell: true, stdio: "ignore", windowsHide: true });
    child.on("exit", (code) => done(code ?? 1));
  });
}

/** Runs the opt-in runtime verification. Every step is confirmed through `opts.approve`. */
export async function runRuntime(root: string, config: Config, opts: RuntimeOptions): Promise<{ report: RuntimeReport; observation: Observation | null }> {
  const absRoot = resolve(root);
  const log = opts.log ?? (() => undefined);
  const steps = planSteps(absRoot, config, opts);
  const rt = config.runtime!;
  const data = loadTestData(absRoot, config);
  const stack = detectStack([absRoot]);
  const map = await buildMap(absRoot, { stack });
  const ui = indexUi(absRoot, stack);
  const startUrl = rt.startUrl ?? rt.frontend?.url ?? rt.backend!.url;
  const procs: RunningProcess[] = [];
  const done: RuntimeReport["steps"] = [];
  const approved = new Map<StepId, boolean>();
  for (const s of steps) approved.set(s.id, await opts.approve(s));
  const record = (id: StepId, ok: boolean, note?: string) => done.push({ id, approved: approved.get(id) ?? false, ok, ...(note ? { note } : {}) });

  let observation: Observation | null = null;
  const extra: RuntimeReport["findings"] = [];
  try {
    for (const [id, proc] of [["start-backend", rt.backend], ["start-frontend", rt.frontend]] as const) {
      if (!proc || !steps.some((s) => s.id === id)) continue;
      if (!approved.get(id)) {
        record(id, false, "not approved");
        continue;
      }
      log(`Starting ${id.replace("start-", "")}: ${proc.command}`);
      const p = startProcess(id.replace("start-", ""), proc.command, resolve(absRoot, proc.cwd ?? "."));
      procs.push(p);
      const ready = await waitForUrl(proc.url, proc.readyTimeoutMs, p);
      record(id, ready, ready ? undefined : `not reachable at ${proc.url} within ${proc.readyTimeoutMs} ms${p.exited ? " (process exited)" : ""}: ${p.output.slice(-3).join(" | ")}`);
      if (!ready) throw new Error("start failed");
    }
    if (!(await waitForUrl(startUrl, 2000))) {
      for (const s of steps.filter((x) => !done.some((d) => d.id === x.id))) record(s.id, false, `app not reachable at ${startUrl}`);
    } else {
      if (steps.some((s) => s.id === "run-playwright-tests")) {
        if (approved.get("run-playwright-tests")) {
          const out = mkdtempSync(join(tmpdir(), "iv-traces-"));
          try {
            const cwd = findPlaywrightConfig(absRoot, config, stack.units.filter((u) => u.role === "frontend").map((u) => u.dir))!;
            log("Running Playwright tests with tracing");
            const code = await runTests(cwd, rt.playwrightTests?.command ?? "npx playwright test", out);
            observation = readTraces(out);
            record("run-playwright-tests", true, `tests exited ${code}; ${observation.requests.length} requests captured`);
          } finally {
            rmSync(out, { recursive: true, force: true });
          }
        } else record("run-playwright-tests", false, "not approved");
      }
      if (steps.some((s) => s.id === "browse")) {
        if (approved.get("browse")) {
          log(`Browsing from ${startUrl}`);
          observation = await crawl(startUrl, { ...data, maxPages: opts.maxPages ?? data.maxPages }, { submitForms: approved.get("submit-forms") === true });
          record("browse", true, `${observation.pages.length} pages, ${observation.requests.length} requests`);
          if (steps.some((s) => s.id === "submit-forms")) record("submit-forms", approved.get("submit-forms") === true);
        } else record("browse", false, "not approved");
      }
      if (steps.some((s) => s.id === "schemathesis")) {
        if (approved.get("schemathesis")) {
          const base = new URL(rt.backend?.url ?? startUrl).origin;
          const schema = rt.openapi ? (/^https?:/.test(rt.openapi) ? rt.openapi : resolve(absRoot, rt.openapi)) : stack.openapi.files[0] ? resolve(absRoot, stack.openapi.files[0]) : stack.openapi.generatedBy.includes("fastapi") ? `${base}/openapi.json` : null;
          if (!schema) record("schemathesis", false, "no OpenAPI schema found; set runtime.openapi");
          else {
            const junit = join(mkdtempSync(join(tmpdir(), "iv-st-")), "junit.xml");
            const r = await runSchemathesis(schema, base, junit);
            extra.push(...r.findings);
            record("schemathesis", true, r.note);
          }
        } else record("schemathesis", false, "not approved");
      }
    }
  } catch (e) {
    if ((e as Error).message !== "start failed") throw e;
  } finally {
    if (observation) for (const p of procs) for (const line of p.output) observation.serverOutput.push({ process: p.name, line });
    await Promise.all(procs.map((p) => p.stop()));
  }

  const analysis = observation
    ? analyze(observation, map, stack, ui, config, data, rt.frontend ? new URL(rt.frontend.url).origin : new URL(startUrl).origin)
    : { findings: [], confirmedEdges: [], requests: [] };
  const findings = [...analysis.findings, ...extra];
  return {
    report: {
      mode: observation?.mode ?? "none",
      steps: done,
      pages: observation?.pages ?? [],
      requests: analysis.requests,
      confirmedEdges: analysis.confirmedEdges,
      findings,
      gate: applyGate(findings, config),
    },
    observation,
  };
}
