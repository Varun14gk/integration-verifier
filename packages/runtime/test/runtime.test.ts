// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema, FindingSchema, loadConfig, type Config } from "@integration-verifier/core";
import { parseJunit, planSteps, runRuntime, RuntimeConfigError, watchedValues, type RuntimeReport } from "@integration-verifier/runtime";

const APP = join(import.meta.dirname, "app");
const browser = process.env.IV_SKIP_BROWSER ? describe.skip : describe;

function appConfig(): Config {
  const loaded = loadConfig(APP);
  if (!loaded.ok) throw new Error("test app config invalid");
  return loaded.config;
}

function cats(r: RuntimeReport): string[] {
  return r.findings.map((f) => `${f.category} ${f.severity} ${f.evidence[0]!.kind === "request" ? (f.evidence[0] as { url: string }).url : (f.evidence[0] as { source: string }).source}`).sort();
}

describe("planning", () => {
  it("refuses to run without a runtime section", () => {
    expect(() => planSteps(APP, ConfigSchema.parse({}))).toThrow(RuntimeConfigError);
  });

  it("lists every step that needs the running app", () => {
    expect(planSteps(APP, appConfig(), { mode: "crawl" }).map((s) => s.id)).toEqual(["start-backend", "browse", "submit-forms"]);
    expect(planSteps(APP, appConfig(), { mode: "auto" }).map((s) => s.id)).toEqual(["start-backend", "run-playwright-tests"]);
    expect(planSteps(APP, appConfig(), { mode: "crawl", start: false, schemathesis: true }).map((s) => s.id)).toEqual(["browse", "submit-forms", "schemathesis"]);
  });

  it("watches sensitive test values only", () => {
    const w = watchedValues({ fields: { email: "a@b.co", password: "pw-123456", city: "Pune" }, sensitive: ["s3cr3t-value"], submitForms: false, maxPages: 1, startPaths: [] }, ConfigSchema.parse({}));
    expect(w.map((x) => x.label).sort()).toEqual(["email", "password", "sensitive value"]);
  });

  it("parses Schemathesis JUnit failures", () => {
    const xml = `<testsuite><testcase name="GET /api/users"><failure message="Server error: 500"/></testcase><testcase name="POST /api/x"></testcase></testsuite>`;
    const f = parseJunit(xml);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ category: "runtime-schema-violation", severity: "high", evidence: [{ kind: "request", method: "GET", url: "/api/users" }] });
  });
});

browser("running the test app", () => {
  it("does nothing that was not approved", async () => {
    const asked: string[] = [];
    const { report, observation } = await runRuntime(APP, appConfig(), { mode: "crawl", approve: async (s) => (asked.push(s.id), false) });
    expect(asked).toEqual(["start-backend", "browse", "submit-forms"]);
    expect(observation).toBeNull();
    expect(report.findings).toEqual([]);
    expect(report.steps.every((s) => !s.approved)).toBe(true);
  }, 60_000);

  it("crawl: confirms edges and finds every planted runtime problem", async () => {
    const { report } = await runRuntime(APP, appConfig(), { mode: "crawl", approve: async () => true });
    expect(report.steps.map((s) => [s.id, s.ok])).toEqual([["start-backend", true], ["browse", true], ["submit-forms", true]]);
    expect(report.confirmedEdges).toHaveLength(2);
    expect(cats(report)).toEqual([
      "runtime-failed-request high /api/stats",
      "runtime-sensitive-exposure critical server-output",
      "runtime-sensitive-exposure high /api/users",
      "runtime-sensitive-exposure high cookie",
      "runtime-sensitive-exposure high local-storage",
      "runtime-sensitive-exposure medium console",
      "runtime-sensitive-exposure medium server-output",
      "runtime-unmapped-request medium /api/stats",
    ]);
    for (const f of report.findings) expect(FindingSchema.safeParse(f).success, f.id).toBe(true);
    expect(JSON.stringify(report)).not.toContain("Iv-Test-Pa55word!");
    expect(report.gate.passed).toBe(false);
  }, 120_000);

  it("tests mode: reads the app's own Playwright traces", async () => {
    const { report } = await runRuntime(APP, appConfig(), { mode: "tests", approve: async () => true });
    expect(report.mode).toBe("playwright-tests");
    expect(report.confirmedEdges).toHaveLength(2);
    expect(cats(report)).toEqual(expect.arrayContaining([
      "runtime-unmapped-request medium /api/stats",
      "runtime-sensitive-exposure high /api/users",
      "runtime-sensitive-exposure critical server-output",
      "runtime-sensitive-exposure medium console",
    ]));
  }, 180_000);
});
