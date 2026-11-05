// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  detectStack, IV_DIR, loadPolicy, runCheck, toMarkdown, toPosix, walkFiles, writeOutput, type CheckReport, type Config, type Finding,
} from "@integration-verifier/core";

export const HARNESSES = ["claude-code", "codex", "gemini-cli"] as const;
export type Harness = (typeof HARNESSES)[number];
export const HOOK_EVENTS = ["pre-write", "post-write", "stop"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** The fields we read from each harness's hook input (JSON on stdin). */
interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; path?: string; absolute_path?: string; filePath?: string; notebook_path?: string; command?: string | string[] };
  stop_hook_active?: boolean;
}

/** What the harness should receive: stdout, stderr and an exit code. */
export interface HookOutput {
  stdout: string;
  stderr?: string;
  code: number;
}

/** Files whose edits can change an integration or leak finding. */
const SOURCE_FILE = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|astro|py|java|kt|kts|scala|cs|go|rb|php|rs|ex|exs|dart|swift|properties|ya?ml|toml|env|json|html|graphql|graphqls|gql|proto)$/;
const MAX_LISTED = 15;
/** Each budget stays below the hook timeout in the adapters (60 s / 300 s). */
const BUDGET_MS: Record<HookEvent, number> = { "pre-write": 10_000, "post-write": 45_000, stop: 240_000 };

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

/** Files a tool call writes: a path field, or every file named in a Codex `apply_patch`. */
export function filesOf(input: HookInput): string[] {
  const t = input.tool_input ?? {};
  const direct = t.file_path ?? t.absolute_path ?? t.filePath ?? t.notebook_path ?? t.path;
  if (direct) return [direct];
  const patch = typeof t.command === "string" ? t.command : Array.isArray(t.command) ? t.command.join("\n") : "";
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)].map((m) => (m[1] ?? m[2])!.trim());
}

/**
 * The project root. The harness's project directory wins over the hook's `cwd`, because
 * the agent may have `cd`-ed into a subfolder. Without one, walk up from `cwd` to the
 * nearest folder with `.iv/` or `.git`.
 */
export function projectRoot(input: HookInput, env: NodeJS.ProcessEnv): string {
  const fromEnv = env.CLAUDE_PROJECT_DIR || env.GEMINI_PROJECT_DIR || env.IV_PROJECT_DIR;
  if (fromEnv) return resolve(fromEnv);
  const start = resolve(input.cwd ?? process.cwd());
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, IV_DIR)) || existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return start;
  }
}

// ---- outputs per harness ----------------------------------------------------

function context(harness: Harness, message: string): HookOutput {
  const hookEventName = harness === "gemini-cli" ? "AfterTool" : "PostToolUse";
  return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: message } }), code: 0 };
}

/**
 * "Do not finish yet": Claude Code and Codex Stop hooks take `decision: "block"`; Gemini
 * CLI's AfterAgent takes `decision: "deny"`, which sends `reason` back as a new prompt.
 */
function blockStop(harness: Harness, reason: string): HookOutput {
  return { stdout: JSON.stringify({ decision: harness === "gemini-cli" ? "deny" : "block", reason }), code: 0 };
}

/** Refuse a tool call. Exit code 2 with the reason on stderr blocks it in all three harnesses. */
function deny(reason: string): HookOutput {
  return { stdout: "", stderr: reason, code: 2 };
}

function notice(harness: Harness, message: string): HookOutput {
  return { stdout: harness === "codex" ? "" : JSON.stringify({ systemMessage: message }), stderr: message, code: 0 };
}

// ---- pre-write: the gate's own files are the user's ---------------------------

