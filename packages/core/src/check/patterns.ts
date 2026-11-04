// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import type { Finding } from "../finding.js";
import { RULES_FILE, type PatternEngine, type PatternMatch } from "../scan/engine.js";
import { identifiers, looksLikeSecret, splitCode } from "../scan/code-text.js";
import { describe, pickSeverity, sensitiveNames } from "./sensitive.js";

/** Checks that need a pattern engine; skipped (and reported as skipped) without one. */
export const ENGINE_CHECKS = ["sensitive-in-logs", "sensitive-in-client-storage", "insecure-cookie", "sensitive-in-error", "hardcoded-secret"] as const;

const SESSION_COOKIE = /sess|auth|token|jwt|sid|remember|login/i;
const SECRET_NAME = /secret|token|api_?key|apikey|passw(or)?d|pwd|private_?key|access_?key|credential|signing_?key|auth_?key/i;

function mask(value: string): string {
  return value.length <= 4 ? "****" : `${value.slice(0, 4)}…(${value.length} chars)`;
}

function evidence(file: string, line: number, snippet: string) {
  return [{ kind: "code" as const, file, line, snippet: snippet.replace(/\s+/g, " ").trim().slice(0, 160) }];
}

/** Turns one located site into a finding, or null when nothing sensitive is involved. */
export function classifyMatch(m: PatternMatch, snippet: string, config: Config): Finding | null {
  const family = m.ruleId.replace(/-(python|js|java|go|csharp)$/, "");
  const { code, literals } = splitCode(snippet);
  const ids = identifiers(code);
  const at = (category: Finding["category"]) => `${category}:${m.file}:${m.line}`;

  switch (family) {
    case "iv-log-call": {
      const found = sensitiveNames(ids, config);
      if (!found.length) return null;
      return {
        id: at("sensitive-in-logs"), category: "sensitive-in-logs", severity: pickSeverity(found, "critical", "medium"),
        evidence: evidence(m.file, m.line, snippet),
        explanation: `Log line includes ${describe(found)}. Logs are kept, shipped and read far more widely than the data itself.`,
        suggestedFix: "Remove the value from the log line, or log a masked form (for example the last 4 characters).", confidence: 0.85,
      };
    }
    case "iv-client-storage": {
      const found = sensitiveNames([...ids, ...literals.flatMap((l) => l.split(/[^\w]+/)), ...literals], config);
      if (!found.length) return null;
      return {
        id: at("sensitive-in-client-storage"), category: "sensitive-in-client-storage", severity: pickSeverity(found, "high", "medium"),
        evidence: evidence(m.file, m.line, snippet),
        explanation: `Stores ${describe(found)} in Web Storage, which any script on the page can read (including injected ones).`,
        suggestedFix: "Keep tokens in an httpOnly, Secure, SameSite cookie set by the server; avoid storing personal data in the browser.", confidence: 0.85,
      };
    }
    case "iv-cookie": {
      const isDocCookie = /^document\.cookie\s*=/.test(snippet);
      const name = isDocCookie ? (literals[0] ?? snippet.split("=")[1] ?? "").split("=")[0]!.trim() : literals[0] ?? "";
      const missing: string[] = [];
      if (isDocCookie) {
        if (!/;\s*secure/i.test(snippet)) missing.push("Secure");
        if (!/samesite/i.test(snippet)) missing.push("SameSite");
      } else if (m.ruleId.endsWith("-python")) {
        if (!/secure\s*=\s*True/.test(snippet)) missing.push("secure");
        if (!/httponly\s*=\s*True/i.test(snippet)) missing.push("httponly");
        if (!/samesite\s*=/i.test(snippet)) missing.push("samesite");
      } else {
        if (!/httpOnly\s*:\s*true/.test(snippet)) missing.push("httpOnly");
        if (!/secure\s*:\s*true/.test(snippet)) missing.push("secure");
        if (!/sameSite\s*:/.test(snippet)) missing.push("sameSite");
      }
      if (!missing.length) return null;
      const sensitive = SESSION_COOKIE.test(name) || sensitiveNames(ids, config).length > 0;
      return {
        id: at("insecure-cookie"), category: "insecure-cookie", severity: sensitive ? "high" : "low",
        evidence: evidence(m.file, m.line, snippet),
        explanation: `Cookie ${name ? `'${name}' ` : ""}is set without ${missing.join(", ")}${sensitive ? "; it looks like a session or auth cookie" : ""}.`,
        suggestedFix: isDocCookie ? "Add '; Secure; SameSite=Lax' (or set it server-side with HttpOnly)." : `Pass { ${missing.map((f) => (f === "sameSite" || f === "samesite" ? `${f}: "lax"` : `${f}: true`)).join(", ")} }.`,
        confidence: 0.9,
      };
    }
    case "iv-error-response": {
      const found = sensitiveNames(ids, config);
      const stack = /\b(stack|traceback|stackTrace|printStackTrace|format_exc)\b/.test(code);
      if (!found.length && !stack) return null;
      return {
        id: at("sensitive-in-error"), category: "sensitive-in-error", severity: found.length ? pickSeverity(found, "high", "medium") : "medium",
        evidence: evidence(m.file, m.line, snippet),
        explanation: `Error response includes ${[found.length ? describe(found) : "", stack ? "a stack trace" : ""].filter(Boolean).join(" and ")}, which is sent back to the client.`,
        suggestedFix: "Return a generic message and an error id; log details server-side without the sensitive values.", confidence: 0.85,
      };
    }
    case "iv-secret-assign": {
      const value = literals[0] ?? "";
      if (!looksLikeSecret(value)) return null;
      const name = ids.find((i) => SECRET_NAME.test(i)) ?? "value";
      return {
        id: at("hardcoded-secret"), category: "hardcoded-secret", severity: "critical",
        evidence: evidence(m.file, m.line, `${name} = "${mask(value)}"`),
        explanation: `${name} is assigned a hardcoded secret-like value${/frontend|client|web|lib\//.test(m.file) ? " in code that may ship to browsers" : ""}.`,
        suggestedFix: "Load it from the environment or a secret manager, and rotate the exposed value.", confidence: 0.8,
      };
    }
    case "iv-secret-config": {
      const kv = /^\s*([\w.\-]+)\s*[:=]\s*(.*)$/.exec(snippet);
      const raw = (kv?.[2] ?? "").trim();
      // YAML/JSON structure (`{ type: string }`, `[a, b]`, anchors, block scalars) is not a value.
      if (!kv || /^[{[&*|>!]/.test(raw)) return null;
      const value = raw.replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "");
      if (!looksLikeSecret(value)) return null;
      return {
        id: at("hardcoded-secret"), category: "hardcoded-secret", severity: "critical",
        evidence: evidence(m.file, m.line, `${kv[1]}=${mask(value)}`),
        explanation: `Config key ${kv[1]} holds a committed secret value.`,
        suggestedFix: `Use an environment placeholder (for example \${${kv[1]!.replace(/[.\-]/g, "_").toUpperCase()}}) and rotate the value.`, confidence: 0.85,
      };
    }
    case "iv-secret-format":
      return {
        id: at("hardcoded-secret"), category: "hardcoded-secret", severity: "critical",
        evidence: evidence(m.file, m.line, mask(snippet)),
        explanation: "Value matches a known credential format.", suggestedFix: "Remove it from the repository and rotate it.", confidence: 0.95,
      };
    default:
      return null;
  }
}

/** Runs our rules with the installed engine and classifies every located site. */
export async function patternFindings(root: string, config: Config, engine: PatternEngine, targets: string[] = ["."]): Promise<Finding[]> {
  const matches = await engine.run(RULES_FILE, targets, root);
  const texts = new Map<string, Buffer>();
  const findings = new Map<string, Finding>();
  for (const m of matches) {
    m.file = m.file.replace(/^\.\//, "");
    let buf = texts.get(m.file);
    if (!buf) {
      try {
        buf = readFileSync(join(root, m.file));
      } catch {
        continue;
      }
      texts.set(m.file, buf);
    }
    // Engine offsets are byte offsets.
    const snippet = buf.subarray(m.startOffset, m.endOffset).toString("utf8");
    const f = classifyMatch(m, snippet, config);
    if (f && !findings.has(f.id)) findings.set(f.id, f);
  }
  return [...findings.values()];
}
