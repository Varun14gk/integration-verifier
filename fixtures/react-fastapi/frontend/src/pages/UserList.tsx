// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0
// Test fixture: deliberately broken sample app. Do not use as a reference.

import { useEffect, useState } from "react";
import { deleteUser, listUsers, type User } from "../api/users";

export function UserList() {
  const [users, setUsers] = useState<User[]>([]);

  useEffect(() => {
    listUsers().then(setUsers);
  }, []);

  return (
    <ul>
      {users.map((user) => (
        <li key={user.id}>
          {user.name} ({user.email})
          <button onClick={() => deleteUser(user.id)}>Delete</button>
        </li>
      ))}
    </ul>
  );
}
