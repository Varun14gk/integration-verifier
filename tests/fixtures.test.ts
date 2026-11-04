// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

// Checks that every fixture's expected.json still points at the code it describes,
// so later PRs can trust it as ground truth.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CATEGORIES, loadConfig, SEVERITIES } from "@integration-verifier/core";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const EXPECTED_FIXTURES = ["angular-spring", "nextjs-express", "react-fastapi", "schema-first"];

interface Location {
  file: string;
  line: number;
  contains: string;
}

function lineAt(fixture: string, loc: Location): string {
  const path = join(FIXTURES, fixture, loc.file);
  expect(existsSync(path), `${fixture}/${loc.file} exists`).toBe(true);
  return readFileSync(path, "utf8").split(/\r?\n/)[loc.line - 1] ?? "";
}

function expectLocation(fixture: string, loc: Location): void {
  expect(lineAt(fixture, loc), `${fixture}/${loc.file}:${loc.line}`).toContain(loc.contains);
}

const fixtureDirs = readdirSync(FIXTURES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

it("has the expected fixtures", () => {
  expect(fixtureDirs).toEqual(EXPECTED_FIXTURES);
});

describe.each(fixtureDirs)("fixture %s", (fixture) => {
  const expected = JSON.parse(readFileSync(join(FIXTURES, fixture, "expected.json"), "utf8"));

  it("names itself correctly", () => {
    expect(expected.fixture).toBe(fixture);
  });

  it("has a valid .iv/config.yaml", () => {
    const loaded = loadConfig(join(FIXTURES, fixture));
    expect(loaded.ok && loaded.source).toBeTruthy();
  });

  it("plants both integration breaks and leaks", () => {
    const phases = new Set(expected.planted.map((p: { phase: number }) => p.phase));
    expect(phases).toEqual(new Set([1, 2]));
  });

  it("has unique planted ids", () => {
    const ids = expected.planted.map((p: { id: string }) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(expected.planted.map((p: { id: string }) => [p.id, p]))("%s points at real code", (_id, planted) => {
    const p = planted as { category: string; severity: string; evidence: Location; related?: Location[] };
    expect(CATEGORIES).toContain(p.category);
    expect(SEVERITIES).toContain(p.severity);
    expectLocation(fixture, p.evidence);
    for (const r of p.related ?? []) expectLocation(fixture, r);
  });

  it("connected edges and must-not-report entries point at real code", () => {
    for (const c of expected.connected) {
      expectLocation(fixture, c.frontend);
      expectLocation(fixture, c.backend);
    }
    for (const m of expected.mustNotReport) {
      expect(CATEGORIES).toContain(m.category);
      expectLocation(fixture, m.evidence);
    }
  });

  it("detection ground truth names folders that exist", () => {
    expect(existsSync(join(FIXTURES, fixture, expected.stack.frontend.dir))).toBe(true);
    expect(existsSync(join(FIXTURES, fixture, expected.stack.backend.dir))).toBe(true);
  });
});
