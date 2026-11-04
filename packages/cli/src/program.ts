// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Command, CommanderError } from "commander";
import {
  applyGate, buildFlow, buildMap, CONFIG_TEMPLATE, configPath, detectStack, formatCheckSummary, formatFlowSummary, formatMapSummary,
  formatStackSummary, indexUi, IV_DIR, loadConfig, runCheck, toMarkdown, toSarif, VERSION, writeOutput, type CheckReport, type Config,
} from "@integration-verifier/core";

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
  { name: "runtime", summary: "opt-in: verify against the running app with Playwright", pr: 5 },
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

  program
    .command("map")
    .description("build the frontend-to-backend integration map (.iv/map.json)")
    .option("-r, --root <dir>", "project root", ".")
    .option("--also <dirs...>", "extra roots, e.g. a backend in a separate repo")
    .option("--json", "print the map as JSON instead of a summary")
    .action(async (opts: { root: string; also?: string[]; json?: boolean }) => {
      const root = resolve(opts.root);
      const loaded = loadConfig(root);
      if (!loaded.ok) {
        io.err(`Invalid config: ${loaded.source}. Run "iv config validate" for details.\n`);
        result.code = EXIT.USAGE;
        return;
      }
      const stack = detectStack([root, ...(opts.also ?? []).map((d) => resolve(d))]);
      writeOutput(root, "stack", stack);
      const map = await buildMap(root, { stack });
      const path = writeOutput(root, "map", map);
      const gate = applyGate(map.findings, loaded.config);
      if (opts.json) io.out(JSON.stringify(map, null, 2) + "\n");
      else {
        io.out(formatMapSummary({ ...map, findings: gate.open }));
        if (gate.dismissed.length) io.out(`${gate.dismissed.length} finding(s) dismissed in config.\n`);
        io.out(`Wrote ${path}\n`);
      }
      if (!gate.passed) result.code = EXIT.FINDINGS;
    });

  const configOrFail = (root: string): Config | null => {
    const loaded = loadConfig(root);
    if (loaded.ok) return loaded.config;
    io.err(`Invalid config: ${loaded.source}. Run "iv config validate" for details.\n`);
    result.code = EXIT.USAGE;
    return null;
  };

  program
    .command("flow")
    .description("trace request and response fields end to end (.iv/flow.json)")
    .option("-r, --root <dir>", "project root", ".")
    .option("--also <dirs...>", "extra roots, e.g. a backend in a separate repo")
    .option("--json", "print the flow as JSON instead of a summary")
    .action(async (opts: { root: string; also?: string[]; json?: boolean }) => {
      const root = resolve(opts.root);
      const config = configOrFail(root);
      if (!config) return;
      const stack = detectStack([root, ...(opts.also ?? []).map((d) => resolve(d))]);
      const map = await buildMap(root, { stack });
      const flow = buildFlow(map, indexUi(root, stack), config);
      const path = writeOutput(root, "flow", flow);
      io.out(opts.json ? JSON.stringify(flow, null, 2) + "\n" : formatFlowSummary(flow) + `Wrote ${path}\n`);
    });

  program
    .command("check")
    .description("run the integration map and all leak checks, then apply the gate (.iv/check.json)")
    .option("-r, --root <dir>", "project root", ".")
    .option("--also <dirs...>", "extra roots, e.g. a backend in a separate repo")
    .option("--files <files...>", "only report findings in these files (fast mode for hooks)")
    .option("--no-engine", "skip checks that need Opengrep/Semgrep")
    .option("--json", "print the check report as JSON")
    .action(async (opts: { root: string; also?: string[]; files?: string[]; engine: boolean; json?: boolean }) => {
      const root = resolve(opts.root);
      const config = configOrFail(root);
      if (!config) return;
      const { stack, map, flow, report } = await runCheck(root, config, {
        ...(opts.also ? { also: opts.also } : {}),
        ...(opts.files ? { files: opts.files } : {}),
        ...(opts.engine ? {} : { engine: null }),
      });
      writeOutput(root, "stack", stack);
      writeOutput(root, "map", map);
      writeOutput(root, "flow", flow);
      const path = writeOutput(root, "check", report);
      io.out(opts.json ? JSON.stringify(report, null, 2) + "\n" : formatCheckSummary(report) + `Wrote ${path}\n`);
      if (!report.gate.passed) result.code = EXIT.FINDINGS;
    });

  program
    .command("report")
    .description("write Markdown and SARIF reports from the last `iv check`")
    .option("-r, --root <dir>", "project root", ".")
    .option("-f, --format <format>", "md, sarif or all", "all")
    .option("-o, --out <dir>", "output folder (default: .iv/)")
    .action((opts: { root: string; format: string; out?: string }) => {
      const root = resolve(opts.root);
      const src = join(root, IV_DIR, "check.json");
      if (!existsSync(src)) {
        io.err(`No ${src}. Run "iv check" first.\n`);
        result.code = EXIT.USAGE;
        return;
      }
      if (!["md", "sarif", "all"].includes(opts.format)) {
        io.err(`Unknown format ${opts.format}; use md, sarif or all.\n`);
        result.code = EXIT.USAGE;
        return;
      }
      const report = (JSON.parse(readFileSync(src, "utf8")) as { data: CheckReport }).data;
      const outDir = resolve(opts.out ?? join(root, IV_DIR));
      mkdirSync(outDir, { recursive: true });
      if (opts.format !== "sarif") {
        writeFileSync(join(outDir, "report.md"), toMarkdown(report), "utf8");
        io.out(`Wrote ${join(outDir, "report.md")}\n`);
      }
      if (opts.format !== "md") {
        writeFileSync(join(outDir, "report.sarif"), JSON.stringify(toSarif(report), null, 2) + "\n", "utf8");
        io.out(`Wrote ${join(outDir, "report.sarif")}\n`);
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
