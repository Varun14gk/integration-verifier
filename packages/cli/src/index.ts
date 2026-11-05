#!/usr/bin/env node
// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { EXIT, run } from "./program.js";

const args = process.argv.slice(2);
let code: number;
try {
  code = await run(args);
} catch (e) {
  // A crash must never look like "findings" (exit 1) to hooks and CI.
  process.stderr.write(`iv: internal error: ${(e as Error).stack ?? String(e)}\n`);
  code = EXIT.ERROR;
}
process.exitCode = code;
// A hook has answered; if a timed-out check is still running, don't let it hold the harness.
// The timer is unref'd, so a normal run still exits as soon as it is done.
if (args[0] === "hook") setTimeout(() => process.exit(code), 500).unref();
