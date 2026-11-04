// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMap, FindingSchema, normalizePath, pathSimilarity, type MapReport } from "@integration-verifier/core";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures");
const PHASE1 = new Set(["not-connected", "mismatched", "unverifiable", "orphan"]);

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "iv-map-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function where(f: { evidence: { kind: string; file?: string; line?: number }[] }): string {
  const e = f.evidence[0]!;
  return `${e.file}:${e.line}`;
}

describe.each(["react-fastapi", "angular-spring", "nextjs-express", "schema-first"])("fixture %s", (fixture) => {
  const expected = JSON.parse(readFileSync(join(FIXTURES, fixture, "expected.json"), "utf8"));
  let map: MapReport;
  const load = async () => (map ??= await buildMap(join(FIXTURES, fixture)));

  it("reports exactly the planted integration problems", async () => {
    await load();
    const planted = expected.planted.filter((p: { phase: number }) => p.phase === 1);
    const want = planted.map((p: { category: string; severity: string; evidence: { file: string; line: number } }) => `${p.category} ${p.severity} ${p.evidence.file}:${p.evidence.line}`).sort();
    const got = map.findings.filter((f) => PHASE1.has(f.category)).map((f) => `${f.category} ${f.severity} ${where(f)}`).sort();
    expect(got).toEqual(want);
  });

  it("suggests the intended route for planted breaks", async () => {
    await load();
    for (const p of expected.planted.filter((x: { suggestion?: string }) => x.suggestion && /^(GET|POST|PUT|PATCH|DELETE) \//.test(x.suggestion))) {
      const f = map.findings.find((x) => where(x) === `${p.evidence.file}:${p.evidence.line}`);
      expect(f?.suggestedFix, p.id).toBe(p.suggestion);
    }
    for (const p of expected.planted.filter((x: { suggestion?: string }) => x.suggestion?.startsWith("destination:"))) {
      const f = map.findings.find((x) => where(x) === `${p.evidence.file}:${p.evidence.line}`);
      expect(f?.suggestedFix, p.id).toBe(p.suggestion);
    }
  });

  it("marks the expected edges as connected", async () => {
    await load();
    for (const c of expected.connected) {
      const call = map.calls.find((x) => x.file === c.frontend.file && x.line === c.frontend.line);
      expect(call, `call at ${c.frontend.file}:${c.frontend.line}`).toBeDefined();
      const edge = map.edges.find((e) => e.call === call!.id)!;
      expect(edge.status).toBe("connected");
      const route = map.routes.find((r) => r.id === edge.route)!;
      expect(`${route.file}:${route.line}`).toBe(`${c.backend.file}:${c.backend.line}`);
      expect(route.method).toBe(c.method);
    }
  });

  it("does not report the must-not-report cases", async () => {
    await load();
    for (const m of expected.mustNotReport.filter((x: { category: string }) => PHASE1.has(x.category))) {
      expect(map.findings.some((f) => f.category === m.category && where(f) === `${m.evidence.file}:${m.evidence.line}`), m.reason).toBe(false);
    }
  });

  it("produces schema-valid findings with evidence", async () => {
    await load();
    for (const f of map.findings) expect(FindingSchema.safeParse(f).success, f.id).toBe(true);
  });
});

describe("paths", () => {
  it("normalises every framework's param syntax to the same key", () => {
    for (const p of ["/api/users/{user_id}", "/api/users/:id", "/api/users/<int:pk>", "/api/users/{id:int}", "api/users/[id]/", "http://localhost:8000/api/users/{id}?x=1"]) {
      expect(normalizePath(p).key).toBe("/api/users/{}");
    }
  });

  it("scores singular/plural near-misses above unrelated paths", () => {
    const a = normalizePath("/api/user/{}").segments;
    expect(pathSimilarity(a, normalizePath("/api/users/{}").segments)).toBeGreaterThan(0.9);
    expect(pathSimilarity(a, normalizePath("/api/orders/{}").segments)).toBeLessThan(0.8);
  });
});

describe("extractors", () => {
  it("joins axios baseURL, NestJS controllers and DTO validation", async () => {
    const root = project({
      "web/package.json": JSON.stringify({ dependencies: { react: "18", axios: "1" } }),
      "web/src/api.ts": `import axios from "axios";
const http = axios.create({ baseURL: "/api/v1" });
interface NewCat { name: string; age: number }
export const addCat = (cat: NewCat) => http.post("/cats", cat);
export const getCat = (id: string) => http.get(\`/cats/\${id}\`);
`,
      "api/package.json": JSON.stringify({ dependencies: { "@nestjs/core": "10", "class-validator": "0.14" } }),
      "api/src/main.ts": `app.setGlobalPrefix("api/v1");\n`,
      "api/src/cats.controller.ts": `import { IsString, IsInt } from "class-validator";
export class CreateCatDto { @IsString() name: string; @IsInt() age: number; }
@Controller("cats")
export class CatsController {
  @Post()
  create(@Body() dto: CreateCatDto) {}
  @Get(":id")
  findOne(@Param("id") id: string) {}
}
`,
    });
    const map = await buildMap(root);
    expect(map.stats.connected).toBe(2);
    expect(map.routes.find((r) => r.method === "POST")!.validated).toBe(true);
    expect(map.findings).toEqual([]);
  });

  it("follows Express router mounts across files", async () => {
    const root = project({
      "web/package.json": JSON.stringify({ dependencies: { vue: "3" } }),
      "web/src/a.js": `fetch("/api/items/" + itemId, { method: "DELETE" });\n`,
      "srv/package.json": JSON.stringify({ dependencies: { express: "4" } }),
      "srv/app.js": `const express = require("express");\nconst items = require("./routes/items");\nconst app = express();\napp.use("/api/items", items);\n`,
      "srv/routes/items.js": `const router = require("express").Router();\nrouter.delete("/:id", (req, res) => res.json({ ok: true }));\nmodule.exports = router;\n`,
    });
    const map = await buildMap(root);
    expect(map.routes.map((r) => `${r.method} ${r.path}`)).toEqual(["DELETE /api/items/:id"]);
    expect(map.stats.connected).toBe(1);
  });

  it("extracts Flask, Django, ASP.NET Core and gin routes", async () => {
    const root = project({
      "flask/requirements.txt": "flask\n",
      "flask/app.py": `from flask import Flask, Blueprint\nbp = Blueprint("u", __name__, url_prefix="/api/u")\n@bp.route("/<int:uid>", methods=["GET", "DELETE"])\ndef user(uid):\n    pass\n`,
      "dj/requirements.txt": "django\n",
      "dj/shop/urls.py": `from django.urls import path\nurlpatterns = [path("api/shop/<int:pk>/", views.detail)]\n`,
      "net/Api.csproj": `<Project Sdk="Microsoft.NET.Sdk.Web"></Project>`,
      "net/UsersController.cs": `[ApiController]\n[Route("api/[controller]")]\npublic class UsersController : ControllerBase {\n  [HttpGet("{id}")]\n  public ActionResult<UserDto> Get(int id) => null;\n}\napp.MapPost("/api/ping", () => "ok");\n`,
      "go/go.mod": "module x\nrequire github.com/gin-gonic/gin v1.10.0\n",
      "go/main.go": `package main\nfunc main() {\n  r := gin.Default()\n  v1 := r.Group("/api/v1")\n  v1.GET("/things/:id", h)\n}\n`,
    });
    const routes = (await buildMap(root)).routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(routes).toEqual([
      "* /api/shop/<int:pk>",
      "DELETE /api/u/<int:uid>",
      "GET /api/u/<int:uid>",
      "GET /api/users/{id}",
      "GET /api/v1/things/:id",
      "POST /api/ping",
    ]);
  });

  it("reports unsupported backends as skipped instead of guessing", async () => {
    const root = project({ "api/package.json": JSON.stringify({ dependencies: { fastify: "4" } }) });
    const map = await buildMap(root);
    expect(map.skipped).toEqual([{ unit: "api", reason: "route extraction for fastify is not supported yet" }]);
  });
});
