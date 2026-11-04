// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import type { MapReport } from "./types.js";

const ICON: Record<string, string> = { connected: "ok", "not-connected": "!!", mismatched: "!=", unverifiable: "??", orphan: "--" };

/** Short human summary of the integration map. */
export function formatMapSummary(map: MapReport): string {
  const s = map.stats;
  const lines = [
    `Integration map: ${map.calls.length} frontend calls, ${map.routes.length} backend routes`,
    `  connected ${s.connected} · not connected ${s["not-connected"]} · mismatched ${s.mismatched} · unverifiable ${s.unverifiable} · orphan ${s.orphan}`,
  ];
  const order = ["critical", "high", "medium", "low", "info"];
  const findings = [...map.findings].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  if (findings.length) lines.push("");
  for (const f of findings) {
    const ev = f.evidence[0]!;
    const where = ev.kind === "code" ? `${ev.file}:${ev.line}` : `${ev.method} ${ev.url}`;
    lines.push(`${ICON[f.category] ?? "  "} [${f.severity}] ${f.category} ${where}`);
    lines.push(`   ${f.explanation}`);
    if (f.suggestedFix) lines.push(`   suggestion (${Math.round(f.confidence * 100)}%): ${f.suggestedFix}`);
  }
  for (const s of map.skipped) lines.push(`skipped ${s.unit}: ${s.reason}`);
  return lines.join("\n") + "\n";
}
