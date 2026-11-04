// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0
// Test fixture: deliberately broken sample app. Do not use as a reference.

/** @type {import('next').NextConfig} */
module.exports = {
  async rewrites() {
    return [
      { source: "/api/:path*", destination: "http://localhost:4000/:path*" },
    ];
  },
};
