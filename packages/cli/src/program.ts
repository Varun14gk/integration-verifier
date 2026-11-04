// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Command, CommanderError } from "commander";
import { CONFIG_TEMPLATE, configPath, detectStack, formatStackSummary, loadConfig, VERSION, writeOutput } from "@integration-verifier/core";

/** Process exit codes. Hooks and CI depend on these, so keep them stable. */
export const EXIT = {
  OK: 0,
  /** Open findings at or above the gate severity. */
  FINDINGS: 1,
  /** Bad arguments or invalid `.iv/config.yaml`. */
  USAGE: 2,
  /** The command exists but is not built yet. */
  NOT_IMPLEMENTED: 3,
} as const;

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

const defaultIo: Io = {
  out: (t) => process.stdout.write(t),
  err: (t) => process.stderr.write(t),
};

/** Commands from the spec that later PRs fill in. */
const PLANNED: { name: string; summary: string; pr: number }[] = [
  { name: "map", summary: "build the frontend-to-backend integration map (.iv/map.json)", pr: 3 },
  { name: "flow", summary: "trace request and response fields end to end", pr: 4 },
  { name: "check", summary: "run data-leak and validation checks", pr: 4 },
  { name: "runtime", summary: "opt-in: verify against the running app with Playwright", pr: 5 },
  { name: "report", summary: "write Markdown and SARIF reports from the latest results", pr: 4 },
  { name: "install", summary: "install harness adapters (Claude Code, Codex, Gemini CLI)", pr: 7 },
];

/**
 * Builds the `iv` program. Actions store their exit code in `result.code`
 * instead of calling process.exit, so tests can run the program in-process.
 */
export function buildProgram(io: Io = defaultIo): { program: Command; result: { code: number } } {
  const result = { code: EXIT.OK as number };
  const program = new Command("iv")
    .description("Integration Verifier: checks that frontend, backend and APIs are connected and that no data leaks")
    .version(VERSION, "-v, --version")
    .configureOutput({ writeOut: io.out, writeErr: io.err })
    .exitOverride()
    .showHelpAfterError();

  program
    .command("detect")
    .description("identify the stack and write .iv/stack.json")
    .option("-r, --root <dir>", "project root", ".")
    .option("--also <dirs...>", "extra roots, e.g. a backend in a separate repo")
    .option("--json", "print the report as JSON instead of a summary")
    .action((opts: { root: string; also?: string[]; json?: boolean }) => {
      const root = resolve(opts.root);
      const report = detectStack([root, ...(opts.also ?? []).map((d) => resolve(d))]);
      const path = writeOutput(root, "stack", report);
      if (opts.json) {
        io.out(JSON.stringify(report, null, 2) + "\n");
      } else {
        io.out(formatStackSummary(report));
        io.out(`Wrote ${path}\n`);
      }
    });

  for (const planned of PLANNED) {
    program
      .command(planned.name)
      .description(planned.summary)
      .option("-r, --root <dir>", "project root", ".")
      .action(() => {
        io.err(`iv ${planned.name}: not implemented yet (planned for PR ${planned.pr}).\n`);
        result.code = EXIT.NOT_IMPLEMENTED;
      });
  }

  const config = program.command("config").description("work with .iv/config.yaml");

  config
    .command("validate")
    .description("check .iv/config.yaml against the schema")
    .option("-r, --root <dir>", "project root", ".")
    .option("--json", "print the resolved config as JSON")
    .action((opts: { root: string; json?: boolean }) => {
      const loaded = loadConfig(resolve(opts.root));
      if (!loaded.ok) {
        io.err(`Invalid config: ${loaded.source}\n`);
        for (const issue of loaded.issues) {
          const where = [issue.path || null, issue.line ? `line ${issue.line}` : null].filter(Boolean).join(", ");
          io.err(`  - ${where ? `${where}: ` : ""}${issue.message}\n`);
        }
        result.code = EXIT.USAGE;
        return;
      }
      if (opts.json) {
        io.out(JSON.stringify({ source: loaded.source, config: loaded.config }, null, 2) + "\n");
      } else if (loaded.source === null) {
        io.out(`No ${configPath(".")} found; using defaults. Run "iv config init" to create one.\n`);
      } else {
        io.out(`Config OK: ${loaded.source}\n`);
      }
    });

  config
    .command("init")
    .description("create .iv/config.yaml with commented defaults")
    .option("-r, --root <dir>", "project root", ".")
    .option("-f, --force", "overwrite an existing config")
    .action((opts: { root: string; force?: boolean }) => {
      const path = configPath(resolve(opts.root));
      if (existsSync(path) && !opts.force) {
        io.err(`${path} already exists. Use --force to overwrite.\n`);
        result.code = EXIT.USAGE;
        return;
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, CONFIG_TEMPLATE, "utf8");
      io.out(`Created ${path}\n`);
    });

  return { program, result };
}

/** Runs `iv` with the given arguments (without `node` and the script path). */
export async function run(args: string[], io: Io = defaultIo): Promise<number> {
  const { program, result } = buildProgram(io);
  try {
    await program.parseAsync(args, { from: "user" });
  } catch (e) {
    if (e instanceof CommanderError) {
      // --help and --version also arrive here, with exit code 0.
      return e.exitCode === 0 ? EXIT.OK : EXIT.USAGE;
    }
    throw e;
  }
  return result.code;
}
