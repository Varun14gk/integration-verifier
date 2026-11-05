#!/usr/bin/env node
// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

// Starts the installed Integration Verifier CLI with the given arguments.
// Harness adapters call this instead of a fixed path, because the plugin folder
// a harness copies does not contain the engine itself. Lookup order:
//   1. IV_CLI: path to the CLI's index.js
//   2. ~/.integration-verifier/cli.json, written by `iv install`
//   3. `iv` on PATH
// It fails closed. When the CLI is missing or dies (crash, signal, timeout), a gate
// hook (`hook <harness> stop|pre-write`) exits 2, which blocks in every harness and
// shows the reason; `post-write` exits 1, a visible but non-blocking error; any other
// command exits 4 (internal error), which never means "findings".
// The canonical copy is adapters/shared/iv-launch.mjs; each adapter ships its own copy.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const args = process.argv.slice(2);
const isHook = args[0] === "hook";
const gateEvent = isHook && (args[2] === "stop" || args[2] === "pre-write");
const failCode = gateEvent ? 2 : isHook ? 1 : 4;

function fail(message) {
  process.stderr.write(`Integration Verifier: ${message}\n`);
  process.exit(failCode);
}

function fromConfig() {
  try {
    const home = process.env.IV_HOME || homedir();
    const c = JSON.parse(readFileSync(join(home, ".integration-verifier", "cli.json"), "utf8"));
    if (c.cli && existsSync(c.cli)) return [c.node && existsSync(c.node) ? c.node : process.execPath, [c.cli, ...args], false];
  } catch {
    /* not installed through iv install */
  }
  return null;
}

function onPath() {
  const names = process.platform === "win32" ? ["iv.cmd", "iv.exe", "iv.bat"] : ["iv"];
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    for (const n of names) if (dir && existsSync(join(dir, n))) return join(dir, n);
  }
  return null;
}

/** cmd.exe needs every argument quoted, or paths with spaces split apart. */
const cmdQuote = (a) => `"${String(a).replace(/"/g, '""')}"`;

const NOT_FOUND =
  "the CLI was not found, so this check could not run. Install it: clone https://github.com/Varun14gk/integration-verifier, " +
  "run `npm ci && npm run build`, then `node packages/cli/dist/index.js install --all`. To stop these checks instead, disable the integration-verifier plugin or extension.";

function resolveCommand() {
  if (process.env.IV_CLI) return [process.execPath, [process.env.IV_CLI, ...args], false];
  const configured = fromConfig();
  if (configured) return configured;
  const cli = onPath();
  if (!cli) fail(NOT_FOUND);
  const viaCmd = /\.(cmd|bat)$/i.test(cli);
  return viaCmd ? [cmdQuote(cli), args.map(cmdQuote), true] : [cli, args, false];
}

const [command, commandArgs, useShell] = resolveCommand();
const child = spawn(command, commandArgs, { stdio: "inherit", shell: useShell, windowsHide: true });
child.on("error", () => fail(NOT_FOUND));
child.on("exit", (code, signal) => {
  if (signal || code === null) fail(`the CLI was stopped (${signal ?? "no exit code"}) before it finished, so this check did not complete.`);
  // The Stop hook answers with 0 (JSON decision) or 2; anything else is a crash, which blocks.
  if (args[2] === "stop" && code !== 0 && code !== 2) fail(`the CLI exited with an error (code ${code}), so the gate could not decide.`);
  process.exit(code);
});
