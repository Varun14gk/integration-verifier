// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { SeveritySchema } from "./finding.js";

export const IV_DIR = ".iv";
export const CONFIG_FILE = "config.yaml";

/** Built-in sensitive-field name patterns (case-insensitive regex), grouped by kind. */
export const DEFAULT_SENSITIVE_PATTERNS: Record<string, string[]> = {
  credential: [
    "pass(word|wd)?",
    "pwd",
    "secret",
    "token",
    "api_?key",
    "access_?key",
    "private_?key",
    "client_?secret",
    "session_?id",
    "auth(orization)?",
  ],
  contact: ["e_?mail", "phone", "mobile"],
  "government-id": ["ssn", "national_?id", "passport", "tax_?id"],
  payment: ["card_?number", "cc_?num", "cvv", "cvc", "iban", "account_?number"],
  personal: ["date_?of_?birth", "dob"],
};

const RuntimeProcessSchema = z.strictObject({
  command: z.string().min(1),
  cwd: z.string().optional(),
  /** URL polled until it responds, which means the process is ready. */
  url: z.url(),
  readyTimeoutMs: z.number().int().positive().default(60_000),
});

const DismissalSchema = z.strictObject({
  findingId: z.string().min(1),
  reason: z.string().min(1),
  by: z.string().optional(),
  date: z.string().optional(),
});

export const ConfigSchema = z.strictObject({
  version: z.literal(1).default(1),
  sensitive: z
    .strictObject({
      /** Extra patterns, added to the built-in ones, keyed by kind. */
      patterns: z.record(z.string(), z.array(z.string())).default({}),
      /** Field names that should never be treated as sensitive. */
      ignore: z.array(z.string()).default([]),
    })
    .default({ patterns: {}, ignore: [] }),
  outbound: z
    .strictObject({
      /** Hosts the backend is allowed to call. Anything else is reported. */
      allowlist: z.array(z.string()).default([]),
    })
    .default({ allowlist: [] }),
  scanner: z
    .strictObject({
      /** Pattern engine installed on the user's machine. `auto` picks whichever is found. */
      engine: z.enum(["auto", "opengrep", "semgrep", "none"]).default("auto"),
      /** Path to the engine binary, when it is not on PATH. */
      command: z.string().optional(),
    })
    .default({ engine: "auto" }),
  runtime: z
    .strictObject({
      frontend: RuntimeProcessSchema.optional(),
      backend: RuntimeProcessSchema.optional(),
      /** Where the browser starts; defaults to the frontend (or backend) url. */
      startUrl: z.url().optional(),
      /** File with test data (form values, sensitive values to watch for). */
      testData: z.string().optional(),
      /** Existing Playwright tests to drive the flows instead of a crawl. */
      playwrightTests: z.strictObject({ cwd: z.string().default("."), command: z.string().optional() }).optional(),
      /** OpenAPI schema (file or URL) for the optional Schemathesis run. */
      openapi: z.string().optional(),
    })
    .optional(),
  gate: z
    .strictObject({
      /** The Stop hook and CI fail while findings at or above this severity are open. */
      failOn: SeveritySchema.default("high"),
    })
    .default({ failOn: "high" }),
  dismissals: z.array(DismissalSchema).default([]),
});

export type Config = z.infer<typeof ConfigSchema>;

export interface ConfigIssue {
  path: string;
  message: string;
  line?: number;
}

export type LoadConfigResult =
  | { ok: true; config: Config; source: string | null }
  | { ok: false; issues: ConfigIssue[]; source: string };

export function configPath(root: string): string {
  return join(root, IV_DIR, CONFIG_FILE);
}

/** Parses config YAML text. `source` is used only for messages. */
export function parseConfig(text: string, source: string): LoadConfigResult {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    return {
      ok: false,
      source,
      issues: doc.errors.map((e) => ({
        path: "",
        message: e.message.split("\n")[0] ?? e.message,
        line: e.linePos?.[0]?.line,
      })),
    };
  }
  const result = ConfigSchema.safeParse(doc.toJS() ?? {});
  if (!result.success) {
    return {
      ok: false,
      source,
      issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    };
  }
  return { ok: true, config: result.data, source };
}

