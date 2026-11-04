// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import type { Config } from "./config.js";
import { severityAtLeast, type Finding } from "./finding.js";

export interface GateResult {
  /** Findings not dismissed. */
  open: Finding[];
  /** Findings dismissed in config, with the recorded reason. */
  dismissed: (Finding & { dismissal: { reason: string; by?: string; date?: string } })[];
  /** Open findings at or above `gate.failOn`. */
  blocking: Finding[];
  passed: boolean;
}

/** Applies dismissals and the severity threshold from config. */
export function applyGate(findings: Finding[], config: Config): GateResult {
  const byId = new Map(config.dismissals.map((d) => [d.findingId, d]));
  const open: Finding[] = [];
  const dismissed: GateResult["dismissed"] = [];
  for (const f of findings) {
    const d = byId.get(f.id);
    if (d) dismissed.push({ ...f, dismissal: { reason: d.reason, ...(d.by ? { by: d.by } : {}), ...(d.date ? { date: d.date } : {}) } });
    else open.push(f);
  }
  const blocking = open.filter((f) => severityAtLeast(f.severity, config.gate.failOn));
  return { open, dismissed, blocking, passed: blocking.length === 0 };
}
