// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import {
  buildTransforms, classifyFieldName, HIGH_RISK_KINDS, normalizePath, type Config, type Finding, type MapReport, type StackReport, type UiIndex,
} from "@integration-verifier/core";
import type { CapturedRequest, Observation, TestData } from "./types.js";

const API_TYPES = new Set(["xhr", "fetch"]);
const SESSION_COOKIE = /sess|auth|token|jwt|sid|remember|login/i;

function mask(v: string): string {
  return v.length <= 4 ? "****" : `${v.slice(0, 2)}…${v.slice(-2)} (${v.length} chars)`;
}

function reqEvidence(r: CapturedRequest) {
  const u = new URL(r.url);
  return { kind: "request" as const, method: r.method, url: u.pathname + u.search, ...(r.status !== null ? { status: r.status } : {}), captureId: r.id };
}

/** Values from test data that must never appear in logs, URLs, storage or other responses. */
export function watchedValues(data: TestData, config: Config): { value: string; label: string; kind: string }[] {
  const out: { value: string; label: string; kind: string }[] = [];
  for (const [k, v] of Object.entries(data.fields)) {
    const kind = classifyFieldName(k, config);
    if (kind && v.length >= 4) out.push({ value: v, label: k, kind });
  }
  for (const v of data.sensitive) if (v.length >= 4) out.push({ value: v, label: "sensitive value", kind: "credential" });
  return out;
}

function jsonKeys(body: string | undefined): Set<string> | null {
  if (!body) return null;
  try {
    const v = JSON.parse(body) as unknown;
    const obj = Array.isArray(v) ? v[0] : v;
    if (obj && typeof obj === "object") return new Set(Object.keys(obj as object));
  } catch {
    /* not JSON */
  }
  return null;
}

export interface Analysis {
  findings: Finding[];
  confirmedEdges: string[];
  requests: { method: string; url: string; status: number | null; route: string | null }[];
}

