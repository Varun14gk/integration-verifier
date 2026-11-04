// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { posix } from "node:path";
import { lineOfNode, named, stringValue, type SyntaxNode } from "../parse/tree-sitter.js";
import { joinPaths, normalizePath } from "./paths.js";
import { findSinks, hasLogging, type FuncDef } from "./sinks.js";
import type { FieldSet, RouteQueryParam, ServerRoute } from "./types.js";

export interface PyModel {
  name: string;
  file: string;
  line: number;
  bases: string[];
  fields: { name: string; required: boolean; line: number }[];
}

/** Facts from all Python files of one unit, gathered before routes are built. */
export interface PyContext {
  models: Map<string, PyModel>;
  /** module basename -> prefix added by include_router / register_blueprint */
  includePrefixes: Map<string, string>;
  defs: Map<string, FuncDef>;
}

const MODEL_BASES = /\b(BaseModel|SQLModel|Schema|TypedDict)\b/;
const SKIP_TYPES = /^(Request|Response|BackgroundTasks|Session|AsyncSession|WebSocket|HTTPConnection|UploadFile)$/;
const ROUTE_ATTRS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "route", "api_route"]);

function kwargs(args: SyntaxNode | null): Map<string, SyntaxNode> {
  const m = new Map<string, SyntaxNode>();
  for (const a of named(args)) {
    if (a.type === "keyword_argument") {
      const k = a.childForFieldName("name")?.text;
      const v = a.childForFieldName("value");
      if (k && v) m.set(k, v);
    }
  }
  return m;
}

function positional(args: SyntaxNode | null): SyntaxNode[] {
  return named(args).filter((a) => a.type !== "keyword_argument" && a.type !== "comment");
}

