"""
User administration from the shell. Run from backend/ with the venv:

    python -m app.auth.cli create-user <username> --founder [--email you@x.com]
    python -m app.auth.cli create-user <username> --role admin      # same as --founder
    python -m app.auth.cli grant <username|email> <workspace> <role> [--title ..] [--area-file f.geojson]
    python -m app.auth.cli grant <username|email> <workspace> --remove
    python -m app.auth.cli list-users
    python -m app.auth.cli hash-password

`--role admin|operator|viewer` is the pre-workspace vocabulary, kept as an
alias: it sets the user's membership on the HYRAK workspace (admin ->
founder, operator -> pilot, viewer -> viewer). `<workspace>` is a workspace
id or "hyrak". `grant` is the owner's tool and bypasses the API grant rules
(it can create the first founder, managers, anything valid for the kind).

Passwords are always read with getpass - never from argv, so they never
land in shell history or `ps`. Nothing secret is printed except the hash
that hash-password exists to print (a hash is safe to put in .env).
"""
from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import sys

from app.auth.passwords import MIN_PASSWORD_LENGTH, hash_password
from app.auth.store import ROLES


# The CLI is its own process: it cannot drop the running server's 60 s
# token cache or reach its live sockets (cross-process invalidation is the
# planned Redis / LISTEN-NOTIFY work). The server picks a change up when the
# cached entry expires; say so after every change that affects access.
SERVER_NOTE = ("note: a running server applies this within 60 s (its token cache); "
               "the same change made through the API applies immediately.")


def _prompt_password(confirm: bool = True) -> str:
    pw = getpass.getpass("Password: ")
    if len(pw) < MIN_PASSWORD_LENGTH:
        sys.exit(f"error: password must be at least {MIN_PASSWORD_LENGTH} characters")
    if confirm and getpass.getpass("Confirm password: ") != pw:
        sys.exit("error: passwords do not match")
    return pw


async def _need_db() -> bool:
    from app.db import init_db
    if not await init_db():
        print("error: database unreachable. For a DB-less bootstrap use hash-password and set "
              "HYRAK_ADMIN_USER / HYRAK_ADMIN_PASSWORD_HASH in .env.", file=sys.stderr)
        return False
    return True


async def _create_user(username: str, role: str | None, founder: bool, email: str | None,
                       display_name: str) -> int:
    from app.auth import service
    if not await _need_db():
        return 2
    pw = _prompt_password()
    try:
        # The shell operator is above a founder: an email given here is vouched for.
        rec = await service.create_user(username, pw, role, email=email,
                                        display_name=display_name, founder=founder,
                                        email_verified=True)
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    ms = await service.memberships_of(rec.id)
    roles = ", ".join(f"{m.role}@{m.workspace_name}" for m in ms) or "no memberships"
    flag = " (disabled - left as it was)" if rec.disabled else ""
    print(f"user '{rec.username}' ready: {roles}{flag}")
    print(SERVER_NOTE)
    return 0


