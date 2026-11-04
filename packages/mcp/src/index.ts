#!/usr/bin/env node
// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

export { createServer } from "./server.js";

/** Serves the tools over stdio, the transport harnesses use for local servers. */
export async function serveStdio(root = process.cwd()): Promise<void> {
  await createServer(root).connect(new StdioServerTransport());
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) await serveStdio(process.env.IV_ROOT ?? process.cwd());
