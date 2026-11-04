// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { detectStack, IV_DIR, loadConfig, runCheck, toMarkdown, toPosix, writeOutput, type Finding } from "@integration-verifier/core";

export const HARNESSES = ["claude-code", "codex", "gemini-cli"] as const;
export type Harness = (typeof HARNESSES)[number];
export type HookEvent = "post-write" | "stop";

/** The fields we read from each harness's hook input (JSON on stdin). */
interface HookInput {
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; path?: string; absolute_path?: string; filePath?: string };
  stop_hook_active?: boolean;
}

/** What the harness should receive: stdout text and an exit code. */
export interface HookOutput {
  stdout: string;
  code: number;
}

const SOURCE_FILE = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|py|java|kt|cs|go|properties|ya?ml|env|json|html)$/;
const MAX_LISTED = 15;

function line(f: Finding): string {
  const e = f.evidence[0]!;
  const where = e.kind === "code" ? `${e.file}:${e.line}` : e.kind === "request" ? `${e.method} ${e.url}` : `${e.source} @ ${e.location}`;
  return `- [${f.severity}] ${f.category} ${where}: ${f.explanation}${f.suggestedFix ? ` Suggested fix: ${f.suggestedFix}` : ""}`;
}

function list(findings: Finding[]): string {
  const shown = findings.slice(0, MAX_LISTED).map(line);
  if (findings.length > MAX_LISTED) shown.push(`- … and ${findings.length - MAX_LISTED} more (see .iv/report.md)`);
  return shown.join("\n");
}

/** Only projects with a detected frontend or backend are checked; anything else passes silently. */
function isWebProject(root: string): boolean {
  return detectStack([root]).units.some((u) => u.role !== "unknown");
}

function filePathOf(input: HookInput): string | null {
  const t = input.tool_input ?? {};
  return t.file_path ?? t.absolute_path ?? t.filePath ?? t.path ?? null;
}

/** Formats feedback for the agent after a file write, per harness. */
function postWriteOutput(harness: Harness, message: string): HookOutput {
  if (harness === "claude-code") return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: message } }), code: 0 };
  if (harness === "gemini-cli") return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "AfterTool", additionalContext: message } }), code: 0 };
  return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: message } }), code: 0 };
}

/** Formats "do not finish yet", per harness. */
function blockStop(harness: Harness, reason: string): HookOutput {
  if (harness === "gemini-cli") return { stdout: JSON.stringify({ decision: "deny", reason }), code: 0 };
  return { stdout: JSON.stringify({ decision: "block", reason }), code: 0 };
}

function notice(harness: Harness, message: string): HookOutput {
  return { stdout: harness === "codex" ? "" : JSON.stringify({ systemMessage: message }), code: 0 };
}

const STATE_FILE = "gate-state.json";

/**
 * Runs one hook. Never throws: a broken check must not break the agent's session,
 * so errors are reported as a notice and the action is allowed.
 */
export async function runHook(harness: Harness, event: HookEvent, rawInput: string, env: NodeJS.ProcessEnv = process.env): Promise<HookOutput> {
  let input: HookInput = {};
  try {
    input = rawInput.trim() ? (JSON.parse(rawInput) as HookInput) : {};
  } catch {
    /* treat as empty */
  }
  const root = resolve(input.cwd ?? env.CLAUDE_PROJECT_DIR ?? env.GEMINI_PROJECT_DIR ?? process.cwd());
  try {
    const loaded = loadConfig(root);
    if (!loaded.ok) return notice(harness, `Integration Verifier: .iv/config.yaml is invalid (${loaded.issues[0]?.message}); checks skipped.`);
    if (!isWebProject(root)) return { stdout: "", code: 0 };

    if (event === "post-write") {
      const file = filePathOf(input);
      if (!file) return { stdout: "", code: 0 };
      const rel = toPosix(relative(root, isAbsolute(file) ? file : join(root, file)));
      if (rel.startsWith("..") || rel.startsWith(`${IV_DIR}/`) || !SOURCE_FILE.test(rel)) return { stdout: "", code: 0 };
      const { report } = await runCheck(root, loaded.config, { files: [rel], engine: null });
      const relevant = report.gate.open.filter((f) => f.severity !== "info");
      if (!relevant.length) return { stdout: "", code: 0 };
      return postWriteOutput(harness, `Integration Verifier (fast check of ${rel}, informational, nothing was changed):\n${list(relevant)}`);
    }

    // stop: the full gate.
    const out = await runCheck(root, loaded.config, {});
    writeOutput(root, "check", out.report);
    mkdirSync(join(root, IV_DIR), { recursive: true });
    writeFileSync(join(root, IV_DIR, "report.md"), toMarkdown(out.report), "utf8");
    const blocking = out.report.gate.blocking;
    const statePath = join(root, IV_DIR, STATE_FILE);
    if (!blocking.length) {
      writeFileSync(statePath, JSON.stringify({ blocking: [] }), "utf8");
      return { stdout: "", code: 0 };
    }
    const ids = blocking.map((f) => f.id).sort();
    const previous = existsSync(statePath) ? ((JSON.parse(readFileSync(statePath, "utf8")) as { blocking?: string[] }).blocking ?? []) : [];
    writeFileSync(statePath, JSON.stringify({ blocking: ids }), "utf8");
    // Block once per distinct set of blocking findings, so the agent can never loop forever.
    if (input.stop_hook_active && JSON.stringify(previous) === JSON.stringify(ids)) {
      return notice(harness, `Integration Verifier: ${ids.length} blocking finding(s) are still open. See .iv/report.md.`);
    }
    return blockStop(
      harness,
      `Integration Verifier gate: ${blocking.length} open finding(s) at or above "${loaded.config.gate.failOn}". Address them before finishing, or ask the user whether to accept any; only if the user agrees, record it with the iv_dismiss tool (or \`iv dismiss <id> --reason "..."\`) using their reason. Do not dismiss on your own. Full report: .iv/report.md\n${list(blocking)}`,
    );
  } catch (e) {
    return notice(harness, `Integration Verifier hook failed (${(e as Error).message}); the action was allowed.`);
  }
}