/** Compares what the running app did with the static map and the test data. */
export function analyze(obs: Observation, map: MapReport, stack: StackReport, ui: UiIndex, config: Config, data: TestData, frontendOrigin: string | null): Analysis {
  const findings = new Map<string, Finding>();
  const add = (f: Finding) => {
    if (!findings.has(f.id)) findings.set(f.id, f);
  };
  const routes = map.routes.map((r) => ({ r, key: normalizePath(r.path).key }));
  const edgeKeys = map.edges.filter((e) => e.call && e.effectivePath && e.status === "connected").map((e) => ({ e, key: normalizePath(e.effectivePath!).key, method: map.calls.find((c) => c.id === e.call)!.method }));
  const frontendUnits = stack.units.filter((u) => u.role === "frontend" || u.role === "fullstack").map((u) => u.dir);
  const transforms = frontendUnits.flatMap((u) => buildTransforms(stack.joins, u));
  const confirmed = new Set<string>();
  const requests: Analysis["requests"] = [];
  const watched = watchedValues(data, config);

  for (const r of obs.requests) {
    if (!API_TYPES.has(r.resourceType)) continue;
    const u = new URL(r.url);
    let path = u.pathname;
    if (frontendOrigin && u.origin === frontendOrigin) {
      const t = transforms.find((x) => x.apply(path) !== null);
      if (t) path = t.apply(path)!;
    }
    const key = normalizePath(path).key;
    const route = routes.find((x) => x.key === key && (x.r.method === r.method || x.r.method === "*"))?.r ?? null;
    requests.push({ method: r.method, url: u.pathname + u.search, status: r.status, route: route?.id ?? null });
    for (const e of edgeKeys) if (e.key === key && e.method === r.method) confirmed.add(e.e.id);

    if (!route) {
      add({
        id: `runtime-unmapped-request:${r.method} ${key}`, category: "runtime-unmapped-request", severity: "medium", evidence: [reqEvidence(r)],
        explanation: `The app sent ${r.method} ${u.pathname}, which matches no route in the static map${r.status ? ` (answered ${r.status})` : ""}.`,
        suggestedFix: "Check the URL the frontend builds, or the backend route it should reach (see iv map).", confidence: 0.9,
      });
    }
    if (r.failure || (r.status !== null && r.status >= 400)) {
      const s = r.status;
      add({
        id: `runtime-failed-request:${r.method} ${key}:${s ?? "network"}`, category: "runtime-failed-request",
        severity: s === null || s >= 500 || s === 404 || s === 405 ? "high" : s === 401 || s === 403 ? "low" : "medium",
        evidence: [reqEvidence(r)],
        explanation: `${r.method} ${u.pathname} failed with ${s ?? r.failure} while driving the app.`,
        suggestedFix: s === 404 || s === 405 ? "The route or method does not exist on the backend; see the suggestion in iv map." : "Check the backend logs for this request.",
        confidence: 0.95,
      });
    }
    if (route && r.status !== null && r.status < 300) {
      const keys = jsonKeys(r.responseBody);
      if (keys) {
        const declared = route.response?.known ? route.response.names.filter((n) => !keys.has(n)) : [];
        const call = map.calls.find((c) => edgeKeys.some((e) => e.e.call === c.id && e.key === key));
        const expectedByUi = call?.response?.known ? call.response.names.filter((n) => !keys.has(n)) : [];
        const missing = [...new Set([...declared, ...expectedByUi])];
        if (missing.length) {
          add({
            id: `runtime-schema-violation:${r.method} ${key}`, category: "runtime-schema-violation", severity: "medium", evidence: [reqEvidence(r)],
            explanation: `Response of ${r.method} ${u.pathname} lacks ${missing.join(", ")}, which ${declared.length ? `the backend model ${route.response?.source ?? ""}` : "the frontend type"} declares.`,
            suggestedFix: "Align the response with the declared model, or update the declaration.", confidence: 0.85,
          });
        }
        for (const k of keys) {
          const kind = classifyFieldName(k, config);
          if (kind && HIGH_RISK_KINDS.has(kind) && !ui.used.has(k)) {
            add({
              id: `runtime-sensitive-exposure:response:${r.method} ${key}:${k}`, category: "runtime-sensitive-exposure", severity: "high", evidence: [reqEvidence(r)],
              explanation: `Observed response of ${r.method} ${u.pathname} contains ${k} (${kind}), which no frontend code reads.`,
              suggestedFix: `Leave ${k} out of the response model.`, confidence: 0.9,
            });
          }
        }
      }
    }
    for (const w of watched) {
      if (u.search.includes(encodeURIComponent(w.value)) || u.search.includes(w.value)) {
        add({
          id: `runtime-sensitive-exposure:url:${r.method} ${key}:${w.label}`, category: "runtime-sensitive-exposure", severity: HIGH_RISK_KINDS.has(w.kind) ? "high" : "medium",
          evidence: [reqEvidence(r)], explanation: `The test value for ${w.label} (${w.kind}) was sent in the URL of ${r.method} ${u.pathname}.`,
          suggestedFix: "Send it in the request body instead.", confidence: 0.95,
        });
      }
      if (r.responseBody?.includes(w.value) && w.kind === "credential") {
        add({
          id: `runtime-sensitive-exposure:echo:${r.method} ${key}:${w.label}`, category: "runtime-sensitive-exposure", severity: "high",
          evidence: [reqEvidence(r)], explanation: `The submitted ${w.label} came back in the response of ${r.method} ${u.pathname}.`,
          suggestedFix: "Never echo credentials in responses.", confidence: 0.95,
        });
      }
    }
  }

  // Every watched value is masked in every detail, not only the one a finding is about.
  const redact = (text: string) => watched.reduce((t, w) => t.split(w.value).join(mask(w.value)), text);
  const observe = (source: "console" | "local-storage" | "session-storage" | "server-output" | "cookie", location: string, detail: string) => ({ kind: "observation" as const, source, location, detail: redact(detail).slice(0, 160) });
  for (const c of obs.console) {
    for (const w of watched) {
      if (!c.text.includes(w.value)) continue;
      add({
        id: `runtime-sensitive-exposure:console:${w.label}`, category: "runtime-sensitive-exposure", severity: HIGH_RISK_KINDS.has(w.kind) ? "high" : "medium",
        evidence: [observe("console", c.page || "page", c.text)],
        explanation: `The test value for ${w.label} (${w.kind}) was printed to the browser console.`, suggestedFix: "Remove the console output.", confidence: 0.95,
      });
    }
  }
  for (const s of obs.storage) {
    const keyKind = classifyFieldName(s.key, config);
    const valueHit = watched.find((w) => s.value.includes(w.value));
    if (!keyKind && !valueHit) continue;
    const kind = valueHit?.kind ?? keyKind!;
    add({
      id: `runtime-sensitive-exposure:${s.kind}:${s.key}`, category: "runtime-sensitive-exposure", severity: HIGH_RISK_KINDS.has(kind) ? "high" : "medium",
      evidence: [observe(s.kind, s.page, `${s.key} = ${mask(s.value)}`)],
      explanation: `Observed ${s.key} (${kind}) in ${s.kind.replace("-", " ")}, readable by any script on the page.`,
      suggestedFix: "Use an httpOnly, Secure cookie set by the server instead.", confidence: 0.95,
    });
  }
  for (const c of obs.cookies) {
    if (!SESSION_COOKIE.test(c.name) || (c.httpOnly && c.secure)) continue;
    add({
      id: `runtime-sensitive-exposure:cookie:${c.name}`, category: "runtime-sensitive-exposure", severity: "high",
      evidence: [observe("cookie", c.domain, `${c.name}: httpOnly=${c.httpOnly} secure=${c.secure} sameSite=${c.sameSite}`)],
      explanation: `Session-like cookie ${c.name} was set without ${[!c.httpOnly && "HttpOnly", !c.secure && "Secure"].filter(Boolean).join(" and ")}.`,
      suggestedFix: "Set it with HttpOnly, Secure and SameSite.", confidence: 0.9,
    });
  }
  for (const o of obs.serverOutput) {
    for (const w of watched) {
      if (!o.line.includes(w.value)) continue;
      add({
        id: `runtime-sensitive-exposure:server-output:${o.process}:${w.label}`, category: "runtime-sensitive-exposure", severity: HIGH_RISK_KINDS.has(w.kind) ? "critical" : "medium",
        evidence: [observe("server-output", o.process, o.line)],
        explanation: `The ${o.process} printed the test value for ${w.label} (${w.kind}) to its output: it is being logged.`,
        suggestedFix: "Find the log call (see sensitive-in-logs from iv check) and remove the value.", confidence: 0.95,
      });
    }
  }
  return { findings: [...findings.values()], confirmedEdges: [...confirmed], requests };
}
