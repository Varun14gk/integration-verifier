// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

/** Where a detection came from. `file` is relative to the primary root. */
export interface DetectEvidence {
  file: string;
  line?: number;
  reason: string;
}

export interface Detected {
  name: string;
  /** 0..1. Manifest dependencies are high; source-pattern guesses are lower. */
  confidence: number;
  evidence: DetectEvidence[];
  /** False for things we recognise but cannot analyse yet. */
  supported: boolean;
}

export type Role = "frontend" | "backend" | "fullstack" | "unknown";

/** One app or service: a folder with its own manifest. */
export interface StackUnit {
  dir: string;
  role: Role;
  language: string;
  languages: string[];
  packageManager: string | null;
  framework: string | null;
  frameworks: Detected[];
  bundler: string | null;
  httpClient: string | null;
  httpClients: Detected[];
  schema: string | null;
  schemaSources: Detected[];
  dataStores: Detected[];
  orms: Detected[];
}

export type JoinKind = "env" | "dev-proxy" | "nextjs-rewrite" | "package-proxy";

/** Something that connects the frontend to the backend: a base URL, proxy or rewrite. */
export interface StackJoin {
  kind: JoinKind;
  unit: string;
  file: string;
  line?: number;
  /** env: variable name. */
  name?: string;
  /** env: value from a .env file, when present. */
  value?: string;
  /** proxy/rewrite: path pattern on the frontend side. */
  from?: string;
  /** proxy/rewrite: where it is sent. */
  to?: string;
}

export interface OutboundHost {
  host: string;
  url: string;
  unit: string;
  file: string;
  line: number;
}

export interface StackReport {
  roots: string[];
  units: StackUnit[];
  apiStyles: Detected[];
  openapi: { files: string[]; generatedBy: string[] };
  joins: StackJoin[];
  outbound: OutboundHost[];
  unsupported: { dir: string; reason: string }[];
  lowConfidence: { unit: string; what: string; name: string; confidence: number }[];
}
