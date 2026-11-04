// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0
// Test fixture: deliberately broken sample app. Do not use as a reference.

import { api } from "./client";

export interface User {
  id: number;
  name: string;
  email: string;
}

export interface NewUser {
  name: string;
  email: string;
  password: string;
}

export async function listUsers(): Promise<User[]> {
  const res = await api.get<User[]>("/api/users");
  return res.data;
}

export async function getUser(id: number): Promise<User> {
  const res = await api.get<User>(`/api/users/${id}`);
  return res.data;
}

export async function createUser(user: NewUser): Promise<User> {
  const res = await api.post<User>("/api/users", { name: user.name, email: user.email, password: user.password });
  return res.data;
}

export async function updateUser(id: number, changes: Partial<User>): Promise<User> {
  const res = await api.put<User>(`/api/users/${id}`, changes);
  return res.data;
}

export async function deleteUser(id: number): Promise<void> {
  await api.delete(`/api/user/${id}`);
}
