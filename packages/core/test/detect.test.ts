// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectStack, formatStackSummary, type StackReport } from "@integration-verifier/core";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures");

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "iv-detect-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function unit(report: StackReport, dir: string) {
  const u = report.units.find((x) => x.dir === dir);
  expect(u, `unit ${dir}`).toBeDefined();
  return u!;
}

describe.each(["react-fastapi", "angular-spring", "nextjs-express"])("fixture %s matches expected.json", (fixture) => {
  const expected = JSON.parse(readFileSync(join(FIXTURES, fixture, "expected.json"), "utf8")).stack;
  const report = detectStack([join(FIXTURES, fixture)]);

  it("frontend", () => {
    const fe = unit(report, expected.frontend.dir);
    expect(fe.role).toBe("frontend");
    expect(fe.language).toBe(expected.frontend.language);
    expect(fe.framework).toBe(expected.frontend.framework);
    expect(fe.httpClient).toBe(expected.frontend.httpClient);
    expect(fe.packageManager).toBe(expected.frontend.packageManager);
    if (expected.frontend.bundler) expect(fe.bundler).toBe(expected.frontend.bundler);
  });

  it("backend", () => {
    const be = unit(report, expected.backend.dir);
    expect(be.role).toBe("backend");
    expect(be.language).toBe(expected.backend.language);
    expect(be.framework).toBe(expected.backend.framework);
    expect(be.schema).toBe(expected.backend.schema);
    expect(be.packageManager).toBe(expected.backend.packageManager);
    expect(be.httpClient).toBeNull();
  });

  it("data stores", () => {
    const stores = report.units.flatMap((u) => u.dataStores.map((d) => d.name));
    expect(new Set(stores)).toEqual(new Set(expected.dataStores));
  });

  it("outbound hosts", () => {
    expect(new Set(report.outbound.map((o) => o.host))).toEqual(new Set(expected.outbound));
  });

  it("joins", () => {
    for (const j of expected.joins) {
      const found = report.joins.find((d) => d.kind === j.kind && d.file === j.file && (j.name ? d.name === j.name : d.from === j.from && d.to === j.to));
      expect(found, JSON.stringify(j)).toBeDefined();
    }
  });

  it("every detection carries evidence with a file", () => {
    for (const u of report.units) {
      for (const d of [...u.frameworks, ...u.httpClients, ...u.schemaSources, ...u.dataStores]) {
        expect(d.evidence.length).toBeGreaterThan(0);
        expect(d.evidence[0]!.file).toMatch(/\S/);
      }
    }
  });

  it("has nothing unsupported or low-confidence", () => {
    expect(report.unsupported).toEqual([]);
    expect(report.lowConfidence).toEqual([]);
  });

  it("prints a summary", () => {
    const text = formatStackSummary(report);
    expect(text).toContain(expected.frontend.framework);
    expect(text).toContain(expected.backend.framework);
  });
});

describe("detectStack", () => {
  it("reports unsupported ecosystems instead of guessing", () => {
    const root = project({ "api/Gemfile": "gem 'rails'\n", "web/package.json": JSON.stringify({ dependencies: { fastify: "4" } }) });
    const report = detectStack([root]);
    expect(report.unsupported.map((u) => u.dir).sort()).toEqual(["api", "web"]);
    expect(report.unsupported.find((u) => u.dir === "api")!.reason).toContain("Ruby");
  });

  it("combines separate frontend and backend repos", () => {
    const fe = project({ "package.json": JSON.stringify({ dependencies: { vue: "3", axios: "1" } }), "src/api.js": "axios.get('/api/x')\n" });
    const be = project({ "requirements.txt": "Flask==3.0\n", "app.py": "from flask import Flask\n" });
    const report = detectStack([fe, be]);
    expect(report.units).toHaveLength(2);
    expect(report.units[0]!.dir).toBe(".");
    expect(report.units[0]!.framework).toBe("vue");
    expect(report.units[1]!.dir.startsWith("..")).toBe(true);
    expect(report.units[1]!.framework).toBe("flask");
    expect(report.units[1]!.language).toBe("python");
  });

  it("detects NestJS, Django REST framework, Go gin and ASP.NET Core", () => {
    const root = project({
      "nest/package.json": JSON.stringify({ dependencies: { "@nestjs/core": "10", "class-validator": "0.14" } }),
      "drf/requirements.txt": "Django>=5\ndjangorestframework>=3.15\n",
      "gin/go.mod": "module x\n\nrequire github.com/gin-gonic/gin v1.10.0\n",
      "dotnet/Api.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>\n',
    });
    const report = detectStack([root]);
    expect(unit(report, "nest").framework).toBe("nestjs");
    expect(unit(report, "nest").schema).toBe("class-validator");
    expect(unit(report, "drf").framework).toBe("django-rest-framework");
    expect(unit(report, "gin").framework).toBe("gin");
    expect(unit(report, "gin").packageManager).toBe("go");
    expect(unit(report, "dotnet").framework).toBe("aspnet-core");
    for (const d of ["nest", "drf", "gin", "dotnet"]) expect(unit(report, d).role).toBe("backend");
  });

  it("detects GraphQL, gRPC and OpenAPI files", () => {
    const root = project({
      "web/package.json": JSON.stringify({ dependencies: { react: "18", "@apollo/client": "3" } }),
      "svc/requirements.txt": "grpcio\n",
      "svc/api.proto": 'syntax = "proto3";\n',
      "docs/openapi.yaml": "openapi: 3.1.0\n",
    });
    const report = detectStack([root]);
    const styles = report.apiStyles.map((s) => s.name);
    expect(styles).toContain("graphql");
    expect(styles).toContain("grpc");
    expect(report.openapi.files).toEqual(["docs/openapi.yaml"]);
    expect(unit(report, "web").httpClient).toBe("apollo-client");
  });

  it("reads lockfiles for the package manager and CRA proxy settings", () => {
    const root = project({
      "package.json": JSON.stringify({ dependencies: { react: "18" }, proxy: "http://localhost:5000" }),
      "pnpm-lock.yaml": "",
    });
    const report = detectStack([root]);
    expect(report.units[0]!.packageManager).toBe("pnpm");
    expect(report.joins).toContainEqual(expect.objectContaining({ kind: "package-proxy", to: "http://localhost:5000" }));
  });

  it("ignores node_modules and URLs in comments", () => {
    const root = project({
      "package.json": JSON.stringify({ dependencies: { express: "4" } }),
      "node_modules/x/package.json": JSON.stringify({ dependencies: { next: "14" } }),
      "server.js": "// see https://docs.example.org/guide\nfetch('https://api.real.example/v1')\n",
    });
    const report = detectStack([root]);
    expect(report.units).toHaveLength(1);
    expect(report.outbound.map((o) => o.host)).toEqual(["api.real.example"]);
    expect(report.outbound[0]!.line).toBe(2);
  });

  it("marks Next.js with API routes as fullstack", () => {
    const root = project({
      "package.json": JSON.stringify({ dependencies: { next: "14", react: "18" } }),
      "app/api/users/route.ts": "export async function GET() {}\n",
    });
    expect(detectStack([root]).units[0]!.role).toBe("fullstack");
  });
});
