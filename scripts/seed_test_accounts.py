"""Create one local test account per role through the running backend's API.

Usage (backend running on :8001):
    backend/.venv/bin/python scripts/seed_test_accounts.py <founder-login> <founder-password>

Signs in as the founder (password typed by the owner for local testing),
creates a demo organization / client / individual workspace, and adds:
staff (manager, airspace manager, HYRAK pilot) and customers (org owner,
admin, pilot, viewer, client pilot, individual owner). Generated passwords go
only to ~/hyrak_control/.env.test-accounts (gitignored, mode 600).
Re-runnable: existing accounts and workspaces are reused, passwords reset.
"""
import os
import secrets
import sys

import httpx

API = "http://localhost:8001"
FOUNDER_LOGIN = sys.argv[1]
FOUNDER_PW = sys.argv[2]
OUT = os.path.expanduser("~/hyrak_control/.env.test-accounts")
PLATFORM = "00000000-0000-0000-0000-000000000001"

IITH_AREA = {"type": "Polygon", "coordinates": [[
    [78.110, 17.585], [78.135, 17.585], [78.135, 17.605], [78.110, 17.605], [78.110, 17.585]]]}
CLIENT_AREA = {"type": "Polygon", "coordinates": [[
    [78.118, 17.590], [78.128, 17.590], [78.128, 17.598], [78.118, 17.598], [78.118, 17.590]]]}

c = httpx.Client(base_url=API, timeout=20)


def ok(r, what):
    if r.status_code >= 400:
        sys.exit(f"{what}: HTTP {r.status_code} {r.text[:300]}")
    return r.json()


fh = {"Authorization": "Bearer " + ok(c.post("/api/auth/login", json={"login": FOUNDER_LOGIN, "password": FOUNDER_PW}), "founder login")["token"]}

workspaces = {w["name"]: w for w in ok(c.get("/api/workspaces", headers=fh), "list")["workspaces"]}


def workspace(name, kind, parent=None, area=None):
    if name in workspaces:
        w = workspaces[name]
        if area is not None:
            ok(c.patch(f"/api/workspaces/{w['id']}", headers=fh, json={"operating_area": area}), "area")
        return w
    body = {"name": name, "kind": kind}
    if parent:
        body["parent_id"] = parent
    if area is not None:
        body["operating_area"] = area
    w = ok(c.post("/api/workspaces", headers=fh, json=body), f"create {name}")["workspace"]
    workspaces[name] = w
    return w


org = workspace("Demo Org (IITH)", "organization", area=IITH_AREA)
client = workspace("Demo Client", "client", parent=org["id"], area=CLIENT_AREA)
indiv = workspace("Demo Individual", "individual")

users = {u["username"]: u for u in ok(c.get("/api/auth/users", headers=fh), "users")["users"]}
rows = []


def staff_account(username, email, compat_role):
    """An account with a HYRAK membership (compat vocabulary)."""
    pw = secrets.token_urlsafe(12)
    if username in users:
        ok(c.patch(f"/api/auth/users/{users[username]['id']}", headers=fh, json={"password": pw}), f"reset {username}")
        uid = users[username]["id"]
    else:
        u = ok(c.post("/api/auth/users", headers=fh, json={
            "username": username, "password": pw, "role": compat_role, "email": email}), f"create {username}")["user"]
        uid = u["id"]
    return uid, pw


def members_of(ws_id):
    return ok(c.get(f"/api/workspaces/{ws_id}/members", headers=fh), "members")["members"]


def set_membership(ws_id, username, role, area=None, title=""):
    for m in members_of(ws_id):
        if m["user"]["username"] == username and not m.get("inherited_from"):
            body = {"role": role, "title": title}
            if area is not None:
                body["area"] = area
            return ok(c.patch(f"/api/workspaces/{ws_id}/members/{m['id']}", headers=fh, json=body), f"patch {username}")
    body = {"login": username, "role": role, "title": title}
    if area is not None:
        body["area"] = area
    return ok(c.post(f"/api/workspaces/{ws_id}/members", headers=fh, json=body), f"add {username}")


def customer_account(username, email, ws_id, role, title=""):
    """A customer account with no HYRAK membership: invite + accept."""
    pw = secrets.token_urlsafe(12)
    if username in users:
        ok(c.patch(f"/api/auth/users/{users[username]['id']}", headers=fh, json={"password": pw}), f"reset {username}")
        set_membership(ws_id, username, role, title=title)
        return pw
    inv = ok(c.post(f"/api/workspaces/{ws_id}/invites", headers=fh,
                    json={"role": role, "email": email, "title": title}), f"invite {username}")
    token = inv["url"].rstrip("/").split("/")[-1]
    ok(c.post(f"/api/auth/invites/{token}/accept", json={
        "display_name": username, "email": email, "password": pw, "username": username}), f"accept {username}")
    return pw


# Staff
_, pw = staff_account("test-manager", "test-manager@hyrak.test", "viewer")
set_membership(org["id"], "test-manager", "manager", title="Service operator, IITH")
rows.append(("Manager / service operator (staff)", "test-manager", pw, "HYRAK viewer + manager on Demo Org (IITH)"))

_, pw = staff_account("test-airspace", "test-airspace@hyrak.test", "viewer")
set_membership(PLATFORM, "test-airspace", "airspace", area=IITH_AREA, title="Airspace, IITH campus")
rows.append(("Airspace manager (staff)", "test-airspace", pw, "HYRAK airspace, area = IITH campus box"))

_, pw = staff_account("test-hyrak-pilot", "test-hyrak-pilot@hyrak.test", "operator")
rows.append(("HYRAK pilot (staff)", "test-hyrak-pilot", pw, "flies HYRAK-owned drones"))

# Customers
for username, ws, role, title, note in [
    ("test-org-owner", org, "owner", "Lab head", "owner of Demo Org (IITH); org console"),
    ("test-org-admin", org, "admin", "Ops lead", "admin of Demo Org (IITH); org console"),
    ("test-org-pilot", org, "pilot", "Pilot", "pilot in Demo Org (IITH)"),
    ("test-org-viewer", org, "viewer", "Observer", "viewer in Demo Org (IITH), view only"),
    ("test-client-pilot", client, "pilot", "Client pilot", "pilot in Demo Client (under Demo Org)"),
    ("test-individual", indiv, "owner", "", "owner of Demo Individual"),
]:
    pw = customer_account(username, f"{username}@hyrak.test", ws["id"], role, title)
    rows.append((f"Customer {role}", username, pw, note))

with open(OUT, "w") as f:
    f.write("# HYRAK local test accounts - generated, gitignored, do not share.\n")
    f.write("# Founder: your own account (not listed). Sign in with username or email (<username>@hyrak.test).\n")
    f.write("# Re-run the seed script to rotate every password.\n\n")
    for role, user, pw, note in rows:
        f.write(f"{role:38} {user:20} {pw:20} # {note}\n")
os.chmod(OUT, 0o600)
print(f"wrote {len(rows)} accounts to {OUT}")
for role, user, _, note in rows:
    print(f"  {role:38} {user:20} {note}")
