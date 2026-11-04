// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import type { StackJoin } from "../detect/types.js";
import type { Evidence, Finding, Severity } from "../finding.js";
import { normalizePath, pathSimilarity, segmentDifference, staticSegments, stringSimilarity, type NormalizedPath } from "./paths.js";
import type { ClientCall, Edge, EdgeStatus, JoinRef, MapReport, Mismatch, ServerRoute, Suggestion } from "./types.js";

interface Transform {
  join: JoinRef;
  /** Path the backend receives, or null when this join does not apply. */
  apply(path: string): string | null;
  /** Suggested replacement for the join's target when it strips `prefix`. */
  fix(prefix: string): string;
}

function urlPath(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "") || "/";
}

/** Proxies and rewrites that change the path between browser and backend. */
export function buildTransforms(joins: StackJoin[], unit: string): Transform[] {
  const out: Transform[] = [];
  for (const j of joins) {
    if (j.unit !== unit || !j.from || !j.to) continue;
    const ref: JoinRef = { kind: j.kind, file: j.file, line: j.line, from: j.from, to: j.to };
    if (j.kind === "nextjs-rewrite") {
      if (!/^[a-z]+:\/\//i.test(j.to)) continue; // internal rewrite, not to the backend
      const names: string[] = [];
      const re = new RegExp(
        "^" +
          j.from.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/:(\w+)(\*|\+)?/g, (_m, n: string, star?: string) => {
            names.push(n);
            return star ? "(.*)" : "([^/]+)";
          }) +
          "$",
      );
      const destPath = urlPath(j.to);
      out.push({
        join: ref,
        apply: (path) => {
          const m = re.exec(path);
          if (!m) return null;
          let p = destPath;
          names.forEach((n, i) => (p = p.replace(new RegExp(`:${n}[*+]?`), m[i + 1] ?? "")));
          return p.replace(/\/{2,}/g, "/") || "/";
        },
        fix: (prefix) => j.to!.replace(destPath, (prefix + destPath).replace(/\/{2,}/g, "/")),
      });
    } else if (j.kind === "dev-proxy" || j.kind === "package-proxy") {
      const from = j.from === "/" ? "" : j.from.replace(/\/$/, "");
      out.push({ join: ref, apply: (path) => (path === from || path.startsWith(from + "/") || from === "" ? path : null), fix: () => j.to! });
    }
  }
  return out;
}

interface IndexedRoute {
  route: ServerRoute;
  norm: NormalizedPath;
}

