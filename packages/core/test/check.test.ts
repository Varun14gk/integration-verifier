// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  applyGate, classifyMatch, ConfigSchema, ENGINE_CHECKS, findEngine, FindingSchema, loadConfig, looksLikeSecret, runCheck, splitCode,
  toMarkdown, toSarif, type CheckReport, type Config, type PatternEngine,
} from "@integration-verifier/core";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures");
const ENGINE_CATS = new Set<string>(ENGINE_CHECKS);
const config: Config = ConfigSchema.parse({});

let engine: PatternEngine | null = null;
beforeAll(async () => {
  engine = await findEngine("auto");
  if (!engine && process.env.IV_REQUIRE_ENGINE) throw new Error("IV_REQUIRE_ENGINE is set but no Opengrep/Semgrep was found");
}, 120_000);

function where(f: { evidence: { file?: string; line?: number }[] }): string {
  return `${f.evidence[0]!.file}:${f.evidence[0]!.line}`;
}

describe.each(["react-fastapi", "angular-spring", "nextjs-express"])("iv check on %s", (fixture) => {
  const root = join(FIXTURES, fixture);
  const expected = JSON.parse(readFileSync(join(root, "expected.json"), "utf8"));
  let report: CheckReport;
  beforeAll(async () => {
    const loaded = loadConfig(root);
    if (!loaded.ok) throw new Error("fixture config invalid");
    report = (await runCheck(root, loaded.config, { engine })).report;
  }, 300_000);

  it("reports exactly the planted problems (all phases)", () => {
    const wanted = expected.planted.filter((p: { category: string }) => engine || !ENGINE_CATS.has(p.category));
    const want = wanted.map((p: { category: string; severity: string; evidence: { file: string; line: number } }) => `${p.category} ${p.severity} ${p.evidence.file}:${p.evidence.line}`).sort();
    const got = report.findings.filter((f) => engine || !ENGINE_CATS.has(f.category)).map((f) => `${f.category} ${f.severity} ${where(f)}`).sort();
    expect(got).toEqual(want);
  });

  it("does not report the must-not-report cases", () => {
    for (const m of expected.mustNotReport) {
      expect(report.findings.some((f) => f.category === m.category && where(f) === `${m.evidence.file}:${m.evidence.line}`), m.reason).toBe(false);
    }
  });

  it("every finding is schema-valid and evidenced", () => {
    for (const f of report.findings) expect(FindingSchema.safeParse(f).success, f.id).toBe(true);
  });

  it("never echoes a hardcoded secret in evidence", () => {
    const text = JSON.stringify(report);
    expect(text).not.toContain("4f9c2e7a1b8d3f6e0a5c9b2d7e1f4a8c");
    expect(text).not.toContain("Sup3rS3cretDbPass!");
  });

  it("fails the gate on high-severity findings", () => {
    expect(report.gate.passed).toBe(false);
  });

  it("lists engine checks as skipped when there is no engine", () => {
    expect(report.skipped.length > 0).toBe(engine === null);
  });
});