/** Loads `<root>/.iv/config.yaml`. A missing file is not an error: defaults are used. */
export function loadConfig(root: string): LoadConfigResult {
  const path = configPath(root);
  if (!existsSync(path)) {
    return { ok: true, config: ConfigSchema.parse({}), source: null };
  }
  return parseConfig(readFileSync(path, "utf8"), path);
}

export interface NewDismissal {
  findingId: string;
  reason: string;
  by?: string;
}

/**
 * Records a dismissal in `.iv/config.yaml` (creating it from the template if needed),
 * keeping the file's comments. Returns the config path. Throws if the result is invalid.
 */
export function addDismissal(root: string, d: NewDismissal): string {
  if (!d.reason.trim()) throw new Error("A dismissal needs a reason.");
  const path = configPath(root);
  const doc = parseDocument(existsSync(path) ? readFileSync(path, "utf8") : CONFIG_TEMPLATE);
  const entry = { findingId: d.findingId, reason: d.reason.trim(), ...(d.by ? { by: d.by } : {}), date: new Date().toISOString().slice(0, 10) };
  const list = doc.get("dismissals");
  if (list && typeof list === "object" && "items" in list) {
    const items = (list as { items: { get?: (k: string) => unknown }[] }).items;
    const idx = items.findIndex((i) => i.get?.("findingId") === d.findingId);
    if (idx >= 0) doc.setIn(["dismissals", idx], doc.createNode(entry));
    else doc.addIn(["dismissals"], doc.createNode(entry));
  } else {
    doc.set("dismissals", doc.createNode([entry]));
  }
  const text = doc.toString();
  const check = parseConfig(text, path);
  if (!check.ok) throw new Error(`Dismissal would make the config invalid: ${check.issues.map((i) => i.message).join("; ")}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
  return path;
}

/** Built-in and user patterns combined, minus nothing: `ignore` is applied per field name. */
export function sensitivePatterns(config: Config): Record<string, RegExp[]> {
  const merged: Record<string, string[]> = {};
  for (const [kind, list] of Object.entries(DEFAULT_SENSITIVE_PATTERNS)) merged[kind] = [...list];
  for (const [kind, list] of Object.entries(config.sensitive.patterns)) {
    merged[kind] = [...(merged[kind] ?? []), ...list];
  }
  const compiled: Record<string, RegExp[]> = {};
  for (const [kind, list] of Object.entries(merged)) {
    compiled[kind] = list.map((p) => new RegExp(`(^|[^a-z])${p}($|[^a-z])`, "i"));
  }
  return compiled;
}

/** Returns the sensitive kind a field name belongs to, or null. */
export function classifyFieldName(name: string, config: Config): string | null {
  if (config.sensitive.ignore.some((i) => i.toLowerCase() === name.toLowerCase())) return null;
  // Split camelCase so `accessToken` is checked as `access_Token`.
  const normalized = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  for (const [kind, patterns] of Object.entries(sensitivePatterns(config))) {
    if (patterns.some((p) => p.test(normalized))) return kind;
  }
  return null;
}

export const CONFIG_TEMPLATE = `# Integration Verifier configuration.
# Docs: https://github.com/Varun14gk/integration-verifier
version: 1

sensitive:
  # Extra field-name patterns (case-insensitive regex), added to the built-in ones.
  patterns: {}
  # Field names that should never be treated as sensitive.
  ignore: []

outbound:
  # Hosts the backend may call. Calls to any other host are reported.
  allowlist: []

scanner:
  # auto | opengrep | semgrep | none
  engine: auto

# Runtime checks (iv runtime) are opt-in. Fill this in to enable them.
# runtime:
#   backend:
#     command: uvicorn app.main:app --port 8000
#     cwd: backend
#     url: http://localhost:8000/docs
#   frontend:
#     command: npm run dev
#     cwd: frontend
#     url: http://localhost:5173

gate:
  # The Stop hook and CI fail while findings at or above this severity are open.
  failOn: high

# Dismiss a finding with a recorded reason:
# dismissals:
#   - findingId: over-exposure:backend/app/models.py:12
#     reason: Field is needed by the admin screen.
dismissals: []
`;
