// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0
// The test app's own Playwright tests, used to check `iv runtime --mode tests`.

module.exports = {
  testDir: "tests",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:47123" },
};
