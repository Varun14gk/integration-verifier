// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import type { Finding } from "../finding.js";

/** Field names of a request body or response. `known: false` means we could not tell. */
export interface FieldSet {
  known: boolean;
  names: string[];
  /** Fields the receiver requires (backend request models only). */
  required?: string[];
  /** Type or model the fields came from. */
  source?: string;
  /** Where that type or model is declared. */
  declaredAt?: { file: string; line: number };
  /** Per-field declaration lines, for evidence in later checks. */
  fieldLines?: Record<string, number>;
  isArray?: boolean;
}

export const UNKNOWN_FIELDS: FieldSet = { known: false, names: [] };

export interface ClientUrl {
  kind: "static" | "dynamic";
  /** Source text of the URL expression. */
  raw: string;
  /** Static: path with params as `{name}`. */
  path?: string;
  /** Static: query parameter names in the URL itself. */
  query?: string[];
}

/** A place where the frontend calls the backend. */
export interface ClientCall {
  id: string;
  unit: string;
  file: string;
  line: number;
  function: string | null;
  client: string;
  method: string;
  url: ClientUrl;
  query: { known: boolean; names: string[] };
  body: FieldSet | null;
  response: FieldSet | null;
}

export interface RouteQueryParam {
  name: string;
  required: boolean;
}

export type Sink =
  | { kind: "store"; name: string; file: string; line: number; via?: string }
  | { kind: "outbound"; host: string; url: string; file: string; line: number };

/** A route the backend exposes. */
export interface ServerRoute {
  id: string;
  unit: string;
  file: string;
  line: number;
  framework: string;
  handler: string | null;
  /** Upper-case method, or `*` for any. */
  method: string;
  /** Full path including prefixes, with the framework's own param syntax. */
  path: string;
  query: { known: boolean; params: RouteQueryParam[] };
  body: FieldSet | null;
  response: FieldSet | null;
  /** True/false when the request has input; null when there is nothing to validate. */
  validated: boolean | null;
  /** Where the evidence for `validated` is (the handler or the body parameter). */
  validationAt?: { file: string; line: number };
  sinks: Sink[];
  /** Whether the handler (or a function it calls) writes a log line; null when unknown. */
  logs?: boolean | null;
}

export type EdgeStatus = "connected" | "not-connected" | "mismatched" | "unverifiable" | "orphan";

export interface Mismatch {
  kind: "method" | "path-params" | "query" | "request-field" | "response-field";
  detail: string;
}

export interface Suggestion {
  route: string;
  method: string;
  path: string;
  confidence: number;
  reason: string;
}

export interface JoinRef {
  kind: string;
  file: string;
  line?: number;
  from?: string;
  to?: string;
}

export interface Edge {
  id: string;
  status: EdgeStatus;
  call?: string;
  route?: string;
  /** Path the backend receives after proxies and rewrites. */
  effectivePath?: string;
  via?: JoinRef;
  mismatches: Mismatch[];
  suggestions: Suggestion[];
  /** Set when a proxy or rewrite, not the call itself, breaks the connection. */
  cause?: "join";
}

export interface MapReport {
  calls: ClientCall[];
  routes: ServerRoute[];
  edges: Edge[];
  findings: Finding[];
  stats: Record<EdgeStatus, number>;
  /** Units we could not analyse, with the reason. */
  skipped: { unit: string; reason: string }[];
}
