// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { classifyFieldName, type Config } from "../config.js";
import type { Severity } from "../finding.js";

/** Kinds whose exposure is treated as most serious. */
export const HIGH_RISK_KINDS = new Set(["credential", "payment", "government-id"]);

export interface SensitiveName {
  name: string;
  kind: string;
}

/** The sensitive names among `names`, with their kind. */
export function sensitiveNames(names: Iterable<string>, config: Config): SensitiveName[] {
  const out: SensitiveName[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const kind = classifyFieldName(name, config);
    if (kind) out.push({ name, kind });
  }
  return out;
}

/** `high` when any name is high-risk, `low` otherwise. */
export function pickSeverity(found: SensitiveName[], high: Severity, low: Severity): Severity {
  return found.some((f) => HIGH_RISK_KINDS.has(f.kind)) ? high : low;
}

export function describe(found: SensitiveName[]): string {
  return found.map((f) => `${f.name} (${f.kind})`).join(", ");
}
