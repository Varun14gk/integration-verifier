#!/usr/bin/env node
// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

// Regenerates fixtures/*/expected.json from the ground-truth list below, resolving
// each `contains` snippet to its line number. Run after editing a fixture:
//   node scripts/gen-fixture-expected.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repo = process.argv[2] ?? join(import.meta.dirname, "..");

const fixtures = {
  "react-fastapi": {
    description: "React (Vite + axios) frontend, FastAPI backend.",
    stack: {
      frontend: { dir: "frontend", language: "typescript", framework: "react", bundler: "vite", httpClient: "axios", packageManager: "npm" },
      backend: { dir: "backend", language: "python", framework: "fastapi", schema: "pydantic", packageManager: "pip" },
      apiStyle: "rest",
      joins: [
        { kind: "env", name: "VITE_API_URL", file: "frontend/.env.example" },
        { kind: "dev-proxy", from: "/api", to: "http://localhost:8000", file: "frontend/vite.config.ts" },
      ],
      dataStores: ["sqlite"],
      outbound: ["mailer.untrusted-relay.example"],
    },
    connected: [
      { method: "GET", path: "/api/users", frontend: ["frontend/src/api/users.ts", 'api.get<User[]>("/api/users")'], backend: ["backend/app/routes/users.py", '@router.get("", response_model=list[UserOut])'] },
      { method: "GET", path: "/api/users/{}", frontend: ["frontend/src/api/users.ts", "api.get<User>(`/api/users/${id}`)"], backend: ["backend/app/routes/users.py", '@router.get("/{user_id}"'] },
      { method: "POST", path: "/api/auth/login", frontend: ["frontend/src/api/auth.ts", '"/api/auth/login"'], backend: ["backend/app/routes/auth.py", '@router.post("/login"'] },
    ],
    planted: [
      { id: "rf-request-field-renamed", category: "mismatched", severity: "high", phase: 1, at: ["frontend/src/api/users.ts", 'api.post<User>("/api/users"'], related: [["backend/app/models.py", "full_name: str\n"]], description: "Frontend sends `name`; backend UserCreate requires `full_name`.", suggestion: "Rename the body field to full_name (or accept name on the backend)." },
      { id: "rf-method-mismatch", category: "mismatched", severity: "high", phase: 1, at: ["frontend/src/api/users.ts", "api.put<User>"], related: [["backend/app/routes/users.py", '@router.patch("/{user_id}"']], description: "Frontend uses PUT /api/users/{id}; backend only exposes PATCH.", suggestion: "PATCH /api/users/{user_id}" },
      { id: "rf-wrong-path", category: "not-connected", severity: "high", phase: 1, at: ["frontend/src/api/users.ts", "api.delete(`/api/user/${id}`)"], related: [["backend/app/routes/users.py", '@router.delete("/{user_id}")']], description: "DELETE /api/user/{id} does not exist (singular `user`).", suggestion: "DELETE /api/users/{user_id}" },
      { id: "rf-orphan-export", category: "orphan", severity: "low", phase: 1, at: ["backend/app/routes/users.py", '@router.get("/export/all")'], description: "GET /api/users/export/all is not called by the frontend." },
      { id: "rf-orphan-reset", category: "orphan", severity: "info", phase: 1, at: ["backend/app/routes/auth.py", '@router.get("/reset")'], negativeNote: "Actually called by resetPassword; listed here so the map test asserts it is NOT an orphan.", expectNotReported: true },
      { id: "rf-overexposed-password-hash", category: "over-exposure", severity: "high", phase: 2, at: ["backend/app/models.py", "password_hash: str"], description: "UserOut returns password_hash; the UI only uses id, name, email." },
      { id: "rf-token-localstorage", category: "sensitive-in-client-storage", severity: "high", phase: 2, at: ["frontend/src/api/auth.ts", 'localStorage.setItem("access_token"'], description: "Access token stored in localStorage (readable by any script on the page)." },
      { id: "rf-password-logged", category: "sensitive-in-logs", severity: "critical", phase: 2, at: ["backend/app/routes/auth.py", "log.info(f\"login attempt"], description: "Plain-text password written to the log." },
      { id: "rf-email-in-url", category: "sensitive-in-url", severity: "medium", phase: 2, at: ["frontend/src/api/auth.ts", "/api/auth/reset?email="], description: "Email address sent in the query string." },
      { id: "rf-outbound-unlisted", category: "outbound-not-allowlisted", severity: "high", phase: 2, at: ["backend/app/routes/auth.py", "https://mailer.untrusted-relay.example/send"], description: "Backend sends user email to a host not on the allowlist." },
      { id: "rf-no-validation-reset", category: "missing-validation", severity: "medium", phase: 2, at: ["backend/app/routes/auth.py", "def reset_password(email):"], description: "`email` parameter has no type or model, so FastAPI does not validate it." },
    ],
    mustNotReport: [
      { category: "orphan", at: ["backend/app/routes/auth.py", '@router.get("/reset")'], reason: "Called by resetPassword in frontend/src/api/auth.ts." },
      { category: "over-exposure", at: ["backend/app/models.py", "    email: str\n    password_hash"], reason: "email is displayed by UserList.tsx." },
    ],
  },

  "angular-spring": {
    description: "Angular (HttpClient) frontend, Spring Boot backend.",
    stack: {
      frontend: { dir: "frontend", language: "typescript", framework: "angular", httpClient: "angular-httpclient", packageManager: "npm" },
      backend: { dir: "backend", language: "java", framework: "spring-boot", schema: "java-dto", packageManager: "maven" },
      apiStyle: "rest",
      joins: [{ kind: "dev-proxy", from: "/api", to: "http://localhost:8080", file: "frontend/proxy.conf.json" }],
      dataStores: ["postgresql"],
      outbound: [],
    },
    connected: [
      { method: "GET", path: "/api/orders/{}", frontend: ["frontend/src/app/services/order.service.ts", "this.http.get<Order>(`/api/orders/${id}`)"], backend: ["backend/src/main/java/com/example/shop/OrderController.java", '@GetMapping("/{id}")'] },
      { method: "POST", path: "/api/orders", frontend: ["frontend/src/app/services/order.service.ts", 'this.http.post<Order>("/api/orders", order)'], backend: ["backend/src/main/java/com/example/shop/OrderController.java", "@PostMapping"] },
      { method: "GET", path: "/api/customers/{}", frontend: ["frontend/src/app/services/customer.service.ts", "/api/customers/${id}"], backend: ["backend/src/main/java/com/example/shop/CustomerController.java", '@GetMapping("/api/customers/{id}")'] },
    ],
    planted: [
      { id: "as-query-params", category: "mismatched", severity: "high", phase: 1, at: ["frontend/src/app/services/order.service.ts", "params: { page, size }"], related: [["backend/src/main/java/com/example/shop/OrderController.java", "@RequestParam int pageNumber"]], description: "Frontend sends page/size; backend requires pageNumber/pageSize.", suggestion: "Send pageNumber and pageSize." },
      { id: "as-path-param-missing", category: "mismatched", severity: "high", phase: 1, at: ["frontend/src/app/services/order.service.ts", "/api/orders/${orderId}/items`"], related: [["backend/src/main/java/com/example/shop/OrderController.java", '@DeleteMapping("/{orderId}/items/{itemId}")']], description: "Backend route needs {itemId}; frontend omits it.", suggestion: "DELETE /api/orders/{orderId}/items/{itemId}" },
      { id: "as-orphan-export", category: "orphan", severity: "low", phase: 1, at: ["backend/src/main/java/com/example/shop/OrderController.java", '@GetMapping("/export")'], description: "GET /api/orders/export is not called by the frontend." },
      { id: "as-no-valid", category: "missing-validation", severity: "medium", phase: 2, at: ["backend/src/main/java/com/example/shop/OrderController.java", "@RequestBody CreateOrderRequest request"], description: "@RequestBody without @Valid, and the DTO has no constraints." },
      { id: "as-email-logged", category: "sensitive-in-logs", severity: "medium", phase: 2, at: ["backend/src/main/java/com/example/shop/OrderController.java", "log.info(\"Order placed by"], description: "Customer email written to the log." },
      { id: "as-overexposed-national-id", category: "over-exposure", severity: "high", phase: 2, at: ["backend/src/main/java/com/example/shop/Customer.java", "public String nationalId;"], description: "Customer.nationalId returned; the UI only uses name." },
      { id: "as-overexposed-email", category: "over-exposure", severity: "medium", phase: 2, at: ["backend/src/main/java/com/example/shop/Customer.java", "public String email;"], description: "Customer.email returned; the UI only uses name." },
      { id: "as-email-sessionstorage", category: "sensitive-in-client-storage", severity: "medium", phase: 2, at: ["frontend/src/app/services/customer.service.ts", 'sessionStorage.setItem("customer_email"'], description: "Email stored in sessionStorage." },
      { id: "as-cookie-no-flags", category: "insecure-cookie", severity: "low", phase: 2, at: ["frontend/src/app/services/customer.service.ts", "document.cookie ="], description: "Cookie set without Secure/SameSite." },
      { id: "as-no-request-logging", category: "missing-logging", severity: "low", phase: 2, at: ["backend/src/main/java/com/example/shop/CustomerController.java", '@GetMapping("/api/customers/{id}")'], description: "No request logging or tracing is configured, and 5 of 6 handlers write no log line." },
      { id: "as-db-password", category: "hardcoded-secret", severity: "critical", phase: 2, at: ["backend/src/main/resources/application.properties", "spring.datasource.password="], description: "Database password committed in application.properties." },
    ],
    mustNotReport: [
      { category: "over-exposure", at: ["backend/src/main/java/com/example/shop/Customer.java", "public String name;"], reason: "name is shown by CustomerCardComponent." },
    ],
  },

  "nextjs-express": {
    description: "Next.js (fetch, rewrites) frontend, Express backend.",
    stack: {
      frontend: { dir: "frontend", language: "typescript", framework: "nextjs", httpClient: "fetch", packageManager: "npm" },
      backend: { dir: "backend", language: "javascript", framework: "express", schema: "zod", packageManager: "npm" },
      apiStyle: "rest",
      joins: [{ kind: "nextjs-rewrite", from: "/api/:path*", to: "http://localhost:4000/:path*", file: "frontend/next.config.js" }],
      dataStores: [],
      outbound: ["payments.example.com", "collect.analytics.example"],
    },
    connected: [],
    planted: [
      { id: "ne-broken-rewrite", category: "not-connected", severity: "critical", phase: 1, at: ["frontend/next.config.js", 'destination: "http://localhost:4000/:path*"'], related: [["backend/src/server.js", 'app.get("/api/products",']], description: "Rewrite strips /api, so /api/products reaches the backend as /products, which does not exist. Every frontend call is affected.", suggestion: "destination: http://localhost:4000/api/:path*" },
      { id: "ne-dynamic-url", category: "unverifiable", severity: "info", phase: 1, at: ["frontend/lib/api.ts", "fetch(`/api/${resource}/${id}`)"], description: "URL built from a variable resource name." },
      { id: "ne-orphan-health", category: "orphan", severity: "info", phase: 1, at: ["backend/src/server.js", 'app.get("/api/health"'], description: "GET /api/health is not called by the frontend (expected for health checks)." },
      { id: "ne-hardcoded-key", category: "hardcoded-secret", severity: "critical", phase: 2, at: ["frontend/lib/analytics.ts", "const ANALYTICS_SECRET_KEY ="], description: "Secret key hardcoded in frontend code that is shipped to browsers." },
      { id: "ne-outbound-analytics", category: "outbound-not-allowlisted", severity: "medium", phase: 2, at: ["frontend/lib/analytics.ts", "https://collect.analytics.example/v1/events"], description: "Call to a host not on the allowlist." },
      { id: "ne-card-logged", category: "sensitive-in-logs", severity: "critical", phase: 2, at: ["backend/src/server.js", 'console.log("charging card"'], description: "Card number written to the log." },
      { id: "ne-orders-no-validation", category: "missing-validation", severity: "high", phase: 2, at: ["backend/src/server.js", 'app.post("/api/orders"'], description: "req.body used without a schema; /api/login shows the project already uses zod." },
      { id: "ne-password-in-error", category: "sensitive-in-error", severity: "high", phase: 2, at: ["backend/src/server.js", "Invalid login for"], description: "Error response echoes the submitted email and password." },
      { id: "ne-no-request-logging", category: "missing-logging", severity: "low", phase: 2, at: ["backend/src/server.js", 'app.get("/api/products",'], description: "No request logging middleware or tracing, and 4 of 5 handlers write no log line." },
      { id: "ne-session-cookie", category: "insecure-cookie", severity: "high", phase: 2, at: ["backend/src/server.js", 'res.cookie("session"'], description: "Session cookie set without httpOnly, secure or sameSite." },
    ],
    mustNotReport: [
      { category: "outbound-not-allowlisted", at: ["backend/src/server.js", "https://payments.example.com/charge"], reason: "payments.example.com is on the allowlist." },
      { category: "missing-validation", at: ["backend/src/server.js", 'app.post("/api/login"'], reason: "Validated with LoginBody (zod)." },
      { category: "over-exposure", at: ["backend/src/server.js", 'app.get("/api/products",'], reason: "supplierCost is unused by the UI but is not a sensitive field." },
    ],
  },
};

