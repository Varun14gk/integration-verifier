// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { join, resolve } from "node:path";
import type { Config } from "../config.js";
import type { StackReport } from "../detect/types.js";
import type { Finding } from "../finding.js";
import { indexUi, targetRoute, type UiIndex } from "../flow/index.js";
import { readText, walkFiles } from "../fs-walk.js";
import { normalizePath } from "../map/paths.js";
import type { MapReport, ServerRoute } from "../map/types.js";
import { ancestor, grammarFor, withTree } from "../parse/tree-sitter.js";
import { identifiers, splitCode } from "../scan/code-text.js";
import { describe, pickSeverity, sensitiveNames } from "./sensitive.js";

/** Sensitive response fields that no frontend code reads. */
export function overExposure(map: MapReport, ui: UiIndex, config: Config): Finding[] {
  const reached = new Map<string, ServerRoute>();
  for (const e of map.edges) {
    if (!e.call) continue;
    const r = targetRoute(map, e.route, e.suggestions);
    if (r) reached.set(r.id, r);
  }
  const byField = new Map<string, { route: ServerRoute[]; name: string; kind: string; file: string; line: number; model: string }>();
  for (const r of reached.values()) {
    if (!r.response?.known) continue;
    for (const s of sensitiveNames(r.response.names, config)) {
      if (ui.used.has(s.name)) continue;
      const line = r.response.fieldLines?.[s.name];
      const file = line && r.response.declaredAt ? r.response.declaredAt.file : r.file;
      const at = line ?? r.line;
      const key = `${file}:${at}:${s.name}`;
      const entry = byField.get(key) ?? { route: [], name: s.name, kind: s.kind, file, line: at, model: r.response.source ?? "response" };
      entry.route.push(r);
      byField.set(key, entry);
    }
  }
  return [...byField.values()].map((e) => ({
    id: `over-exposure:${e.file}:${e.line}`,
    category: "over-exposure",
    severity: pickSeverity([{ name: e.name, kind: e.kind }], "high", "medium"),
    evidence: [{ kind: "code", file: e.file, line: e.line, snippet: `${e.model}.${e.name}` }, ...e.route.map((r) => ({ kind: "code" as const, file: r.file, line: r.line, snippet: `${r.method} ${r.path}` }))],
    explanation: `${e.model}.${e.name} (${e.kind}) is returned by ${e.route.map((r) => `${r.method} ${r.path}`).join(", ")}, but no frontend code reads it.`,
    suggestedFix: `Leave ${e.name} out of the response (for example with a separate public response model).`,
    confidence: 0.8,
  }));
}

function hostAllowed(host: string, allowlist: string[]): boolean {
  return allowlist.some((a) => {
    const p = a.toLowerCase();
    if (p.startsWith("*.")) return host === p.slice(2) || host.endsWith(p.slice(1));
    if (p.startsWith(".")) return host.endsWith(p) || host === p.slice(1);
    return host === p;
  });
}

const CALL_TYPES = ["call_expression", "call", "method_invocation", "invocation_expression", "new_expression", "object_creation_expression"];

/** Identifiers in the arguments of the call that contains the URL literal. */
async function callArgumentNames(root: string, file: string, line: number, url: string): Promise<{ names: string[]; inCall: boolean }> {
  const g = grammarFor(file);
  const text = readText(join(root, file));
  if (!g || text === null) return { names: [], inCall: false };
  return (
    (await withTree(g, text, (r) => {
      for (const s of r.descendantsOfType(["string", "template_string", "string_literal", "interpreted_string_literal"])) {
        if (!s || s.startPosition.row + 1 !== line || !s.text.includes(url)) continue;
        const call = ancestor(s, CALL_TYPES);
        if (!call) return { names: [], inCall: false };
        // Headers carry the caller's own credentials for that host; what matters is the data sent.
        const args = (call.childForFieldName("arguments")?.text ?? call.text).replace(/\bheaders\s*[:=]\s*\{[^}]*\}/g, "");
        const code = splitCode(args).code.replace(/[A-Za-z_$][\w$]*\s*:(?!:)/g, " ");
        return { names: identifiers(code), inCall: true };
      }
      return { names: [], inCall: false };
    })) ?? { names: [], inCall: false }
  );
}

