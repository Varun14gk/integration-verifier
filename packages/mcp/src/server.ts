// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  addDismissal, buildFlow, buildMap, detectStack, formatCheckSummary, formatFlowSummary, formatMapSummary, formatStackSummary,
  indexUi, IV_DIR, loadConfig, runCheck, toMarkdown, toSarif, VERSION, writeOutput, type Config, type Finding,
} from "@integration-verifier/core";
import { planSteps, runRuntime, RuntimeConfigError, type StepId } from "@integration-verifier/runtime";

const MAX_FINDINGS_IN_REPLY = 100;
const STEP_IDS = ["start-backend", "start-frontend", "browse", "submit-forms", "run-playwright-tests", "schemathesis"] as const;

const rootArg = { root: z.string().optional().describe("Project root (default: the server's working directory)") };
const alsoArg = { also: z.array(z.string()).optional().describe("Extra roots, e.g. a backend in a separate repository") };

type Reply = { content: { type: "text"; text: string }[]; isError?: boolean };

function text(...parts: string[]): Reply {
  return { content: parts.filter(Boolean).map((t) => ({ type: "text" as const, text: t })) };
}

function error(message: string): Reply {
  return { ...text(message), isError: true };
}

function findingsJson(findings: Finding[]): string {
  const shown = findings.slice(0, MAX_FINDINGS_IN_REPLY);
  return JSON.stringify({ findings: shown, ...(findings.length > shown.length ? { truncated: findings.length - shown.length } : {}) }, null, 1);
}

function configFor(root: string): Config | string {
  const loaded = loadConfig(root);
  return loaded.ok ? loaded.config : `Invalid ${loaded.source}: ${loaded.issues.map((i) => `${i.path || "(root)"}: ${i.message}`).join("; ")}`;
}

/**
 * The Integration Verifier MCP server. Every tool reports; none edits the
 * user's application code. Only `.iv/` is written.
 */
