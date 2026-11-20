// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { exec, killEngineProcesses } from "../src/scan/engine.js";

describe("engine processes", () => {
  it("killEngineProcesses stops a running engine, so a timed-out hook leaves nothing behind", async () => {
    const started = Date.now();
    const run = exec(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
    await new Promise((r) => setTimeout(r, 300));
    killEngineProcesses();
    const result = await run;
    expect(result.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("is a no-op when nothing runs", () => {
    expect(() => killEngineProcesses()).not.toThrow();
  });

  it("a program that can't be started is 'not found', never a crash", async () => {
    expect((await exec("Z:/definitely/not/here/semgrep", ["--version"])).code).toBe(127);
  });
});
