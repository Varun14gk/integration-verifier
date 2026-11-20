#!/usr/bin/env node
// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

export { createServer } from "./server.js";

/**
 * The project the tools act on when a call gives no `root`: the agent's project
 * directory (Claude Code exports CLAUDE_PROJECT_DIR to MCP servers), else the
 * directory the server was started in.
 */
export function defaultMcpRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.IV_ROOT || env.CLAUDE_PROJECT_DIR || env.GEMINI_PROJECT_DIR || process.cwd();
}

/** Serves the tools over stdio, the transport harnesses use for local servers. */
export async function serveStdio(root = defaultMcpRoot()): Promise<void> {
  await createServer(root).connect(new StdioServerTransport());
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) await serveStdio();