/** Pass 1: models, include prefixes and function definitions. */
export function collectPython(root: SyntaxNode, file: string, ctx: PyContext): void {
  for (const cls of root.descendantsOfType("class_definition")) {
    if (!cls) continue;
    const name = cls.childForFieldName("name")?.text;
    const bases = cls.childForFieldName("superclasses")?.text ?? "";
    if (!name) continue;
    const fields: PyModel["fields"] = [];
    for (const stmt of named(cls.childForFieldName("body"))) {
      const asg = stmt.type === "expression_statement" ? named(stmt)[0] : null;
      if (asg?.type !== "assignment") continue;
      const left = asg.childForFieldName("left");
      const type = asg.childForFieldName("type")?.text ?? "";
      const hasDefault = asg.childForFieldName("right") !== null;
      if (left?.type !== "identifier" || !type) continue;
      const optional = /Optional\[|\|\s*None|None\s*\|/.test(type);
      fields.push({ name: left.text, required: !hasDefault && !optional, line: lineOfNode(asg) });
    }
    ctx.models.set(name, { name, file, line: lineOfNode(cls), bases: bases.replace(/[()]/g, "").split(",").map((s) => s.trim()).filter(Boolean), fields });
  }
  for (const call of root.descendantsOfType("call")) {
    if (!call) continue;
    const fn = call.childForFieldName("function")?.text ?? "";
    if (!/\.(include_router|register_blueprint)$/.test(fn)) continue;
    const args = call.childForFieldName("arguments");
    const target = positional(args)[0]?.text ?? "";
    const prefix = stringValue(kwargs(args).get("prefix") ?? kwargs(args).get("url_prefix")) ?? "";
    const mod = target.split(".")[0]!;
    if (prefix) ctx.includePrefixes.set(mod, prefix);
  }
  for (const def of root.descendantsOfType("function_definition")) {
    const name = def?.childForFieldName("name")?.text;
    if (def && name) ctx.defs.set(name, { file, line: lineOfNode(def), text: def.text });
  }
}

/** Resolves a model (and its model bases) to fields. */
export function pyModelFields(typeText: string, ctx: PyContext): FieldSet | null {
  let t = typeText.trim();
  let isArray = false;
  const list = /^(?:list|List|Sequence|Iterable)\[(.+)\]$/.exec(t);
  if (list) {
    t = list[1]!.trim();
    isArray = true;
  }
  t = t.replace(/^Optional\[(.+)\]$/, "$1");
  const model = ctx.models.get(t);
  if (!model || !isModel(model, ctx)) return null;
  const fields: PyModel["fields"] = [];
  const seen = new Set<string>();
  const add = (m: PyModel) => {
    if (seen.has(m.name)) return;
    seen.add(m.name);
    for (const b of m.bases) {
      const bm = ctx.models.get(b);
      if (bm) add(bm);
    }
    fields.push(...m.fields);
  };
  add(model);
  return {
    known: true,
    names: fields.map((f) => f.name),
    required: fields.filter((f) => f.required).map((f) => f.name),
    source: model.name,
    declaredAt: { file: model.file, line: model.line },
    fieldLines: Object.fromEntries(fields.map((f) => [f.name, f.line])),
    isArray,
  };
}

function isModel(m: PyModel, ctx: PyContext, depth = 0): boolean {
  if (depth > 5) return false;
  return m.bases.some((b) => MODEL_BASES.test(b) || (ctx.models.has(b) && isModel(ctx.models.get(b)!, ctx, depth + 1)));
}

/** Pass 2: routes declared with decorators (FastAPI, Flask) in one file. */
export function extractPythonRoutes(root: SyntaxNode, unit: string, file: string, ctx: PyContext, storeName: string): ServerRoute[] {
  const routers = new Map<string, { prefix: string; framework: string }>();
  for (const asg of root.descendantsOfType("assignment")) {
    const left = asg?.childForFieldName("left");
    const right = asg?.childForFieldName("right");
    if (!asg || left?.type !== "identifier" || right?.type !== "call") continue;
    const ctor = right.childForFieldName("function")?.text ?? "";
    const kw = kwargs(right.childForFieldName("arguments"));
    if (/(^|\.)(APIRouter|FastAPI)$/.test(ctor)) routers.set(left.text, { prefix: stringValue(kw.get("prefix")) ?? "", framework: "fastapi" });
    else if (/(^|\.)Flask$/.test(ctor)) routers.set(left.text, { prefix: "", framework: "flask" });
    else if (/(^|\.)Blueprint$/.test(ctor)) routers.set(left.text, { prefix: stringValue(kw.get("url_prefix")) ?? "", framework: "flask" });
  }
  const modulePrefix = ctx.includePrefixes.get(posix.basename(file, ".py")) ?? "";

  const routes: ServerRoute[] = [];
  for (const dd of root.descendantsOfType("decorated_definition")) {
    if (!dd) continue;
    const def = dd.childForFieldName("definition");
    if (def?.type !== "function_definition") continue;
    for (const dec of named(dd).filter((c) => c.type === "decorator")) {
      const call = named(dec)[0];
      if (call?.type !== "call") continue;
      const fn = call.childForFieldName("function");
      if (fn?.type !== "attribute") continue;
      const obj = fn.childForFieldName("object")?.text ?? "";
      const attr = fn.childForFieldName("attribute")?.text ?? "";
      const router = routers.get(obj);
      if (!router || !ROUTE_ATTRS.has(attr)) continue;
      const args = call.childForFieldName("arguments");
      const kw = kwargs(args);
      const sub = stringValue(positional(args)[0] ?? kw.get("path") ?? kw.get("rule")) ?? "";
      let methods = [attr.toUpperCase()];
      if (attr === "route" || attr === "api_route") {
        const list = kw.get("methods");
        methods = list ? [...list.text.matchAll(/["'](\w+)["']/g)].map((m) => m[1]!.toUpperCase()) : ["GET"];
      }
      const path = joinPaths(modulePrefix, router.prefix, sub);
      const pathParams = new Set(normalizePath(path).params);
      const params = analyseParams(def, pathParams, ctx, router.framework);
      const responseText = kw.get("response_model")?.text ?? def.childForFieldName("return_type")?.text;
      const handler: FuncDef = { file, line: lineOfNode(def), text: def.text };
      for (const method of methods) {
        routes.push({
          id: `route:${file}:${lineOfNode(dd)}:${method}`,
          unit,
          file,
          line: lineOfNode(dec),
          framework: router.framework,
          handler: def.childForFieldName("name")?.text ?? null,
          method,
          path,
          query: params.query,
          body: params.body,
          response: responseText ? pyModelFields(responseText, ctx) : null,
          validated: params.validated,
          validationAt: { file, line: lineOfNode(def) },
          sinks: findSinks(handler, ctx.defs, storeName),
          logs: hasLogging(handler, ctx.defs),
        });
      }
    }
  }
  return routes;
}

function analyseParams(def: SyntaxNode, pathParams: Set<string>, ctx: PyContext, framework: string) {
  const query: RouteQueryParam[] = [];
  let body: FieldSet | null = null;
  let hasInput = pathParams.size > 0;
  let allTyped = true;
  if (framework === "flask") {
    const text = def.text;
    if (/request\.(get_json|json|form|data|values)\b/.test(text)) {
      hasInput = true;
      body = { known: false, names: [] };
      allTyped = /\.(load|validate|model_validate|parse_obj)\(|\w+\(\*\*/.test(text);
    }
    const q = [...text.matchAll(/request\.args(?:\.get)?[[(]\s*["'](\w+)["']/g)].map((m) => m[1]!);
    if (q.length) {
      hasInput = true;
      for (const name of new Set(q)) query.push({ name, required: false });
    }
    return { query: { known: true, params: query }, body, validated: hasInput ? allTyped : null };
  }
  for (const p of named(def.childForFieldName("parameters"))) {
    let name: string | undefined;
    let type: string | undefined;
    let value: string | undefined;
    if (p.type === "identifier") name = p.text;
    else if (p.type === "typed_parameter") {
      name = named(p).find((c) => c.type === "identifier")?.text;
      type = p.childForFieldName("type")?.text;
    } else if (p.type === "default_parameter" || p.type === "typed_default_parameter") {
      name = p.childForFieldName("name")?.text;
      type = p.childForFieldName("type")?.text;
      value = p.childForFieldName("value")?.text;
    } else continue;
    if (!name || name === "self" || name === "cls") continue;
    if (value && /^(Depends|Security|Header|Cookie)\(/.test(value)) continue;
    if (type && SKIP_TYPES.test(type)) continue;
    hasInput = true;
    if (!type) allTyped = false;
    if (pathParams.has(name)) continue;
    const model = type ? pyModelFields(type, ctx) : null;
    if (model || (value && /^Body\(/.test(value))) {
      body = model ?? { known: false, names: [] };
      continue;
    }
    const required = value === undefined || /^(Query|Path)\(\s*(\.\.\.|\))/.test(value) || value === "...";
    query.push({ name, required });
  }
  return { query: { known: true, params: query }, body, validated: hasInput ? allTyped : null };
}

/** Django `path()` entries in urls.py: method-agnostic, no field information. */
export function extractDjangoRoutes(root: SyntaxNode, unit: string, file: string): ServerRoute[] {
  if (!file.endsWith("urls.py")) return [];
  const routes: ServerRoute[] = [];
  for (const call of root.descendantsOfType("call")) {
    if (!call || !/^(path|re_path)$/.test(call.childForFieldName("function")?.text ?? "")) continue;
    const args = positional(call.childForFieldName("arguments"));
    const route = stringValue(args[0]);
    const view = args[1]?.text ?? "";
    if (route === null || /^include\(/.test(view)) continue;
    routes.push({
      id: `route:${file}:${lineOfNode(call)}:*`, unit, file, line: lineOfNode(call), framework: "django",
      handler: view, method: "*", path: joinPaths(route), query: { known: false, params: [] },
      body: null, response: null, validated: null, sinks: [],
    });
  }
  return routes;
}
