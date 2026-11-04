// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { Finding } from "@integration-verifier/core";

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = (err as NodeJS.ErrnoException | null)?.code === "ENOENT" ? 127 : err ? Number((err as { code?: number }).code ?? 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

/** Installed Schemathesis version (major), or null. It is optional and never bundled. */
export async function schemathesisVersion(): Promise<number | null> {
  const r = await run("schemathesis", ["--version"], 30_000);
  const m = /(\d+)\.\d+/.exec(r.stdout + r.stderr);
  return r.code === 0 && m ? Number(m[1]) : null;
}

/** Turns a JUnit report from Schemathesis into findings. */
export function parseJunit(xml: string): Finding[] {
  const out: Finding[] = [];
  for (const m of xml.matchAll(/<testcase\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/testcase>/g)) {
    const name = m[1]!.replace(/&amp;/g, "&").replace(/&quot;/g, '"');
    const failure = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(m[2]!);
    if (!failure) continue;
    const op = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/.exec(name);
    const message = /\bmessage="([^"]*)"/.exec(failure[2] ?? "")?.[1];
    const detail = (message || failure[3] || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim().split("\n")[0]!.slice(0, 300);
    out.push({
      id: `runtime-schema-violation:schemathesis:${name}`,
      category: "runtime-schema-violation",
      severity: /5\d\d|server error|crash/i.test(detail) ? "high" : "medium",
      evidence: [{ kind: "request", method: op?.[1] ?? "GET", url: op?.[2] ?? name }],
      explanation: `Schemathesis: ${name} failed: ${detail || "check failed"}`,
      suggestedFix: "Reproduce with the command Schemathesis prints and fix the handler or the schema.",
      confidence: 0.8,
    });
  }
  return out;
}

/** Runs Schemathesis against `baseUrl` using `schema` (file or URL). */
export async function runSchemathesis(schema: string, baseUrl: string, junitPath: string): Promise<{ findings: Finding[]; note: string }> {
  const major = await schemathesisVersion();
  if (major === null) return { findings: [], note: "schemathesis is not installed (pip install schemathesis)" };
  const args = major >= 4
    ? ["run", schema, "--url", baseUrl, "--report", "junit", "--report-junit-path", junitPath, "--max-examples", "20"]
    : ["run", schema, "--base-url", baseUrl, "--junit-xml", junitPath, "--hypothesis-max-examples", "20"];
  const r = await run("schemathesis", args, 600_000);
  if (!existsSync(junitPath)) return { findings: [], note: `schemathesis exited ${r.code} without a report: ${r.stderr.trim().split("\n").pop() ?? ""}` };
  const findings = parseJunit(readFileSync(junitPath, "utf8"));
  return { findings, note: `schemathesis ${major}.x: ${findings.length} failing operation(s)` };
}
