// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

/** What a dependency tells us about a unit. */
export interface DepRule {
  kind: "framework" | "httpClient" | "bundler" | "schema" | "dataStore" | "orm" | "apiStyle" | "openapiGen";
  value: string;
  role?: "frontend" | "backend";
  supported?: boolean;
}

/** npm package name -> meaning. Exact names, or prefixes ending in `*`. */
export const NPM_DEPS: Record<string, DepRule[]> = {
  next: [{ kind: "framework", value: "nextjs", role: "frontend" }, { kind: "bundler", value: "next" }],
  "@angular/core": [{ kind: "framework", value: "angular", role: "frontend" }],
  react: [{ kind: "framework", value: "react", role: "frontend" }],
  nuxt: [{ kind: "framework", value: "nuxt", role: "frontend", supported: false }],
  vue: [{ kind: "framework", value: "vue", role: "frontend" }],
  "@sveltejs/kit": [{ kind: "framework", value: "sveltekit", role: "frontend" }],
  svelte: [{ kind: "framework", value: "svelte", role: "frontend" }],
  express: [{ kind: "framework", value: "express", role: "backend" }],
  "@nestjs/core": [{ kind: "framework", value: "nestjs", role: "backend" }],
  fastify: [{ kind: "framework", value: "fastify", role: "backend", supported: false }],
  koa: [{ kind: "framework", value: "koa", role: "backend", supported: false }],
  hono: [{ kind: "framework", value: "hono", role: "backend", supported: false }],
  vite: [{ kind: "bundler", value: "vite" }],
  webpack: [{ kind: "bundler", value: "webpack" }],
  axios: [{ kind: "httpClient", value: "axios" }],
  "@tanstack/react-query": [{ kind: "httpClient", value: "react-query" }],
  "react-query": [{ kind: "httpClient", value: "react-query" }],
  "@reduxjs/toolkit": [{ kind: "httpClient", value: "rtk-query" }],
  "@apollo/client": [{ kind: "httpClient", value: "apollo-client" }, { kind: "apiStyle", value: "graphql" }],
  urql: [{ kind: "httpClient", value: "urql" }, { kind: "apiStyle", value: "graphql" }],
  "graphql-request": [{ kind: "httpClient", value: "graphql-request" }, { kind: "apiStyle", value: "graphql" }],
  "openapi-fetch": [{ kind: "httpClient", value: "openapi-client" }],
  orval: [{ kind: "httpClient", value: "openapi-client" }],
  "@openapitools/openapi-generator-cli": [{ kind: "httpClient", value: "openapi-client" }],
  "@trpc/client": [{ kind: "httpClient", value: "trpc" }, { kind: "apiStyle", value: "trpc" }],
  "@trpc/server": [{ kind: "apiStyle", value: "trpc" }],
  "@apollo/server": [{ kind: "apiStyle", value: "graphql" }],
  "apollo-server": [{ kind: "apiStyle", value: "graphql" }],
  "@grpc/grpc-js": [{ kind: "apiStyle", value: "grpc" }],
  "socket.io": [{ kind: "apiStyle", value: "websocket" }],
  "socket.io-client": [{ kind: "apiStyle", value: "websocket" }],
  ws: [{ kind: "apiStyle", value: "websocket" }],
  zod: [{ kind: "schema", value: "zod" }],
  "class-validator": [{ kind: "schema", value: "class-validator" }],
  joi: [{ kind: "schema", value: "joi" }],
  yup: [{ kind: "schema", value: "yup" }],
  "@nestjs/swagger": [{ kind: "openapiGen", value: "nestjs-swagger" }],
  pg: [{ kind: "dataStore", value: "postgresql" }],
  mysql2: [{ kind: "dataStore", value: "mysql" }],
  mysql: [{ kind: "dataStore", value: "mysql" }],
  sqlite3: [{ kind: "dataStore", value: "sqlite" }],
  "better-sqlite3": [{ kind: "dataStore", value: "sqlite" }],
  mongodb: [{ kind: "dataStore", value: "mongodb" }],
  mongoose: [{ kind: "dataStore", value: "mongodb" }, { kind: "orm", value: "mongoose" }],
  redis: [{ kind: "dataStore", value: "redis" }],
  ioredis: [{ kind: "dataStore", value: "redis" }],
  "@prisma/client": [{ kind: "orm", value: "prisma" }],
  typeorm: [{ kind: "orm", value: "typeorm" }],
  sequelize: [{ kind: "orm", value: "sequelize" }],
  "drizzle-orm": [{ kind: "orm", value: "drizzle" }],
};

