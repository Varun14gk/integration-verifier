// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

const { test, expect } = require("@playwright/test");

test("user can sign in", async ({ page }) => {
  await page.goto("/");
  await page.fill("input[name=email]", "runtime.tester@example.com");
  await page.fill("input[name=password]", "Iv-Test-Pa55word!");
  await page.click("button[type=submit]");
  await expect(page.locator("#status")).toHaveText("ok");
});
