// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { basename, dirname, join, posix, relative, resolve } from "node:path";
import { lineOf, readText, toPosix, walkFiles } from "../fs-walk.js";
import {
  API_ENV_NAME, FRAMEWORK_PRIORITY, GO_DEPS, HTTP_CLIENT_PRIORITY, JVM_DEPS, NON_OUTBOUND_HOSTS,
  NPM_DEPS, NUGET_DEPS, PY_DEPS, SCHEMA_PRIORITY, UNSUPPORTED_MANIFESTS, type DepRule,
} from "./rules.js";
import type { Detected, DetectEvidence, OutboundHost, Role, StackJoin, StackReport, StackUnit } from "./types.js";

const MANIFESTS = ["package.json", "requirements.txt", "pyproject.toml", "Pipfile", "setup.py", "pom.xml", "build.gradle", "build.gradle.kts", "go.mod"];
const SOURCE_EXT: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".vue": "javascript", ".svelte": "javascript",
  ".py": "python", ".java": "java", ".kt": "kotlin", ".cs": "csharp", ".go": "go",
};
const MANIFEST_LANGUAGE: Record<string, string> = {
  "package.json": "javascript", "requirements.txt": "python", "pyproject.toml": "python", Pipfile: "python",
  "setup.py": "python", "pom.xml": "java", "build.gradle": "java", "build.gradle.kts": "kotlin", "go.mod": "go",
};

/** Accumulates detections by name, keeping the highest confidence and all evidence. */
class Bag {
  private items = new Map<string, Detected>();
  add(name: string, confidence: number, evidence: DetectEvidence, supported = true): void {
    const existing = this.items.get(name);
    if (existing) {
      existing.confidence = Math.max(existing.confidence, confidence);
      if (existing.evidence.length < 5) existing.evidence.push(evidence);
    } else {
      this.items.set(name, { name, confidence, evidence: [evidence], supported });
    }
  }
  has(name: string): boolean {
    return this.items.has(name);
  }
  list(priority: string[] = []): Detected[] {
    const rank = (n: string) => (priority.includes(n) ? priority.indexOf(n) : priority.length);
    return [...this.items.values()].sort((a, b) => rank(a.name) - rank(b.name) || b.confidence - a.confidence);
  }
}

interface UnitWork {
  abs: string;
  dir: string;
  manifests: string[];
  files: string[];
  frameworks: Bag;
  httpClients: Bag;
  bundlers: Bag;
  schemas: Bag;
  dataStores: Bag;
  orms: Bag;
  roles: Set<"frontend" | "backend">;
}

interface Context {
  primary: string;
  apiStyles: Bag;
  openapiFiles: Set<string>;
  openapiGen: Set<string>;
  joins: StackJoin[];
  outbound: OutboundHost[];
}

/**
 * Detects the stack under one or more roots. The first root is primary: all
 * paths in the report are relative to it. Extra roots cover separate repos.
 */