/** Calls to hosts that are not on the outbound allowlist. */
export async function outboundNotAllowlisted(root: string, stack: StackReport, config: Config): Promise<Finding[]> {
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const o of stack.outbound) {
    if (hostAllowed(o.host, config.outbound.allowlist)) continue;
    const id = `outbound-not-allowlisted:${o.file}:${o.line}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const { names, inCall } = await callArgumentNames(root, o.file, o.line, o.url);
    const found = sensitiveNames(names, config);
    out.push({
      id,
      category: "outbound-not-allowlisted",
      severity: found.length ? "high" : "medium",
      evidence: [{ kind: "code", file: o.file, line: o.line, snippet: o.url }],
      explanation: `${inCall ? "Calls" : "References"} ${o.host}, which is not on the outbound allowlist${found.length ? `, sending ${describe(found)}` : ""}.`,
      suggestedFix: `If ${o.host} is expected, add it to outbound.allowlist in .iv/config.yaml; otherwise remove the call.`,
      confidence: inCall ? 0.9 : 0.6,
    });
  }
  return out;
}

/** Routes that accept input without a schema, model or validator. */
export function missingValidation(map: MapReport): Finding[] {
  const out = new Map<string, Finding>();
  for (const r of map.routes) {
    if (r.validated !== false) continue;
    const at = r.validationAt ?? { file: r.file, line: r.line };
    const untypedBody = r.body !== null && ["express", "flask", "django", "django-rest-framework"].includes(r.framework);
    const id = `missing-validation:${at.file}:${at.line}`;
    if (out.has(id)) continue;
    out.set(id, {
      id,
      category: "missing-validation",
      severity: untypedBody ? "high" : "medium",
      evidence: [{ kind: "code", file: at.file, line: at.line, snippet: `${r.method} ${r.path}` }],
      explanation: `${r.method} ${r.path} uses request input without validation${r.framework === "spring-boot" ? " (@RequestBody without @Valid)" : r.framework === "fastapi" ? " (parameter without a type or model)" : " (no schema check before use)"}.`,
      suggestedFix:
        r.framework === "spring-boot" ? "Add @Valid to the @RequestBody parameter and constraints (@NotNull, @Email, …) to the DTO."
        : r.framework === "fastapi" ? "Give every parameter a type, or use a Pydantic model."
        : r.framework === "express" ? "Validate req.body with a schema (zod, joi, express-validator) before using it."
        : "Validate the input with a schema before using it.",
      confidence: 0.85,
    });
  }
  return [...out.values()];
}

/** Sensitive values placed in URLs or query strings. */
export function sensitiveInUrl(map: MapReport, config: Config): Finding[] {
  const out: Finding[] = [];
  for (const c of map.calls) {
    if (c.url.kind !== "static") continue;
    const names = [...(c.url.query ?? []), ...c.query.names, ...normalizePath(c.url.path!).params];
    const found = sensitiveNames(names, config);
    if (!found.length) continue;
    out.push({
      id: `sensitive-in-url:${c.file}:${c.line}`,
      category: "sensitive-in-url",
      severity: pickSeverity(found, "high", "medium"),
      evidence: [{ kind: "code", file: c.file, line: c.line, snippet: `${c.method} ${c.url.raw}`.slice(0, 160) }],
      explanation: `Puts ${describe(found)} in the URL. URLs end up in server logs, proxies, browser history and Referer headers.`,
      suggestedFix: "Send the value in the request body (POST) or a header instead.",
      confidence: 0.85,
    });
  }
  return out;
}

const DEFAULT_ACCESS_LOG = new Set(["fastapi", "flask", "django", "django-rest-framework"]);
const LOGGING_DEPS = /opentelemetry|@sentry\/|sentry-sdk|dd-trace|ddtrace|newrelic|elastic-apm|micrometer-tracing|spring-cloud-sleuth|morgan|pino-http|express-winston|express-pino-logger|serilog|logstash-logback/i;

/** Backends where neither request logging nor tracing is set up and handlers do not log. */
export function missingLogging(root: string, stack: StackReport, map: MapReport): Finding[] {
  const out: Finding[] = [];
  for (const unit of stack.units) {
    if (unit.role !== "backend" || DEFAULT_ACCESS_LOG.has(unit.framework ?? "")) continue;
    const abs = resolve(root, unit.dir);
    const configured = walkFiles(abs).some((f) => {
      if (!/(^|\/)(package\.json|pom\.xml|build\.gradle(\.kts)?|requirements\.txt|pyproject\.toml|go\.mod|[^/]+\.csproj|application[^/]*\.(properties|ya?ml))$/.test(f) && !/\.(js|ts|java|go|cs)$/.test(f)) return false;
      const t = readText(join(abs, f)) ?? "";
      return LOGGING_DEPS.test(t) || /server\.tomcat\.accesslog\.enabled\s*[=:]\s*true|CommonsRequestLoggingFilter|UseHttpLogging|UseSerilogRequestLogging/.test(t);
    });
    if (configured) continue;
    const silent = map.routes.filter((r) => r.unit === unit.dir && r.logs === false).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    if (!silent.length) continue;
    const total = map.routes.filter((r) => r.unit === unit.dir).length;
    const first = silent[0]!;
    out.push({
      id: `missing-logging:${first.file}:${first.line}`,
      category: "missing-logging",
      severity: "low",
      evidence: silent.map((r) => ({ kind: "code" as const, file: r.file, line: r.line, snippet: `${r.method} ${r.path}` })),
      explanation: `${silent.length} of ${total} routes in ${unit.dir}/ write no log line, and no request logging or tracing is configured for ${unit.framework}.`,
      suggestedFix:
        unit.framework === "express" ? "Add request logging middleware (for example pino-http or morgan) or OpenTelemetry."
        : unit.framework === "spring-boot" ? "Enable server.tomcat.accesslog.enabled=true, a request logging filter, or Micrometer tracing."
        : "Add request logging or tracing middleware.",
      confidence: 0.7,
    });
  }
  return out;
}

export { indexUi };
