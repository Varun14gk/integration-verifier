// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Splits a code snippet into code and string-literal text. Interpolations inside
 * template strings and f-strings (`${x}`, `{x}`) count as code, because the
 * value is what ends up in the output.
 */
export function splitCode(snippet: string): { code: string; literals: string[] } {
  let code = "";
  const literals: string[] = [];
  let i = 0;
  while (i < snippet.length) {
    const ch = snippet[i]!;
    const isFString = (ch === '"' || ch === "'") && /[fF]$/.test(snippet.slice(Math.max(0, i - 2), i).replace(/[rRbB]/g, ""));
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let lit = "";
      i++;
      while (i < snippet.length && snippet[i] !== quote) {
        if (snippet[i] === "\\") {
          lit += snippet.slice(i, i + 2);
          i += 2;
          continue;
        }
        const interp = (quote === "`" && snippet.startsWith("${", i)) || (isFString && snippet[i] === "{" && snippet[i + 1] !== "{");
        if (interp) {
          let depth = 0;
          const start = i;
          for (; i < snippet.length; i++) {
            if (snippet[i] === "{") depth++;
            else if (snippet[i] === "}" && --depth === 0) break;
          }
          code += " " + snippet.slice(start, i + 1).replace(/^\$?\{|\}$/g, "") + " ";
          i++;
          continue;
        }
        lit += snippet[i];
        i++;
      }
      literals.push(lit);
      code += ' "" ';
      i++;
      continue;
    }
    code += ch;
    i++;
  }
  return { code, literals };
}

/** Identifiers in code text (string literal contents excluded). */
export function identifiers(code: string): string[] {
  return [...new Set(code.match(/[A-Za-z_$][\w$]*/g) ?? [])];
}

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const PLACEHOLDER = /^(changeme|change[-_]?me|x+|\*+|\.+|<[^>]*>|your[-_ ].*|example.*|placeholder|todo|dummy|test|null|none|true|false|secret|password|token|redacted)$/i;

/** True when a literal looks like a real secret rather than a placeholder, key name or URL. */
export function looksLikeSecret(value: string): boolean {
  const v = value.trim();
  if (v.length < 8 || PLACEHOLDER.test(v)) return false;
  if (/\$\{|%\(|\{\{|process\.env|^env\(|^ENC\(/.test(v)) return false;
  if (/^[a-z][a-z0-9]*(?:[_.-][a-z0-9]+)*$/.test(v) && !/\d/.test(v)) return false; // a key or name like access_token
  if (/^https?:\/\//.test(v) && !/:[^/@]+@/.test(v)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(v)).length;
  return entropy(v) >= 3.2 || (classes >= 3 && v.length >= 10);
}
