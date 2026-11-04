// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** The subset of the web-tree-sitter Node API the extractors use. */
export interface SyntaxNode {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  parent: SyntaxNode | null;
  namedChildren: (SyntaxNode | null)[];
  children: (SyntaxNode | null)[];
  previousNamedSibling: SyntaxNode | null;
  nextNamedSibling: SyntaxNode | null;
  childForFieldName(name: string): SyntaxNode | null;
  childrenForFieldName(name: string): (SyntaxNode | null)[];
  descendantsOfType(types: string | string[]): (SyntaxNode | null)[];
}

export type Grammar = "typescript" | "tsx" | "javascript" | "python" | "java" | "c-sharp" | "go";

const EXT_GRAMMAR: Record<string, Grammar> = {
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "tsx",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".java": "java", ".cs": "c-sharp", ".go": "go",
};

export function grammarFor(file: string): Grammar | null {
  if (file.endsWith(".d.ts")) return null;
  const dot = file.lastIndexOf(".");
  return dot >= 0 ? EXT_GRAMMAR[file.slice(dot)] ?? null : null;
}

interface TreeSitterModule {
  Parser: { new (): ParserLike; init(opts: { locateFile: (f: string) => string }): Promise<void> };
  Language: { load(path: string): Promise<unknown> };
}
interface ParserLike {
  setLanguage(lang: unknown): void;
  parse(text: string): { rootNode: SyntaxNode; delete(): void } | null;
}

const require = createRequire(import.meta.url);
let ready: Promise<TreeSitterModule> | null = null;
const parsers = new Map<Grammar, Promise<ParserLike>>();

function load(): Promise<TreeSitterModule> {
  if (!ready) {
    const ts = require("@vscode/tree-sitter-wasm") as TreeSitterModule;
    const dir = dirname(require.resolve("@vscode/tree-sitter-wasm"));
    ready = ts.Parser.init({ locateFile: (f) => join(dir, f) }).then(() => ts);
  }
  return ready;
}

function parserFor(grammar: Grammar): Promise<ParserLike> {
  let p = parsers.get(grammar);
  if (!p) {
    p = load().then(async (ts) => {
      const dir = dirname(require.resolve("@vscode/tree-sitter-wasm"));
      const lang = await ts.Language.load(join(dir, `tree-sitter-${grammar}.wasm`));
      const parser = new ts.Parser();
      parser.setLanguage(lang);
      return parser;
    });
    parsers.set(grammar, p);
  }
  return p;
}

/**
 * Parses `text` and runs `fn` on the root node. The tree is freed afterwards,
 * so `fn` must not keep nodes; copy out plain data instead.
 */
export async function withTree<T>(grammar: Grammar, text: string, fn: (root: SyntaxNode) => T): Promise<T | null> {
  const parser = await parserFor(grammar);
  const tree = parser.parse(text);
  if (!tree) return null;
  try {
    return fn(tree.rootNode);
  } finally {
    tree.delete();
  }
}

// ---- helpers shared by the extractors -------------------------------------

/** 1-based line of a node. */
export function lineOfNode(n: SyntaxNode): number {
  return n.startPosition.row + 1;
}

export function named(n: SyntaxNode | null | undefined): SyntaxNode[] {
  return (n?.namedChildren ?? []).filter((c): c is SyntaxNode => c !== null);
}

export function descendants(n: SyntaxNode, types: string | string[]): SyntaxNode[] {
  return n.descendantsOfType(types).filter((c): c is SyntaxNode => c !== null);
}

const STRING_TYPES = new Set([
  "string", "string_literal", "interpreted_string_literal", "raw_string_literal", "verbatim_string_literal",
]);

/** Value of a plain string literal in any supported language, or null. */
export function stringValue(n: SyntaxNode | null | undefined): string | null {
  if (!n || !STRING_TYPES.has(n.type)) return null;
  // Python f-strings and JS templates are not plain strings.
  if (n.type === "string" && named(n).some((c) => c.type === "interpolation" || c.type === "template_substitution")) return null;
  const m = /^[a-zA-Z@$]*("""|'''|"|'|`)([\s\S]*)\1$/.exec(n.text);
  return m ? m[2]! : null;
}

/** Nearest ancestor of one of the given types. */
export function ancestor(n: SyntaxNode, types: string[]): SyntaxNode | null {
  for (let p = n.parent; p; p = p.parent) if (types.includes(p.type)) return p;
  return null;
}
