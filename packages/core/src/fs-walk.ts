// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Folders that never contain the user's own source. */
export const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "target", "bin", "obj",
  ".venv", "venv", "env", "__pycache__", ".mypy_cache", ".pytest_cache", ".tox",
  ".next", ".nuxt", ".svelte-kit", ".angular", ".turbo", ".cache", ".parcel-cache",
  ".gradle", ".idea", ".vscode", "coverage", "vendor", ".iv",
]);

const MAX_FILES = 50_000;
const MAX_FILE_BYTES = 1_000_000;

/** Lists files under `root` as POSIX paths relative to it, skipping ignored folders. */
export function walkFiles(root: string): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0 && files.length < MAX_FILES) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) stack.push(full);
      } else if (entry.isFile()) {
        files.push(toPosix(relative(root, full)));
      }
    }
  }
  return files.sort();
}

export function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/** Reads a text file, or returns null for missing, huge or binary files. */
export function readText(path: string): string | null {
  try {
    if (statSync(path).size > MAX_FILE_BYTES) return null;
    const text = readFileSync(path, "utf8");
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

/** 1-based line number of a character offset. */
export function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}
