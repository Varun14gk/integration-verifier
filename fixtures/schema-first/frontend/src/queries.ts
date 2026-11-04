// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0
// Test fixture: deliberately broken sample app. Do not use as a reference.

import { gql } from "@apollo/client";

export const GET_USER = gql`
  query GetUser($id: ID!) {
    user(id: $id) {
      id
      displayName
      email
    }
  }
`;

export const LIST_USERS = gql`
  query ListUsers {
    users {
      id
      displayname
    }
  }
`;

export const RENAME_USER = gql`
  mutation RenameUser($id: ID!, $name: String!) {
    renameUser(id: $id, displayName: $name) {
      id
    }
  }
`;

export const STATS = gql`
  query Stats {
    stats {
      total
    }
  }
`;