export function detectStack(roots: string[]): StackReport {
  const absRoots = roots.map((r) => resolve(r));
  const primary = absRoots[0] ?? resolve(".");
  const ctx: Context = { primary, apiStyles: new Bag(), openapiFiles: new Set(), openapiGen: new Set(), joins: [], outbound: [] };
  const units: UnitWork[] = [];
  const unsupported: StackReport["unsupported"] = [];

  for (const root of absRoots) {
    const files = walkFiles(root);
    const manifestDirs = new Map<string, string[]>();
    for (const f of files) {
      const name = posix.basename(f);
      const dir = posix.dirname(f);
      if (MANIFESTS.includes(name) || name.endsWith(".csproj")) {
        manifestDirs.set(dir, [...(manifestDirs.get(dir) ?? []), name]);
      } else if (name in UNSUPPORTED_MANIFESTS) {
        unsupported.push({ dir: rel(primary, join(root, dir)), reason: `${UNSUPPORTED_MANIFESTS[name]} projects are not supported yet (${name})` });
      }
      if (/(^|\/)(openapi|swagger)[^/]*\.(json|ya?ml)$/i.test(f)) ctx.openapiFiles.add(rel(primary, join(root, f)));
    }
    // Each file belongs to the deepest unit folder that contains it.
    const unitDirs = [...manifestDirs.keys()].sort((a, b) => b.length - a.length);
    const byUnit = new Map<string, string[]>(unitDirs.map((d) => [d, []]));
    for (const f of files) {
      const owner = unitDirs.find((d) => d === "." || f.startsWith(d + "/"));
      if (owner !== undefined) byUnit.get(owner)!.push(owner === "." ? f : f.slice(owner.length + 1));
    }
    for (const dir of unitDirs.reverse()) {
      const abs = join(root, dir);
      units.push({
        abs, dir: rel(primary, abs), manifests: manifestDirs.get(dir)!, files: byUnit.get(dir)!,
        frameworks: new Bag(), httpClients: new Bag(), bundlers: new Bag(), schemas: new Bag(),
        dataStores: new Bag(), orms: new Bag(), roles: new Set(),
      });
    }
  }

  for (const unit of units) {
    readManifests(unit, ctx);
    scanSources(unit, ctx);
    findJoins(unit, ctx);
  }

  const stackUnits = units.map(finishUnit);
  const lowConfidence: StackReport["lowConfidence"] = [];
  for (const u of stackUnits) {
    for (const [what, list] of [["framework", u.frameworks], ["httpClient", u.httpClients], ["schema", u.schemaSources], ["dataStore", u.dataStores]] as const) {
      for (const d of list) if (d.confidence < 0.7) lowConfidence.push({ unit: u.dir, what, name: d.name, confidence: d.confidence });
    }
    for (const f of u.frameworks) {
      if (!f.supported) unsupported.push({ dir: u.dir, reason: `framework ${f.name} is recognised but not supported yet` });
    }
  }

  return {
    roots: absRoots.map((r) => rel(primary, r)),
    units: stackUnits,
    apiStyles: ctx.apiStyles.list(),
    openapi: { files: [...ctx.openapiFiles].sort(), generatedBy: [...ctx.openapiGen].sort() },
    joins: ctx.joins,
    outbound: ctx.outbound,
    unsupported,
    lowConfidence,
  };
}

function rel(primary: string, abs: string): string {
  return toPosix(relative(primary, abs)) || ".";
}

function unitFile(unit: UnitWork, file: string): string {
  return unit.dir === "." ? file : `${unit.dir}/${file}`;
}

function apply(unit: UnitWork, ctx: Context, rules: DepRule[], confidence: number, ev: DetectEvidence): void {
  for (const r of rules) {
    switch (r.kind) {
      case "framework":
        unit.frameworks.add(r.value, confidence, ev, r.supported ?? true);
        if (r.role) unit.roles.add(r.role);
        break;
      case "httpClient": unit.httpClients.add(r.value, confidence, ev); break;
      case "bundler": unit.bundlers.add(r.value, confidence, ev); break;
      case "schema": unit.schemas.add(r.value, confidence, ev); break;
      case "dataStore": unit.dataStores.add(r.value, confidence, ev); break;
      case "orm": unit.orms.add(r.value, confidence, ev); break;
      case "apiStyle": ctx.apiStyles.add(r.value, confidence, ev); break;
      case "openapiGen": ctx.openapiGen.add(r.value); break;
    }
  }
}

