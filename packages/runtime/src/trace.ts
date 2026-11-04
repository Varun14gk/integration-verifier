// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { CapturedRequest, Observation } from "./types.js";

/** Minimal ZIP reader (stored and deflated entries), enough for Playwright traces. */
export function readZip(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + compSize);
    files.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function* traceZips(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) yield* traceZips(full);
    else if (e.endsWith(".zip")) yield full;
  }
}

interface ResourceSnapshot {
  request?: { method?: string; url?: string; postData?: { text?: string } };
  response?: { status?: number; content?: { mimeType?: string; _sha1?: string; _file?: string } };
  _resourceType?: string;
  _frameref?: string;
}

/** Reads network and console events from every trace.zip under `dir`. */
export function readTraces(dir: string): Observation {
  const obs: Observation = { mode: "playwright-tests", pages: [], requests: [], console: [], storage: [], cookies: [], serverOutput: [] };
  let n = 0;
  for (const zip of traceZips(dir)) {
    const files = readZip(readFileSync(zip));
    for (const [name, content] of files) {
      if (name.endsWith(".network")) {
        for (const line of content.toString("utf8").split("\n")) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line) as { type?: string; snapshot?: ResourceSnapshot };
          if (ev.type !== "resource-snapshot" || !ev.snapshot?.request?.url) continue;
          const s = ev.snapshot;
          const content = s.response?.content;
          const mime = content?.mimeType ?? "";
          // Newer traces name the body file (`_file`); older ones give its sha1.
          const bodyPath = content?._file ?? (content?._sha1 ? `resources/${content._sha1}` : null);
          const body = bodyPath ? files.get(bodyPath) : undefined;
          const req: CapturedRequest = {
            id: `trace-${++n}`,
            method: s.request!.method ?? "GET",
            url: s.request!.url!,
            resourceType: s._resourceType ?? (/json/.test(mime) ? "fetch" : "other"),
            status: s.response?.status && s.response.status > 0 ? s.response.status : null,
            ...(s.request!.postData?.text ? { requestBody: s.request!.postData.text } : {}),
            ...(body && /json|text/.test(mime) ? { responseBody: body.toString("utf8") } : {}),
            ...(mime ? { contentType: mime } : {}),
            page: "",
          };
          obs.requests.push(req);
        }
      } else if (name.endsWith(".trace")) {
        for (const line of content.toString("utf8").split("\n")) {
          if (!line.includes('"console"')) continue;
          const ev = JSON.parse(line) as { type?: string; messageType?: string; text?: string; pageId?: string };
          if (ev.type === "console" && typeof ev.text === "string") obs.console.push({ type: ev.messageType ?? "log", text: ev.text, page: ev.pageId ?? "" });
        }
      }
    }
  }
  return obs;
}