describe("classifyMatch", () => {
  const m = (ruleId: string) => ({ ruleId, file: "a.ts", line: 3, startOffset: 0, endOffset: 0 });

  it("flags logged secrets but not literal words", () => {
    expect(classifyMatch(m("iv-log-call-js"), 'console.log("bad password for", user.id)', config)).toBeNull();
    expect(classifyMatch(m("iv-log-call-js"), "console.log(`token=${session.accessToken}`)", config)?.severity).toBe("critical");
    expect(classifyMatch(m("iv-log-call-python"), 'log.info(f"hi {user.email}")', config)?.severity).toBe("medium");
  });

  it("checks cookie flags", () => {
    expect(classifyMatch(m("iv-cookie-js"), 'res.cookie("sid", v, { httpOnly: true, secure: true, sameSite: "lax" })', config)).toBeNull();
    expect(classifyMatch(m("iv-cookie-js"), 'res.cookie("sid", v)', config)?.severity).toBe("high");
    expect(classifyMatch(m("iv-cookie-js"), 'document.cookie = "theme=dark; path=/"', config)?.severity).toBe("low");
  });

  it("separates real secrets from placeholders and key names", () => {
    expect(looksLikeSecret("changeme")).toBe(false);
    expect(looksLikeSecret("access_token")).toBe(false);
    expect(looksLikeSecret("${DB_PASSWORD}")).toBe(false);
    expect(looksLikeSecret("Sup3rS3cretDbPass!")).toBe(true);
    expect(classifyMatch(m("iv-secret-assign-js"), 'const TOKEN_KEY = "access_token"', config)).toBeNull();
    expect(classifyMatch(m("iv-secret-config"), "spring.datasource.password=${DB_PASSWORD}", config)).toBeNull();
  });

  it("flags stack traces in error responses", () => {
    expect(classifyMatch(m("iv-error-response-js"), "res.status(500).json({ error: err.stack })", config)?.category).toBe("sensitive-in-error");
  });

  it("splits code from literals but keeps interpolations", () => {
    const { code, literals } = splitCode('log(f"pw={user.password} ok", x)');
    expect(code).toContain("user.password");
    expect(literals[0]).toContain("pw=");
  });
});

describe("gate and reports", () => {
  const finding = {
    id: "hardcoded-secret:a.ts:1", category: "hardcoded-secret" as const, severity: "critical" as const,
    evidence: [{ kind: "code" as const, file: "a.ts", line: 1 }], explanation: "x", confidence: 0.9,
  };
  const low = { ...finding, id: "orphan:b.py:2", category: "orphan" as const, severity: "low" as const, evidence: [{ kind: "code" as const, file: "b.py", line: 2 }] };

  it("dismissals with a reason unblock the gate", () => {
    const cfg = ConfigSchema.parse({ dismissals: [{ findingId: finding.id, reason: "test key, rotated", by: "varun" }] });
    const gate = applyGate([finding, low], cfg);
    expect(gate.passed).toBe(true);
    expect(gate.dismissed[0]!.dismissal.reason).toBe("test key, rotated");
    expect(gate.open).toEqual([low]);
  });

  it("writes Markdown and SARIF with suppressions", () => {
    const cfg = ConfigSchema.parse({ dismissals: [{ findingId: low.id, reason: "used by mobile app" }] });
    const report: CheckReport = { findings: [finding, low], gate: applyGate([finding, low], cfg), engine: null, skipped: [], scope: { files: null } };
    const md = toMarkdown(report);
    expect(md).toContain("Gate: failed");
    expect(md).toContain("used by mobile app");
    const sarif = toSarif(report) as { version: string; runs: { results: { ruleId: string; level: string; suppressions?: unknown[] }[] }[] };
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0]!.results.map((r) => [r.ruleId, r.level, !!r.suppressions])).toEqual([["hardcoded-secret", "error", false], ["orphan", "note", true]]);
  });
});

describe("scoped checks (fast mode)", () => {
  it("only reports findings in the given files", async () => {
    const root = mkdtempSync(join(tmpdir(), "iv-scope-"));
    const files: Record<string, string> = {
      "api/requirements.txt": "fastapi\n",
      "api/a.py": 'from fastapi import FastAPI\napp = FastAPI()\n@app.get("/a")\ndef a(q):\n    return 1\n',
      "api/b.py": 'from fastapi import APIRouter\nr = APIRouter()\n@r.get("/b")\ndef b(q):\n    return 1\n',
    };
    for (const [p, t] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), t);
    }
    const { report } = await runCheck(root, config, { engine: null, files: ["api/b.py"] });
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.findings.every((f) => f.evidence.some((e) => e.kind === "code" && e.file === "api/b.py"))).toBe(true);
  });
});
