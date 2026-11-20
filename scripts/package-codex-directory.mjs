#!/usr/bin/env node
// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

// Builds the ZIP for OpenAI's public plugin directory: the "directory edition" of the
// Codex plugin. The portal rejects ZIPs with lifecycle hooks, and local (stdio) MCP
// servers need partner approval, so this edition has neither. Its skills tell Codex to run
// the `iv` CLI instead of the MCP tools, and the manifest marks it as needing local
// execution. The full plugin (hooks + MCP) stays the manual-install edition.
//
// Usage: node scripts/package-codex-directory.mjs [outDir]   (default: dist/)

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { directorySkill } from "./directory-edition.mjs";

const ROOT = join(import.meta.dirname, "..");
const CODEX = join(ROOT, "adapters", "codex");
const VERSION = /export const VERSION = "([^"]+)"/.exec(readFileSync(join(ROOT, "packages", "core", "src", "version.ts"), "utf8"))[1];

export { directorySkill };

/** The directory manifest: the Codex manifest without hooks and MCP, marked as local. */
export function directoryManifest() {
  const m = JSON.parse(readFileSync(join(CODEX, ".codex-plugin", "plugin.json"), "utf8"));
  delete m.hooks;
  delete m.mcpServers;
  m.version = VERSION;
  m.extensions = { "com.openai": { requires_local_executor: true } };
  return JSON.stringify(m, null, 2) + "\n";
}

/** Every file of the directory edition, as zip path -> content. */
export function directoryFiles() {
  const files = new Map();
  files.set(".codex-plugin/plugin.json", directoryManifest());
  const add = (dir, transform = (t) => t) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) add(full, transform);
      else files.set(relative(CODEX, full).split("\\").join("/"), transform(readFileSync(full, "utf8")));
    }
  };
  add(join(CODEX, "skills"), directorySkill);
  add(join(CODEX, "assets"));
  files.set("README.md", readFileSync(join(CODEX, "README.md"), "utf8").replace(/^# .*$/m, "# Integration Verifier for Codex (directory edition)\n\nSkills only: no hooks and no MCP server, as the public plugin directory requires. The skills run the `iv` CLI: `npm install -g integration-verifier`. For the automatic gate, use the full plugin: `iv install --codex`."));
  files.set("LICENSE", readFileSync(join(ROOT, "LICENSE"), "utf8"));
  return files;
}

/** A standard ZIP (deflate) of the given files, with fixed timestamps so builds are reproducible. */
export function zip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  const DOS_TIME = 0;
  const DOS_DATE = (2026 - 1980) << 9 | (1 << 5) | 1; // 2026-01-01
  for (const [name, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const data = Buffer.from(text, "utf8");
    const packed = deflateRawSync(data, { level: 9 });
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    local.push(header, nameBuf, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += header.length + nameBuf.length + packed.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuf, end]);
}

if (process.argv[1]?.endsWith("package-codex-directory.mjs")) {
  const outDir = process.argv[2] ?? join(ROOT, "dist");
  mkdirSync(outDir, { recursive: true });
  const files = directoryFiles();
  const out = join(outDir, `integration-verifier-codex-directory-${VERSION}.zip`);
  writeFileSync(out, zip(files));
  console.log(`Wrote ${out} (${files.size} files: no hooks, no MCP server).`);
}
