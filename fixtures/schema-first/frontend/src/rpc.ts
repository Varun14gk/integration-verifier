// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0
// Test fixture: deliberately broken sample app. Do not use as a reference.

import { createClient } from "@connectrpc/connect";
import { transport } from "./transport";
import { UserService } from "./gen/users_connect";

const users = createClient(UserService, transport);

export async function loadUser(id: string) {
  return users.getUser({ id });
}

export async function loadAll() {
  return users.listUsers({});
}

export async function archive(id: string) {
  return users.archiveUser({ id });
}
