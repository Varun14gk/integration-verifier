// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0
// Test fixture: deliberately broken sample app. Do not use as a reference.

import type { User } from "./rest";

export function Profile({ user }: { user: User }) {
  return (
    <p>
      {user.displayName} ({user.email})
    </p>
  );
}
