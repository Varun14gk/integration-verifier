#!/usr/bin/env node
// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

// Packs the four packages exactly as `npm publish` would, installs the tarballs into an
// empty project, and runs the installed CLI the way a user would: --version, a check on a
// fixture, an installer dry run, a hook, and an MCP handshake. Run after `npm run build`.
//
// Usage: node scripts/smoke-npm.mjs

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const PACKAGES = ["core", "runtime", "mcp", "cli"];
const work = mkdtempSync(join(tmpdir(), "iv-npm-smoke-"));
const npm = (args, cwd) => {
  const r = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, { cwd, encoding: "utf8", shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error(`npm ${args.join(" ")} failed in ${cwd}:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};
const ok = (what) => console.log(`ok   ${what}`);

try {
  const packs = join(work, "packs");
  mkdirSync(packs);
  for (const p of PACKAGES) npm(["pack", "--pack-destination", packs], join(ROOT, "packages", p));
  const tarballs = readdirSync(packs).map((f) => join(packs, f));
  if (tarballs.length !== PACKAGES.length) throw new Error(`expected ${PACKAGES.length} tarballs, got ${tarballs.length}`);
  if (existsSync(join(ROOT, "packages", "cli", "adapters"))) throw new Error("postpack left packages/cli/adapters behind");
  ok("packed 4 packages; postpack cleaned up");

  const app = join(work, "app");
  cpSync(join(ROOT, "fixtures", "react-fastapi"), join(app, "proj"), { recursive: true });
  writeFileSync(join(app, "package.json"), '{ "name": "smoke", "private": true }\n');
  npm(["install", "--no-audit", "--no-fund", ...tarballs], app);
  const cli = join(app, "node_modules", "integration-verifier", "dist", "index.js");
  for (const f of [".claude-plugin/marketplace.json", "adapters/claude-code/.claude-plugin/plugin.json", "adapters/codex/.codex-plugin/plugin.json", "adapters/gemini-cli/gemini-extension.json", "adapters/shared/iv-launch.mjs", "LICENSE"]) {
    if (!existsSync(join(app, "node_modules", "integration-verifier", f))) throw new Error(`the package is missing ${f}`);
  }
  ok("installed from the tarballs; adapters and LICENSE are in the package");

  const iv = (args, input) => spawnSync(process.execPath, [cli, ...args], { cwd: app, encoding: "utf8", input, env: { ...process.env, IV_HOME: join(work, "home") } });
  const version = iv(["--version"]).stdout.trim();
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`iv --version printed ${version}`);
  ok(`iv --version: ${version}`);

  const check = iv(["check", "--root", "proj"]);
  if (check.status !== 1) throw new Error(`iv check on the broken fixture exited ${check.status}, expected 1 (findings):\n${check.stdout}\n${check.stderr}`);
  ok("iv check finds the fixture's problems (exit 1)");

  for (const h of ["--claude-code", "--codex", "--gemini-cli", "--github-action"]) {
    const r = iv(["install", h, "--dry-run", "--root", "proj"]);
    if (r.status !== 0) throw new Error(`iv install ${h} --dry-run exited ${r.status}:\n${r.stdout}\n${r.stderr}`);
  }
  ok("iv install --dry-run works for every harness and the GitHub Action");

  const hook = iv(["hook", "claude-code", "pre-write"], "{}");
  if (hook.status !== 0) throw new Error(`pre-write hook exited ${hook.status}: ${hook.stderr}`);
  ok("pre-write hook answers");

  const tools = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [cli, "mcp", "--root", join(app, "proj")], { stdio: ["pipe", "pipe", "inherit"] });
    const timer = setTimeout(() => (p.kill(), reject(new Error("MCP server did not answer in 60 s"))), 60_000);
    let buf = "";
    const send = (m) => p.stdin.write(JSON.stringify(m) + "\n");
    p.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines.filter(Boolean)) {
        const m = JSON.parse(line);
        if (m.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        } else if (m.id === 2) {
          clearTimeout(timer);
          p.kill();
          resolve(m.result.tools.map((t) => t.name));
        }
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } });
  });
  if (!tools.includes("iv_check")) throw new Error(`MCP tools: ${tools.join(", ")}`);
  ok(`MCP server lists ${tools.length} tools`);
  console.log("npm package smoke test passed.");
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 3 });
}
