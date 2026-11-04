// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Config } from "../config.js";
import { detectStack } from "../detect/detect.js";
import type { StackReport } from "../detect/types.js";
import type { Finding } from "../finding.js";
import { buildFlow, type FlowReport } from "../flow/index.js";
import { toPosix } from "../fs-walk.js";
import { applyGate, type GateResult } from "../gate.js";
import { buildMap } from "../map/index.js";
import type { MapReport } from "../map/types.js";
import { findEngine, type PatternEngine } from "../scan/engine.js";
import { indexUi, missingLogging, missingValidation, outboundNotAllowlisted, overExposure, sensitiveInUrl } from "./analyzers.js";
import { ENGINE_CHECKS, patternFindings } from "./patterns.js";

export { ENGINE_CHECKS, classifyMatch } from "./patterns.js";
export { overExposure, missingValidation, sensitiveInUrl, missingLogging, outboundNotAllowlisted } from "./analyzers.js";

export interface CheckOptions {
  also?: string[];
  /** Only report findings with evidence in these files (paths relative to root, or absolute). */
  files?: string[];
  /** Pass an engine (or null for none) to skip lookup. */
  engine?: PatternEngine | null;
}

export interface CheckReport {
  findings: Finding[];
  gate: GateResult;
  engine: { name: string; version: string } | null;
  /** Checks that did not run, with why. */
  skipped: { check: string; reason: string }[];
  scope: { files: string[] | null };
}

const ORDER = ["critical", "high", "medium", "low", "info"];

/** Runs map, flow and every leak check, then applies the gate. */
export async function runCheck(root: string, config: Config, opts: CheckOptions = {}): Promise<{ stack: StackReport; map: MapReport; flow: FlowReport; report: CheckReport }> {
  const absRoot = resolve(root);
  const stack = detectStack([absRoot, ...(opts.also ?? []).map((d) => resolve(d))]);
  const map = await buildMap(absRoot, { stack });
  const ui = indexUi(absRoot, stack);
  const flow = buildFlow(map, ui, config);
  const scopeFiles = opts.files?.map((f) => toPosix(relative(absRoot, resolve(absRoot, f))));

  const findings: Finding[] = [
    ...map.findings,
    ...overExposure(map, ui, config),
    ...(await outboundNotAllowlisted(absRoot, stack, config)),
    ...missingValidation(map),
    ...sensitiveInUrl(map, config),
    ...missingLogging(absRoot, stack, map),
  ];

  const skipped: CheckReport["skipped"] = [];
  const engine = opts.engine !== undefined ? opts.engine : await findEngine(config.scanner.engine, config.scanner.command);
  if (engine) {
    const targets = scopeFiles ? scopeFiles.filter((f) => existsSync(join(absRoot, f))) : ["."];
    if (targets.length) findings.push(...(await patternFindings(absRoot, config, engine, targets)));
  } else {
    const reason = config.scanner.engine === "none" ? "scanner.engine is none" : "no pattern engine found: install Opengrep or Semgrep CE (see README)";
    for (const check of ENGINE_CHECKS) skipped.push({ check, reason });
  }

  let scoped = findings;
  if (scopeFiles) {
    const set = new Set(scopeFiles);
    scoped = findings.filter((f) => f.evidence.some((e) => e.kind === "code" && set.has(e.file)));
  }
  const unique = [...new Map(scoped.map((f) => [f.id, f])).values()].sort(
    (a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity) || a.id.localeCompare(b.id),
  );
  return {
    stack,
    map,
    flow,
    report: {
      findings: unique,
      gate: applyGate(unique, config),
      engine: engine ? { name: engine.name, version: engine.version } : null,
      skipped,
      scope: { files: scopeFiles ?? null },
    },
  };
}

/** Short terminal summary of a check run. */
export function formatCheckSummary(r: CheckReport): string {
  const counts = ORDER.map((s) => [s, r.gate.open.filter((f) => f.severity === s).length] as const).filter(([, n]) => n > 0);
  const lines = [
    `Integration Verifier: ${r.gate.open.length} open finding${r.gate.open.length === 1 ? "" : "s"}${counts.length ? ` (${counts.map(([s, n]) => `${n} ${s}`).join(", ")})` : ""}${r.gate.dismissed.length ? `, ${r.gate.dismissed.length} dismissed` : ""}`,
    `Engine: ${r.engine ? `${r.engine.name} ${r.engine.version}` : "none"}${r.scope.files ? ` · scope: ${r.scope.files.length} file(s)` : ""}`,
  ];
  for (const f of r.gate.open) {
    const e = f.evidence[0]!;
    lines.push(`  [${f.severity}] ${f.category} ${e.kind === "code" ? `${e.file}:${e.line}` : `${e.method} ${e.url}`}`);
    lines.push(`      ${f.explanation}`);
    if (f.suggestedFix) lines.push(`      fix: ${f.suggestedFix}`);
  }
  if (r.skipped.length) lines.push(`Skipped: ${[...new Set(r.skipped.map((s) => s.check))].join(", ")} (${r.skipped[0]!.reason})`);
  lines.push(r.gate.passed ? "Gate: passed" : `Gate: FAILED (${r.gate.blocking.length} open at or above the failOn severity)`);
  return lines.join("\n") + "\n";
}
