// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { NON_OUTBOUND_HOSTS } from "../detect/rules.js";
import type { Sink } from "./types.js";

/** A function definition kept as text so handlers can be followed one hop. */
export interface FuncDef {
  file: string;
  line: number;
  text: string;
}

const STORE_RE =
  /\b(SELECT\s[\s\S]{0,200}?\sFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b|\.(execute|executemany|query|findOne|findMany|findAll|findById|findUnique|insertOne|insertMany|updateOne|deleteOne|aggregate|save|saveAll|persist|merge)\s*\(|\bprisma\.\w+\.|\b\w+Repository\.\w+\(|\bsession\.(add|query|execute|commit)\(|\bQueryRow\(|\bdb\.(Query|Exec|Get|Select|Create|First|Find|Where)\(/i;
const URL_RE = /["'`](https?:\/\/([a-zA-Z0-9.-]+)(:\d+)?[^"'`\s]*)["'`]/g;
const CALL_RE = /\b([A-Za-z_]\w*)\s*\(/g;

function lineAt(text: string, offset: number): number {
  let n = 0;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Data stores and outbound hosts a handler reaches, directly or through one called function. */
export function findSinks(handler: FuncDef, defs: Map<string, FuncDef>, storeName: string): Sink[] {
  const sinks: Sink[] = [];
  const scan = (def: FuncDef, via?: string) => {
    for (const m of def.text.matchAll(URL_RE)) {
      const host = m[2]!.toLowerCase();
      if (NON_OUTBOUND_HOSTS.has(host)) continue;
      sinks.push({ kind: "outbound", host, url: m[1]!, file: def.file, line: def.line + lineAt(def.text, m.index) });
    }
    const s = STORE_RE.exec(def.text);
    if (s) sinks.push({ kind: "store", name: storeName, file: def.file, line: def.line + lineAt(def.text, s.index), ...(via ? { via } : {}) });
  };
  scan(handler);
  const seen = new Set<string>();
  for (const m of handler.text.matchAll(CALL_RE)) {
    const name = m[1]!;
    const def = defs.get(name);
    if (!def || seen.has(name) || def.text === handler.text) continue;
    seen.add(name);
    scan(def, name);
  }
  return sinks;
}
