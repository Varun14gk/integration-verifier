// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { join, resolve } from "node:path";
import type { Config } from "../config.js";
import type { StackReport } from "../detect/types.js";
import { lineOf, readText, walkFiles } from "../fs-walk.js";
import type { MapReport, ServerRoute, Sink } from "../map/types.js";
import { classifyFieldName } from "../config.js";

export interface Location {
  file: string;
  line: number;
}

/** Where the frontend reads each property name, and where form inputs are bound. */
export interface UiIndex {
  used: Map<string, Location>;
  inputs: Map<string, Location>;
}

const UI_FILE = /\.(tsx?|jsx?|mjs|vue|svelte|html)$/;
const TEST_FILE = /(^|\/)(__tests__|tests?|e2e)\/|\.(test|spec|stories)\.[jt]sx?$/;

/** Indexes property reads and form inputs across all frontend units. */
export function indexUi(root: string, stack: StackReport): UiIndex {
  const used = new Map<string, Location>();
  const inputs = new Map<string, Location>();
  for (const unit of stack.units) {
    if (unit.role !== "frontend" && unit.role !== "fullstack") continue;
    const abs = resolve(root, unit.dir);
    for (const rel of walkFiles(abs)) {
      if (!UI_FILE.test(rel) || TEST_FILE.test(rel) || rel.endsWith(".d.ts")) continue;
      const text = readText(join(abs, rel));
      if (text === null) continue;
      const file = unit.dir === "." ? rel : `${unit.dir}/${rel}`;
      const note = (map: Map<string, Location>, name: string, offset: number) => {
        if (!map.has(name)) map.set(name, { file, line: lineOf(text, offset) });
      };
      for (const m of text.matchAll(/(?<=[\w$)\]?])\.([A-Za-z_$][\w$]*)/g)) note(used, m[1]!, m.index);
      for (const m of text.matchAll(/(?:const|let|var)\s*\{([^}=]+)\}\s*=/g)) {
        for (const part of m[1]!.split(",")) {
          const key = part.split(":")[0]!.trim();
          if (/^[A-Za-z_$][\w$]*$/.test(key)) note(used, key, m.index);
        }
      }
      for (const m of text.matchAll(/\b(?:name|formControlName|ng-model|data-field)\s*=\s*["']([\w.]+)["']|register\(\s*["'](\w+)["']|v-model\s*=\s*["'][\w.]*?\.?(\w+)["']/g)) {
        const name = (m[1] ?? m[2] ?? m[3])!.split(".").pop()!;
        note(inputs, name, m.index);
      }
    }
  }
  return { used, inputs };
}

export interface FlowField {
  field: string;
  sensitive: string | null;
}

export interface RequestField extends FlowField {
  /** Form input the value most likely comes from (same name). */
  input: Location | null;
  sentAt: Location | null;
  /** Whether the backend accepts this field (null when unknown). */
  accepted: boolean | null;
  backend: (Location & { model?: string }) | null;
  sinks: Sink[];
}

export interface ResponseField extends FlowField {
  backend: (Location & { model?: string }) | null;
  usedByUi: boolean;
  uiUsage: Location | null;
  sources: Sink[];
}

export interface FlowEdge {
  edge: string;
  call: Location & { method: string; path: string | null };
  route: (Location & { method: string; path: string }) | null;
  request: RequestField[];
  response: ResponseField[];
}

export interface FlowReport {
  flows: FlowEdge[];
  uiFieldsIndexed: number;
  formInputsIndexed: number;
}

/** The route a call reaches, or is most likely meant to reach. */
export function targetRoute(map: MapReport, edgeRoute: string | undefined, suggestions: { route: string }[]): ServerRoute | null {
  const id = edgeRoute ?? suggestions[0]?.route;
  return id ? map.routes.find((r) => r.id === id) ?? null : null;
}

function modelLoc(fs: ServerRoute["body"], name: string): (Location & { model?: string }) | null {
  const line = fs?.fieldLines?.[name];
  if (!fs?.declaredAt || !line) return null;
  return { file: fs.declaredAt.file, line, ...(fs.source ? { model: fs.source } : {}) };
}

/** Field-level trace for every frontend call: request fields forward, response fields back to the UI. */
export function buildFlow(map: MapReport, ui: UiIndex, config: Config): FlowReport {
  const flows: FlowEdge[] = [];
  for (const edge of map.edges) {
    if (!edge.call) continue;
    const call = map.calls.find((c) => c.id === edge.call)!;
    const route = targetRoute(map, edge.route, edge.suggestions);
    const requestNames = new Set([...(call.body?.names ?? []), ...(route?.body?.required ?? [])]);
    const request: RequestField[] = [...requestNames].map((field) => ({
      field,
      sensitive: classifyFieldName(field, config),
      input: ui.inputs.get(field) ?? null,
      sentAt: call.body?.names.includes(field) ? { file: call.file, line: call.line } : null,
      accepted: route?.body?.known ? route.body.names.includes(field) : null,
      backend: modelLoc(route?.body ?? null, field),
      sinks: route?.sinks ?? [],
    }));
    const response: ResponseField[] = (route?.response?.known ? route.response.names : call.response?.names ?? []).map((field) => ({
      field,
      sensitive: classifyFieldName(field, config),
      backend: modelLoc(route?.response ?? null, field),
      usedByUi: ui.used.has(field),
      uiUsage: ui.used.get(field) ?? null,
      sources: (route?.sinks ?? []).filter((s) => s.kind === "store"),
    }));
    flows.push({
      edge: edge.id,
      call: { file: call.file, line: call.line, method: call.method, path: call.url.path ?? null },
      route: route ? { file: route.file, line: route.line, method: route.method, path: route.path } : null,
      request,
      response,
    });
  }
  return { flows, uiFieldsIndexed: ui.used.size, formInputsIndexed: ui.inputs.size };
}

/** Short human summary: sensitive fields and where they travel. */
export function formatFlowSummary(flow: FlowReport): string {
  const lines = [`Data flow: ${flow.flows.length} calls traced (${flow.uiFieldsIndexed} UI field reads, ${flow.formInputsIndexed} form inputs indexed)`];
  for (const f of flow.flows) {
    const sensitiveReq = f.request.filter((r) => r.sensitive);
    const sensitiveRes = f.response.filter((r) => r.sensitive);
    if (!sensitiveReq.length && !sensitiveRes.length) continue;
    lines.push(`  ${f.call.method} ${f.call.path ?? "(dynamic)"}  ${f.call.file}:${f.call.line}${f.route ? ` -> ${f.route.file}:${f.route.line}` : ""}`);
    for (const r of sensitiveReq) {
      const sinks = r.sinks.map((s) => (s.kind === "store" ? `store ${s.name}` : `outbound ${s.host}`)).join(", ");
      lines.push(`    request  ${r.field} (${r.sensitive})${r.input ? ` from input ${r.input.file}:${r.input.line}` : ""}${r.accepted === false ? " — not accepted by backend" : ""}${sinks ? ` -> ${sinks}` : ""}`);
    }
    for (const r of sensitiveRes) {
      lines.push(`    response ${r.field} (${r.sensitive}) ${r.usedByUi ? `used at ${r.uiUsage!.file}:${r.uiUsage!.line}` : "NOT used by the UI"}`);
    }
  }
  return lines.join("\n") + "\n";
}
