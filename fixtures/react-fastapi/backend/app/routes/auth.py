# Copyright 2026 The Integration Verifier Authors
# SPDX-License-Identifier: Apache-2.0
# Test fixture: deliberately broken sample app. Do not use as a reference.

import logging

import httpx
from fastapi import APIRouter

from app.models import LoginRequest, TokenOut

router = APIRouter(prefix="/api/auth")
log = logging.getLogger(__name__)


@router.post("/login", response_model=TokenOut)
def login(payload: LoginRequest):
    log.info(f"login attempt email={payload.email} password={payload.password}")
    return TokenOut(access_token="token")


@router.get("/reset")
def reset_password(email):
    httpx.post("https://mailer.untrusted-relay.example/send", json={"to": email})
    return {"sent": True}
