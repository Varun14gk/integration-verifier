// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { lineOfNode, named, stringValue, type SyntaxNode } from "../parse/tree-sitter.js";
import { joinPaths, normalizePath } from "./paths.js";
import { findSinks, hasLogging, type FuncDef } from "./sinks.js";
import type { FieldSet, RouteQueryParam, ServerRoute } from "./types.js";

/** A Java or C# class (or record) reduced to its fields. */
export interface DtoDecl {
  name: string;
  file: string;
  line: number;
  fields: { name: string; line: number; constrained: boolean }[];
}

export type DtoIndex = Map<string, DtoDecl>;

const CONSTRAINTS = /^(NotNull|NotBlank|NotEmpty|Size|Min|Max|Email|Pattern|Positive|PositiveOrZero|Negative|Past|Future|Valid|Required|Range|StringLength|EmailAddress|RegularExpression)$/;

// ---- Java / Spring ---------------------------------------------------------

interface Annotation {
  name: string;
  positional: string[];
  pairs: Map<string, string>;
}

function annotations(modifiers: SyntaxNode | null | undefined): Annotation[] {
  const out: Annotation[] = [];
  for (const a of named(modifiers)) {
    if (a.type !== "annotation" && a.type !== "marker_annotation") continue;
    const ann: Annotation = { name: a.childForFieldName("name")?.text ?? "", positional: [], pairs: new Map() };
    for (const arg of named(a.childForFieldName("arguments"))) {
      if (arg.type === "element_value_pair") {
        const v = arg.childForFieldName("value");
        const s = stringValue(v) ?? (v?.type === "element_value_array_initializer" ? stringValue(named(v)[0]) : null);
        ann.pairs.set(arg.childForFieldName("key")?.text ?? "", s ?? v?.text ?? "");
      } else if (arg.type === "element_value_array_initializer") {
        const s = stringValue(named(arg)[0]);
        if (s !== null) ann.positional.push(s);
      } else {
        const s = stringValue(arg);
        if (s !== null) ann.positional.push(s);
      }
    }
    out.push(ann);
  }
  return out;
}

function modifiersOf(n: SyntaxNode): SyntaxNode | undefined {
  return named(n).find((c) => c.type === "modifiers");
}

const SPRING_MAPPINGS: Record<string, string> = { GetMapping: "GET", PostMapping: "POST", PutMapping: "PUT", PatchMapping: "PATCH", DeleteMapping: "DELETE", RequestMapping: "*" };

function mappingPath(a: Annotation): string {
  return a.positional[0] ?? a.pairs.get("value") ?? a.pairs.get("path") ?? "";
}

export function collectJavaDtos(root: SyntaxNode, file: string, index: DtoIndex, defs: Map<string, FuncDef>): void {
  for (const cls of root.descendantsOfType(["class_declaration", "record_declaration"])) {
    if (!cls) continue;
    const name = cls.childForFieldName("name")?.text;
    if (!name) continue;
    const fields: DtoDecl["fields"] = [];
    if (cls.type === "record_declaration") {
      for (const p of named(cls.childForFieldName("parameters"))) {
        const n = p.childForFieldName("name")?.text;
        if (n) fields.push({ name: n, line: lineOfNode(p), constrained: annotations(modifiersOf(p)).some((a) => CONSTRAINTS.test(a.name)) });
      }
    }
    for (const f of named(cls.childForFieldName("body"))) {
      if (f.type === "method_declaration") {
        const mn = f.childForFieldName("name")?.text;
        if (mn) defs.set(mn, { file, line: lineOfNode(f), text: f.text });
      }
      if (f.type !== "field_declaration") continue;
      const mods = modifiersOf(f);
      if (/\bstatic\b/.test(mods?.text ?? "")) continue;
      for (const d of f.childrenForFieldName("declarator")) {
        const n = d?.childForFieldName("name")?.text;
        if (n) fields.push({ name: n, line: lineOfNode(f), constrained: annotations(mods).some((a) => CONSTRAINTS.test(a.name)) });
      }
    }
    index.set(name, { name, file, line: lineOfNode(cls), fields });
  }
}

