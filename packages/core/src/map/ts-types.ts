// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { lineOfNode, named, type SyntaxNode } from "../parse/tree-sitter.js";
import type { FieldSet } from "./types.js";

/** A TypeScript interface, object type alias or class, reduced to its fields. */
export interface TypeDecl {
  name: string;
  file: string;
  line: number;
  fields: { name: string; optional: boolean; line: number; validated: boolean }[];
  extends: string[];
}

export type TypeIndex = Map<string, TypeDecl>;

function propName(n: SyntaxNode | null): string | null {
  if (!n) return null;
  return n.text.replace(/^["']|["']$/g, "");
}

/** Collects interfaces, object type aliases and classes declared in one file. */
export function collectTsTypes(root: SyntaxNode, file: string, index: TypeIndex): void {
  const visit = (n: SyntaxNode) => {
    if (n.type === "interface_declaration" || n.type === "type_alias_declaration" || n.type === "class_declaration" || n.type === "abstract_class_declaration") {
      const name = n.childForFieldName("name")?.text;
      const body = n.type === "type_alias_declaration" ? n.childForFieldName("value") : n.childForFieldName("body");
      if (name && body && (body.type === "object_type" || body.type === "interface_body" || body.type === "class_body")) {
        const fields: TypeDecl["fields"] = [];
        let pendingDecorators = 0;
        for (const member of named(body)) {
          if (member.type === "decorator") {
            pendingDecorators++;
            continue;
          }
          if (member.type === "property_signature" || member.type === "public_field_definition") {
            const fname = propName(member.childForFieldName("name"));
            const ownDecorators = named(member).filter((c) => c.type === "decorator").length;
            if (fname) {
              fields.push({
                name: fname,
                optional: /^\s*(?:@[\s\S]*?\s)?(?:(?:public|private|protected|readonly|declare)\s+)*["']?[\w$]+["']?\s*\?/.test(member.text.replace(/@\w+\([^)]*\)\s*/g, "")),
                line: lineOfNode(member),
                validated: ownDecorators + pendingDecorators > 0,
              });
            }
          }
          pendingDecorators = 0;
        }
        const ext: string[] = [];
        for (const c of named(n)) {
          if (c.type === "extends_type_clause" || c.type === "class_heritage") {
            for (const t of c.text.replace(/^(extends|implements)\s+/, "").split(/[,\s]+/)) if (/^[A-Z]\w*$/.test(t)) ext.push(t);
          }
        }
        index.set(name, { name, file, line: lineOfNode(n), fields, extends: ext });
      }
    }
    for (const c of named(n)) visit(c);
  };
  visit(root);
}

function declFields(name: string, index: TypeIndex, seen = new Set<string>()): TypeDecl["fields"] | null {
  const decl = index.get(name);
  if (!decl || seen.has(name)) return null;
  seen.add(name);
  const fields = [...decl.fields];
  for (const e of decl.extends) fields.push(...(declFields(e, index, seen) ?? []));
  return fields;
}

const WRAPPERS = /^(Promise|Observable|AxiosResponse|HttpResponse|Readonly|Required|Awaited)<([\s\S]+)>$/;

/** Turns a TypeScript type (as text) into the field names it describes. */
export function fieldsFromTypeText(text: string, index: TypeIndex): FieldSet | null {
  let t = text.replace(/^:\s*/, "").trim();
  let isArray = false;
  let allOptional = false;
  for (let guard = 0; guard < 6; guard++) {
    const wrap = WRAPPERS.exec(t);
    const arr = /^(?:Array|ReadonlyArray)<([\s\S]+)>$/.exec(t);
    const partial = /^Partial<([\s\S]+)>$/.exec(t);
    if (wrap) t = wrap[2]!.trim();
    else if (arr) { t = arr[1]!.trim(); isArray = true; }
    else if (partial) { t = partial[1]!.trim(); allOptional = true; }
    else if (t.endsWith("[]")) { t = t.slice(0, -2).trim(); isArray = true; }
    else break;
  }
  if (/^(void|any|unknown|never|undefined|null|string|number|boolean|object)$/.test(t)) return null;
  if (t.startsWith("{")) {
    const inner = t.slice(1, -1);
    const names: string[] = [];
    const required: string[] = [];
    let depth = 0;
    let token = "";
    for (const ch of inner + ";") {
      if (ch === "{" || ch === "<" || ch === "(") depth++;
      if (ch === "}" || ch === ">" || ch === ")") depth--;
      if ((ch === ";" || ch === ",") && depth === 0) {
        const m = /^\s*["']?([\w$]+)["']?(\?)?\s*:/.exec(token);
        if (m) {
          names.push(m[1]!);
          if (!m[2] && !allOptional) required.push(m[1]!);
        }
        token = "";
      } else token += ch;
    }
    return { known: true, names, required, source: "inline type", isArray };
  }
  const name = /^([A-Z][\w$]*)$/.exec(t)?.[1];
  if (!name) return { known: false, names: [], source: t };
  const fields = declFields(name, index);
  if (!fields) return { known: false, names: [], source: name };
  const decl = index.get(name)!;
  return {
    known: true,
    names: fields.map((f) => f.name),
    required: allOptional ? [] : fields.filter((f) => !f.optional).map((f) => f.name),
    source: name,
    declaredAt: { file: decl.file, line: decl.line },
    fieldLines: Object.fromEntries(fields.map((f) => [f.name, f.line])),
    isArray,
  };
}
