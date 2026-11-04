// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMap, detectStack } from "@integration-verifier/core";
import { openApiRoutes } from "../src/map/server-openapi.js";
import { classifySources, gqlTemplates, graphqlMap } from "../src/map/graphql.js";
import { parseProto } from "../src/map/grpc.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures");

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "iv-schemas-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe("schema-first fixture (unsupported backend language)", () => {
  it("reports the Scala backend as unsupported but still maps it from its schemas", async () => {
    const root = join(FIXTURES, "schema-first");
    const stack = detectStack([root]);
    expect(stack.unsupported).toContainEqual(expect.objectContaining({ dir: "backend", reason: expect.stringContaining("Scala") }));
    const map = await buildMap(root, { stack });
    expect(new Set(map.routes.map((r) => r.framework))).toEqual(new Set(["openapi", "graphql", "grpc"]));
    expect(map.stats.connected).toBe(6);
  });
});

describe("OpenAPI", () => {
  it("reads Swagger 2.0 basePath, $ref, allOf and required fields", () => {
    const spec = `swagger: "2.0"
basePath: /v2
paths:
  /pets:
    post:
      parameters:
        - in: body
          name: body
          schema: { $ref: "#/definitions/NewPet" }
        - { in: query, name: dryRun, required: true, type: boolean }
      responses:
        200:
          schema: { type: array, items: { $ref: "#/definitions/Pet" } }
definitions:
  Base:
    properties: { id: { type: string } }
    required: [id]
  NewPet:
    required: [name]
    properties: { name: { type: string }, tag: { type: string } }
  Pet:
    allOf:
      - $ref: "#/definitions/Base"
      - properties: { name: { type: string } }
`;
    const [r] = openApiRoutes(spec, ".", "api.yaml");
    expect(r).toMatchObject({ method: "POST", path: "/v2/pets", framework: "openapi" });
    expect(r!.query.params).toEqual([{ name: "dryRun", required: true }]);
    expect(r!.body).toMatchObject({ known: true, names: ["name", "tag"], required: ["name"], source: "NewPet" });
    expect(r!.response).toMatchObject({ known: true, isArray: true });
    expect(new Set(r!.response!.names)).toEqual(new Set(["id", "name"]));
  });

  it("ignores YAML that is not an API spec, and code routes take precedence over spec routes", async () => {
    expect(openApiRoutes("name: not-a-spec\n", ".", "x.yaml")).toEqual([]);
    const root = project({
      "api/package.json": JSON.stringify({ dependencies: { express: "4" } }),
      "api/server.js": 'const express = require("express");\nconst app = express();\napp.get("/items", (req, res) => res.json([]));\n',
      "api/openapi.json": JSON.stringify({ openapi: "3.0.0", paths: { "/items": { get: { responses: {} } }, "/extra": { get: { responses: {} } } } }),
    });
    const routes = (await buildMap(root)).routes.map((r) => `${r.framework} ${r.method} ${r.path}`).sort();
    expect(routes).toEqual(["express GET /items", "openapi GET /extra"]);
  });
});

describe("GraphQL", () => {
  const schema = [{ file: "s.graphql", unit: ".", line: 1, text: "type Query { me: User }\ntype User { id: ID!\n name: String }" }];

  it("validates operations with fragments defined in other files", () => {
    const ops = [
      ...gqlTemplates("const Q = gql`query Me { me { ...UserBits } }`;", "web", "a.ts"),
      ...gqlTemplates("const F = gql`\nfragment UserBits on User {\n  id\n  nickname\n}`;", "web", "b.ts"),
    ];
    const { operations } = classifySources(ops);
    const out = graphqlMap(schema, operations);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ category: "mismatched", evidence: [{ file: "b.ts", line: 4 }] });
  });

  it("separates schema documents from operations and reports an invalid schema as skipped", () => {
    const { schema: s, operations } = classifySources([...schema, { file: "o.graphql", unit: ".", line: 1, text: "query { me { id } }" }]);
    expect([s.length, operations.length]).toEqual([1, 1]);
    expect(graphqlMap(s, operations).edges.map((e) => e.status)).toEqual(["connected"]);
    const bad = graphqlMap([{ file: "s.graphql", unit: ".", line: 1, text: "type Query { me: Missing }" }], operations);
    expect(bad.skipped).toMatch(/schema could not be built/);
  });
});

describe("gRPC", () => {
  it("parses services and rpcs with their HTTP paths, ignoring comments", () => {
    const rpcs = parseProto("syntax = \"proto3\";\npackage a.b;\n// rpc Fake(X) returns (Y);\nservice S {\n  rpc Get(R) returns (R);\n  /* rpc Old(R) returns (R); */\n  rpc List(R) returns (stream R);\n}\n");
    expect(rpcs.map((r) => [r.path, r.line])).toEqual([["/a.b.S/Get", 5], ["/a.b.S/List", 7]]);
  });
});