/** Unwraps List<X>, ResponseEntity<X>, Optional<X>, X[] and friends to a DTO's fields. */
export function dtoFields(typeText: string, index: DtoIndex): FieldSet | null {
  let t = typeText.trim();
  let isArray = false;
  for (let g = 0; g < 4; g++) {
    const m = /^(?:[\w.]+\.)?(ResponseEntity|Optional|Mono|Flux|List|Set|Collection|Iterable|Page|ActionResult|Task|IEnumerable|IList|IReadOnlyList|IActionResult)<(.+)>$/.exec(t);
    if (m) {
      if (/^(Flux|List|Set|Collection|Iterable|Page|IEnumerable|IList|IReadOnlyList)$/.test(m[1]!)) isArray = true;
      t = m[2]!.trim();
    } else if (t.endsWith("[]")) {
      isArray = true;
      t = t.slice(0, -2);
    } else break;
  }
  const d = index.get(t);
  if (!d) return null;
  return {
    known: true,
    names: d.fields.map((f) => f.name),
    required: [],
    source: d.name,
    declaredAt: { file: d.file, line: d.line },
    fieldLines: Object.fromEntries(d.fields.map((f) => [f.name, f.line])),
    isArray,
  };
}

export function extractSpringRoutes(root: SyntaxNode, unit: string, file: string, dtos: DtoIndex, defs: Map<string, FuncDef>, storeName: string): ServerRoute[] {
  const routes: ServerRoute[] = [];
  for (const cls of root.descendantsOfType("class_declaration")) {
    if (!cls) continue;
    const classAnns = annotations(modifiersOf(cls));
    if (!classAnns.some((a) => a.name === "RestController" || a.name === "Controller")) continue;
    const base = classAnns.find((a) => a.name === "RequestMapping");
    const prefix = base ? mappingPath(base) : "";
    for (const m of named(cls.childForFieldName("body"))) {
      if (m.type !== "method_declaration") continue;
      const anns = annotations(modifiersOf(m));
      const mapping = anns.find((a) => a.name in SPRING_MAPPINGS);
      if (!mapping) continue;
      let method = SPRING_MAPPINGS[mapping.name]!;
      if (mapping.name === "RequestMapping") method = /RequestMethod\.(\w+)/.exec(mapping.pairs.get("method") ?? "")?.[1] ?? "*";
      const path = joinPaths(prefix, mappingPath(mapping));
      const query: RouteQueryParam[] = [];
      let body: FieldSet | null = null;
      let validated: boolean | null = null;
      let validationLine = lineOfNode(m);
      for (const p of named(m.childForFieldName("parameters"))) {
        const pAnns = annotations(modifiersOf(p));
        const pName = p.childForFieldName("name")?.text ?? "";
        const type = p.childForFieldName("type")?.text ?? "";
        const rp = pAnns.find((a) => a.name === "RequestParam");
        if (rp) {
          const name = rp.positional[0] ?? rp.pairs.get("value") ?? rp.pairs.get("name") ?? pName;
          query.push({ name, required: rp.pairs.get("required") !== "false" && !rp.pairs.has("defaultValue") });
          validated ??= true;
        }
        if (pAnns.some((a) => a.name === "PathVariable")) validated ??= true;
        if (pAnns.some((a) => a.name === "RequestBody")) {
          body = dtoFields(type, dtos) ?? { known: false, names: [], source: type };
          validated = pAnns.some((a) => a.name === "Valid" || a.name === "Validated");
          validationLine = lineOfNode(p);
        }
      }
      routes.push({
        id: `route:${file}:${lineOfNode(m)}:${method}`,
        unit,
        file,
        line: lineOfNode(m),
        framework: "spring-boot",
        handler: `${cls.childForFieldName("name")?.text}.${m.childForFieldName("name")?.text}`,
        method,
        path,
        query: { known: true, params: query },
        body,
        response: dtoFields(m.childForFieldName("type")?.text ?? "", dtos),
        validated,
        validationAt: { file, line: validationLine },
        sinks: findSinks({ file, line: lineOfNode(m), text: m.text }, defs, storeName),
        logs: hasLogging({ file, line: lineOfNode(m), text: m.text }, defs),
      });
    }
  }
  return routes;
}