/** `.iv` as a path segment: at the start, after a separator, or after a space, quote or `=` in a shell command. */
const PROTECTED = /(^|[\s"'=\\/])\.iv([\\/]|$)/;
const SHELL_WRITE = /(>|\btee\b|\bsed\s+-i|\bmv\b|\bcp\b|\brm\b|\bdel\b|\bmove\b|\bcopy\b|Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|\btruncate\b|\bpython\b|\bnode\b|\bperl\b|\bruby\b)/;
const PROTECT_REASON =
  "Integration Verifier: files in .iv/ (the gate's policy and state) can only be changed by the user. " +
  "If a finding should be accepted, explain why and ask the user; when they agree, use the iv_dismiss tool with their reason.";

function preWrite(input: HookInput, root: string): HookOutput {
  const targets = filesOf(input).map((f) => toPosix(relative(root, isAbsolute(f) ? f : join(root, f))));
  if (targets.some((t) => PROTECTED.test(t) && !t.startsWith(".."))) return deny(PROTECT_REASON);
  const cmd = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
  if (cmd && !cmd.includes("*** Begin Patch") && PROTECTED.test(cmd.replace(/\\/g, "/")) && SHELL_WRITE.test(cmd)) return deny(PROTECT_REASON);
  return { stdout: "", code: 0 };
}

// ---- stop: the gate ---------------------------------------------------------------

interface SessionState {
  blocking: string[];
  blocks: number;
  at: string;
}

const STATE_FILE = "gate-state.json";
const CACHE_FILE = "gate-cache.json";
const LOG_FILE = "gate-log.jsonl";

function readJson<T>(path: string, fallback: T): T {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
  } catch {
    return fallback; // a corrupt state file is treated as "no history", which keeps the gate strict
  }
}

/** A cheap fingerprint of the project: every analysed file's size and mtime, plus the policy. */
function fingerprint(root: string, config: Config): string {
  const h = createHash("sha256").update(JSON.stringify(config));
  for (const f of walkFiles(root)) {
    try {
      const s = statSync(join(root, f));
      h.update(`${f}\0${s.size}\0${s.mtimeMs}\n`);
    } catch {
      /* removed while walking */
    }
  }
  return h.digest("hex");
}

async function gateReport(root: string, config: Config): Promise<CheckReport> {
  const cachePath = join(root, IV_DIR, CACHE_FILE);
  const fp = fingerprint(root, config);
  const cached = readJson<{ fingerprint?: string; report?: CheckReport }>(cachePath, {});
  if (cached.fingerprint === fp && cached.report) return cached.report;
  const out = await runCheck(root, config, {});
  writeOutput(root, "check", out.report);
  writeFileSync(join(root, IV_DIR, "report.md"), toMarkdown(out.report), "utf8");
  writeFileSync(cachePath, JSON.stringify({ fingerprint: fp, report: out.report }), "utf8");
  return out.report;
}

const FIX_OR_ASK =
  "Fix them, or ask the user whether to accept any; only if the user agrees, record it with the iv_dismiss tool (or `iv dismiss <id> --reason \"...\"`) using their reason. Do not dismiss or edit .iv/ on your own. Full report: .iv/report.md";

async function stop(harness: Harness, input: HookInput, root: string): Promise<HookOutput> {
  const policy = loadPolicy(root);
  if (!policy.ok) {
    return blockStop(harness, `Integration Verifier gate: ${policy.source} is invalid (${policy.issues.map((i) => `${i.path ? `${i.path}: ` : ""}${i.message}`).join("; ")}), so the checks cannot run. Ask the user to fix the file (\`iv config validate\` shows the problem).`);
  }
  mkdirSync(join(root, IV_DIR), { recursive: true });
  const report = await gateReport(root, policy.config);
  const blocking = report.gate.blocking;
  const ids = blocking.map((f) => f.id).sort();

  const statePath = join(root, IV_DIR, STATE_FILE);
  const all = readJson<{ sessions?: Record<string, SessionState> }>(statePath, {});
  const sessions = all.sessions && typeof all.sessions === "object" ? all.sessions : {};
  const key = input.session_id || "default";
  const prev = sessions[key];
  const same = prev && JSON.stringify(prev.blocking) === JSON.stringify(ids);
  const blocks = ids.length ? (input.stop_hook_active && same ? prev.blocks + 1 : 1) : 0;
  sessions[key] = { blocking: ids, blocks, at: new Date().toISOString() };
  // Keep the 50 most recent sessions.
  const kept = Object.fromEntries(Object.entries(sessions).sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, 50));
  writeFileSync(statePath, JSON.stringify({ sessions: kept }, null, 1), "utf8");

  const note = policy.uncommittedChanges ? "\nNote: uncommitted changes to .iv/config.yaml are ignored by the gate until they are committed." : "";
  if (!ids.length) return policy.uncommittedChanges ? notice(harness, note.trim()) : { stdout: "", code: 0 };

  const max = policy.config.gate.maxStopBlocks;
  if (max > 0 && blocks > max) {
    appendFileSync(join(root, IV_DIR, LOG_FILE), JSON.stringify({ at: new Date().toISOString(), event: "stop-override", harness, session: key, blocks: blocks - 1, findings: ids }) + "\n", "utf8");
    return notice(harness, `Integration Verifier: the session ended with ${ids.length} blocking finding(s) still open after ${max} blocked attempts. This override is recorded in .iv/gate-log.jsonl; the git pre-commit hook and CI will still block. See .iv/report.md.`);
  }
  return blockStop(harness, `Integration Verifier gate (attempt ${blocks}${max ? ` of ${max}` : ""}): ${blocking.length} open finding(s) at or above "${policy.config.gate.failOn}". ${FIX_OR_ASK}${note}\n${list(blocking)}`);
}