function locate(fixture, [file, contains]) {
  const text = readFileSync(join(repo, "fixtures", fixture, file), "utf8");
  const idx = text.indexOf(contains);
  if (idx < 0) throw new Error(`${fixture}/${file}: snippet not found: ${contains}`);
  if (text.indexOf(contains, idx + 1) >= 0) throw new Error(`${fixture}/${file}: snippet not unique: ${contains}`);
  const line = text.slice(0, idx).split("\n").length;
  const firstLine = contains.split("\n")[0];
  return { file, line, contains: firstLine };
}

for (const [name, f] of Object.entries(fixtures)) {
  const planted = f.planted
    .filter((p) => !p.expectNotReported)
    .map(({ at, related, expectNotReported, negativeNote, ...rest }) => ({
      ...rest,
      evidence: locate(name, at),
      ...(related ? { related: related.map((r) => locate(name, r)) } : {}),
    }));
  const out = {
    $comment: "Ground truth for this fixture. Every line number is checked by tests/fixtures.test.ts.",
    fixture: name,
    description: f.description,
    stack: f.stack,
    connected: f.connected.map((c) => ({ method: c.method, path: c.path, frontend: locate(name, c.frontend), backend: locate(name, c.backend) })),
    planted,
    mustNotReport: f.mustNotReport.map((m) => ({ category: m.category, evidence: locate(name, m.at), reason: m.reason })),
  };
  writeFileSync(join(repo, "fixtures", name, "expected.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`${name}: ${planted.length} planted, ${out.connected.length} connected, ${out.mustNotReport.length} must-not-report`);
}
