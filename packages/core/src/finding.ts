// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export const SeveritySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof SeveritySchema>;

export const CATEGORIES = [
  // Phase 1: integration map
  "not-connected",
  "mismatched",
  "unverifiable",
  "orphan",
  // Phase 2: data flow and leaks
  "over-exposure",
  "sensitive-in-logs",
  "sensitive-in-url",
  "sensitive-in-client-storage",
  "insecure-cookie",
  "sensitive-in-error",
  "hardcoded-secret",
  "outbound-not-allowlisted",
  "missing-validation",
  "missing-logging",
  // Phase 3: runtime
  "runtime-unmapped-request",
  "runtime-failed-request",
  "runtime-schema-violation",
  "runtime-sensitive-exposure",
] as const;
export const CategorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof CategorySchema>;

/** Evidence from static analysis: a location in the user's code. */
export const CodeEvidenceSchema = z.object({
  kind: z.literal("code"),
  file: z.string().min(1),
  line: z.number().int().positive(),
  column: z.number().int().positive().optional(),
  snippet: z.string().optional(),
});

/** Evidence from runtime verification: a captured network request. */
export const RequestEvidenceSchema = z.object({
  kind: z.literal("request"),
  method: z.string().min(1),
  url: z.string().min(1),
  status: z.number().int().optional(),
  captureId: z.string().optional(),
});

/** Evidence from runtime verification that is not a request: console, storage, cookies, server output. */
export const ObservationEvidenceSchema = z.object({
  kind: z.literal("observation"),
  source: z.enum(["console", "local-storage", "session-storage", "cookie", "server-output", "response"]),
  /** Page URL or process name where it was observed. */
  location: z.string().min(1),
  detail: z.string().optional(),
});

export const EvidenceSchema = z.discriminatedUnion("kind", [CodeEvidenceSchema, RequestEvidenceSchema, ObservationEvidenceSchema]);
export type Evidence = z.infer<typeof EvidenceSchema>;

export const FindingSchema = z.object({
  /** Stable id, so a finding can be dismissed and still recognised on the next run. */
  id: z.string().min(1),
  category: CategorySchema,
  severity: SeveritySchema,
  /** At least one piece of evidence. Findings without evidence are not allowed. */
  evidence: z.array(EvidenceSchema).min(1),
  explanation: z.string().min(1),
  /** A suggestion for the coder. The tool never applies it. */
  suggestedFix: z.string().optional(),
  /** 0..1: how sure the analysis is that this is a real problem. */
  confidence: z.number().min(0).max(1),
});
export type Finding = z.infer<typeof FindingSchema>;

const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

/** True when `severity` is at least as serious as `threshold`. */
export function severityAtLeast(severity: Severity, threshold: Severity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[threshold];
}
