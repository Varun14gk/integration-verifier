// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0
// Test fixture: deliberately broken sample app. Do not use as a reference.

import { api } from "./client";

export async function login(email: string, password: string): Promise<void> {
  const res = await api.post<{ access_token: string }>("/api/auth/login", { email, password });
  localStorage.setItem("access_token", res.data.access_token);
}

export async function resetPassword(email: string): Promise<void> {
  await api.get(`/api/auth/reset?email=${encodeURIComponent(email)}`);
}