export function createServer(defaultRoot = process.cwd()): McpServer {
  const server = new McpServer({ name: "integration-verifier", version: VERSION });
  const rootOf = (r?: string) => resolve(defaultRoot, r ?? ".");

  server.registerTool(
    "iv_detect",
    {
      title: "Detect stack",
      description: "Identify the project's frontends, backends, frameworks, HTTP clients, API style, joins (base URLs, proxies, rewrites), data stores and outbound hosts. Writes .iv/stack.json.",
      inputSchema: { ...rootArg, ...alsoArg },
    },
    async ({ root, also }) => {
      const r = rootOf(root);
      const stack = detectStack([r, ...(also ?? []).map((d) => resolve(r, d))]);
      writeOutput(r, "stack", stack);
      return text(formatStackSummary(stack), JSON.stringify({ units: stack.units.map((u) => ({ dir: u.dir, role: u.role, framework: u.framework, httpClient: u.httpClient, schema: u.schema })), joins: stack.joins, unsupported: stack.unsupported }));
    },
  );

  server.registerTool(
    "iv_map",
    {
      title: "Integration map",
      description: "Map every frontend call to the backend route it reaches, and classify each as connected, not connected, mismatched (method/params/fields), unverifiable or orphan, with ranked suggestions. Suggestions are for the coder to decide; nothing is changed. Writes .iv/map.json.",
      inputSchema: { ...rootArg, ...alsoArg },
    },
    async ({ root, also }) => {
      const r = rootOf(root);
      const stack = detectStack([r, ...(also ?? []).map((d) => resolve(r, d))]);
      const map = await buildMap(r, { stack });
      writeOutput(r, "stack", stack);
      writeOutput(r, "map", map);
      return text(formatMapSummary(map), findingsJson(map.findings));
    },
  );

  server.registerTool(
    "iv_flow",
    {
      title: "Data flow",
      description: "Trace request fields (form input -> body -> backend model -> store/outbound) and response fields (model -> UI usage) for every call. Writes .iv/flow.json.",
      inputSchema: { ...rootArg },
    },
    async ({ root }) => {
      const r = rootOf(root);
      const config = configFor(r);
      if (typeof config === "string") return error(config);
      const stack = detectStack([r]);
      const map = await buildMap(r, { stack });
      const flow = buildFlow(map, indexUi(r, stack), config);
      writeOutput(r, "flow", flow);
      return text(formatFlowSummary(flow));
    },
  );

  server.registerTool(
    "iv_check",
    {
      title: "Check integration and leaks",
      description: "Run the integration map plus all leak checks (over-exposure, sensitive values in logs/URLs/storage/errors, insecure cookies, hardcoded secrets, outbound hosts, validation, logging) and apply the gate. Pass `files` for a fast check of changed files. Writes .iv/check.json.",
      inputSchema: {
        ...rootArg,
        ...alsoArg,
        files: z.array(z.string()).optional().describe("Only report findings in these files"),
        engine: z.boolean().optional().describe("Use the installed Opengrep/Semgrep (default true; false is faster)"),
      },
    },
    async ({ root, also, files, engine }) => {
      const r = rootOf(root);
      const config = configFor(r);
      if (typeof config === "string") return error(config);
      const out = await runCheck(r, config, { ...(also ? { also } : {}), ...(files ? { files } : {}), ...(engine === false ? { engine: null } : {}) });
      writeOutput(r, "stack", out.stack);
      writeOutput(r, "map", out.map);
      writeOutput(r, "flow", out.flow);
      writeOutput(r, "check", out.report);
      return text(formatCheckSummary(out.report), findingsJson(out.report.gate.open));
    },
  );

  server.registerTool(
    "iv_report",
    {
      title: "Write reports",
      description: "Run the checks and write .iv/report.md (for humans) and .iv/report.sarif (for code scanning).",
      inputSchema: { ...rootArg, engine: z.boolean().optional() },
    },
    async ({ root, engine }) => {
      const r = rootOf(root);
      const config = configFor(r);
      if (typeof config === "string") return error(config);
      const { report } = await runCheck(r, config, engine === false ? { engine: null } : {});
      writeOutput(r, "check", report);
      mkdirSync(join(r, IV_DIR), { recursive: true });
      writeFileSync(join(r, IV_DIR, "report.md"), toMarkdown(report), "utf8");
      writeFileSync(join(r, IV_DIR, "report.sarif"), JSON.stringify(toSarif(report), null, 2) + "\n", "utf8");
      return text(`Wrote ${join(r, IV_DIR, "report.md")} and ${join(r, IV_DIR, "report.sarif")}.`, formatCheckSummary(report));
    },
  );

  const runtimeArgs = {
    ...rootArg,
    mode: z.enum(["auto", "crawl", "tests"]).optional().describe("Existing Playwright tests, a crawl, or automatic"),
    start: z.boolean().optional().describe("false when the app is already running"),
    schemathesis: z.boolean().optional(),
  };

  server.registerTool(
    "iv_runtime_plan",
    {
      title: "Plan runtime verification",
      description: "List the steps `iv_runtime` would take (starting processes, opening a browser, submitting forms, ...). Show these to the user and ask which to allow BEFORE calling iv_runtime. Runs nothing.",
      inputSchema: runtimeArgs,
    },
    async ({ root, mode, start, schemathesis }) => {
      const r = rootOf(root);
      const config = configFor(r);
      if (typeof config === "string") return error(config);
      try {
        const steps = planSteps(r, config, { ...(mode ? { mode } : {}), ...(start === false ? { start } : {}), schemathesis: !!schemathesis });
        return text(steps.map((s, i) => `${i + 1}. [${s.id}] ${s.description}`).join("\n"), JSON.stringify({ steps }));
      } catch (e) {
        if (e instanceof RuntimeConfigError) return error(e.message);
        throw e;
      }
    },
  );

  server.registerTool(
    "iv_runtime",
    {
      title: "Run runtime verification",
      description: "Start the app and drive it with Playwright, then compare real traffic with the map and look for leaked values. Only the steps listed in `approvedSteps` run; get them from iv_runtime_plan and pass ONLY the ones the user explicitly approved. Writes .iv/runtime.json.",
      inputSchema: { ...runtimeArgs, approvedSteps: z.array(z.enum(STEP_IDS)).describe("Step ids the user approved") },
    },
    async ({ root, mode, start, schemathesis, approvedSteps }) => {
      const r = rootOf(root);
      const config = configFor(r);
      if (typeof config === "string") return error(config);
      const allowed = new Set<StepId>(approvedSteps);
      try {
        const { report } = await runRuntime(r, config, {
          ...(mode ? { mode } : {}),
          ...(start === false ? { start } : {}),
          schemathesis: !!schemathesis,
          approve: async (s) => allowed.has(s.id),
        });
        writeOutput(r, "runtime", report);
        const steps = report.steps.map((s) => `${s.id}: ${s.approved ? (s.ok ? "done" : "failed") : "skipped"}${s.note ? ` (${s.note})` : ""}`).join("\n");
        return text(`Runtime (${report.mode}): ${report.requests.length} API requests, ${report.confirmedEdges.length} edges confirmed\n${steps}`, findingsJson(report.gate.open));
      } catch (e) {
        if (e instanceof RuntimeConfigError) return error(e.message);
        throw e;
      }
    },
  );

  server.registerTool(
    "iv_dismiss",
    {
      title: "Dismiss a finding",
      description: "Record that the USER decided a finding is acceptable, with their reason, in .iv/config.yaml. Only call this when the user asked to dismiss it; never to get past the gate on your own.",
      inputSchema: {
        ...rootArg,
        findingId: z.string().describe("The finding id, e.g. hardcoded-secret:src/a.ts:6"),
        reason: z.string().min(3).describe("The user's reason, in their words"),
        by: z.string().optional().describe("Who decided"),
      },
    },
    async ({ root, findingId, reason, by }) => {
      const r = rootOf(root);
      try {
        const path = addDismissal(r, { findingId, reason, ...(by ? { by } : {}) });
        return text(`Dismissed ${findingId} in ${path}. It stays recorded with the reason, and shows under "Dismissed" in reports.`);
      } catch (e) {
        return error((e as Error).message);
      }
    },
  );

  return server;
}
