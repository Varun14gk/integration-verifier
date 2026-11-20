// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION } from "@integration-verifier/core";

const ROOT = join(import.meta.dirname, "..");
const PACKAGES = ["core", "runtime", "mcp", "cli"] as const;
const manifest = (p: string) => JSON.parse(readFileSync(join(ROOT, "packages", p, "package.json"), "utf8"));

describe("npm packages (scripts/smoke-npm.mjs installs them for real in CI)", () => {
  it("are publishable: version, license, repository, README, public scoped access", () => {
    for (const p of PACKAGES) {
      const m = manifest(p);
      expect(m.version, p).toBe(VERSION);
      expect(m.private, p).toBeUndefined();
      expect(m.license, p).toBe("Apache-2.0");
      expect(m.repository, p).toEqual({ type: "git", url: "git+https://github.com/Varun14gk/integration-verifier.git", directory: `packages/${p}` });
      expect(m.engines, p).toEqual({ node: ">=22" });
      expect(m.scripts, p).toEqual({ prepack: "node ../../scripts/prepack.mjs", postpack: "node ../../scripts/prepack.mjs --clean" });
      expect(existsSync(join(ROOT, "packages", p, "README.md")), p).toBe(true);
      if (m.name.startsWith("@")) expect(m.publishConfig, p).toEqual({ access: "public" });
    }
  });

  it("depend on each other at exactly this version", () => {
    for (const p of PACKAGES) {
      for (const [dep, v] of Object.entries(manifest(p).dependencies as Record<string, string>)) {
        if (dep.startsWith("@integration-verifier/")) expect(v, `${p} -> ${dep}`).toBe(VERSION);
      }
    }
  });

  it("the CLI ships the adapters `iv install` copies, and core ships its rules", () => {
    expect(manifest("cli").files).toEqual(expect.arrayContaining(["dist", "adapters", ".claude-plugin"]));
    expect(manifest("cli").bin).toEqual({ iv: "dist/index.js" });
    expect(manifest("core").files).toContain("rules");
  });

  it("no pack copies are left in the clone (they would redirect `iv install` to them)", () => {
    expect(existsSync(join(ROOT, "packages", "cli", "adapters"))).toBe(false);
    expect(existsSync(join(ROOT, "packages", "cli", ".claude-plugin"))).toBe(false);
  });
});
