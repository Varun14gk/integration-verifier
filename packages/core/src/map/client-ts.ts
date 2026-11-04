// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { ancestor, lineOfNode, named, stringValue, type SyntaxNode } from "../parse/tree-sitter.js";
import { fieldsFromTypeText, type TypeIndex } from "./ts-types.js";
import type { ClientCall, ClientUrl, FieldSet } from "./types.js";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const BODY_METHODS = new Set(["post", "put", "patch"]);

/** Per-unit facts collected before extracting calls. */
export interface ClientContext {
  types: TypeIndex;
  /** Identifiers that are axios instances, with their base path when static. */
  axiosInstances: Map<string, string>;
  /** Property or variable names that hold an Angular HttpClient. */
  httpClientNames: Set<string>;
  /** Known values of env variables (from .env files). */
  env: Map<string, string>;
}

/** Collects axios instances and HttpClient injections in one file. */
export function collectClientFacts(root: SyntaxNode, ctx: ClientContext, env: Map<string, string>): void {
  const visit = (n: SyntaxNode) => {
    if (n.type === "variable_declarator") {
      const value = n.childForFieldName("value");
      const name = n.childForFieldName("name")?.text;
      if (name && value?.type === "call_expression" && /^axios\.create$/.test(value.childForFieldName("function")?.text ?? "")) {
        const cfg = named(value.childForFieldName("arguments"))[0];
        let base = "";
        const baseNode = cfg ? objectProp(cfg, "baseURL") : null;
        if (baseNode) base = staticBase(baseNode, env) ?? "";
        ctx.axiosInstances.set(name, base);
      }
    }
    if ((n.type === "required_parameter" || n.type === "optional_parameter" || n.type === "public_field_definition") && /:\s*HttpClient\b/.test(n.text)) {
      const name = (n.childForFieldName("pattern") ?? n.childForFieldName("name"))?.text;
      if (name) ctx.httpClientNames.add(name);
    }
    if (n.type === "variable_declarator" && /inject\(\s*HttpClient\s*\)/.test(n.childForFieldName("value")?.text ?? "")) {
      const name = n.childForFieldName("name")?.text;
      if (name) ctx.httpClientNames.add(name);
    }
    for (const c of named(n)) visit(c);
  };
  visit(root);
}

