// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import type { Finding, GateResult } from "@integration-verifier/core";

export interface CapturedRequest {
  id: string;
  method: string;
  url: string;
  resourceType: string;
  status: number | null;
  failure?: string;
  requestBody?: string;
  responseBody?: string;
  contentType?: string;
  /** Page that issued the request. */
  page: string;
}

export interface Observation {
  mode: "crawl" | "playwright-tests";
  pages: string[];
  requests: CapturedRequest[];
  console: { type: string; text: string; page: string }[];
  storage: { kind: "local-storage" | "session-storage"; key: string; value: string; page: string }[];
  cookies: { name: string; value: string; httpOnly: boolean; secure: boolean; sameSite: string; domain: string }[];
  serverOutput: { process: string; line: string }[];
}

/** Values typed into forms, and values that must never leak. */
export interface TestData {
  fields: Record<string, string>;
  sensitive: string[];
  submitForms: boolean;
  maxPages: number;
  startPaths: string[];
}

export type StepId = "start-backend" | "start-frontend" | "browse" | "submit-forms" | "run-playwright-tests" | "schemathesis";

export interface Step {
  id: StepId;
  description: string;
}

export interface RuntimeReport {
  mode: Observation["mode"] | "none";
  steps: { id: StepId; approved: boolean; ok: boolean; note?: string }[];
  pages: string[];
  requests: { method: string; url: string; status: number | null; route: string | null }[];
  /** Static edges confirmed by an observed request. */
  confirmedEdges: string[];
  findings: Finding[];
  gate: GateResult;
}
