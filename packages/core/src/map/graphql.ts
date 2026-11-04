// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import {
  buildASTSchema, concatAST, Kind, NoUnusedFragmentsRule, parse, specifiedRules, UniqueFragmentNamesRule, validate,
  type DocumentNode, type GraphQLError, type OperationDefinitionNode,
} from "graphql";
import type { Finding } from "../finding.js";
import { lineOf } from "../fs-walk.js";
import type { ClientCall, Edge, ServerRoute } from "./types.js";

/** A GraphQL document found in a file: a .graphql file, or a gql`...` / graphql(`...`) template. */
export interface GqlSource {
  file: string;
  unit: string;
  /** 1-based line where the document text starts. */
  line: number;
  text: string;
}

const TEMPLATE = /\b(?:gql|graphql)\s*(?:<[^>]*>)?\s*(?:\(\s*)?`((?:\\`|[^`])*)`/g;

/** GraphQL documents embedded in JS/TS source. Interpolations (fragments) are blanked. */
export function gqlTemplates(text: string, unit: string, file: string): GqlSource[] {
  const out: GqlSource[] = [];
  for (const m of text.matchAll(TEMPLATE)) {
    const start = m.index + m[0].indexOf("`") + 1;
    out.push({ file, unit, line: lineOf(text, start), text: m[1]!.replace(/\$\{[^}]*\}/g, (s) => " ".repeat(s.length)) });
  }
  return out;
}

const isSchemaDoc = (t: string) => /\b(type|extend\s+type|schema|input|enum|interface|union|scalar)\s+\w*\s*[{@=]|\bschema\s*\{/.test(t) && /\btype\s+(Query|Mutation|Subscription)\b|\bschema\s*\{/.test(t);
const isOperationDoc = (t: string) => /^\s*(#[^\n]*\n\s*)*(query|mutation|subscription|fragment)\b|^\s*\{/.test(t);

export function classifySources(sources: GqlSource[]): { schema: GqlSource[]; operations: GqlSource[] } {
  return { schema: sources.filter((s) => isSchemaDoc(s.text)), operations: sources.filter((s) => !isSchemaDoc(s.text) && isOperationDoc(s.text)) };
}

const ROOT_TYPES = { query: "Query", mutation: "Mutation", subscription: "Subscription" } as const;

function rootFields(op: OperationDefinitionNode): string[] {
  return op.selectionSet.selections.flatMap((s) => (s.kind === Kind.FIELD ? [s.name.value] : []));
}

/**
 * Validates every frontend GraphQL operation against the schema and builds the
 * same calls / routes / edges / findings shapes as the REST map.
 */
export function graphqlMap(schemaSources: GqlSource[], operationSources: GqlSource[]): { calls: ClientCall[]; routes: ServerRoute[]; edges: Edge[]; findings: Finding[]; skipped?: string } {
  const empty = { calls: [], routes: [], edges: [], findings: [] };
  if (!schemaSources.length || !operationSources.length) return empty;

  const schemaDocs: { src: GqlSource; doc: DocumentNode }[] = [];
  for (const src of schemaSources) {
    try {
      schemaDocs.push({ src, doc: parse(src.text) });
    } catch {
      /* not parseable SDL; skipped below if nothing remains */
    }
  }
  let schema;
  try {
    schema = buildASTSchema(concatAST(schemaDocs.map((d) => d.doc)), { assumeValidSDL: false });
  } catch (e) {
    return { ...empty, skipped: `GraphQL schema could not be built: ${(e as Error).message.split("\n")[0]}` };
  }

  // Root fields become routes, located at their declaration in the SDL.
  const routes: ServerRoute[] = [];
  for (const { src, doc } of schemaDocs) {
    for (const def of doc.definitions) {
      if ((def.kind !== Kind.OBJECT_TYPE_DEFINITION && def.kind !== Kind.OBJECT_TYPE_EXTENSION) || !["Query", "Mutation", "Subscription"].includes(def.name.value)) continue;
      for (const f of def.fields ?? []) {
        const line = src.line + (f.loc?.startToken.line ?? 1) - 1;
        routes.push({
          id: `route:${src.file}:${line}:GRAPHQL`, unit: src.unit, file: src.file, line, framework: "graphql",
          handler: `${def.name.value}.${f.name.value}`, method: def.name.value.toUpperCase(), path: `graphql:${def.name.value}.${f.name.value}`,
          query: { known: false, params: [] }, body: null, response: null, validated: null, sinks: [], logs: null,
        });
      }
    }
  }

  // Fragments may be defined in any frontend file; make them available to every operation.
  const parsedOps: { src: GqlSource; doc: DocumentNode }[] = [];
  const parseErrors: Finding[] = [];
  for (const src of operationSources) {
    try {
      parsedOps.push({ src, doc: parse(src.text) });
    } catch (e) {
      const g = e as GraphQLError;
      const line = src.line + (g.locations?.[0]?.line ?? 1) - 1;
      parseErrors.push({
        id: `mismatched:${src.file}:${line}`, category: "mismatched", severity: "high",
        evidence: [{ kind: "code", file: src.file, line, snippet: src.text.trim().split("\n")[0]!.slice(0, 120) }],
        explanation: `GraphQL syntax error: ${g.message}`, confidence: 0.95,
      });
    }
  }
  const ownerOf = new Map(parsedOps.map((p) => [p.doc.loc?.source.body ?? "", p.src]));
  const fragments = parsedOps.flatMap((p) => p.doc.definitions.filter((d) => d.kind === Kind.FRAGMENT_DEFINITION));
  // Fragments are pooled across files, so "unused" and "duplicate name" are not errors here.
  const rules = specifiedRules.filter((r) => r !== NoUnusedFragmentsRule && r !== UniqueFragmentNamesRule);
  const seenFragments = new Set<string>();
  const pooledFragments = fragments.filter((f) => f.kind === Kind.FRAGMENT_DEFINITION && !seenFragments.has(f.name.value) && seenFragments.add(f.name.value));

  const calls: ClientCall[] = [];
  const edges: Edge[] = [];
  const findings = new Map<string, Finding>(parseErrors.map((f) => [f.id, f]));
  const used = new Set<string>();
  for (const { src, doc } of parsedOps) {
    for (const op of doc.definitions.filter((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION)) {
      const line = src.line + (op.loc?.startToken.line ?? 1) - 1;
      const rootType = ROOT_TYPES[op.operation];
      const fields = rootFields(op);
      const call: ClientCall = {
        id: `call:${src.file}:${line}`, unit: src.unit, file: src.file, line, function: op.name?.value ?? null, client: "graphql",
        method: op.operation.toUpperCase(), url: { kind: "static", raw: `${op.operation} ${op.name?.value ?? "(anonymous)"}`, path: `graphql:${rootType}.${fields.join(",")}`, query: [] },
        query: { known: false, names: [] }, body: null, response: null,
      };
      calls.push(call);
      const errors = validate(schema, { kind: Kind.DOCUMENT, definitions: [op, ...pooledFragments] }, rules);
      for (const f of fields) used.add(`${rootType}.${f}`);
      const target = routes.find((r) => r.path === `graphql:${rootType}.${fields[0]}`);
      if (!errors.length) {
        edges.push({ id: `edge:${call.id}`, status: "connected", call: call.id, ...(target ? { route: target.id } : {}), mismatches: [], suggestions: [] });
        continue;
      }
      const rootMissing = errors.some((e) => new RegExp(`Cannot query field "\\w+" on type "${rootType}"`).test(e.message));
      edges.push({
        id: `edge:${call.id}`, status: rootMissing ? "not-connected" : "mismatched", call: call.id, ...(target ? { route: target.id } : {}),
        mismatches: errors.map((e) => ({ kind: "response-field" as const, detail: e.message })), suggestions: [],
      });
      for (const e of errors) {
        // The error may sit in a fragment from another file: locate it in its own source.
        const node = e.nodes?.[0];
        const owner = (node?.loc && ownerOf.get(node.loc.source.body)) || src;
        const errLine = owner.line + (node?.loc?.startToken.line ?? e.locations?.[0]?.line ?? 1) - 1;
        const hint = /Did you mean (.+)\?/.exec(e.message)?.[1];
        const atRoot = new RegExp(`on type "${rootType}"`).test(e.message);
        const id = `${atRoot && /Cannot query field/.test(e.message) ? "not-connected" : "mismatched"}:${owner.file}:${errLine}`;
        if (findings.has(id)) continue;
        findings.set(id, {
          id,
          category: atRoot && /Cannot query field/.test(e.message) ? "not-connected" : "mismatched",
          severity: "high",
          evidence: [{ kind: "code", file: owner.file, line: errLine, snippet: `${op.operation} ${op.name?.value ?? ""}`.trim() }],
          explanation: `GraphQL ${op.operation} ${op.name?.value ?? "(anonymous)"} does not match the schema: ${e.message}`,
          ...(hint ? { suggestedFix: `Use ${hint}` } : {}),
          confidence: 0.95,
        });
      }
    }
  }
  for (const r of routes) {
    if (used.has(r.handler!)) continue;
    edges.push({ id: `edge:${r.id}`, status: "orphan", route: r.id, mismatches: [], suggestions: [] });
    findings.set(`orphan:${r.file}:${r.line}`, {
      id: `orphan:${r.file}:${r.line}`, category: "orphan", severity: "low",
      evidence: [{ kind: "code", file: r.file, line: r.line, snippet: r.handler! }],
      explanation: `GraphQL ${r.handler} is not used by any frontend operation. It may be used by another client, or be dead code.`, confidence: 0.7,
    });
  }
  return { calls, routes, edges, findings: [...findings.values()] };
}
