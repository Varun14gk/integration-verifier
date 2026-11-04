// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

export interface NormalizedPath {
  /** Canonical form used to join both sides: params become `{}`. */
  key: string;
  segments: string[];
  params: string[];
}

const PARAM_PATTERNS: RegExp[] = [
  /^\{([^}:]+)(:[^}]*)?\}$/, // {id}, {id:int} (FastAPI, Spring, ASP.NET, OpenAPI)
  /^:([A-Za-z_]\w*)\??$/, // :id (Express, Nest, gin)
  /^<(?:[a-z]+:)?([A-Za-z_]\w*)>$/, // <id>, <int:id> (Flask, Django)
  /^\[([A-Za-z_]\w*)\]$/, // [id] (Next.js file routes)
];

/** Returns the param name when a segment is a path parameter. */
export function paramName(segment: string): string | null {
  for (const re of PARAM_PATTERNS) {
    const m = re.exec(segment);
    if (m) return m[1]!;
  }
  return null;
}

/** Strips scheme, host, query and hash, and normalises slashes and params. */
export function normalizePath(raw: string): NormalizedPath {
  let p = raw.trim();
  p = p.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
  p = p.split("#")[0]!.split("?")[0]!;
  const segments = p.split("/").filter((s) => s.length > 0);
  const params: string[] = [];
  const keySegs = segments.map((s) => {
    const name = paramName(s);
    if (name !== null) {
      params.push(name);
      return "{}";
    }
    return s;
  });
  return { key: "/" + keySegs.join("/"), segments: keySegs, params };
}

export function joinPaths(...parts: string[]): string {
  const joined = parts.filter((p) => p && p !== "/").map((p) => p.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
  return "/" + joined;
}

function lev(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

/** 0..1 similarity of two strings (edit distance based). */
export function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - lev(a, b) / max;
}

function canonicalWord(s: string): string {
  return s.toLowerCase().replace(/[-_]/g, "");
}

function singular(s: string): string {
  if (s.endsWith("ies")) return s.slice(0, -3) + "y";
  if (s.endsWith("ses") || s.endsWith("xes")) return s.slice(0, -2);
  if (s.endsWith("s") && !s.endsWith("ss")) return s.slice(0, -1);
  return s;
}

/** Explains how two segments differ, or null when they are the same. */
export function segmentDifference(a: string, b: string): string | null {
  if (a === b) return null;
  if (a === "{}" || b === "{}") return `'${a}' vs '${b}' (parameter vs literal)`;
  if (singular(canonicalWord(a)) === singular(canonicalWord(b))) {
    return canonicalWord(a) === canonicalWord(b) ? `'${a}' vs '${b}' (case or separator)` : `'${a}' vs '${b}' (singular/plural)`;
  }
  return `'${a}' vs '${b}'`;
}

function segmentSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a === "{}" || b === "{}") return 0.4;
  const ca = canonicalWord(a);
  const cb = canonicalWord(b);
  if (ca === cb) return 0.95;
  if (singular(ca) === singular(cb)) return 0.9;
  return stringSimilarity(ca, cb) * 0.6;
}

/** 0..1 similarity of two normalised paths, aligning segments with insert/delete. */
export function pathSimilarity(a: string[], b: string[]): number {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return 1;
  const dp: number[][] = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (1 - segmentSimilarity(a[i - 1]!, b[j - 1]!)));
    }
  }
  return 1 - dp[n]![m]! / Math.max(n, m);
}

/** Static (non-param) segments, used to spot "same route, different params". */
export function staticSegments(segments: string[]): string[] {
  return segments.filter((s) => s !== "{}");
}