function readManifests(unit: UnitWork, ctx: Context): void {
  for (const manifest of unit.manifests) {
    const text = readText(join(unit.abs, manifest));
    if (text === null) continue;
    const file = unitFile(unit, manifest);
    const at = (needle: string, reason: string): DetectEvidence => {
      const i = text.indexOf(needle);
      return { file, line: i >= 0 ? lineOf(text, i) : undefined, reason };
    };

    if (manifest === "package.json") {
      let pkg: Record<string, unknown>;
      try {
        pkg = JSON.parse(text);
      } catch {
        continue;
      }
      const deps = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object), ...(pkg.peerDependencies as object) };
      for (const name of Object.keys(deps)) {
        const rules = NPM_DEPS[name];
        if (rules) apply(unit, ctx, rules, 0.95, at(`"${name}"`, `dependency ${name}`));
      }
      if (typeof pkg.proxy === "string") {
        ctx.joins.push({ kind: "package-proxy", unit: unit.dir, file, line: at('"proxy"', "").line, from: "/", to: pkg.proxy });
      }
    } else if (manifest === "pom.xml" || manifest.startsWith("build.gradle")) {
      for (const [needle, rules] of Object.entries(JVM_DEPS)) {
        if (text.includes(needle)) apply(unit, ctx, rules, 0.95, at(needle, `dependency ${needle}`));
      }
    } else if (manifest === "go.mod") {
      for (const [needle, rules] of Object.entries(GO_DEPS)) {
        if (text.includes(needle)) apply(unit, ctx, rules, 0.95, at(needle, `module ${needle}`));
      }
    } else if (manifest.endsWith(".csproj")) {
      if (/Sdk="Microsoft\.NET\.Sdk\.Web"/.test(text) || text.includes("Microsoft.AspNetCore")) {
        apply(unit, ctx, [{ kind: "framework", value: "aspnet-core", role: "backend" }], 0.95, at("Microsoft.", "ASP.NET Core SDK"));
      }
      for (const [needle, rules] of Object.entries(NUGET_DEPS)) {
        if (text.includes(`"${needle}`)) apply(unit, ctx, rules, 0.95, at(needle, `package ${needle}`));
      }
    } else {
      // Python manifests: match known distribution names as whole words.
      for (const [name, rules] of Object.entries(PY_DEPS)) {
        const m = new RegExp(`(^|[\\s"'\\[,])${name.replace(/[-.]/g, "[-_.]")}(?=$|[\\s"'<>=~!;\\[\\],])`, "im").exec(text);
        if (m) apply(unit, ctx, rules, 0.95, { file, line: lineOf(text, m.index + m[1]!.length), reason: `dependency ${name}` });
      }
    }
  }
}

function languageOf(file: string): string | undefined {
  const dot = file.lastIndexOf(".");
  return dot >= 0 ? SOURCE_EXT[file.slice(dot)] : undefined;
}

