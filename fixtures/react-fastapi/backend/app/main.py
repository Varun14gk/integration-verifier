# Copyright 2026 The Integration Verifier Authors
# SPDX-License-Identifier: Apache-2.0
# Test fixture: deliberately broken sample app. Do not use as a reference.

from fastapi import FastAPI

from app.routes import auth, users

app = FastAPI()
app.include_router(users.router)
app.include_router(auth.router)