function methodMatches(route: string, call: string): boolean {
  return route === "*" || route === call;
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH"]);

/** How likely a call with one method meant a route with another. */
function methodAffinity(call: string, route: string): number {
  if (call === route) return 1;
  const pair = new Set([call, route]);
  if (pair.has("PUT") && pair.has("PATCH")) return 0.8;
  if (WRITE_METHODS.has(call) && WRITE_METHODS.has(route)) return 0.5;
  if (pair.has("GET") && pair.has("HEAD")) return 0.5;
  return 0;
}

function list(names: string[]): string {
  return names.join(", ");
}

function closest(name: string, candidates: string[]): string | null {
  let best: string | null = null;
  let score = 0.5;
  for (const c of candidates) {
    const s = c.includes(name) || name.includes(c) ? 0.8 : stringSimilarity(name.toLowerCase(), c.toLowerCase());
    if (s > score) {
      score = s;
      best = c;
    }
  }
  return best;
}

/** Field-level differences between a call and the route it reaches. */
export function compareFields(call: ClientCall, route: ServerRoute): Mismatch[] {
  const out: Mismatch[] = [];
  if (call.query.known && route.query.known) {
    const missing = route.query.params.filter((p) => p.required && !call.query.names.includes(p.name)).map((p) => p.name);
    const unknown = route.query.params.length > 0 ? call.query.names.filter((n) => !route.query.params.some((p) => p.name === n)) : [];
    if (missing.length || unknown.length) {
      const parts = [];
      if (missing.length) parts.push(`backend requires query param${missing.length > 1 ? "s" : ""} ${list(missing)}`);
      if (unknown.length) parts.push(`frontend sends ${list(unknown)}, which the backend does not read`);
      out.push({ kind: "query", detail: parts.join("; ") });
    }
  }
  if (call.body?.known && route.body?.known) {
    const missing = (route.body.required ?? []).filter((n) => !call.body!.names.includes(n));
    const unknown = call.body.names.filter((n) => !route.body!.names.includes(n));
    if (missing.length || unknown.length) {
      const parts = [];
      if (missing.length) parts.push(`backend ${route.body.source ?? "body"} requires ${list(missing)}`);
      for (const u of unknown) {
        const hint = closest(u, missing.length ? missing : route.body.names);
        parts.push(`frontend sends '${u}'${hint ? ` (did you mean '${hint}'?)` : ", which the backend does not accept"}`);
      }
      out.push({ kind: "request-field", detail: parts.join("; ") });
    }
  }
  if (call.response?.known && route.response?.known) {
    const missing = call.response.names.filter((n) => !route.response!.names.includes(n));
    if (missing.length) {
      out.push({ kind: "response-field", detail: `frontend reads ${list(missing)} from ${call.response.source ?? "the response"}, but backend ${route.response.source ?? "response"} has no such field${missing.length > 1 ? "s" : ""}` });
    }
  }
  return out;
}

function fieldNames(f: { body: { names: string[] } | null; response: { names: string[] } | null }): Set<string> {
  return new Set([...(f.body?.names ?? []), ...(f.response?.names ?? [])]);
}

/** Ranks backend routes as likely intended targets of a call that does not connect. */
export function rankSuggestions(call: ClientCall, norm: NormalizedPath, routes: IndexedRoute[]): Suggestion[] {
  const callFields = fieldNames(call);
  const scored = routes.map(({ route, norm: rn }) => {
    const pathScore = pathSimilarity(norm.segments, rn.segments);
    const methodScore = methodMatches(route.method, call.method) ? 1 : 0;
    const routeFields = fieldNames(route);
    let fieldScore: number | null = null;
    if (callFields.size && routeFields.size) {
      const inter = [...callFields].filter((f) => routeFields.has(f)).length;
      fieldScore = inter / new Set([...callFields, ...routeFields]).size;
    }
    const score = fieldScore === null ? 0.75 * pathScore + 0.25 * methodScore : 0.6 * pathScore + 0.2 * methodScore + 0.2 * fieldScore;
    const reasons: string[] = [];
    const diffs = norm.segments.length === rn.segments.length ? norm.segments.map((s, i) => segmentDifference(s, rn.segments[i]!)).filter(Boolean) : [];
    if (diffs.length) reasons.push(`path differs: ${diffs.join(", ")}`);
    else if (norm.segments.length !== rn.segments.length) reasons.push(`path has ${rn.segments.length} segments instead of ${norm.segments.length}`);
    reasons.push(methodScore ? `same method ${call.method}` : `method ${route.method} instead of ${call.method}`);
    if (fieldScore !== null) reasons.push(`${Math.round(fieldScore * 100)}% field overlap`);
    return { route: route.id, method: route.method, path: route.path, confidence: Math.round(score * 100) / 100, reason: reasons.join("; ") };
  });
  return scored.filter((s) => s.confidence >= 0.4).sort((a, b) => b.confidence - a.confidence).slice(0, 3);
}

function callEvidence(call: ClientCall): Evidence {
  return { kind: "code", file: call.file, line: call.line, snippet: `${call.method} ${call.url.raw}`.slice(0, 160) };
}

function routeEvidence(route: ServerRoute): Evidence {
  return { kind: "code", file: route.file, line: route.line, snippet: `${route.method} ${route.path}` };
}

const HEALTH = /\/(health|healthz|ready|readiness|live|liveness|metrics|status|ping|version)$/i;

/** Joins calls to routes and turns every problem into a finding. */
export function matchCallsToRoutes(calls: ClientCall[], routes: ServerRoute[], joins: StackJoin[]): Omit<MapReport, "calls" | "routes" | "skipped"> {
  const indexed: IndexedRoute[] = routes.map((route) => ({ route, norm: normalizePath(route.path) }));
  const edges: Edge[] = [];
  const findings: Finding[] = [];
  const referenced = new Set<string>();
  const joinFailures = new Map<string, { transform: Transform; calls: ClientCall[]; prefix: string; targets: IndexedRoute[] }>();
  const transformsByUnit = new Map<string, Transform[]>();

  for (const call of calls) {
    if (call.url.kind === "dynamic") {
      const pattern = call.url.raw.replace(/^[`"']|[`"']$/g, "").replace(/^\$\{[^}]+\}/, "").replace(/\$\{[^}]+\}/g, "\u0000");
      const re = pattern.startsWith("/") ? new RegExp("^" + pattern.split("?")[0]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\u0000/g, "[^/]+") + "$") : null;
      const candidates = re ? indexed.filter((r) => re.test(r.norm.key) && methodMatches(r.route.method, call.method)) : [];
      edges.push({
        id: `edge:${call.id}`, status: "unverifiable", call: call.id, mismatches: [],
        suggestions: candidates.slice(0, 5).map((c) => ({ route: c.route.id, method: c.route.method, path: c.route.path, confidence: 0.3, reason: "matches the static parts of the URL" })),
      });
      findings.push({
        id: `unverifiable:${call.file}:${call.line}`, category: "unverifiable", severity: "info", evidence: [callEvidence(call)],
        explanation: `URL is built at runtime (${call.url.raw.slice(0, 80)}), so it cannot be checked statically.${candidates.length ? ` It could reach: ${candidates.map((c) => `${c.route.method} ${c.route.path}`).join(", ")}.` : ""}`,
        suggestedFix: "Use a literal path per endpoint, or check it with `iv runtime`.", confidence: 0.9,
      });
      continue;
    }

    if (!transformsByUnit.has(call.unit)) transformsByUnit.set(call.unit, buildTransforms(joins, call.unit));
    const transform = transformsByUnit.get(call.unit)!.find((t) => t.apply(call.url.path!) !== null);
    const effective = transform ? transform.apply(call.url.path!)! : call.url.path!;
    const norm = normalizePath(effective);
    const sameKey = indexed.filter((r) => r.norm.key === norm.key);
    const exact = sameKey.filter((r) => methodMatches(r.route.method, call.method));
    const base: Partial<Edge> = { call: call.id, effectivePath: effective, ...(transform ? { via: transform.join } : {}) };

    if (exact.length) {
      const target = exact[0]!.route;
      referenced.add(target.id);
      const mismatches = compareFields(call, target);
      edges.push({ id: `edge:${call.id}`, status: mismatches.length ? "mismatched" : "connected", route: target.id, mismatches, suggestions: [], ...base } as Edge);
      if (mismatches.length) findings.push(mismatchFinding(call, target, mismatches, null));
      continue;
    }
    if (sameKey.length) {
      const callFields = fieldNames(call);
      const rank = (r: ServerRoute) => methodAffinity(call.method, r.method) + [...fieldNames(r)].filter((f) => callFields.has(f)).length * 0.01;
      const target = [...sameKey].sort((a, b) => rank(b.route) - rank(a.route))[0]!.route;
      referenced.add(target.id);
      const mismatches: Mismatch[] = [{ kind: "method", detail: `frontend uses ${call.method}; backend exposes ${sameKey.map((r) => r.route.method).join(", ")} for this path` }, ...compareFields(call, target)];
      const suggestion: Suggestion = { route: target.id, method: target.method, path: target.path, confidence: 0.9, reason: "same path, different method" };
      edges.push({ id: `edge:${call.id}`, status: "mismatched", route: target.id, mismatches, suggestions: [suggestion], ...base } as Edge);
      findings.push(mismatchFinding(call, target, mismatches, suggestion));
      continue;
    }
    const callStatic = staticSegments(norm.segments).join("/");
    const arity = indexed.find((r) => methodMatches(r.route.method, call.method) && staticSegments(r.norm.segments).join("/") === callStatic && r.norm.segments.length !== norm.segments.length);
    if (arity) {
      referenced.add(arity.route.id);
      const mismatches: Mismatch[] = [{ kind: "path-params", detail: `backend route ${arity.route.path} has ${arity.norm.params.length} path parameter${arity.norm.params.length === 1 ? "" : "s"}; frontend URL has ${normalizePath(call.url.path!).params.length}` }];
      const suggestion: Suggestion = { route: arity.route.id, method: arity.route.method, path: arity.route.path, confidence: 0.85, reason: "same static path segments, different path parameters" };
      edges.push({ id: `edge:${call.id}`, status: "mismatched", route: arity.route.id, mismatches, suggestions: [suggestion], ...base } as Edge);
      findings.push(mismatchFinding(call, arity.route, mismatches, suggestion));
      continue;
    }
    if (transform) {
      const original = normalizePath(call.url.path!);
      const targets = indexed.filter((r) => r.norm.key === original.key);
      if (targets.length) {
        const key = `${transform.join.file}:${transform.join.line}`;
        const prefix = call.url.path!.endsWith(effective) ? call.url.path!.slice(0, call.url.path!.length - effective.length) : "";
        const entry = joinFailures.get(key) ?? { transform, calls: [], prefix, targets: [] };
        entry.calls.push(call);
        entry.targets.push(...targets);
        joinFailures.set(key, entry);
        for (const t of targets) referenced.add(t.route.id);
        const t = targets.find((r) => methodMatches(r.route.method, call.method)) ?? targets[0]!;
        edges.push({
          id: `edge:${call.id}`, status: "not-connected", cause: "join", mismatches: [],
          suggestions: [{ route: t.route.id, method: t.route.method, path: t.route.path, confidence: 0.95, reason: `reached without the ${transform.join.kind}` }], ...base,
        } as Edge);
        continue;
      }
    }
    const suggestions = rankSuggestions(call, norm, indexed);
    if (suggestions[0]) referenced.add(suggestions[0].route);
    edges.push({ id: `edge:${call.id}`, status: "not-connected", mismatches: [], suggestions, ...base } as Edge);
    const top = suggestions[0];
    findings.push({
      id: `not-connected:${call.file}:${call.line}`,
      category: "not-connected",
      severity: "high",
      evidence: [callEvidence(call), ...(top ? [routeEvidence(indexed.find((r) => r.route.id === top.route)!.route)] : [])],
      explanation: `${call.method} ${effective} is not exposed by the backend${transform && effective !== call.url.path ? ` (after ${transform.join.kind} ${transform.join.from} -> ${transform.join.to})` : ""}.${top ? ` Most likely intended: ${top.method} ${top.path} (${top.reason}).` : ""}`,
      ...(top ? { suggestedFix: `${top.method} ${top.path}` } : {}),
      confidence: top ? Math.max(0.6, top.confidence) : 0.7,
    });
  }

  for (const { transform, calls: affected, prefix } of joinFailures.values()) {
    const j = transform.join;
    const sample = affected[0]!;
    findings.push({
      id: `not-connected:${j.file}:${j.line}`,
      category: "not-connected",
      severity: "critical",
      evidence: [{ kind: "code", file: j.file, line: j.line ?? 1, snippet: `${j.from} -> ${j.to}` }, ...affected.map(callEvidence)],
      explanation: `The ${j.kind} ${j.from} -> ${j.to} sends ${sample.url.path} to the backend as ${transform.apply(sample.url.path!)}, which does not exist. The backend serves these calls at their original paths. ${affected.length} call${affected.length === 1 ? "" : "s"} affected.`,
      suggestedFix: j.kind === "nextjs-rewrite" ? `destination: ${transform.fix(prefix)}` : `Point ${j.from} at a target that keeps the ${prefix} prefix.`,
      confidence: 0.95,
    });
  }

  const dynamicCandidates = new Set(edges.filter((e) => e.status === "unverifiable").flatMap((e) => e.suggestions.map((s) => s.route)));
  for (const { route } of indexed) {
    if (referenced.has(route.id)) continue;
    edges.push({ id: `edge:${route.id}`, status: "orphan", route: route.id, mismatches: [], suggestions: [] });
    const maybe = dynamicCandidates.has(route.id);
    findings.push({
      id: `orphan:${route.file}:${route.line}`,
      category: "orphan",
      severity: HEALTH.test(route.path) ? "info" : "low",
      evidence: [routeEvidence(route)],
      explanation: `${route.method} ${route.path} is not called by the frontend${maybe ? ", unless a dynamically built URL reaches it" : ""}. It may be used by another client, or be dead code.`,
      confidence: maybe ? 0.5 : 0.8,
    });
  }

  const stats = { connected: 0, "not-connected": 0, mismatched: 0, unverifiable: 0, orphan: 0 } as Record<EdgeStatus, number>;
  for (const e of edges) stats[e.status]++;
  return { edges, findings, stats };
}

function mismatchFinding(call: ClientCall, route: ServerRoute, mismatches: Mismatch[], suggestion: Suggestion | null): Finding {
  const serious = mismatches.some((m) => m.kind === "method" || m.kind === "path-params" || /requires/.test(m.detail));
  const severity: Severity = serious ? "high" : "medium";
  return {
    id: `mismatched:${call.file}:${call.line}`,
    category: "mismatched",
    severity,
    evidence: [callEvidence(call), routeEvidence(route)],
    explanation: `${call.method} ${call.url.path} reaches ${route.method} ${route.path} (${route.file}:${route.line}), but: ${mismatches.map((m) => m.detail).join("; ")}.`,
    suggestedFix: suggestion ? `${suggestion.method} ${suggestion.path}` : mismatches.map((m) => m.detail).join("; "),
    confidence: mismatches.some((m) => m.kind === "query") ? 0.85 : 0.9,
  };
}
