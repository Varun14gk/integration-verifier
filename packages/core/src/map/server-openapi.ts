// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { parse as parseYaml } from "yaml";
import { lineOf } from "../fs-walk.js";
import { joinPaths } from "./paths.js";
import type { FieldSet, RouteQueryParam, ServerRoute } from "./types.js";

type Json = Record<string, unknown>;
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/** Resolves local `$ref`s ("#/components/schemas/User"). Remote refs are left unresolved. */
function deref(doc: Json, node: unknown, seen = new Set<string>()): Json | null {
  if (!node || typeof node !== "object") return null;
  const ref = (node as Json).$ref;
  if (typeof ref !== "string") return node as Json;
  if (!ref.startsWith("#/") || seen.has(ref)) return null;
  seen.add(ref);
  let cur: unknown = doc;
  for (const part of ref.slice(2).split("/")) cur = (cur as Json | undefined)?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  return deref(doc, cur, seen);
}

/** Field names of an object schema (following $ref, allOf, arrays). */
export function schemaFields(doc: Json, schema: unknown, depth = 0): FieldSet | null {
  const s = deref(doc, schema);
  if (!s || depth > 8) return null;
  if (s.type === "array" || s.items) {
    const inner = schemaFields(doc, s.items, depth + 1);
    return inner ? { ...inner, isArray: true } : null;
  }
  const names = new Set<string>();
  const required = new Set<string>();
  let known = false;
  for (const part of [s, ...((s.allOf as unknown[]) ?? [])]) {
    const p: Json | null = part === s ? s : deref(doc, part);
    if (!p) continue;
    if (p !== s && (p.properties || p.allOf)) {
      const sub = schemaFields(doc, p, depth + 1);
      if (sub) {
        known = true;
        sub.names.forEach((n) => names.add(n));
        (sub.required ?? []).forEach((n) => required.add(n));
      }
      continue;
    }
    if (p.properties && typeof p.properties === "object") {
      known = true;
      Object.keys(p.properties as Json).forEach((n) => names.add(n));
    }
    if (Array.isArray(p.required)) (p.required as unknown[]).forEach((n) => typeof n === "string" && required.add(n));
  }
  // oneOf/anyOf or free-form objects: we cannot tell which fields apply.
  if (!known) return null;
  const ref = typeof (schema as Json | undefined)?.$ref === "string" ? String((schema as Json).$ref).split("/").pop() : undefined;
  return { known: true, names: [...names], required: [...required], ...(ref ? { source: ref } : { source: "schema" }) };
}

function jsonSchemaOf(doc: Json, content: unknown): unknown {
  if (!content || typeof content !== "object") return undefined;
  const c = content as Json;
  const key = Object.keys(c).find((k) => /json/i.test(k)) ?? Object.keys(c)[0];
  return key ? (c[key] as Json | undefined)?.schema : undefined;
}

function basePath(doc: Json): string {
  if (typeof doc.basePath === "string") return doc.basePath;
  const servers = doc.servers as { url?: string }[] | undefined;
  const url = servers?.[0]?.url ?? "";
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "").replace(/\{[^}]+\}/g, "").replace(/\/+$/, "");
}

/** Line in the spec text where a path key is declared (1 when not found). */
function lineOfPath(text: string, path: string): number {
  for (const needle of [`"${path}"`, `'${path}'`, `${path}:`]) {
    const i = text.indexOf(needle);
    if (i >= 0) return lineOf(text, i);
  }
  return 1;
}

/** Offset of the first line at or after `from` declaring `key` as a YAML or JSON property, or -1. */
function offsetOfKey(text: string, key: string, from = 0): number {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^[ \\t]*(?:"${esc}"|'${esc}'|${esc})[ \\t]*:`, "gm");
  re.lastIndex = from;
  const m = re.exec(text);
  return m ? m.index + m[0].indexOf(key) : -1;
}

/**
 * Adds declaration lines so findings can point at the schema property itself. Properties
 * are looked up after the schema's own declaration, so `email` in `User` is not confused
 * with `email` in `UserCreate`.
 */
function withLines(fs: FieldSet | null, text: string, file: string): FieldSet | null {
  if (!fs?.known) return fs;
  const schemaAt = fs.source && fs.source !== "schema" ? offsetOfKey(text, fs.source) : -1;
  const fieldLines: Record<string, number> = {};
  for (const n of fs.names) {
    const at = offsetOfKey(text, n, Math.max(0, schemaAt));
    if (at >= 0) fieldLines[n] = lineOf(text, at);
  }
  return { ...fs, ...(schemaAt >= 0 ? { declaredAt: { file, line: lineOf(text, schemaAt) } } : {}), fieldLines };
}

/** Turns an OpenAPI 3.x or Swagger 2.0 document into backend routes. */
export function openApiRoutes(text: string, unit: string, file: string): ServerRoute[] {
  let doc: Json;
  try {
    doc = parseYaml(text) as Json;
  } catch {
    return [];
  }
  if (!doc || typeof doc !== "object" || !(doc.openapi || doc.swagger) || typeof doc.paths !== "object") return [];
  const base = basePath(doc);
  const routes: ServerRoute[] = [];
  for (const [path, itemRaw] of Object.entries(doc.paths as Json)) {
    const item = deref(doc, itemRaw);
    if (!item) continue;
    const shared = ((item.parameters as unknown[]) ?? []).map((p) => deref(doc, p)).filter(Boolean) as Json[];
    for (const method of METHODS) {
      const op = deref(doc, item[method]);
      if (!op) continue;
      const params = [...shared, ...(((op.parameters as unknown[]) ?? []).map((p) => deref(doc, p)).filter(Boolean) as Json[])];
      const query: RouteQueryParam[] = params.filter((p) => p.in === "query" && typeof p.name === "string").map((p) => ({ name: String(p.name), required: p.required === true }));
      let body: FieldSet | null = null;
      const reqBody = deref(doc, op.requestBody);
      if (reqBody) body = schemaFields(doc, jsonSchemaOf(doc, reqBody.content)) ?? { known: false, names: [] };
      const bodyParam = params.find((p) => p.in === "body");
      if (bodyParam) body = schemaFields(doc, bodyParam.schema) ?? { known: false, names: [] };
      const responses = (op.responses as Json | undefined) ?? {};
      const okKey = ["200", "201", "202", "2XX", "default"].find((k) => k in responses);
      const ok = okKey ? deref(doc, responses[okKey]) : null;
      const response = ok ? schemaFields(doc, ok.content ? jsonSchemaOf(doc, ok.content) : ok.schema) : null;
      const line = lineOfPath(text, path);
      routes.push({
        id: `route:${file}:${line}:${method.toUpperCase()}`,
        unit,
        file,
        line,
        framework: "openapi",
        handler: typeof op.operationId === "string" ? op.operationId : null,
        method: method.toUpperCase(),
        path: joinPaths(base, path),
        query: { known: true, params: query },
        body: withLines(body, text, file),
        response: withLines(response, text, file),
        // A spec describes the contract; it does not prove the server validates input.
        validated: null,
        sinks: [],
        logs: null,
      });
    }
  }
  return routes;
}
