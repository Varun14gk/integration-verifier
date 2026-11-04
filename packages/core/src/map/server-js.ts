// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { posix } from "node:path";
import { lineOfNode, named, stringValue, type SyntaxNode } from "../parse/tree-sitter.js";
import { joinPaths, normalizePath } from "./paths.js";
import { findSinks, type FuncDef } from "./sinks.js";
import { fieldsFromTypeText, type TypeIndex } from "./ts-types.js";
import type { FieldSet, RouteQueryParam, ServerRoute } from "./types.js";

const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "all", "options", "head"]);
const NEST_METHODS: Record<string, string> = { Get: "GET", Post: "POST", Put: "PUT", Patch: "PATCH", Delete: "DELETE", All: "*", Options: "OPTIONS", Head: "HEAD" };
const VALIDATOR_MIDDLEWARE = /valid|celebrate|checkSchema|schema|\bbody\(|\bquery\(|\bparam\(/i;

/** Facts from all JS/TS files of one backend unit. */
export interface JsServerContext {
  types: TypeIndex;
  defs: Map<string, FuncDef>;
  /** "file#var" -> mount prefixes from app.use("/prefix", router). */
  mounts: Map<string, string[]>;
  /** file -> names of express apps/routers declared in it */
  routers: Map<string, Set<string>>;
  /** file -> name it exports as default / module.exports */
  defaultExport: Map<string, string>;
  /** Nest app.setGlobalPrefix value. */
  globalPrefix: string;
  /** All unit files, to resolve relative imports. */
  files: Set<string>;
}

function resolveImport(from: string, spec: string, files: Set<string>): string | null {
  if (!spec.startsWith(".")) return null;
  const base = posix.normalize(posix.join(posix.dirname(from), spec)).replace(/\.(js|mjs|cjs)$/, "");
  for (const ext of [".ts", ".js", ".mjs", ".cjs", ".tsx", "/index.ts", "/index.js"]) {
    if (files.has(base + ext)) return base + ext;
  }
  return files.has(base) ? base : null;
}

/** Pass 1: routers, mounts, exports, function defs and the Nest global prefix. */
export function collectJsServer(root: SyntaxNode, file: string, ctx: JsServerContext): void {
  const routers = new Set<string>();
  const imports = new Map<string, string>();
  for (const d of root.descendantsOfType("variable_declarator")) {
    const name = d?.childForFieldName("name")?.text;
    const value = d?.childForFieldName("value");
    if (!d || !name || !value) continue;
    if (/^(express|express\.Router|Router|require\(\s*["']express["']\s*\)(\.Router)?)\s*\(/.test(value.text)) routers.add(name);
    const req = /^require\(\s*["']([^"']+)["']\s*\)/.exec(value.text);
    if (req) {
      const target = resolveImport(file, req[1]!, ctx.files);
      if (target) imports.set(name, target);
    }
    if (value.type === "arrow_function" || value.type === "function_expression" || value.type === "function") {
      ctx.defs.set(name, { file, line: lineOfNode(d), text: value.text });
    }
  }
  for (const imp of root.descendantsOfType("import_statement")) {
    const src = stringValue(imp?.childForFieldName("source"));
    const clause = imp ? named(imp).find((c) => c.type === "import_clause") : undefined;
    const target = src ? resolveImport(file, src, ctx.files) : null;
    if (!clause || !target) continue;
    const def = named(clause).find((c) => c.type === "identifier");
    if (def) imports.set(def.text, target);
    for (const spec of clause.descendantsOfType("import_specifier")) {
      const local = spec?.childForFieldName("alias")?.text ?? spec?.childForFieldName("name")?.text;
      if (local) imports.set(local, `${target}#${spec!.childForFieldName("name")!.text}`);
    }
  }
  for (const fd of root.descendantsOfType("function_declaration")) {
    const name = fd?.childForFieldName("name")?.text;
    if (fd && name) ctx.defs.set(name, { file, line: lineOfNode(fd), text: fd.text });
  }
  for (const call of root.descendantsOfType("call_expression")) {
    const fn = call?.childForFieldName("function");
    if (!call || fn?.type !== "member_expression") continue;
    const prop = fn.childForFieldName("property")?.text;
    const obj = fn.childForFieldName("object")?.text ?? "";
    const args = named(call.childForFieldName("arguments"));
    if (prop === "setGlobalPrefix") ctx.globalPrefix = stringValue(args[0]) ?? "";
    if (prop !== "use" || args.length < 2) continue;
    const prefix = stringValue(args[0]);
    if (prefix === null) continue;
    const prefixOfOwner = (key: string) => {
      ctx.mounts.set(key, [...(ctx.mounts.get(key) ?? []), `${file}#${obj}|${prefix}`]);
    };
    for (const a of args.slice(1)) {
      if (a.type !== "identifier") continue;
      const imported = imports.get(a.text);
      if (imported) prefixOfOwner(imported.includes("#") ? imported : `${imported}#default`);
      else if (routers.has(a.text)) prefixOfOwner(`${file}#${a.text}`);
    }
  }
  for (const ex of root.descendantsOfType(["export_statement", "assignment_expression"])) {
    if (!ex) continue;
    const m = /^(?:export\s+default\s+|module\.exports\s*=\s*)([A-Za-z_$][\w$]*)\s*;?$/.exec(ex.text);
    if (m) ctx.defaultExport.set(file, m[1]!);
  }
  ctx.routers.set(file, routers);
}

/** All prefixes under which `file#name` is mounted, following parent mounts. */
function prefixesFor(file: string, name: string, ctx: JsServerContext, depth = 0): string[] {
  if (depth > 5) return [""];
  const keys = [`${file}#${name}`];
  if (ctx.defaultExport.get(file) === name) keys.push(`${file}#default`);
  const mounts = keys.flatMap((k) => ctx.mounts.get(k) ?? []);
  if (mounts.length === 0) return [""];
  return mounts.flatMap((m) => {
    const [owner, prefix] = m.split("|") as [string, string];
    const [ownerFile, ownerName] = owner.split("#") as [string, string];
    return prefixesFor(ownerFile, ownerName, ctx, depth + 1).map((p) => joinPaths(p, prefix));
  });
}

function handlerParams(fn: SyntaxNode): string[] {
  const params = fn.childForFieldName("parameters") ?? fn.childForFieldName("parameter");
  if (!params) return [];
  if (params.type === "identifier") return [params.text];
  return named(params).map((p) => (p.childForFieldName("pattern") ?? p).text);
}

function destructured(fn: SyntaxNode, source: string): string[] {
  const names: string[] = [];
  for (const d of fn.descendantsOfType("variable_declarator")) {
    if (d?.childForFieldName("value")?.text !== source) continue;
    const pat = d.childForFieldName("name");
    if (pat?.type !== "object_pattern") continue;
    for (const p of named(pat)) {
      if (p.type === "shorthand_property_identifier_pattern") names.push(p.text);
      else if (p.type === "pair_pattern") names.push(p.childForFieldName("key")!.text);
      else if (p.type === "object_assignment_pattern") names.push(named(p)[0]!.text);
    }
  }
  return names;
}

function memberProps(fn: SyntaxNode, object: string): string[] {
  const names: string[] = [];
  for (const m of fn.descendantsOfType("member_expression")) {
    if (m?.childForFieldName("object")?.text === object) names.push(m.childForFieldName("property")!.text);
  }
  return names;
}

function objectKeys(n: SyntaxNode): string[] | null {
  if (n.type !== "object") return null;
  return named(n).flatMap((p) => (p.type === "pair" ? [p.childForFieldName("key")!.text.replace(/^["']|["']$/g, "")] : p.type === "shorthand_property_identifier" ? [p.text] : []));
}

/** Fields of the success response, from res.json(...) / res.send(...) calls. */
function responseFields(fn: SyntaxNode, res: string): FieldSet | null {
  for (const call of fn.descendantsOfType("call_expression")) {
    const callee = call?.childForFieldName("function");
    if (!call || callee?.type !== "member_expression") continue;
    const prop = callee.childForFieldName("property")?.text;
    const objText = callee.childForFieldName("object")?.text ?? "";
    if ((prop !== "json" && prop !== "send") || !(objText === res || objText.startsWith(res + "."))) continue;
    if (/\.status\(\s*[45]\d\d\s*\)/.test(objText)) continue;
    const arg = named(call.childForFieldName("arguments"))[0];
    if (!arg) continue;
    if (arg.type === "array") {
      const first = named(arg)[0];
      const keys = first ? objectKeys(first) : null;
      if (keys) return { known: true, names: keys, source: "response literal", isArray: true };
    }
    const keys = objectKeys(arg);
    if (keys) return { known: true, names: keys, source: "response literal" };
  }
  return null;
}

/** Pass 2: Express-style routes in one file. */
export function extractExpressRoutes(root: SyntaxNode, unit: string, file: string, ctx: JsServerContext, storeName: string): ServerRoute[] {
  const routers = ctx.routers.get(file) ?? new Set<string>();
  const routes: ServerRoute[] = [];
  for (const call of root.descendantsOfType("call_expression")) {
    const callee = call?.childForFieldName("function");
    if (!call || callee?.type !== "member_expression") continue;
    const prop = callee.childForFieldName("property")?.text ?? "";
    let obj = callee.childForFieldName("object");
    if (!ROUTE_METHODS.has(prop) || !obj) continue;
    const args = named(call.childForFieldName("arguments"));
    let sub = stringValue(args[0]);
    let handlerArgs = args.slice(1);
    // router.route("/x").get(h) chains
    if (obj.type === "call_expression" && obj.childForFieldName("function")?.text.endsWith(".route")) {
      sub = stringValue(named(obj.childForFieldName("arguments"))[0]);
      handlerArgs = args;
      obj = obj.childForFieldName("function")!.childForFieldName("object");
    }
    if (sub === null || !obj || obj.type !== "identifier" || !routers.has(obj.text) || handlerArgs.length === 0) continue;

    const last = handlerArgs[handlerArgs.length - 1]!;
    const middlewares = handlerArgs.slice(0, -1).map((m) => m.text);
    let fn: SyntaxNode | null = ["arrow_function", "function_expression", "function"].includes(last.type) ? last : null;
    let fnText = fn?.text ?? ctx.defs.get(last.text)?.text ?? "";
    if (!fn && last.type === "identifier") {
      for (const d of root.descendantsOfType(["function_declaration", "variable_declarator"])) {
        if (d?.childForFieldName("name")?.text === last.text) {
          fn = d.type === "variable_declarator" ? d.childForFieldName("value") : d;
          fnText = fn?.text ?? fnText;
        }
      }
    }
    const [req = "req", res = "res"] = fn ? handlerParams(fn) : [];
    const bodyNames = fn ? [...new Set([...memberProps(fn, `${req}.body`), ...destructured(fn, `${req}.body`)])] : [];
    const usesBody = new RegExp(`\\b${req}\\.body\\b`).test(fnText);
    const queryNames = fn ? [...new Set([...memberProps(fn, `${req}.query`), ...destructured(fn, `${req}.query`)])] : [];
    const schemaCheck = new RegExp(`\\.(safeParse|parse|validate|validateAsync|assert)\\(\\s*${req}\\.(body|query)`).test(fnText);
    const validatedByMiddleware = middlewares.some((m) => VALIDATOR_MIDDLEWARE.test(m));
    const hasInput = usesBody || queryNames.length > 0;
    const method = prop === "all" ? "*" : prop.toUpperCase();
    for (const prefix of prefixesFor(file, obj.text, ctx)) {
      const path = joinPaths(prefix, sub);
      routes.push({
        id: `route:${file}:${lineOfNode(call)}:${method}`,
        unit,
        file,
        line: lineOfNode(call),
        framework: "express",
        handler: last.type === "identifier" ? last.text : null,
        method,
        path,
        query: { known: !!fn, params: queryNames.map((name): RouteQueryParam => ({ name, required: false })) },
        body: usesBody ? { known: bodyNames.length > 0, names: bodyNames, required: [], source: `${req}.body` } : null,
        response: fn ? responseFields(fn, res) : null,
        validated: hasInput ? schemaCheck || validatedByMiddleware : null,
        validationAt: { file, line: lineOfNode(call) },
        sinks: findSinks({ file, line: lineOfNode(call), text: fnText }, ctx.defs, storeName),
      });
    }
  }
  return routes;
}

function decoratorCall(d: SyntaxNode): { name: string; args: SyntaxNode[] } | null {
  const call = named(d)[0];
  if (call?.type === "call_expression") return { name: call.childForFieldName("function")?.text ?? "", args: named(call.childForFieldName("arguments")) };
  if (call?.type === "identifier") return { name: call.text, args: [] };
  return null;
}

/** Pass 2: NestJS controllers in one file. */
export function extractNestRoutes(root: SyntaxNode, unit: string, file: string, ctx: JsServerContext, storeName: string): ServerRoute[] {
  const routes: ServerRoute[] = [];
  for (const cls of root.descendantsOfType("class_declaration")) {
    if (!cls) continue;
    const decorators = [...named(cls), ...(cls.parent?.type === "export_statement" ? named(cls.parent) : [])].filter((c) => c.type === "decorator");
    const controller = decorators.map(decoratorCall).find((d) => d?.name === "Controller");
    if (!controller) continue;
    const prefix = stringValue(controller.args[0]) ?? "";
    let pending: SyntaxNode[] = [];
    for (const member of named(cls.childForFieldName("body"))) {
      if (member.type === "decorator") {
        pending.push(member);
        continue;
      }
      const decs = [...pending, ...named(member).filter((c) => c.type === "decorator")];
      pending = [];
      if (member.type !== "method_definition") continue;
      const routeDec = decs.map(decoratorCall).find((d) => d && d.name in NEST_METHODS);
      if (!routeDec) continue;
      const method = NEST_METHODS[routeDec.name]!;
      const path = joinPaths(ctx.globalPrefix, prefix, stringValue(routeDec.args[0]) ?? "");
      const query: RouteQueryParam[] = [];
      let body: FieldSet | null = null;
      let validated: boolean | null = normalizePath(path).params.length > 0 ? true : null;
      for (const p of named(member.childForFieldName("parameters"))) {
        const pd = named(p).filter((c) => c.type === "decorator").map(decoratorCall)[0];
        const type = p.childForFieldName("type")?.text ?? "";
        if (pd?.name === "Body") {
          body = fieldsFromTypeText(type, ctx.types) ?? { known: false, names: [], source: type };
          const decl = ctx.types.get(type.replace(/^:\s*/, ""));
          validated = !!decl && decl.fields.some((f) => f.validated);
        } else if (pd?.name === "Query") {
          const name = stringValue(pd.args[0]);
          if (name) query.push({ name, required: p.type === "required_parameter" });
          else {
            const fs = fieldsFromTypeText(type, ctx.types);
            for (const n of fs?.names ?? []) query.push({ name: n, required: (fs?.required ?? []).includes(n) });
          }
        }
      }
      routes.push({
        id: `route:${file}:${lineOfNode(member)}:${method}`,
        unit,
        file,
        line: lineOfNode(member),
        framework: "nestjs",
        handler: `${cls.childForFieldName("name")?.text}.${member.childForFieldName("name")?.text}`,
        method,
        path,
        query: { known: true, params: query },
        body,
        response: member.childForFieldName("return_type") ? fieldsFromTypeText(member.childForFieldName("return_type")!.text, ctx.types) : null,
        validated,
        validationAt: { file, line: lineOfNode(member) },
        sinks: findSinks({ file, line: lineOfNode(member), text: member.text }, ctx.defs, storeName),
      });
    }
  }
  return routes;
}
