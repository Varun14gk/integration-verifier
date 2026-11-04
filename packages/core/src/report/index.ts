// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { CATEGORIES, type Finding } from "../finding.js";
import type { CheckReport } from "../check/index.js";
import { TOOL_NAME, VERSION } from "../version.js";

const REPO_URL = "https://github.com/Varun14gk/integration-verifier";

const CATEGORY_TITLE: Record<string, string> = {
  "not-connected": "Frontend calls a route the backend does not expose",
  mismatched: "Route exists but method, params or fields differ",
  unverifiable: "URL is built at runtime",
  orphan: "Backend route no frontend calls",
  "over-exposure": "Sensitive field returned but never used by the UI",
  "sensitive-in-logs": "Sensitive value written to logs",
  "sensitive-in-url": "Sensitive value in a URL or query string",
  "sensitive-in-client-storage": "Sensitive value in browser storage",
  "insecure-cookie": "Cookie without security flags",
  "sensitive-in-error": "Sensitive value in an error response",
  "hardcoded-secret": "Hardcoded secret",
  "outbound-not-allowlisted": "Outbound call to a host not on the allowlist",
  "missing-validation": "Route without input validation",
  "missing-logging": "Routes without logging or tracing",
  "runtime-unmapped-request": "Observed request to an unmapped route",
  "runtime-failed-request": "Observed request failed",
  "runtime-schema-violation": "Observed response violates the schema",
  "runtime-sensitive-exposure": "Sensitive value observed at runtime",
};

function where(f: Finding): string {
  const e = f.evidence[0]!;
  return e.kind === "code" ? `${e.file}:${e.line}` : `${e.method} ${e.url}${e.status ? ` (${e.status})` : ""}`;
}

function esc(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Markdown report for humans. */
export function toMarkdown(r: CheckReport, generatedAt = new Date()): string {
  const out: string[] = ["# Integration Verifier report", ""];
  out.push(`Generated ${generatedAt.toISOString()} by ${TOOL_NAME} ${VERSION}. Engine: ${r.engine ? `${r.engine.name} ${r.engine.version}` : "none"}.`, "");
  out.push(`**Gate: ${r.gate.passed ? "passed" : "failed"}** · ${r.gate.open.length} open · ${r.gate.blocking.length} blocking · ${r.gate.dismissed.length} dismissed`, "");
  if (r.skipped.length) out.push(`> Skipped checks: ${[...new Set(r.skipped.map((s) => s.check))].join(", ")} (${r.skipped[0]!.reason}).`, "");
  out.push("| Severity | Category | Where | Confidence |", "|---|---|---|---|");
  for (const f of r.gate.open) out.push(`| ${f.severity} | ${f.category} | \`${esc(where(f))}\` | ${Math.round(f.confidence * 100)}% |`);
  out.push("");
  for (const f of r.gate.open) {
    out.push(`## ${f.severity.toUpperCase()}: ${CATEGORY_TITLE[f.category] ?? f.category}`, "");
    out.push(`- **Where:** \`${where(f)}\``, `- **Finding id:** \`${f.id}\``, `- **Confidence:** ${Math.round(f.confidence * 100)}%`, "");
    out.push(f.explanation, "");
    if (f.suggestedFix) out.push(`**Suggested fix:** ${f.suggestedFix}`, "");
    if (f.evidence.length > 1) {
      out.push("Evidence:");
      for (const e of f.evidence) out.push(`- ${e.kind === "code" ? `\`${e.file}:${e.line}\`${e.snippet ? `: \`${esc(e.snippet)}\`` : ""}` : `${e.method} ${e.url}`}`);
      out.push("");
    }
  }
  if (r.gate.dismissed.length) {
    out.push("## Dismissed", "", "| Finding | Reason | By |", "|---|---|---|");
    for (const d of r.gate.dismissed) out.push(`| \`${d.id}\` | ${esc(d.dismissal.reason)} | ${d.dismissal.by ?? ""} |`);
    out.push("");
  }
  out.push("_Suggestions are not applied automatically. Dismiss a finding by adding it to `dismissals` in `.iv/config.yaml` with a reason._", "");
  return out.join("\n");
}

const LEVEL: Record<string, "error" | "warning" | "note"> = { critical: "error", high: "error", medium: "warning", low: "note", info: "note" };

/** SARIF 2.1.0 for code-scanning tools. Dismissed findings carry a suppression. */
export function toSarif(r: CheckReport): object {
  const result = (f: Finding, suppression?: string) => {
    const code = f.evidence.filter((e) => e.kind === "code");
    const primary = code[0];
    return {
      ruleId: f.category,
      level: LEVEL[f.severity],
      message: { text: f.explanation + (f.suggestedFix ? ` Suggested fix: ${f.suggestedFix}` : "") },
      ...(primary ? { locations: [{ physicalLocation: { artifactLocation: { uri: primary.file }, region: { startLine: primary.line } } }] } : {}),
      ...(code.length > 1 ? { relatedLocations: code.slice(1).map((e, i) => ({ id: i + 1, physicalLocation: { artifactLocation: { uri: e.file }, region: { startLine: e.line } }, message: { text: e.snippet ?? "" } })) } : {}),
      partialFingerprints: { ivFindingId: f.id },
      properties: { severity: f.severity, confidence: f.confidence, ...(f.suggestedFix ? { suggestedFix: f.suggestedFix } : {}) },
      ...(suppression !== undefined ? { suppressions: [{ kind: "external", justification: suppression }] } : {}),
    };
  };
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: TOOL_NAME,
            version: VERSION,
            informationUri: REPO_URL,
            rules: CATEGORIES.map((c) => ({ id: c, name: c, shortDescription: { text: CATEGORY_TITLE[c] ?? c }, helpUri: `${REPO_URL}#${c}` })),
          },
        },
        results: [...r.gate.open.map((f) => result(f)), ...r.gate.dismissed.map((d) => result(d, d.dismissal.reason))],
      },
    ],
  };
}