// ---- post-write -------------------------------------------------------------------

async function postWrite(harness: Harness, input: HookInput, root: string): Promise<HookOutput> {
  const rels = filesOf(input)
    .map((file) => toPosix(relative(root, isAbsolute(file) ? file : join(root, file))))
    .filter((rel) => !rel.startsWith("..") && !rel.startsWith(`${IV_DIR}/`) && SOURCE_FILE.test(rel));
  if (!rels.length) return { stdout: "", code: 0 };
  const policy = loadPolicy(root);
  if (!policy.ok) return context(harness, `Integration Verifier: ${policy.source} is invalid, so no checks ran. Tell the user; \`iv config validate\` shows the problem.`);
  const { report } = await runCheck(root, policy.config, { files: rels, engine: null });
  const relevant = report.gate.open.filter((f) => f.severity !== "info");
  if (!relevant.length) return { stdout: "", code: 0 };
  return context(harness, `Integration Verifier (fast check of ${rels.join(", ")}, informational, nothing was changed):\n${list(relevant)}`);
}

// ---- entry --------------------------------------------------------------------------

function withBudget<T>(ms: number, work: Promise<T>): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<"timeout">((done) => (timer = setTimeout(() => done("timeout"), ms)));
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs one hook. It fails closed: when the gate cannot decide (invalid config, an
 * internal error, running out of time), the Stop hook blocks and says why, and the
 * post-write hook reports the problem, instead of quietly allowing.
 */
export async function runHook(harness: Harness, event: HookEvent, rawInput: string, env: NodeJS.ProcessEnv = process.env): Promise<HookOutput> {
  let input: HookInput = {};
  try {
    input = rawInput.trim() ? (JSON.parse(rawInput) as HookInput) : {};
  } catch {
    /* treat as empty */
  }
  const root = projectRoot(input, env);
  const failed = (why: string): HookOutput => {
    if (event === "stop") return blockStop(harness, `Integration Verifier gate could not run (${why}), so finishing is blocked. Tell the user; they can run \`iv check\` to see the problem.`);
    if (event === "pre-write") return { stdout: "", stderr: `Integration Verifier pre-write check failed: ${why}`, code: 1 };
    return context(harness, `Integration Verifier: the fast check failed (${why}). Tell the user.`);
  };
  try {
    if (event === "pre-write") return preWrite(input, root);
    if (!detectStack([root]).units.some((u) => u.role !== "unknown")) return { stdout: "", code: 0 };
    const work = event === "stop" ? stop(harness, input, root) : postWrite(harness, input, root);
    const out = await withBudget(Number(env.IV_HOOK_BUDGET_MS) || BUDGET_MS[event], work);
    return out === "timeout" ? failed(`it did not finish within ${Math.round((Number(env.IV_HOOK_BUDGET_MS) || BUDGET_MS[event]) / 1000)} s`) : out;
  } catch (e) {
    return failed((e as Error).message);
  }
}
