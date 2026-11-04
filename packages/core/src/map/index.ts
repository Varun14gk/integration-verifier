// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { join, resolve } from "node:path";
import { detectStack } from "../detect/detect.js";
import type { StackReport, StackUnit } from "../detect/types.js";
import { readText, walkFiles } from "../fs-walk.js";
import { grammarFor, lineOfNode, withTree } from "../parse/tree-sitter.js";
import { collectClientFacts, extractCallsFromTree, type ClientContext } from "./client-ts.js";
import { matchCallsToRoutes } from "./match.js";
import { joinPaths } from "./paths.js";
import { collectJsServer, extractExpressRoutes, extractNestRoutes, type JsServerContext } from "./server-js.js";
import {
  collectCsDtos, collectJavaDtos, extractAspNetRoutes, extractGoRoutes, extractSpringRoutes, type DtoIndex,
} from "./server-jvm-cs-go.js";
import { collectPython, extractDjangoRoutes, extractPythonRoutes, type PyContext } from "./server-python.js";
import { findSinks, type FuncDef } from "./sinks.js";
import { collectTsTypes } from "./ts-types.js";
import type { ClientCall, MapReport, ServerRoute } from "./types.js";

export * from "./types.js";
export { normalizePath, pathSimilarity } from "./paths.js";
export { compareFields, rankSuggestions } from "./match.js";
export { fieldsFromTypeText, collectTsTypes, type TypeDecl, type TypeIndex } from "./ts-types.js";
export { formatMapSummary } from "./summary.js";

const TEST_FILE = /(^|\/)(__tests__|__mocks__|tests?|spec|e2e|cypress|playwright)\/|\.(test|spec|stories|e2e)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$/;
const FRONTEND_FRAMEWORKS = new Set(["react", "nextjs", "angular", "vue", "svelte", "sveltekit"]);

interface SourceFile {
  rel: string;
  /** Path relative to the primary root. */
  file: string;
  text: string;
}

function sources(root: string, unit: StackUnit, grammars: string[]): SourceFile[] {
  const abs = resolve(root, unit.dir);
  const out: SourceFile[] = [];
  for (const rel of walkFiles(abs)) {
    const g = grammarFor(rel);
    if (!g || !grammars.includes(g) || TEST_FILE.test(rel)) continue;
    const text = readText(join(abs, rel));
    if (text !== null) out.push({ rel, file: unit.dir === "." ? rel : `${unit.dir}/${rel}`, text });
  }
  return out;
}

const JS_GRAMMARS = ["typescript", "tsx", "javascript"];

async function frontendCalls(root: string, unit: StackUnit, stack: StackReport): Promise<ClientCall[]> {
  const files = sources(root, unit, JS_GRAMMARS);
  const env = new Map(stack.joins.filter((j) => j.kind === "env" && j.unit === unit.dir && j.value).map((j) => [j.name!, j.value!]));
  const ctx: ClientContext = { types: new Map(), axiosInstances: new Map(), httpClientNames: new Set(), env };
  for (const f of files) {
    await withTree(grammarFor(f.rel)!, f.text, (r) => {
      collectTsTypes(r, f.file, ctx.types);
      collectClientFacts(r, ctx, env);
    });
  }
  const calls: ClientCall[] = [];
  for (const f of files) calls.push(...((await withTree(grammarFor(f.rel)!, f.text, (r) => extractCallsFromTree(r, unit.dir, f.file, ctx))) ?? []));
  return calls;
}

function storeName(unit: StackUnit): string {
  return unit.dataStores[0]?.name ?? unit.orms[0]?.name ?? "database";
}

async function nextApiRoutes(root: string, unit: StackUnit): Promise<ServerRoute[]> {
  const routes: ServerRoute[] = [];
  for (const f of sources(root, unit, JS_GRAMMARS)) {
    const app = /^(?:src\/)?app\/(.*)\/route\.[jt]s$/.exec(f.rel);
    const pages = /^(?:src\/)?pages\/(api\/.*?)(?:\/index)?\.[jt]s$/.exec(f.rel);
    if (!app && !pages) continue;
    const path = joinPaths(...(app ? app[1]! : pages![1]!).split("/").filter((s) => !/^\(.*\)$/.test(s)));
    const methods = app ? [...f.text.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]!) : ["*"];
    for (const method of methods) {
      routes.push({
        id: `route:${f.file}:1:${method}`, unit: unit.dir, file: f.file, line: 1, framework: "nextjs", handler: method, method, path,
        query: { known: false, params: [] }, body: null, response: null, validated: null,
        sinks: findSinks({ file: f.file, line: 1, text: f.text }, new Map(), storeName(unit)),
      });
    }
  }
  return routes;
}

