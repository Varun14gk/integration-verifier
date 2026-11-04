// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FindingSchema, severityAtLeast, writeOutput } from "@integration-verifier/core";

const finding = {
  id: "not-connected:frontend/src/api/users.ts:41",
  category: "not-connected",
  severity: "high",
  evidence: [{ kind: "code", file: "frontend/src/api/users.ts", line: 41 }],
  explanation: "DELETE /api/user/{id} is not exposed by the backend.",
  suggestedFix: "DELETE /api/users/{user_id}",
  confidence: 0.9,
};

describe("FindingSchema", () => {
  it("accepts a complete finding", () => {
    expect(FindingSchema.safeParse(finding).success).toBe(true);
  });

  it("accepts request evidence", () => {
    const runtime = { ...finding, category: "runtime-failed-request", evidence: [{ kind: "request", method: "DELETE", url: "/api/user/1", status: 404 }] };
    expect(FindingSchema.safeParse(runtime).success).toBe(true);
  });

  it("rejects a finding without evidence", () => {
    expect(FindingSchema.safeParse({ ...finding, evidence: [] }).success).toBe(false);
  });

  it("rejects confidence outside 0..1", () => {
    expect(FindingSchema.safeParse({ ...finding, confidence: 1.5 }).success).toBe(false);
  });
});

describe("severityAtLeast", () => {
  it("orders severities", () => {
    expect(severityAtLeast("critical", "high")).toBe(true);
    expect(severityAtLeast("high", "high")).toBe(true);
    expect(severityAtLeast("medium", "high")).toBe(false);
  });
});

describe("writeOutput", () => {
  it("writes an enveloped JSON file under .iv/", () => {
    const root = mkdtempSync(join(tmpdir(), "iv-out-"));
    const path = writeOutput(root, "stack", { hello: "world" });
    expect(path).toBe(join(root, ".iv", "stack.json"));
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.tool).toBe("integration-verifier");
    expect(parsed.kind).toBe("stack");
    expect(parsed.data).toEqual({ hello: "world" });
  });

  it("refuses kinds that could escape .iv/", () => {
    expect(() => writeOutput(tmpdir(), "../evil", {})).toThrow();
  });
});
