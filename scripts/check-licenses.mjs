#!/usr/bin/env node
// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

// Fails if any installed npm package has a license outside the allowlist.
// Anything GPL/AGPL, source-available or otherwise restricted must be approved
// by the maintainers first (see CONTRIBUTING.md), then added to EXCEPTIONS.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ALLOWED = new Set(["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "BlueOak-1.0.0", "CC0-1.0", "Python-2.0"]);

/** Packages approved despite a license outside ALLOWED: name -> reason. */
const EXCEPTIONS = {
  lightningcss: "MPL-2.0, file-level copyleft. Dev-only (vitest -> vite), never shipped or modified.",
  "lightningcss-win32-x64-msvc": "Platform binary of lightningcss, same terms.",
  "lightningcss-linux-x64-gnu": "Platform binary of lightningcss, same terms.",
  "lightningcss-darwin-arm64": "Platform binary of lightningcss, same terms.",
};

function* packages(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.name.startsWith("@")) {
      yield* packages(full);
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      const manifest = join(full, "package.json");
      if (existsSync(manifest)) yield { manifest, nested: join(full, "node_modules") };
    }
  }
}

function licenseOf(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(" OR ");
  return "UNKNOWN";
}

function acceptable(expr) {
  // Accept "A OR B" when any option is allowed, "A AND B" only when all are.
  const clean = expr.replace(/[()]/g, "");
  if (clean.includes(" AND ")) return clean.split(" AND ").every((p) => ALLOWED.has(p.trim()));
  return clean.split(" OR ").some((p) => ALLOWED.has(p.trim()));
}

const seen = new Map();
const queue = [join(process.cwd(), "node_modules")];
while (queue.length) {
  for (const { manifest, nested } of packages(queue.pop())) {
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    if (pkg.private || pkg.name?.startsWith("@integration-verifier/") || pkg.name === "integration-verifier") continue;
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) continue;
    seen.set(key, licenseOf(pkg));
    queue.push(nested);
  }
}

const bad = [...seen].filter(([key, license]) => !acceptable(license) && !(key.split("@").slice(0, -1).join("@") in EXCEPTIONS));
if (bad.length) {
  console.error("Packages with licenses that need approval:");
  for (const [key, license] of bad) console.error(`  ${key}: ${license}`);
  process.exit(1);
}
console.log(`${seen.size} packages checked, all licenses approved.`);
