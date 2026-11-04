// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

describe("repository hygiene", () => {
  it("every source file of ours has a copyright and SPDX header", () => {
    const ours = trackedFiles().filter((f) => /\.(ts|tsx|js|mjs|py|java)$/.test(f) && !f.endsWith("__init__.py"));
    expect(ours.length).toBeGreaterThan(10);
    const missing = ours.filter((f) => {
      const head = readFileSync(join(ROOT, f), "utf8").split("\n").slice(0, 4).join("\n");
      return !head.includes("Copyright 2026 The Integration Verifier Authors") || !head.includes("SPDX-License-Identifier: Apache-2.0");
    });
    expect(missing).toEqual([]);
  });

  it("ships the Apache-2.0 license, NOTICE and third-party notices", () => {
    expect(readFileSync(join(ROOT, "LICENSE"), "utf8")).toContain("Apache License");
    expect(readFileSync(join(ROOT, "NOTICE"), "utf8")).toContain("Integration Verifier");
    expect(readFileSync(join(ROOT, "THIRD_PARTY_NOTICES.md"), "utf8")).toContain("commander");
  });

  it("every installed dependency has an approved license", () => {
    // Throws (non-zero exit) if anything is outside the allowlist.
    execFileSync(process.execPath, [join(ROOT, "scripts", "check-licenses.mjs")], { cwd: ROOT, encoding: "utf8" });
  });
});
