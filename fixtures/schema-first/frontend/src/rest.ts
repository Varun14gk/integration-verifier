// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0
// Test fixture: deliberately broken sample app. Do not use as a reference.

export interface User {
  id: string;
  displayName: string;
  email: string;
}

export async function listUsers(limit: number): Promise<User[]> {
  const res = await fetch(`/api/v1/users?limit=${limit}`);
  return res.json();
}

export async function getUser(userId: string): Promise<User> {
  const res = await fetch(`/api/v1/users/${userId}`);
  return res.json();
}

export async function createUser(name: string, email: string): Promise<User> {
  const res = await fetch("/api/v1/users", { method: "POST", body: JSON.stringify({ name, email }) });
  return res.json();
}

export async function removeUser(userId: string): Promise<void> {
  await fetch(`/api/v1/user/${userId}`, { method: "DELETE" });
}
