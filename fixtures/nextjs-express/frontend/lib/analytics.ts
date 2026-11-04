// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0
// Test fixture: deliberately broken sample app. Do not use as a reference.
// The key below is fake and exists only so the secret check has something to find.

const ANALYTICS_SECRET_KEY = "ivfx_4f9c2e7a1b8d3f6e0a5c9b2d7e1f4a8c";

export function track(event: string): void {
  void fetch("https://collect.analytics.example/v1/events", {
    method: "POST",
    headers: { Authorization: `Bearer ${ANALYTICS_SECRET_KEY}` },
    body: JSON.stringify({ event }),
  });
}
