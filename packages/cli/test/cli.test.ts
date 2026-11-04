// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "@integration-verifier/core";
import { EXIT, run, type Io } from "../src/program.js";

function capture(): Io & { stdout: () => string; stderr: () => string } {
  let out = "";
  let err = "";
  return {
    out: (t) => void (out += t),
    err: (t) => void (err += t),
    stdout: () => out,
    stderr: () => err,
  };
}

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));

describe("iv (in process)", () => {
  it("prints the version", async () => {
    const io = capture();
    expect(await run(["--version"], io)).toBe(EXIT.OK);
    expect(io.stdout().trim()).toBe(VERSION);
  });

  it("lists every command from the spec in --help", async () => {
    const io = capture();
    expect(await run(["--help"], io)).toBe(EXIT.OK);
    for (const cmd of ["detect", "map", "flow", "check", "runtime", "report", "install", "config"]) {
      expect(io.stdout()).toContain(cmd);
    }
  });

  it("detect prints a summary and writes .iv/stack.json", async () => {
    const root = mkdtempSync(join(tmpdir(), "iv-cli-"));
    writeFileSync(join(root, "requirements.txt"), "fastapi\n");
    const io = capture();
    expect(await run(["detect", "--root", root], io)).toBe(EXIT.OK);
    expect(io.stdout()).toContain("fastapi");
    const written = JSON.parse(readFileSync(join(root, ".iv", "stack.json"), "utf8"));
    expect(written.kind).toBe("stack");
    expect(written.data.units[0].framework).toBe("fastapi");
  });

  it.each(["map", "flow", "check", "runtime", "report", "install"])("%s is reported as not implemented", async (cmd) => {
    const io = capture();
    expect(await run([cmd], io)).toBe(EXIT.NOT_IMPLEMENTED);
    expect(io.stderr()).toMatch(/not implemented yet \(planned for PR \d+\)/);
  });

  it("returns a usage error for an unknown command", async () => {
    expect(await run(["frobnicate"], capture())).toBe(EXIT.USAGE);
  });

  it("validates a good config", async () => {
    const io = capture();
    const root = fileURLToPath(new URL("../../../fixtures/react-fastapi", import.meta.url));
    expect(await run(["config", "validate", "--root", root], io)).toBe(EXIT.OK);
    expect(io.stdout()).toContain("Config OK");
  });

  it("reports a bad config with exit code 2", async () => {
    const root = mkdtempSync(join(tmpdir(), "iv-cli-"));
    mkdirSync(join(root, ".iv"));
    writeFileSync(join(root, ".iv", "config.yaml"), "gate:\n  failOn: urgent\n");
    const io = capture();
    expect(await run(["config", "validate", "--root", root], io)).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain("gate.failOn");
  });

  it("init creates a config and refuses to overwrite it", async () => {
    const root = mkdtempSync(join(tmpdir(), "iv-cli-"));
    expect(await run(["config", "init", "--root", root], capture())).toBe(EXIT.OK);
    expect(existsSync(join(root, ".iv", "config.yaml"))).toBe(true);
    expect(await run(["config", "validate", "--root", root], capture())).toBe(EXIT.OK);
    expect(await run(["config", "init", "--root", root], capture())).toBe(EXIT.USAGE);
  });
});

describe("iv (built binary)", () => {
  it("runs from dist and sets the exit code", () => {
    expect(execFileSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).trim()).toBe(VERSION);
    const map = spawnSync(process.execPath, [BIN, "map"], { encoding: "utf8" });
    expect(map.status).toBe(EXIT.NOT_IMPLEMENTED);
  });
});
