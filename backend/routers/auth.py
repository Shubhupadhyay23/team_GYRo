"""Auth endpoints: Signup, Login, profile update, and selfie upload."""

import logging
import re
from typing import Optional

import phonenumbers
from phonenumbers import NumberParseException
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, EmailStr
import bcrypt

from models.database import NeonHTTPClient

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])


class SignupRequest(BaseModel):
    name: str
    email: EmailStr
    password: str
    phone: Optional[str] = None


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class ProfileUpdateRequest(BaseModel):
    user_id: str
    name: str
    phone: Optional[str] = None


class SelfieUploadRequest(BaseModel):
    user_id: str
    selfie_base64: str


@router.post("/signup")
async def signup(body: SignupRequest):
    """Register a new user with email and password."""
    db = NeonHTTPClient()
    try:
        # Check if email already exists
        existing = await db.execute("SELECT id FROM users WHERE email = $1", [body.email])
        if existing:
            raise HTTPException(status_code=400, detail="Email already registered")

        # Hash the password
        salt = bcrypt.gensalt()
        hashed_password = bcrypt.hashpw(body.password.encode('utf-8'), salt).decode('utf-8')

        # Handle phone normalization if provided
        e164_phone = None
        if body.phone:
            if not body.phone.strip():
                raise HTTPException(status_code=400, detail="Phone number cannot be empty")
            try:
                parsed = phonenumbers.parse(body.phone, "US")
                if not phonenumbers.is_valid_number(parsed):
                    raise HTTPException(status_code=400, detail="Invalid phone number")
                e164_phone = phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)
            except NumberParseException:
                raise HTTPException(status_code=400, detail="Invalid phone number format")

        rows = await db.execute(
            """
            INSERT INTO users (name, email, password_hash, phone)
            VALUES ($1, $2, $3, $4)
            RETURNING id, name, email, phone, poke_id
            """,
            [body.name, body.email, hashed_password, e164_phone],
        )
        return rows[0]
    finally:
        await db.close()


@router.post("/login")
async def login(body: LoginRequest):
    """Authenticate user with email and password."""
    db = NeonHTTPClient()
    try:
        rows = await db.execute(
            "SELECT id, name, email, phone, poke_id, password_hash FROM users WHERE email = $1",
            [body.email]
        )
        if not rows:
            raise HTTPException(status_code=401, detail="Invalid email or password")
        
        user = rows[0]
        if not user.get("password_hash") or not bcrypt.checkpw(body.password.encode('utf-8'), user["password_hash"].encode('utf-8')):
            raise HTTPException(status_code=401, detail="Invalid email or password")
        
        # Remove password_hash from response
        user.pop("password_hash")
        return user
    finally:
        await db.close()


@router.post("/profile")
async def update_profile(body: ProfileUpdateRequest):
    """Update user name and optionally phone number."""
    db = NeonHTTPClient()
    try:
        e164_phone = None
        if body.phone is not None:
            if not body.phone.strip():
                raise HTTPException(status_code=400, detail="Phone number cannot be empty")

            try:
                parsed = phonenumbers.parse(body.phone, "US")
                if not phonenumbers.is_valid_number(parsed):
                    raise HTTPException(status_code=400, detail="Invalid phone number")

                e164_phone = phonenumbers.format_number(
                    parsed, phonenumbers.PhoneNumberFormat.E164
                )
            except NumberParseException:
                raise HTTPException(status_code=400, detail="Invalid phone number format")

            rows = await db.execute(
                """
                UPDATE users SET name = $1, phone = $2
                WHERE id = $3::uuid
                RETURNING id, name, email, phone, poke_id
                """,
                [body.name, e164_phone, body.user_id],
            )
        else:
            rows = await db.execute(
                """
                UPDATE users SET name = $1
                WHERE id = $2::uuid
                RETURNING id, name, email, phone, poke_id
                """,
                [body.name, body.user_id],
            )
        if not rows:
            raise HTTPException(status_code=404, detail="User not found")
        return rows[0]
    finally:
        await db.close()


@router.post("/selfie")
async def upload_selfie(body: SelfieUploadRequest):
    """Store a base64-encoded selfie image for the user."""
    selfie = re.sub(r"^data:image/\w+;base64,", "", body.selfie_base64)

    db = NeonHTTPClient()
    try:
        rows = await db.execute(
            """
            UPDATE users SET selfie_base64 = $1
            WHERE id = $2::uuid
            RETURNING id, name, email, phone, poke_id
            """,
            [selfie, body.user_id],
        )
        if not rows:
            raise HTTPException(status_code=404, detail="User not found")
        return rows[0]
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to save selfie for user %s", body.user_id)
        raise HTTPException(status_code=500, detail=f"Failed to save selfie: {exc}")
    finally:
        await db.close()