// ---- C# / ASP.NET Core -----------------------------------------------------

interface CsAttr {
  name: string;
  args: string[];
}

function csAttributes(n: SyntaxNode): CsAttr[] {
  const out: CsAttr[] = [];
  for (const list of named(n).filter((c) => c.type === "attribute_list")) {
    for (const a of named(list).filter((c) => c.type === "attribute")) {
      const args = a.descendantsOfType("string_literal").map((s) => (s ? stringValue(s) ?? s.text.replace(/^"|"$/g, "") : ""));
      out.push({ name: a.childForFieldName("name")?.text.replace(/Attribute$/, "") ?? "", args });
    }
  }
  return out;
}

const CS_HTTP: Record<string, string> = { HttpGet: "GET", HttpPost: "POST", HttpPut: "PUT", HttpPatch: "PATCH", HttpDelete: "DELETE" };
const CS_PRIMITIVES = /^(int|long|short|string|bool|Guid|DateTime|decimal|double|float|byte|uint|ulong)\??$/;

export function collectCsDtos(root: SyntaxNode, file: string, index: DtoIndex): void {
  for (const cls of root.descendantsOfType(["class_declaration", "record_declaration"])) {
    if (!cls) continue;
    const name = cls.childForFieldName("name")?.text;
    if (!name) continue;
    const fields: DtoDecl["fields"] = [];
    for (const p of cls.descendantsOfType("property_declaration")) {
      const n = p?.childForFieldName("name")?.text;
      if (p && n) fields.push({ name: n[0]!.toLowerCase() + n.slice(1), line: lineOfNode(p), constrained: csAttributes(p).some((a) => CONSTRAINTS.test(a.name)) });
    }
    for (const p of named(cls.childForFieldName("parameters") ?? named(cls).find((c) => c.type === "parameter_list"))) {
      const n = p.childForFieldName("name")?.text;
      if (n) fields.push({ name: n[0]!.toLowerCase() + n.slice(1), line: lineOfNode(p), constrained: false });
    }
    index.set(name, { name, file, line: lineOfNode(cls), fields });
  }
}

