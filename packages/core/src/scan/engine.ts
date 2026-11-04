// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IGNORED_DIRS } from "../fs-walk.js";

/** A site located by a pattern rule. Offsets index into the file's text. */
export interface PatternMatch {
  ruleId: string;
  /** Path as given back by the engine (relative to the scan cwd). */
  file: string;
  line: number;
  startOffset: number;
  endOffset: number;
}

/** An installed pattern engine. The tool never bundles one. */
export interface PatternEngine {
  name: "semgrep" | "opengrep";
  command: string;
  version: string;
  run(rulesFile: string, targets: string[], cwd: string): Promise<PatternMatch[]>;
}

/** Our rule file, shipped with the package. */
export const RULES_FILE = fileURLToPath(new URL("../../rules/iv-rules.yaml", import.meta.url));

function exec(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // semgrep.exe looks for pysemgrep next to itself, so put its folder on PATH.
    const env = { ...process.env, PATH: `${dirname(cmd)}${delimiter}${process.env.PATH ?? ""}`, SEMGREP_SEND_METRICS: "off" };
    execFile(cmd, args, { cwd: opts.cwd, env, timeout: opts.timeoutMs ?? 600_000, maxBuffer: 256 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException).code === "number" ? ((err as unknown as { code: number }).code) : err ? 1 : 0;
      resolve({ code: (err as NodeJS.ErrnoException | null)?.code === "ENOENT" ? 127 : code, stdout, stderr });
    });
  });
}

/** Places pip and package managers commonly put engine binaries that may not be on PATH. */
function candidateCommands(name: string): string[] {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const out = [name];
  const dirs: string[] = [];
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    for (const base of [join(appData, "Python"), join(local, "Programs", "Python")]) {
      try {
        for (const v of readdirSync(base)) dirs.push(join(base, v, "Scripts"), join(base, v));
      } catch {
        /* not installed */
      }
    }
  } else {
    dirs.push(join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin");
  }
  for (const d of dirs) if (existsSync(join(d, exe))) out.push(join(d, exe));
  return out;
}

interface SemgrepJson {
  results: { check_id: string; path: string; start: { line: number; offset: number }; end: { offset: number } }[];
  errors: { message?: string; level?: string }[];
}

function makeEngine(name: PatternEngine["name"], command: string, version: string): PatternEngine {
  return {
    name,
    command,
    version,
    async run(rulesFile, targets, cwd) {
      const excludes = [...IGNORED_DIRS].flatMap((d) => ["--exclude", d]);
      const args = ["scan", "--config", rulesFile, "--json", "--quiet", "--metrics=off", "--disable-version-check", "--no-git-ignore", ...excludes, ...targets];
      const res = await exec(command, name === "opengrep" ? args.filter((a) => a !== "--metrics=off" && a !== "--disable-version-check") : args, { cwd });
      let parsed: SemgrepJson;
      try {
        parsed = JSON.parse(res.stdout) as SemgrepJson;
      } catch {
        throw new Error(`${name} failed (exit ${res.code}): ${res.stderr.trim().split("\n").slice(-3).join(" ")}`);
      }
      const fatal = parsed.errors.filter((e) => e.level === "error" && !/Syntax error|Lexical error|Partial/.test(e.message ?? ""));
      if (fatal.length && parsed.results.length === 0) throw new Error(`${name}: ${fatal[0]!.message}`);
      return parsed.results.map((r) => ({
        ruleId: r.check_id.slice(r.check_id.lastIndexOf("iv-")),
        file: r.path.replace(/\\/g, "/"),
        line: r.start.line,
        startOffset: r.start.offset,
        endOffset: r.end.offset,
      }));
    },
  };
}

/**
 * Finds an installed engine. `preferred` comes from `scanner.engine` in config;
 * `command` from `scanner.command` overrides the lookup.
 */
export async function findEngine(preferred: "auto" | "opengrep" | "semgrep" | "none", command?: string): Promise<PatternEngine | null> {
  if (preferred === "none") return null;
  const names: PatternEngine["name"][] = preferred === "auto" ? ["opengrep", "semgrep"] : [preferred];
  for (const name of names) {
    const cmds = command ? [command] : candidateCommands(name);
    for (const cmd of cmds) {
      const res = await exec(cmd, ["--version"], { timeoutMs: 60_000 });
      const version = res.stdout.trim().split(/\s+/).pop();
      if (res.code === 0 && version) return makeEngine(name, cmd, version);
    }
  }
  return null;
}
