// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyFieldName, CONFIG_TEMPLATE, ConfigSchema, loadConfig, parseConfig } from "@integration-verifier/core";

function projectWithConfig(text: string): string {
  const root = mkdtempSync(join(tmpdir(), "iv-config-"));
  mkdirSync(join(root, ".iv"));
  writeFileSync(join(root, ".iv", "config.yaml"), text);
  return root;
}

describe("loadConfig", () => {
  it("uses defaults when there is no config file", () => {
    const result = loadConfig(mkdtempSync(join(tmpdir(), "iv-empty-")));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBeNull();
    expect(result.config.gate.failOn).toBe("high");
    expect(result.config.scanner.engine).toBe("auto");
    expect(result.config.dismissals).toEqual([]);
  });

  it("reads a valid config", () => {
    const root = projectWithConfig("outbound:\n  allowlist: [api.example.com]\ngate:\n  failOn: medium\n");
    const result = loadConfig(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.outbound.allowlist).toEqual(["api.example.com"]);
    expect(result.config.gate.failOn).toBe("medium");
  });

  it("rejects unknown keys with their path", () => {
    const result = parseConfig("gate:\n  failOn: high\n  failOnn: low\n", "test.yaml");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe("gate");
  });

  it("rejects a bad severity", () => {
    const result = parseConfig("gate:\n  failOn: urgent\n", "test.yaml");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe("gate.failOn");
  });

  it("reports YAML syntax errors with a line number", () => {
    const result = parseConfig("outbound:\n  allowlist: [a, b\n", "test.yaml");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.line).toBeGreaterThan(0);
  });

  it("requires a reason for every dismissal", () => {
    const result = parseConfig("dismissals:\n  - findingId: x\n", "test.yaml");
    expect(result.ok).toBe(false);
  });

  it("accepts the template written by `iv config init`", () => {
    expect(parseConfig(CONFIG_TEMPLATE, "template").ok).toBe(true);
  });
});

describe("classifyFieldName", () => {
  const config = ConfigSchema.parse({});

  it.each([
    ["password", "credential"],
    ["password_hash", "credential"],
    ["accessToken", "credential"],
    ["api_key", "credential"],
    ["email", "contact"],
    ["customerEmail", "contact"],
    ["nationalId", "government-id"],
    ["passport", "government-id"],
    ["cardNumber", "payment"],
  ])("%s is %s", (name, kind) => {
    expect(classifyFieldName(name, config)).toBe(kind);
  });

  it.each(["name", "title", "author", "compass", "tokenizer", "supplierCost", "id"])("%s is not sensitive", (name) => {
    expect(classifyFieldName(name, config)).toBeNull();
  });

  it("applies user patterns and ignores", () => {
    const custom = ConfigSchema.parse({ sensitive: { patterns: { health: ["diagnosis"] }, ignore: ["email"] } });
    expect(classifyFieldName("diagnosis", custom)).toBe("health");
    expect(classifyFieldName("email", custom)).toBeNull();
  });
});