async def _grant(login: str, workspace: str, role: str | None, title: str,
                 area_file: str | None, remove: bool) -> int:
    from app.auth import perms, service
    from app.auth.store import PLATFORM_WORKSPACE_ID, MembershipRecord, new_id
    if not await _need_db():
        return 2
    store = service.write_store()
    user = await service.find_account(login)
    if user is None:
        print(f"error: no account '{login}'", file=sys.stderr)
        return 2
    wid = PLATFORM_WORKSPACE_ID if workspace.lower() in ("hyrak", "platform") else workspace
    ws = await store.get_workspace(wid)
    if ws is None:
        print(f"error: no workspace '{workspace}'", file=sys.stderr)
        return 2
    before = await service.compat_role_of(user.id)
    current = next((m for m in await store.memberships_for_user(user.id)
                    if m.workspace_id == ws.id), None)
    if remove:
        if current is None:
            print("nothing to remove")
            return 0
        if current.role == perms.FOUNDER and await store.count_role(ws.id, perms.FOUNDER) <= 1:
            print("error: that is the last founder", file=sys.stderr)
            return 2
        await store.delete_membership(current.id)
        await service.membership_changed(user.id, before_compat=before, reduced=True)
        print(f"removed {current.role} on {ws.name} from {user.username}")
        print(SERVER_NOTE)
        return 0
    if role not in perms.roles_for_kind(ws.kind):
        print(f"error: role must be one of {', '.join(perms.roles_for_kind(ws.kind))} "
              f"on a {ws.kind} workspace", file=sys.stderr)
        return 2
    area = None
    if area_file:
        with open(area_file, "r", encoding="utf-8") as f:
            area = json.load(f)
        if isinstance(area, dict) and area.get("type") == "Feature":
            area = area.get("geometry")
        reason = perms.validate_area(area)
        if reason:
            print(f"error: {reason}", file=sys.stderr)
            return 2
    if role == perms.AIRSPACE and area is None:
        print("error: airspace needs --area-file", file=sys.stderr)
        return 2
    if current is None:
        await store.add_membership(MembershipRecord(
            id=new_id(), user_id=user.id, workspace_id=ws.id, role=role, area=area,
            title=title or ""))
    else:
        fields = {"role": role, "title": title or current.title}
        if area_file:
            fields["area"] = area
        await store.update_membership(current.id, **fields)
    await service.membership_changed(user.id, before_compat=before,
                                     reduced=current is not None and current.role != role)
    print(f"{user.username} is now {role} on {ws.name}")
    print(SERVER_NOTE)
    return 0


async def _list_users() -> int:
    from app.auth import perms, service
    if not await _need_db():
        return 2
    for u in await service.list_users():
        ms = await service.memberships_of(u.id)
        flag = " (disabled)" if u.disabled else ""
        compat = perms.compat_role(ms)
        print(f"{u.username:24} {compat:9} {u.email or '-':32} {u.id}{flag}")
        for m in ms:
            title = f"  \"{m.title}\"" if m.title else ""
            area = "  [area]" if m.area else ""
            print(f"    {m.role:9} on {m.workspace_name} ({m.workspace_kind}, {m.workspace_id}){title}{area}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m app.auth.cli")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create-user", help="create a user or replace their password "
                                           "(prompts for the password)")
    c.add_argument("username")
    c.add_argument("--email", default=None)
    c.add_argument("--display-name", default="")
    c.add_argument("--founder", action="store_true", help="founder on the HYRAK workspace")
    c.add_argument("--role", choices=ROLES, default=None,
                   help="compatibility alias: admin = founder, operator = HYRAK pilot, "
                        "viewer = HYRAK viewer")
    g = sub.add_parser("grant", help="give (or with --remove take) a role on a workspace")
    g.add_argument("login", help="username or email")
    g.add_argument("workspace", help="workspace id, or 'hyrak'")
    g.add_argument("role", nargs="?", default=None)
    g.add_argument("--title", default="")
    g.add_argument("--area-file", default=None, help="GeoJSON Polygon / MultiPolygon file")
    g.add_argument("--remove", action="store_true")
    sub.add_parser("hash-password", help="print a scrypt hash for HYRAK_ADMIN_PASSWORD_HASH")
    sub.add_parser("list-users", help="accounts and their memberships")
    args = ap.parse_args(argv)

    if args.cmd == "hash-password":
        print(hash_password(_prompt_password()))
        return 0
    if args.cmd == "create-user":
        return asyncio.run(_create_user(args.username, args.role, args.founder,
                                        args.email, args.display_name))
    if args.cmd == "grant":
        if not args.remove and not args.role:
            ap.error("grant needs a role (or --remove)")
        return asyncio.run(_grant(args.login, args.workspace, args.role, args.title,
                                  args.area_file, args.remove))
    if args.cmd == "list-users":
        return asyncio.run(_list_users())
    return 1


if __name__ == "__main__":
    sys.exit(main())
