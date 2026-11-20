#!/usr/bin/env node
// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

// npm pack/publish hooks for the workspace packages. npm runs them in the package folder.
//   node ../../scripts/prepack.mjs        copy LICENSE (and, for the CLI, the adapters) in
//   node ../../scripts/prepack.mjs --clean remove the copies again (postpack)
// The CLI's `iv install` copies the harness adapters from its own package when they are
// there (an npm install) and from the repository otherwise (a clone), so the copies must
// not be left behind in a clone.

import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const pkgDir = process.cwd();
const { name } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const isCli = name === "integration-verifier";
const copies = ["LICENSE", ...(isCli ? ["adapters", ".claude-plugin"] : [])];

for (const c of copies) rmSync(join(pkgDir, c), { recursive: true, force: true });
if (!process.argv.includes("--clean")) {
  for (const c of copies) {
    const src = join(ROOT, c);
    if (!existsSync(src)) throw new Error(`prepack: ${src} is missing`);
    cpSync(src, join(pkgDir, c), { recursive: true });
  }
  console.log(`prepack ${name}: copied ${copies.join(", ")}`);
}