function scanSources(unit: UnitWork, ctx: Context): void {
  for (const f of unit.files) {
    const lang = languageOf(f);
    if (!lang) continue;
    const text = readText(join(unit.abs, f));
    if (text === null) continue;
    const file = unitFile(unit, f);
    const hit = (re: RegExp): DetectEvidence | null => {
      const m = re.exec(text);
      return m ? { file, line: lineOf(text, m.index), reason: `matched ${re.source.slice(0, 40)}` } : null;
    };
    let ev: DetectEvidence | null;

    if (lang === "typescript" || lang === "javascript") {
      if ((ev = hit(/\bfetch\s*\(/))) unit.httpClients.add("fetch", 0.8, ev);
      if ((ev = hit(/from\s+["']@angular\/common\/http["']/))) unit.httpClients.add("angular-httpclient", 0.95, ev);
      if ((ev = hit(/from\s+["']@reduxjs\/toolkit\/query/))) unit.httpClients.add("rtk-query", 0.95, ev);
      if ((ev = hit(/new\s+EventSource\s*\(/))) ctx.apiStyles.add("sse", 0.8, ev);
      if ((ev = hit(/new\s+WebSocket\s*\(/))) ctx.apiStyles.add("websocket", 0.8, ev);
      if ((ev = hit(/^\s*(export\s+)?(interface|type)\s+\w+/m))) unit.schemas.add("typescript-types", 0.8, ev);
    } else if (lang === "python") {
      if ((ev = hit(/^\s*(from\s+pydantic\s+import|import\s+pydantic)/m))) unit.schemas.add("pydantic", 0.95, ev);
      if ((ev = hit(/^\s*import\s+sqlite3/m))) unit.dataStores.add("sqlite", 0.9, ev);
      if ((ev = hit(/^\s*from\s+fastapi\s+import/m))) {
        unit.frameworks.add("fastapi", 0.85, ev);
        unit.roles.add("backend");
        ctx.openapiGen.add("fastapi");
      }
      if ((ev = hit(/^\s*from\s+flask\s+import/m))) { unit.frameworks.add("flask", 0.85, ev); unit.roles.add("backend"); }
      if ((ev = hit(/^\s*from\s+rest_framework/m))) { unit.frameworks.add("django-rest-framework", 0.85, ev); unit.roles.add("backend"); }
      if ((ev = hit(/\bWebSocket\b/))) ctx.apiStyles.add("websocket", 0.6, ev);
    } else if (lang === "java" || lang === "kotlin") {
      if ((ev = hit(/@RestController\b/))) {
        unit.frameworks.add("spring-boot", 0.85, ev);
        unit.roles.add("backend");
      }
      if ((ev = hit(/@RequestBody\b/))) unit.schemas.add("java-dto", 0.8, ev);
      if ((ev = hit(/import\s+(jakarta|javax)\.validation/))) unit.schemas.add("bean-validation", 0.9, ev);
    } else if (lang === "csharp") {
      if ((ev = hit(/\[ApiController\]|\.Map(Get|Post|Put|Delete|Patch)\s*\(/))) {
        unit.frameworks.add("aspnet-core", 0.85, ev);
        unit.roles.add("backend");
      }
    } else if (lang === "go") {
      if ((ev = hit(/"net\/http"/)) && /\bhttp\.(HandleFunc|Handle|ListenAndServe)\b/.test(text)) {
        unit.frameworks.add("net-http", 0.75, ev);
        unit.roles.add("backend");
      }
    }
    if (f.endsWith(".proto")) ctx.apiStyles.add("grpc", 0.9, { file, reason: "protobuf file" });

    findOutbound(unit, ctx, file, text);
    findEnvRefs(unit, ctx, file, text);
  }
  for (const f of unit.files) {
    if (/application(-\w+)?\.(properties|ya?ml)$/.test(f)) {
      const text = readText(join(unit.abs, f));
      const m = text && /jdbc:(postgresql|mysql|sqlserver|oracle|h2|sqlite|mariadb):/.exec(text);
      if (m && text) unit.dataStores.add(m[1]!, 0.95, { file: unitFile(unit, f), line: lineOf(text, m.index), reason: "JDBC URL" });
    }
    if (f.endsWith(".proto")) ctx.apiStyles.add("grpc", 0.9, { file: unitFile(unit, f), reason: "protobuf file" });
  }
}

const URL_LITERAL = /["'`](https?:\/\/([a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(:\d+)?[^"'`\s]*)["'`]/g;

function findOutbound(unit: UnitWork, ctx: Context, file: string, text: string): void {
  for (const m of text.matchAll(URL_LITERAL)) {
    const host = m[2]!.toLowerCase();
    if (NON_OUTBOUND_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".local")) continue;
    // Skip URLs in comments.
    const lineStart = text.lastIndexOf("\n", m.index) + 1;
    const prefix = text.slice(lineStart, m.index).trim();
    if (prefix.startsWith("//") || prefix.startsWith("#") || prefix.startsWith("*")) continue;
    ctx.outbound.push({ host, url: m[1]!, unit: unit.dir, file, line: lineOf(text, m.index) });
  }
}

function findEnvRefs(unit: UnitWork, ctx: Context, file: string, text: string): void {
  for (const m of text.matchAll(/\b(?:import\.meta\.env|process\.env)\.([A-Z_][A-Z0-9_]*)/g)) {
    const name = m[1]!;
    if (!API_ENV_NAME.test(name)) continue;
    if (ctx.joins.some((j) => j.kind === "env" && j.name === name && j.unit === unit.dir && j.file === file)) continue;
    ctx.joins.push({ kind: "env", unit: unit.dir, file, line: lineOf(text, m.index), name });
  }
}

function findJoins(unit: UnitWork, ctx: Context): void {
  for (const f of unit.files) {
    const name = basename(f);
    const file = unitFile(unit, f);
    if (/^\.env(\.[\w-]+)?$/.test(name) && dirname(f) === ".") {
      const text = readText(join(unit.abs, f)) ?? "";
      for (const m of text.matchAll(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/gm)) {
        if (!API_ENV_NAME.test(m[1]!)) continue;
        ctx.joins.push({ kind: "env", unit: unit.dir, file, line: lineOf(text, m.index), name: m[1], value: m[2]!.trim().replace(/^["']|["']$/g, "") });
      }
    } else if (/^vite\.config\.(ts|js|mjs|cjs|mts)$/.test(name)) {
      const text = readText(join(unit.abs, f)) ?? "";
      const proxyAt = text.search(/\bproxy\s*:/);
      if (proxyAt < 0) continue;
      const block = text.slice(proxyAt);
      const entry = /["'](\/[^"']*)["']\s*:\s*(?:["']([^"']+)["']|\{[^}]*?target\s*:\s*["']([^"']+)["'])/g;
      for (const m of block.matchAll(entry)) {
        ctx.joins.push({ kind: "dev-proxy", unit: unit.dir, file, line: lineOf(text, proxyAt + m.index), from: m[1], to: m[2] ?? m[3] });
      }
    } else if (/^proxy\.conf\.json$/.test(name)) {
      const text = readText(join(unit.abs, f)) ?? "";
      try {
        const conf = JSON.parse(text) as Record<string, { target?: string }>;
        for (const [from, v] of Object.entries(conf)) {
          if (v?.target) ctx.joins.push({ kind: "dev-proxy", unit: unit.dir, file, line: lineOf(text, text.indexOf(`"${from}"`)), from, to: v.target });
        }
      } catch {
        /* not JSON: ignore */
      }
    } else if (/^next\.config\.(js|mjs|cjs|ts)$/.test(name)) {
      const text = readText(join(unit.abs, f)) ?? "";
      const re = /source\s*:\s*["'`]([^"'`]+)["'`]\s*,\s*destination\s*:\s*["'`]([^"'`]+)["'`]/g;
      for (const m of text.matchAll(re)) {
        ctx.joins.push({ kind: "nextjs-rewrite", unit: unit.dir, file, line: lineOf(text, m.index), from: m[1], to: m[2] });
      }
    }
  }
}

function packageManager(unit: UnitWork): string | null {
  const has = (f: string) => existsSync(join(unit.abs, f));
  const m = unit.manifests;
  if (m.includes("package.json")) {
    if (has("pnpm-lock.yaml")) return "pnpm";
    if (has("yarn.lock")) return "yarn";
    if (has("bun.lockb") || has("bun.lock")) return "bun";
    return "npm";
  }
  if (m.includes("pyproject.toml") && has("poetry.lock")) return "poetry";
  if (m.includes("pyproject.toml") && has("uv.lock")) return "uv";
  if (m.includes("Pipfile")) return "pipenv";
  if (m.some((x) => ["requirements.txt", "pyproject.toml", "setup.py"].includes(x))) return "pip";
  if (m.includes("pom.xml")) return "maven";
  if (m.some((x) => x.startsWith("build.gradle"))) return "gradle";
  if (m.some((x) => x.endsWith(".csproj"))) return "dotnet";
  if (m.includes("go.mod")) return "go";
  return null;
}

function finishUnit(unit: UnitWork): StackUnit {
  const counts = new Map<string, number>();
  for (const f of unit.files) {
    const lang = languageOf(f);
    if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  const languages = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);
  const manifestLang = unit.manifests.map((m) => (m.endsWith(".csproj") ? "csharp" : MANIFEST_LANGUAGE[m])).find(Boolean) ?? "unknown";
  // A package.json project with any TypeScript is a TypeScript project.
  const language = manifestLang === "javascript" && counts.has("typescript") ? "typescript" : manifestLang;

  const frameworks = unit.frameworks.list(FRAMEWORK_PRIORITY);
  const httpClients = unit.httpClients.list(HTTP_CLIENT_PRIORITY);
  const schemaSources = unit.schemas.list(SCHEMA_PRIORITY);
  const isNextWithApi = frameworks[0]?.name === "nextjs" && unit.files.some((f) => /^(src\/)?(pages\/api\/|app\/.*\/route\.(ts|js)$)/.test(f));

  let role: Role = "unknown";
  if (isNextWithApi || (unit.roles.has("frontend") && unit.roles.has("backend"))) role = "fullstack";
  else if (unit.roles.has("frontend")) role = "frontend";
  else if (unit.roles.has("backend")) role = "backend";

  // Backends rarely use TypeScript interfaces as their API schema; prefer real validators.
  const schemas = role === "backend" ? schemaSources.filter((s) => s.name !== "typescript-types") : schemaSources;

  return {
    dir: unit.dir,
    role,
    language,
    languages,
    packageManager: packageManager(unit),
    framework: frameworks[0]?.name ?? null,
    frameworks,
    bundler: unit.bundlers.list(["next", "vite", "webpack"])[0]?.name ?? null,
    httpClient: role === "backend" ? null : httpClients[0]?.name ?? null,
    httpClients,
    schema: schemas[0]?.name ?? null,
    schemaSources: schemas,
    dataStores: unit.dataStores.list(),
    orms: unit.orms.list(),
  };
}
