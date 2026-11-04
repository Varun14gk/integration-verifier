// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync, type ChildProcess } from "node:child_process";

export interface RunningProcess {
  name: string;
  command: string;
  /** Everything the process printed, for the server-output checks. */
  output: string[];
  exited: boolean;
  stop(): Promise<void>;
}

const MAX_OUTPUT_LINES = 20_000;

/** Starts a command from `.iv/config.yaml` in a shell, capturing its output. */
export function startProcess(name: string, command: string, cwd: string, env: NodeJS.ProcessEnv = {}): RunningProcess {
  const child: ChildProcess = spawn(command, {
    cwd,
    shell: true,
    env: { ...process.env, ...env, FORCE_COLOR: "0" },
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const rp: RunningProcess = {
    name,
    command,
    output: [],
    exited: false,
    stop: () => stopTree(child, rp),
  };
  const collect = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      if (line && rp.output.length < MAX_OUTPUT_LINES) rp.output.push(line);
    }
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.on("exit", () => (rp.exited = true));
  return rp;
}

function stopTree(child: ChildProcess, rp: RunningProcess): Promise<void> {
  if (rp.exited || child.pid === undefined) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
    setTimeout(() => {
      if (!rp.exited) {
        try {
          if (process.platform !== "win32") process.kill(-child.pid!, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      resolve();
    }, 5000).unref();
  });
}

/** Polls `url` until it answers with any HTTP status, the process exits, or time runs out. */
export async function waitForUrl(url: string, timeoutMs: number, proc?: RunningProcess): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc?.exited) return false;
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return false;
}
