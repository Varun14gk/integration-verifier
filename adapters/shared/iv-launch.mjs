#!/usr/bin/env node
// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

// Starts the installed Integration Verifier CLI with the given arguments.
// Harness adapters call this instead of a fixed path, because the plugin folder
// a harness copies does not contain the engine itself. Lookup order:
//   1. IV_CLI: path to the CLI's index.js
//   2. ~/.integration-verifier/cli.json, written by `iv install`
//   3. `iv` on PATH
// When nothing is found, hooks pass (exit 0) with a hint; other commands fail.
// The canonical copy is adapters/shared/iv-launch.mjs; each adapter ships its own copy.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const args = process.argv.slice(2);
const isHook = args[0] === "hook";

function fromConfig() {
  try {
    const home = process.env.IV_HOME || homedir();
    const c = JSON.parse(readFileSync(join(home, ".integration-verifier", "cli.json"), "utf8"));
    if (c.cli && existsSync(c.cli)) return [c.node && existsSync(c.node) ? c.node : process.execPath, [c.cli, ...args]];
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

function notFound() {
  process.stderr.write(
    "Integration Verifier CLI not found. Install it: clone https://github.com/Varun14gk/integration-verifier, " +
      "run `npm ci && npm run build`, then `node packages/cli/dist/index.js install --all`.\n",
  );
  process.exit(isHook ? 0 : 1);
}

const onPathCli = !process.env.IV_CLI && !fromConfig() ? onPath() : null;
const [command, commandArgs, useShell] = process.env.IV_CLI
  ? [process.execPath, [process.env.IV_CLI, ...args], false]
  : (fromConfig() ?? (onPathCli ? [onPathCli, args, onPathCli.endsWith(".cmd") || onPathCli.endsWith(".bat")] : notFound()));

const child = spawn(command, commandArgs, { stdio: "inherit", shell: useShell, windowsHide: true });
child.on("error", notFound);
child.on("exit", (code) => process.exit(code ?? (isHook ? 0 : 1)));
