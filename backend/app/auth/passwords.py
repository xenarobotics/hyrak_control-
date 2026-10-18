"""
Password hashing with the standard library only.

scrypt (n=2**15, r=8, p=1, 16-byte salt) is what hashlib offers that is
memory-hard; bcrypt/passlib are deliberately not dependencies. Stored form:

    scrypt$<salt_b64>$<hash_b64>

Verification is a constant-time compare of the recomputed hash, and a
malformed stored string verifies False rather than raising, so a corrupted
row cannot turn into a 500 on the login route.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets

SCRYPT_N = 2 ** 15
SCRYPT_R = 8
SCRYPT_P = 1
_SALT_BYTES = 16
_DKLEN = 32
# n * r * 128 bytes plus headroom - hashlib's default 32 MiB ceiling is
# exactly what n=2**15, r=8 needs, so it has to be raised explicitly.
_MAXMEM = 64 * 1024 * 1024

# NIST 800-63B: length, no composition rules (docs/ACCESS_MODEL.md section 4).
MIN_PASSWORD_LENGTH = 10


def _derive(password: str, salt: bytes) -> bytes:
    return hashlib.scrypt(
        password.encode("utf-8"), salt=salt,
        n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=_DKLEN, maxmem=_MAXMEM,
    )


def hash_password(password: str) -> str:
    if not isinstance(password, str) or len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"password must be at least {MIN_PASSWORD_LENGTH} characters")
    salt = secrets.token_bytes(_SALT_BYTES)
    digest = _derive(password, salt)
    return "scrypt$%s$%s" % (
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(digest).decode("ascii"),
    )


def verify_password(password: str, stored: str | None) -> bool:
    if not stored or not isinstance(password, str):
        return False
    try:
        scheme, salt_b64, hash_b64 = stored.split("$", 2)
        if scheme != "scrypt":
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
    except (ValueError, TypeError):
        return False
    try:
        actual = _derive(password, salt)
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


def looks_like_hash(value: str | None) -> bool:
    """True for the stored form above - used to refuse a plaintext put in
    HYRAK_ADMIN_PASSWORD_HASH by mistake."""
    if not value or not value.startswith("scrypt$"):
        return False
    return value.count("$") == 2