export function extractAspNetRoutes(root: SyntaxNode, unit: string, file: string, dtos: DtoIndex): ServerRoute[] {
  const routes: ServerRoute[] = [];
  for (const cls of root.descendantsOfType("class_declaration")) {
    if (!cls) continue;
    const name = cls.childForFieldName("name")?.text ?? "";
    const attrs = csAttributes(cls);
    const isController = attrs.some((a) => a.name === "ApiController") || /Controller$/.test(name);
    if (!isController) continue;
    const controllerToken = name.replace(/Controller$/, "").toLowerCase();
    const prefix = (attrs.find((a) => a.name === "Route")?.args[0] ?? "").replace("[controller]", controllerToken);
    for (const m of cls.descendantsOfType("method_declaration")) {
      if (!m) continue;
      const mAttrs = csAttributes(m);
      const http = mAttrs.find((a) => a.name in CS_HTTP);
      if (!http) continue;
      const sub = http.args[0] ?? mAttrs.find((a) => a.name === "Route")?.args[0] ?? "";
      const path = sub.startsWith("/") ? joinPaths(sub) : joinPaths(prefix, sub);
      const pathParams = new Set(normalizePath(path).params);
      const query: RouteQueryParam[] = [];
      let body: FieldSet | null = null;
      for (const p of named(m.childForFieldName("parameters"))) {
        const pName = p.childForFieldName("name")?.text ?? "";
        const type = p.childForFieldName("type")?.text ?? "";
        const pa = csAttributes(p).map((a) => a.name);
        if (pathParams.has(pName) || pa.includes("FromRoute")) continue;
        if (pa.includes("FromBody") || (!CS_PRIMITIVES.test(type) && !pa.includes("FromQuery"))) body = dtoFields(type, dtos) ?? { known: false, names: [], source: type };
        else query.push({ name: pName, required: !type.endsWith("?") });
      }
      routes.push({
        id: `route:${file}:${lineOfNode(m)}:${CS_HTTP[http.name]}`, unit, file, line: lineOfNode(m), framework: "aspnet-core",
        handler: `${name}.${m.childForFieldName("name")?.text}`, method: CS_HTTP[http.name]!, path,
        query: { known: true, params: query }, body, response: dtoFields(m.childForFieldName("returns")?.text ?? "", dtos),
        // [ApiController] validates DataAnnotations automatically.
        validated: body ? attrs.some((a) => a.name === "ApiController") : pathParams.size || query.length ? true : null,
        validationAt: { file, line: lineOfNode(m) }, sinks: [],
      });
    }
  }
  // Minimal APIs: app.MapGet("/x", ...), with MapGroup prefixes.
  const groups = new Map<string, string>();
  for (const v of root.descendantsOfType("variable_declarator")) {
    const m = v && /^(\w+)\s*=\s*(\w+)\.MapGroup\(\s*"([^"]*)"/.exec(v.text);
    if (m) groups.set(m[1]!, joinPaths(groups.get(m[2]!) ?? "", m[3]!));
  }
  for (const inv of root.descendantsOfType("invocation_expression")) {
    const fn = inv?.childForFieldName("function");
    if (!inv || fn?.type !== "member_access_expression") continue;
    const verb = /^Map(Get|Post|Put|Patch|Delete)$/.exec(fn.childForFieldName("name")?.text ?? "")?.[1];
    if (!verb) continue;
    const args = named(inv.childForFieldName("arguments"));
    const sub = stringValue(named(args[0])[0] ?? args[0]);
    if (sub === null) continue;
    const owner = fn.childForFieldName("expression")?.text ?? "";
    routes.push({
      id: `route:${file}:${lineOfNode(inv)}:${verb.toUpperCase()}`, unit, file, line: lineOfNode(inv), framework: "aspnet-core",
      handler: null, method: verb.toUpperCase(), path: joinPaths(groups.get(owner) ?? "", sub),
      query: { known: false, params: [] }, body: null, response: null, validated: null, sinks: [],
    });
  }
  return routes;
}

// ---- Go ---------------------------------------------------------------------

const GO_METHODS: Record<string, string> = {
  GET: "GET", POST: "POST", PUT: "PUT", PATCH: "PATCH", DELETE: "DELETE", Any: "*",
  Get: "GET", Post: "POST", Put: "PUT", Patch: "PATCH", Delete: "DELETE", HandleFunc: "*", Handle: "*",
};

export function extractGoRoutes(root: SyntaxNode, unit: string, file: string, framework: string): ServerRoute[] {
  const groups = new Map<string, string>();
  for (const d of root.descendantsOfType(["short_var_declaration", "assignment_statement"])) {
    const m = d && /^(\w+)\s*:?=\s*(\w+)\.(?:Group|Route)\(\s*"([^"]*)"/.exec(d.text);
    if (m) groups.set(m[1]!, joinPaths(groups.get(m[2]!) ?? "", m[3]!));
  }
  const routes: ServerRoute[] = [];
  for (const call of root.descendantsOfType("call_expression")) {
    const fn = call?.childForFieldName("function");
    if (!call || fn?.type !== "selector_expression") continue;
    const field = fn.childForFieldName("field")?.text ?? "";
    let method = GO_METHODS[field];
    if (!method) continue;
    const args = named(call.childForFieldName("arguments"));
    let sub = stringValue(args[0]);
    if (sub === null || args.length < 2) continue;
    // Go 1.22 patterns: "GET /users/{id}"
    const pattern = /^([A-Z]+)\s+(\/.*)$/.exec(sub);
    if (pattern) {
      method = pattern[1]!;
      sub = pattern[2]!;
    }
    const owner = fn.childForFieldName("operand")?.text ?? "";
    routes.push({
      id: `route:${file}:${lineOfNode(call)}:${method}`, unit, file, line: lineOfNode(call), framework,
      handler: args[args.length - 1]!.text.slice(0, 60), method, path: joinPaths(groups.get(owner) ?? "", sub),
      query: { known: false, params: [] }, body: null, response: null, validated: null, sinks: [],
    });
  }
  return routes;
}
