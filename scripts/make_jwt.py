#!/usr/bin/env python3
"""
Generates a single long-lived HS256 JWT for PostgREST, with a `role`
claim naming the Postgres role to impersonate (see sql/10_roles_and_grants.sql
and README.md).

No third-party dependencies (no PyJWT) — uses only the Python 3 standard
library, since a fresh server often won't have pip/PyJWT installed and
this is a one-time, one-file need.

Usage:
    python3 make_jwt.py <jwt-secret> [role]

    <jwt-secret>  Must exactly match the `jwt-secret` value in your
                  postgrest.conf (e.g. generated via `openssl rand -base64 32`).
    [role]        Postgres role to impersonate. Defaults to gnucash_mgc_user
                  (the role name sql/10_roles_and_grants.sql creates).

Example:
    python3 make_jwt.py "$(openssl rand -base64 32)" gnucash_mgc_user

This JWT has no `exp` claim — it never expires. That's a deliberate
simplification for this single-user, self-hosted use case (each
self-hoster only ever needs to authenticate as themselves), not an
oversight. Treat it like a password: store it in Expo SecureStore on
the phone (which the app does automatically), never commit it to a
repo or share it.
"""

import base64
import hashlib
import hmac
import json
import sys


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def make_jwt(secret: str, role: str) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {"role": role}

    header_b64 = b64url(json.dumps(header, separators=(",", ":")).encode("utf-8"))
    payload_b64 = b64url(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")

    signature = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    signature_b64 = b64url(signature)

    return f"{header_b64}.{payload_b64}.{signature_b64}"


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    jwt_secret = sys.argv[1]
    jwt_role = sys.argv[2] if len(sys.argv) > 2 else "gnucash_mgc_user"

    print(make_jwt(jwt_secret, jwt_role))
