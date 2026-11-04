# Copyright 2026 The Integration Verifier Authors
# SPDX-License-Identifier: Apache-2.0
# Test fixture: deliberately broken sample app. Do not use as a reference.

from fastapi import APIRouter

from app.db import fetch_users
from app.models import UserCreate, UserOut, UserUpdate

router = APIRouter(prefix="/api/users")


@router.get("", response_model=list[UserOut])
def list_users():
    return [UserOut(id=r[0], name=r[1], email=r[2], password_hash=r[3]) for r in fetch_users()]


@router.get("/{user_id}", response_model=UserOut)
def get_user(user_id: int):
    r = fetch_users()[0]
    return UserOut(id=r[0], name=r[1], email=r[2], password_hash=r[3])


@router.post("", response_model=UserOut)
def create_user(payload: UserCreate):
    return UserOut(id=1, name=payload.full_name, email=payload.email, password_hash="x")


@router.patch("/{user_id}", response_model=UserOut)
def update_user(user_id: int, payload: UserUpdate):
    return get_user(user_id)


@router.delete("/{user_id}")
def delete_user(user_id: int):
    return {"deleted": user_id}


@router.get("/export/all")
def export_users():
    return fetch_users()