/** Python distribution name -> meaning. */
export const PY_DEPS: Record<string, DepRule[]> = {
  fastapi: [{ kind: "framework", value: "fastapi", role: "backend" }, { kind: "schema", value: "pydantic" }, { kind: "openapiGen", value: "fastapi" }],
  flask: [{ kind: "framework", value: "flask", role: "backend" }],
  django: [{ kind: "framework", value: "django", role: "backend" }],
  djangorestframework: [{ kind: "framework", value: "django-rest-framework", role: "backend" }],
  "drf-spectacular": [{ kind: "openapiGen", value: "drf-spectacular" }],
  pydantic: [{ kind: "schema", value: "pydantic" }],
  marshmallow: [{ kind: "schema", value: "marshmallow" }],
  graphene: [{ kind: "apiStyle", value: "graphql" }],
  "strawberry-graphql": [{ kind: "apiStyle", value: "graphql" }],
  grpcio: [{ kind: "apiStyle", value: "grpc" }],
  websockets: [{ kind: "apiStyle", value: "websocket" }],
  sqlalchemy: [{ kind: "orm", value: "sqlalchemy" }],
  psycopg: [{ kind: "dataStore", value: "postgresql" }],
  "psycopg2": [{ kind: "dataStore", value: "postgresql" }],
  "psycopg2-binary": [{ kind: "dataStore", value: "postgresql" }],
  asyncpg: [{ kind: "dataStore", value: "postgresql" }],
  pymysql: [{ kind: "dataStore", value: "mysql" }],
  pymongo: [{ kind: "dataStore", value: "mongodb" }],
  motor: [{ kind: "dataStore", value: "mongodb" }],
  redis: [{ kind: "dataStore", value: "redis" }],
};

/** Substrings of Maven/Gradle files -> meaning. */
export const JVM_DEPS: Record<string, DepRule[]> = {
  "spring-boot-starter-web": [{ kind: "framework", value: "spring-boot", role: "backend" }],
  "spring-boot-starter-webflux": [{ kind: "framework", value: "spring-boot", role: "backend" }],
  "spring-boot-starter-validation": [{ kind: "schema", value: "bean-validation" }],
  "spring-boot-starter-data-jpa": [{ kind: "orm", value: "jpa" }],
  "spring-boot-starter-data-mongodb": [{ kind: "dataStore", value: "mongodb" }],
  "spring-boot-starter-data-redis": [{ kind: "dataStore", value: "redis" }],
  "springdoc-openapi": [{ kind: "openapiGen", value: "springdoc" }],
  "spring-boot-starter-graphql": [{ kind: "apiStyle", value: "graphql" }],
  "grpc-": [{ kind: "apiStyle", value: "grpc" }],
  postgresql: [{ kind: "dataStore", value: "postgresql" }],
  "mysql-connector": [{ kind: "dataStore", value: "mysql" }],
};

/** Go module paths -> meaning. */
export const GO_DEPS: Record<string, DepRule[]> = {
  "github.com/gin-gonic/gin": [{ kind: "framework", value: "gin", role: "backend" }],
  "github.com/labstack/echo": [{ kind: "framework", value: "echo", role: "backend" }],
  "github.com/gofiber/fiber": [{ kind: "framework", value: "fiber", role: "backend", supported: false }],
  "google.golang.org/grpc": [{ kind: "apiStyle", value: "grpc" }],
  "github.com/lib/pq": [{ kind: "dataStore", value: "postgresql" }],
  "github.com/jackc/pgx": [{ kind: "dataStore", value: "postgresql" }],
  "gorm.io/gorm": [{ kind: "orm", value: "gorm" }],
};

/** NuGet package ids -> meaning. */
export const NUGET_DEPS: Record<string, DepRule[]> = {
  "Swashbuckle.AspNetCore": [{ kind: "openapiGen", value: "swashbuckle" }],
  "Microsoft.EntityFrameworkCore": [{ kind: "orm", value: "entity-framework" }],
  "Npgsql": [{ kind: "dataStore", value: "postgresql" }],
  "Grpc.AspNetCore": [{ kind: "apiStyle", value: "grpc" }],
  "HotChocolate.AspNetCore": [{ kind: "apiStyle", value: "graphql" }],
};

/** Preferred framework when several match (meta-frameworks before their base). */
export const FRAMEWORK_PRIORITY = [
  "nextjs", "nuxt", "sveltekit", "angular", "react", "vue", "svelte",
  "nestjs", "express", "fastify", "koa", "hono",
  "django-rest-framework", "django", "fastapi", "flask",
  "spring-boot", "aspnet-core", "gin", "echo", "fiber", "net-http",
];

export const SCHEMA_PRIORITY = ["openapi", "pydantic", "marshmallow", "zod", "class-validator", "joi", "yup", "java-dto", "bean-validation", "csharp-dto", "go-struct", "typescript-types"];

export const HTTP_CLIENT_PRIORITY = ["openapi-client", "trpc", "rtk-query", "react-query", "apollo-client", "urql", "graphql-request", "angular-httpclient", "axios", "fetch"];

/** Manifests we recognise but whose ecosystems are not supported yet. */
export const UNSUPPORTED_MANIFESTS: Record<string, string> = {
  Gemfile: "Ruby",
  "composer.json": "PHP",
  "Cargo.toml": "Rust",
  "mix.exs": "Elixir",
  "pubspec.yaml": "Dart/Flutter",
  "build.sbt": "Scala",
  "project.clj": "Clojure",
  "deps.edn": "Clojure",
  "stack.yaml": "Haskell",
  "dune-project": "OCaml",
  "shard.yml": "Crystal",
};

/** Hosts that are never treated as outbound API calls. */
export const NON_OUTBOUND_HOSTS = new Set([
  "localhost", "127.0.0.1", "0.0.0.0", "[::1]", "www.w3.org", "w3.org", "json-schema.org",
  "schemas.xmlsoap.org", "maven.apache.org", "www.apache.org", "github.com", "developercertificate.org",
]);

/** Env var names that usually carry an API base URL. */
export const API_ENV_NAME = /(API|URL|HOST|BASE|BACKEND|ENDPOINT|SERVER)/i;
