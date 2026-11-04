# Copyright 2026 The Integration Verifier Authors
# SPDX-License-Identifier: Apache-2.0
# Test fixture: deliberately broken sample app. Do not use as a reference.

import sqlite3

conn = sqlite3.connect("app.db", check_same_thread=False)


def fetch_users():
    return conn.execute("SELECT id, name, email, password_hash FROM users").fetchall()
