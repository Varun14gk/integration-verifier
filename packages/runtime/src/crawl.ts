// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { chromium, type BrowserContext, type Page, type Request } from "playwright";
import type { CapturedRequest, Observation, TestData } from "./types.js";

const BODY_LIMIT = 512 * 1024;
const TEXTUAL = /json|text|javascript|xml|x-www-form-urlencoded/;

function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Records every request in a browser context. */
export function recordNetwork(context: BrowserContext, requests: CapturedRequest[]): () => Promise<void> {
  const pending: Promise<void>[] = [];
  let n = 0;
  const capture = async (req: Request, failed: boolean) => {
    const res = failed ? null : await req.response().catch(() => null);
    const contentType = res?.headers()["content-type"] ?? "";
    let responseBody: string | undefined;
    if (res && TEXTUAL.test(contentType)) {
      const buf = await res.body().catch(() => null);
      if (buf && buf.length <= BODY_LIMIT) responseBody = buf.toString("utf8");
    }
    const post = req.postData();
    requests.push({
      id: `req-${++n}`,
      method: req.method(),
      url: req.url(),
      resourceType: req.resourceType(),
      status: res?.status() ?? null,
      ...(failed ? { failure: req.failure()?.errorText ?? "failed" } : {}),
      ...(post ? { requestBody: post.slice(0, BODY_LIMIT) } : {}),
      ...(responseBody !== undefined ? { responseBody } : {}),
      ...(contentType ? { contentType } : {}),
      page: req.frame()?.url() ?? "",
    });
  };
  context.on("requestfinished", (r) => void pending.push(capture(r, false)));
  context.on("requestfailed", (r) => void pending.push(capture(r, true)));
  return async () => {
    await Promise.allSettled(pending);
  };
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
}

/** Fills inputs whose name, id, placeholder, label or type matches a test-data key. */
async function fillForms(page: Page, data: TestData): Promise<number> {
  const keys = new Map(Object.entries(data.fields).map(([k, v]) => [normKey(k), v]));
  if (keys.size === 0) return 0;
  let filled = 0;
  for (const input of await page.$$("input, textarea, select")) {
    const attrs = await input.evaluate((el) => {
      const e = el as HTMLInputElement;
      const label = e.labels?.[0]?.textContent ?? "";
      return [e.name, e.id, e.placeholder, e.getAttribute("aria-label") ?? "", label, e.type].filter(Boolean);
    });
    const hit = attrs.map(normKey).find((a) => keys.has(a));
    if (!hit) continue;
    await input.fill(keys.get(hit)!).catch(() => undefined);
    filled++;
  }
  return filled;
}

/** Visits same-origin pages breadth-first, fills (and optionally submits) forms. */
export async function crawl(startUrl: string, data: TestData, opts: { submitForms: boolean }): Promise<Observation> {
  const obs: Observation = { mode: "crawl", pages: [], requests: [], console: [], storage: [], cookies: [], serverOutput: [] };
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const flush = recordNetwork(context, obs.requests);
    context.on("page", (p) => p.on("console", (m) => obs.console.push({ type: m.type(), text: m.text(), page: p.url() })));
    const origin = new URL(startUrl).origin;
    const queue = [...new Set([startUrl, ...data.startPaths.map((p) => new URL(p, startUrl).href)])];
    const seen = new Set<string>();
    while (queue.length && obs.pages.length < data.maxPages) {
      const url = queue.shift()!;
      if (seen.has(url)) continue;
      seen.add(url);
      const page = await context.newPage();
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
        await settle(page);
        obs.pages.push(url);
        if ((await fillForms(page, data)) > 0 && opts.submitForms) {
          for (const form of await page.$$("form")) {
            await form.evaluate((f) => (f as HTMLFormElement).requestSubmit()).catch(() => undefined);
            await settle(page);
          }
        }
        const store = await page.evaluate(() => ({
          local: Object.entries(localStorage),
          session: Object.entries(sessionStorage),
        })).catch(() => ({ local: [], session: [] }));
        for (const [key, value] of store.local) obs.storage.push({ kind: "local-storage", key, value, page: url });
        for (const [key, value] of store.session) obs.storage.push({ kind: "session-storage", key, value, page: url });
        const links = await page.$$eval("a[href]", (as) => as.map((a) => (a as HTMLAnchorElement).href)).catch(() => []);
        for (const l of links) {
          const u = new URL(l);
          u.hash = "";
          if (u.origin === origin && !seen.has(u.href)) queue.push(u.href);
        }
      } catch {
        /* unreachable page: the failed request is recorded */
      } finally {
        await page.close();
      }
    }
    await flush();
    obs.cookies = (await context.cookies()).map((c) => ({ name: c.name, value: c.value, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite, domain: c.domain }));
  } finally {
    await browser.close();
  }
  return obs;
}
