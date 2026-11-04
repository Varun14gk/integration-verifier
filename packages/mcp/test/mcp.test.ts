// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@integration-verifier/core";
import { createServer } from "@integration-verifier/mcp";

const FIXTURES = fileURLToPath(new URL("../../../fixtures", import.meta.url));
const RUNTIME_APP = fileURLToPath(new URL("../../runtime/test/app", import.meta.url));

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

let client: Client;
beforeAll(async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(FIXTURES).connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);
});
afterAll(() => client.close());

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

describe("iv MCP server", () => {
  it("exposes the same commands as the CLI", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["iv_check", "iv_detect", "iv_dismiss", "iv_flow", "iv_map", "iv_report", "iv_runtime", "iv_runtime_plan"]);
    expect(tools.find((t) => t.name === "iv_runtime")!.inputSchema.required).toContain("approvedSteps");
  });

  it("iv_map returns the summary and findings", async () => {
    const r = await call("iv_map", { root: "react-fastapi" });
    expect(r.isError).toBeFalsy();
    expect(r.content[0]!.text).toContain("Integration map: 7 frontend calls");
    const { findings } = JSON.parse(r.content[1]!.text);
    expect(findings.map((f: { suggestedFix?: string }) => f.suggestedFix)).toContain("DELETE /api/users/{user_id}");
  });

  it("iv_check runs the fast mode without the engine", async () => {
    const r = await call("iv_check", { root: "nextjs-express", engine: false, files: ["frontend/next.config.js"] });
    const { findings } = JSON.parse(r.content[1]!.text);
    expect(findings.map((f: { category: string }) => f.category)).toEqual(["not-connected"]);
  });

  it("iv_runtime_plan lists steps and iv_runtime runs only approved ones", async () => {
    const plan = await call("iv_runtime_plan", { root: RUNTIME_APP, mode: "crawl" });
    expect(JSON.parse(plan.content[1]!.text).steps.map((s: { id: string }) => s.id)).toEqual(["start-backend", "browse", "submit-forms"]);
    const run = await call("iv_runtime", { root: RUNTIME_APP, mode: "crawl", approvedSteps: [] });
    expect(run.content[0]!.text).toContain("start-backend: skipped");
    expect(JSON.parse(run.content[1]!.text).findings).toEqual([]);
  }, 60_000);

  it("iv_runtime explains a missing runtime config", async () => {
    const r = await call("iv_runtime_plan", { root: "react-fastapi" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("No runtime section");
  });

  it("iv_dismiss records the user's reason in config", async () => {
    const root = mkdtempSync(join(tmpdir(), "iv-mcp-"));
    mkdirSync(join(root, ".iv"));
    writeFileSync(join(root, ".iv", "config.yaml"), "# keep me\nversion: 1\n");
    const r = await call("iv_dismiss", { root, findingId: "orphan:api/x.py:3", reason: "called by the mobile app", by: "varun" });
    expect(r.isError).toBeFalsy();
    const text = readFileSync(join(root, ".iv", "config.yaml"), "utf8");
    expect(text).toContain("# keep me");
    const loaded = loadConfig(root);
    expect(loaded.ok && loaded.config.dismissals[0]).toMatchObject({ findingId: "orphan:api/x.py:3", reason: "called by the mobile app", by: "varun" });
    await call("iv_dismiss", { root, findingId: "orphan:api/x.py:3", reason: "still used by mobile" });
    const again = loadConfig(root);
    expect(again.ok && again.config.dismissals.map((d) => d.reason)).toEqual(["still used by mobile"]);
  });
});

describe("stdio transport", () => {
  it("serves tools over stdio from the built entry point", async () => {
    const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
    const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: { ...process.env, IV_ROOT: FIXTURES } as Record<string, string> });
    const c = new Client({ name: "stdio-test", version: "0" });
    await c.connect(transport);
    try {
      const r = (await c.callTool({ name: "iv_detect", arguments: { root: "angular-spring" } })) as ToolResult;
      expect(r.content[0]!.text).toContain("spring-boot");
    } finally {
      await c.close();
    }
  }, 60_000);
});
