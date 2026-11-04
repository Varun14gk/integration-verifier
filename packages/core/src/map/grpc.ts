// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { lineOf } from "../fs-walk.js";
import type { ClientCall, ServerRoute } from "./types.js";

export interface ProtoRpc {
  service: string;
  method: string;
  /** Full HTTP path gRPC, gRPC-web and Connect use: /package.Service/Method */
  path: string;
  line: number;
}

/** Services and rpcs declared in a .proto file. */
export function parseProto(text: string): ProtoRpc[] {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
  const pkg = /\bpackage\s+([\w.]+)\s*;/.exec(clean)?.[1];
  const out: ProtoRpc[] = [];
  for (const svc of clean.matchAll(/\bservice\s+(\w+)\s*\{/g)) {
    const start = svc.index + svc[0].length;
    let depth = 1;
    let end = start;
    for (; end < clean.length && depth > 0; end++) {
      if (clean[end] === "{") depth++;
      else if (clean[end] === "}") depth--;
    }
    const body = clean.slice(start, end);
    for (const rpc of body.matchAll(/\brpc\s+(\w+)\s*\(/g)) {
      out.push({ service: svc[1]!, method: rpc[1]!, path: `/${pkg ? `${pkg}.` : ""}${svc[1]}/${rpc[1]}`, line: lineOf(clean, start + rpc.index) });
    }
  }
  return out;
}

export function protoRoutes(text: string, unit: string, file: string): ServerRoute[] {
  return parseProto(text).map((r) => ({
    id: `route:${file}:${r.line}:POST`,
    unit,
    file,
    line: r.line,
    framework: "grpc",
    handler: `${r.service}.${r.method}`,
    // gRPC runs over HTTP POST to /package.Service/Method, which is also what runtime traffic shows.
    method: "POST",
    path: r.path,
    query: { known: false, params: [] },
    body: null,
    response: null,
    validated: null,
    sinks: [],
    logs: null,
  }));
}

const lowerFirst = (s: string) => s[0]!.toLowerCase() + s.slice(1);

/**
 * Frontend calls through generated gRPC-web / Connect clients: `new UserServiceClient(...)`,
 * `createClient(UserService, ...)` or `createPromiseClient(UserService, ...)`, then
 * `client.getUser(...)`. Method names are matched to rpcs case-insensitively on the first letter.
 */
export function grpcClientCalls(text: string, unit: string, file: string, rpcs: ProtoRpc[]): ClientCall[] {
  const services = new Map<string, ProtoRpc[]>();
  for (const r of rpcs) services.set(r.service, [...(services.get(r.service) ?? []), r]);
  const clients = new Map<string, string>();
  for (const m of text.matchAll(/(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*(?:new\s+(\w+?)(?:Client|PromiseClient)\s*\(|create(?:Promise)?Client\s*\(\s*(\w+)\b)/g)) {
    const svc = m[2] ?? m[3];
    if (svc && services.has(svc)) clients.set(m[1]!, svc);
  }
  const calls: ClientCall[] = [];
  for (const [name, svc] of clients) {
    for (const m of text.matchAll(new RegExp(`\\b${name}\\.(\\w+)\\s*\\(`, "g"))) {
      const rpc = services.get(svc)!.find((r) => lowerFirst(r.method) === lowerFirst(m[1]!));
      const line = lineOf(text, m.index);
      const path = rpc ? rpc.path : `${services.get(svc)![0]!.path.replace(/\/[^/]+$/, "")}/${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)}`;
      calls.push({
        id: `call:${file}:${line}`, unit, file, line, function: null, client: "grpc", method: "POST",
        url: { kind: "static", raw: `${name}.${m[1]}()`, path, query: [] },
        query: { known: false, names: [] }, body: null, response: null,
      });
    }
  }
  return calls;
}