async function backendRoutes(root: string, unit: StackUnit): Promise<{ routes: ServerRoute[]; skipped?: string }> {
  const fw = unit.framework ?? "";
  const store = storeName(unit);
  const defs = new Map<string, FuncDef>();
  if (["fastapi", "flask", "django", "django-rest-framework"].includes(fw)) {
    const files = sources(root, unit, ["python"]);
    const ctx: PyContext = { models: new Map(), includePrefixes: new Map(), defs };
    for (const f of files) await withTree("python", f.text, (r) => collectPython(r, f.file, ctx));
    const routes: ServerRoute[] = [];
    for (const f of files) {
      routes.push(...((await withTree("python", f.text, (r) => [...extractPythonRoutes(r, unit.dir, f.file, ctx, store), ...extractDjangoRoutes(r, unit.dir, f.file)])) ?? []));
    }
    return { routes };
  }
  if (fw === "express" || fw === "nestjs") {
    const files = sources(root, unit, JS_GRAMMARS);
    const ctx: JsServerContext = { types: new Map(), defs, mounts: new Map(), routers: new Map(), defaultExport: new Map(), globalPrefix: "", files: new Set(files.map((f) => f.file)) };
    for (const f of files) {
      await withTree(grammarFor(f.rel)!, f.text, (r) => {
        collectTsTypes(r, f.file, ctx.types);
        collectJsServer(r, f.file, ctx);
      });
    }
    const routes: ServerRoute[] = [];
    for (const f of files) {
      routes.push(...((await withTree(grammarFor(f.rel)!, f.text, (r) => (fw === "nestjs" ? extractNestRoutes : extractExpressRoutes)(r, unit.dir, f.file, ctx, store))) ?? []));
    }
    return { routes };
  }
  if (fw === "spring-boot") {
    const files = sources(root, unit, ["java"]);
    const dtos: DtoIndex = new Map();
    for (const f of files) await withTree("java", f.text, (r) => collectJavaDtos(r, f.file, dtos, defs));
    const routes: ServerRoute[] = [];
    for (const f of files) routes.push(...((await withTree("java", f.text, (r) => extractSpringRoutes(r, unit.dir, f.file, dtos, defs, store))) ?? []));
    return { routes };
  }
  if (fw === "aspnet-core") {
    const files = sources(root, unit, ["c-sharp"]);
    const dtos: DtoIndex = new Map();
    for (const f of files) await withTree("c-sharp", f.text, (r) => collectCsDtos(r, f.file, dtos));
    const routes: ServerRoute[] = [];
    for (const f of files) routes.push(...((await withTree("c-sharp", f.text, (r) => extractAspNetRoutes(r, unit.dir, f.file, dtos))) ?? []));
    return { routes };
  }
  if (["gin", "echo", "net-http"].includes(fw)) {
    const routes: ServerRoute[] = [];
    for (const f of sources(root, unit, ["go"])) routes.push(...((await withTree("go", f.text, (r) => extractGoRoutes(r, unit.dir, f.file, fw))) ?? []));
    return { routes };
  }
  return { routes: [], skipped: fw ? `route extraction for ${fw} is not supported yet` : "no backend framework detected" };
}

export interface BuildMapOptions {
  stack?: StackReport;
  also?: string[];
}

/** Builds the integration map: frontend call sites joined to backend routes. */
export async function buildMap(root: string, opts: BuildMapOptions = {}): Promise<MapReport> {
  const absRoot = resolve(root);
  const stack = opts.stack ?? detectStack([absRoot, ...(opts.also ?? []).map((d) => resolve(d))]);
  const calls: ClientCall[] = [];
  const routes: ServerRoute[] = [];
  const skipped: MapReport["skipped"] = [];
  for (const unit of stack.units) {
    const isFrontend = unit.role === "frontend" || unit.role === "fullstack" || FRONTEND_FRAMEWORKS.has(unit.framework ?? "");
    if (isFrontend) {
      if (unit.language === "typescript" || unit.language === "javascript") calls.push(...(await frontendCalls(absRoot, unit, stack)));
      else skipped.push({ unit: unit.dir, reason: `frontend language ${unit.language} is not supported` });
    }
    if (unit.role === "fullstack" && unit.framework === "nextjs") routes.push(...(await nextApiRoutes(absRoot, unit)));
    if (unit.role === "backend") {
      const r = await backendRoutes(absRoot, unit);
      routes.push(...r.routes);
      if (r.skipped) skipped.push({ unit: unit.dir, reason: r.skipped });
    }
  }
  return { calls, routes, ...matchCallsToRoutes(calls, routes, stack.joins), skipped };
}

// Keep lineOfNode re-exported for extractor authors.
export { lineOfNode };
