"""
User administration from the shell. Run from backend/ with the venv:

    python -m app.auth.cli create-user <username> --role admin
    python -m app.auth.cli hash-password
    python -m app.auth.cli list-users

Passwords are always read with getpass - never from argv, so they never
land in shell history or `ps`. Nothing secret is printed except the hash
that hash-password exists to print (a hash is safe to put in .env).
"""
from __future__ import annotations

import argparse
import asyncio
import getpass
import sys

from app.auth.passwords import MIN_PASSWORD_LENGTH, hash_password
from app.auth.store import ROLES


def _prompt_password(confirm: bool = True) -> str:
    pw = getpass.getpass("Password: ")
    if len(pw) < MIN_PASSWORD_LENGTH:
        sys.exit(f"error: password must be at least {MIN_PASSWORD_LENGTH} characters")
    if confirm and getpass.getpass("Confirm password: ") != pw:
        sys.exit("error: passwords do not match")
    return pw


async def _create_user(username: str, role: str) -> int:
    from app.auth import service
    from app.db import init_db
    if not await init_db():
        print("error: database unreachable. For a DB-less bootstrap use hash-password and set "
              "HYRAK_ADMIN_USER / HYRAK_ADMIN_PASSWORD_HASH in .env.", file=sys.stderr)
        return 2
    pw = _prompt_password()
    try:
        rec = await service.create_user(username, pw, role)
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    print(f"user '{rec.username}' ready with role {rec.role}")
    return 0


async def _list_users() -> int:
    from app.auth import service
    from app.db import init_db
    if not await init_db():
        print("error: database unreachable", file=sys.stderr)
        return 2
    for u in await service.list_users():
        flag = " (disabled)" if u["disabled"] else ""
        print(f"{u['username']:24} {u['role']:9} {u['id']}{flag}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m app.auth.cli")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create-user", help="create or replace a user (prompts for the password)")
    c.add_argument("username")
    c.add_argument("--role", choices=ROLES, default="viewer")
    sub.add_parser("hash-password", help="print a scrypt hash for HYRAK_ADMIN_PASSWORD_HASH")
    sub.add_parser("list-users")
    args = ap.parse_args(argv)

    if args.cmd == "hash-password":
        print(hash_password(_prompt_password()))
        return 0
    if args.cmd == "create-user":
        return asyncio.run(_create_user(args.username, args.role))
    if args.cmd == "list-users":
        return asyncio.run(_list_users())
    return 1


if __name__ == "__main__":
    sys.exit(main())