function objectProp(obj: SyntaxNode, key: string): SyntaxNode | null {
  if (obj.type !== "object") return null;
  for (const p of named(obj)) {
    if (p.type === "pair" && p.childForFieldName("key")?.text.replace(/^["']|["']$/g, "") === key) return p.childForFieldName("value");
    if (p.type === "shorthand_property_identifier" && p.text === key) return p;
  }
  return null;
}

const ENV_REF = /^(?:import\.meta\.env|process\.env)\.([A-Z_][A-Z0-9_]*)$/;

/** Path part of a base URL expression when it can be known statically. */
function staticBase(n: SyntaxNode, env: Map<string, string>): string | null {
  const s = stringValue(n);
  if (s !== null) return pathPart(s);
  const m = ENV_REF.exec(n.text);
  if (m) return env.has(m[1]!) ? pathPart(env.get(m[1]!)!) : "";
  return null;
}

function pathPart(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "").replace(/\/+$/, "");
}

const ID_LIKE = /^(id|pk|uuid|guid|slug|key|code|num|number|idx|index|name|handle|username)$|(Id|ID|_id|Uuid|Slug|Key|Code|Number|No|Name)$/;
const BASE_LIKE = /(^|_|\.)(base|api|host|server|backend|origin|endpoint|root)(_?ur[li])?$|ur[li]$|baseUrl|apiUrl|BASE_URL|API_URL/i;

type Part = { lit: string } | { expr: SyntaxNode };

function flatten(n: SyntaxNode, consts: Map<string, SyntaxNode>, depth = 0): Part[] {
  if (depth > 5) return [{ expr: n }];
  const s = stringValue(n);
  if (s !== null) return [{ lit: s }];
  switch (n.type) {
    case "template_string": {
      const parts: Part[] = [];
      for (const c of n.children) {
        if (!c) continue;
        if (c.type === "string_fragment" || c.type === "escape_sequence") parts.push({ lit: c.text });
        else if (c.type === "template_substitution") {
          const e = named(c)[0];
          if (e) parts.push(...flatten(e, consts, depth + 1));
        }
      }
      return parts;
    }
    case "binary_expression": {
      const left = n.childForFieldName("left");
      const right = n.childForFieldName("right");
      if (left && right && n.text.slice(left.endIndex - n.startIndex, right.startIndex - n.startIndex).includes("+")) {
        return [...flatten(left, consts, depth + 1), ...flatten(right, consts, depth + 1)];
      }
      return [{ expr: n }];
    }
    case "parenthesized_expression":
      return named(n)[0] ? flatten(named(n)[0]!, consts, depth + 1) : [{ expr: n }];
    case "identifier": {
      const v = consts.get(n.text);
      return v ? flatten(v, consts, depth + 1) : [{ expr: n }];
    }
    default:
      return [{ expr: n }];
  }
}

function lastIdentifier(n: SyntaxNode): string {
  if (n.type === "call_expression") {
    const arg = named(n.childForFieldName("arguments"))[0];
    return arg ? lastIdentifier(arg) : n.text;
  }
  if (n.type === "member_expression") return n.childForFieldName("property")?.text ?? n.text;
  if (n.type === "subscript_expression") return lastIdentifier(n.childForFieldName("index") ?? n);
  return n.text.replace(/^["']|["']$/g, "");
}

/** Resolves a URL expression to a static path with named params, or marks it dynamic. */
export function resolveUrl(n: SyntaxNode, consts: Map<string, SyntaxNode>, env: Map<string, string>, base: string): ClientUrl {
  const parts = flatten(n, consts);
  let path = "";
  let inQuery = false;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if ("lit" in p) {
      if (p.lit.includes("?")) inQuery = true;
      path += p.lit;
      continue;
    }
    if (inQuery) {
      path += "x";
      continue;
    }
    if (i === 0 && path === "") {
      const b = staticBase(p.expr, env);
      if (b !== null || BASE_LIKE.test(p.expr.text)) {
        path += b ?? "";
        continue;
      }
    }
    const name = lastIdentifier(p.expr);
    if (ID_LIKE.test(name)) {
      path += `{${name}}`;
      continue;
    }
    return { kind: "dynamic", raw: n.text };
  }
  const [rawPath, rawQuery] = path.split("?", 2);
  let full = rawPath!;
  // Absolute URLs to other hosts are outbound calls, not backend calls; keep the path.
  full = full.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
  if (!full.startsWith("/")) full = "/" + full;
  if (base && !full.startsWith(base + "/") && full !== base) full = base + full;
  const query = rawQuery ? [...rawQuery.matchAll(/(?:^|&)([^=&]+)=?/g)].map((m) => m[1]!) : [];
  return { kind: "static", raw: n.text, path: full, query };
}

function enclosingFunction(n: SyntaxNode): SyntaxNode | null {
  return ancestor(n, ["function_declaration", "method_definition", "arrow_function", "function_expression", "function"]);
}

function functionName(fn: SyntaxNode | null): string | null {
  if (!fn) return null;
  const own = fn.childForFieldName("name")?.text;
  if (own) return own;
  if (fn.parent?.type === "variable_declarator") return fn.parent.childForFieldName("name")?.text ?? null;
  if (fn.parent?.type === "pair") return fn.parent.childForFieldName("key")?.text ?? null;
  return null;
}

function paramType(fn: SyntaxNode | null, name: string): string | null {
  const params = fn?.childForFieldName("parameters");
  for (const p of named(params)) {
    if ((p.type === "required_parameter" || p.type === "optional_parameter") && p.childForFieldName("pattern")?.text === name) {
      return p.childForFieldName("type")?.text ?? null;
    }
  }
  return null;
}

/** Field names sent in a request body expression. */
function bodyFields(n: SyntaxNode | null | undefined, fn: SyntaxNode | null, ctx: ClientContext): FieldSet {
  if (!n) return { known: true, names: [] };
  if (n.type === "call_expression" && /^JSON\.stringify$/.test(n.childForFieldName("function")?.text ?? "")) {
    return bodyFields(named(n.childForFieldName("arguments"))[0], fn, ctx);
  }
  if (n.type === "object") {
    const names: string[] = [];
    let known = true;
    for (const p of named(n)) {
      if (p.type === "pair") names.push(p.childForFieldName("key")!.text.replace(/^["']|["']$/g, ""));
      else if (p.type === "shorthand_property_identifier") names.push(p.text);
      else if (p.type === "spread_element") known = false;
    }
    return { known, names, source: "object literal" };
  }
  if (n.type === "identifier") {
    const t = paramType(fn, n.text);
    if (t) return fieldsFromTypeText(t, ctx.types) ?? { known: false, names: [], source: t };
  }
  return { known: false, names: [], source: n.text.slice(0, 60) };
}

function queryFromOptions(opts: SyntaxNode | null | undefined, url: ClientUrl): ClientCall["query"] {
  const fromUrl = url.query ?? [];
  if (!opts) return { known: url.kind === "static", names: fromUrl };
  const params = objectProp(opts, "params");
  if (!params) return { known: opts.type === "object", names: fromUrl };
  if (params.type === "object") {
    const names = named(params).map((p) => (p.type === "pair" ? p.childForFieldName("key")!.text.replace(/^["']|["']$/g, "") : p.text));
    return { known: true, names: [...fromUrl, ...names] };
  }
  if (params.type === "shorthand_property_identifier" || params.type === "identifier") return { known: false, names: fromUrl };
  const sets = [...params.text.matchAll(/\.(?:set|append)\(\s*["']([^"']+)["']/g)].map((m) => m[1]!);
  return { known: sets.length > 0, names: [...fromUrl, ...sets] };
}

/** Finds HTTP calls in one parsed file. */
export function extractCallsFromTree(root: SyntaxNode, unit: string, file: string, ctx: ClientContext): ClientCall[] {
  const consts = new Map<string, SyntaxNode>();
  for (const d of root.descendantsOfType("variable_declarator")) {
    const name = d?.childForFieldName("name");
    const value = d?.childForFieldName("value");
    if (name?.type === "identifier" && value && ["string", "template_string", "binary_expression"].includes(value.type)) consts.set(name.text, value);
  }
  const calls: ClientCall[] = [];
  for (const call of root.descendantsOfType("call_expression")) {
    if (!call) continue;
    let fnNode = call.childForFieldName("function");
    // `await api.get<T>(...)` parses with the await around the callee.
    if (fnNode?.type === "await_expression") fnNode = named(fnNode)[0] ?? null;
    const args = named(call.childForFieldName("arguments"));
    if (!fnNode) continue;
    let client: string | null = null;
    let method = "GET";
    let urlNode: SyntaxNode | undefined;
    let bodyNode: SyntaxNode | null | undefined;
    let optsNode: SyntaxNode | undefined;
    let base = "";

    if (fnNode.type === "identifier" && fnNode.text === "fetch") {
      client = "fetch";
      urlNode = args[0];
      optsNode = args[1];
      const m = optsNode ? objectProp(optsNode, "method") : null;
      method = (m && stringValue(m)?.toUpperCase()) || "GET";
      bodyNode = optsNode ? objectProp(optsNode, "body") : null;
    } else if (fnNode.type === "member_expression") {
      const prop = fnNode.childForFieldName("property")?.text ?? "";
      const obj = fnNode.childForFieldName("object");
      const objName = obj?.type === "member_expression" && obj.childForFieldName("object")?.type === "this" ? obj.childForFieldName("property")?.text : obj?.text;
      if (!HTTP_METHODS.has(prop) || !objName) continue;
      if (objName === "axios" || ctx.axiosInstances.has(objName)) {
        client = "axios";
        base = ctx.axiosInstances.get(objName) ?? "";
      } else if (ctx.httpClientNames.has(objName)) {
        client = "angular-httpclient";
      } else continue;
      method = prop.toUpperCase();
      urlNode = args[0];
      if (BODY_METHODS.has(prop)) {
        bodyNode = args[1] ?? null;
        optsNode = args[2];
      } else {
        optsNode = args[1];
      }
    } else continue;
    if (!urlNode) continue;

    // An absolute URL literal points at some other host: an outbound call, handled by the leak checks.
    const first = flatten(urlNode, consts)[0];
    if (first && "lit" in first && /^([a-z][a-z0-9+.-]*:)?\/\//i.test(first.lit)) continue;
    const fn = enclosingFunction(call);
    const url = resolveUrl(urlNode, consts, ctx.env, base);
    const typeArgs = call.childForFieldName("type_arguments");
    const typeText = typeArgs ? named(typeArgs)[0]?.text : fn?.childForFieldName("return_type")?.text;
    const response = typeText ? fieldsFromTypeText(typeText, ctx.types) : null;
    calls.push({
      id: `call:${file}:${lineOfNode(call)}`,
      unit,
      file,
      line: lineOfNode(call),
      function: functionName(fn),
      client,
      method,
      url,
      query: queryFromOptions(optsNode, url),
      body: BODY_METHODS.has(method.toLowerCase()) ? bodyFields(bodyNode, fn, ctx) : null,
      response,
    });
  }
  return calls;
}
