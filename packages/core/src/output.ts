// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IV_DIR } from "./config.js";
import { OUTPUT_SCHEMA_VERSION, TOOL_NAME, VERSION } from "./version.js";

/** Every `.iv/*.json` file is wrapped in this envelope. */
export interface OutputEnvelope<T> {
  tool: typeof TOOL_NAME;
  toolVersion: string;
  schemaVersion: number;
  kind: string;
  generatedAt: string;
  data: T;
}

export function envelope<T>(kind: string, data: T, now: Date = new Date()): OutputEnvelope<T> {
  return {
    tool: TOOL_NAME,
    toolVersion: VERSION,
    schemaVersion: OUTPUT_SCHEMA_VERSION,
    kind,
    generatedAt: now.toISOString(),
    data,
  };
}

/**
 * Writes `<root>/.iv/<kind>.json` and returns its path. This is the only place
 * the tool writes inside the user's project, and only under `.iv/`.
 */
export function writeOutput<T>(root: string, kind: string, data: T): string {
  if (!/^[a-z][a-z0-9-]*$/.test(kind)) throw new Error(`invalid output kind: ${kind}`);
  const dir = join(root, IV_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${kind}.json`);
  writeFileSync(path, JSON.stringify(envelope(kind, data), null, 2) + "\n", "utf8");
  return path;
}
