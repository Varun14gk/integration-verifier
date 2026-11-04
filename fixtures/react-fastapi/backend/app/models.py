# Copyright 2026 The Integration Verifier Authors
# SPDX-License-Identifier: Apache-2.0
# Test fixture: deliberately broken sample app. Do not use as a reference.

from pydantic import BaseModel


class UserCreate(BaseModel):
    full_name: str
    email: str
    password: str


class UserUpdate(BaseModel):
    full_name: str | None = None
    email: str | None = None


class UserOut(BaseModel):
    id: int
    name: str
    email: str
    password_hash: str


class LoginRequest(BaseModel):
    email: str
    password: str


class TokenOut(BaseModel):
    access_token: str
