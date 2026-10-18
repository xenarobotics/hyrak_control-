"""workspaces, memberships, invites, password resets, audit events

Phase 1 of docs/ACCESS_MODEL.md: the flat users.role (viewer / operator /
admin) becomes memberships on a workspace tree with HYRAK at the root.

users also gain email_verified (false for everyone): an email is trusted
for invites and lookups only once the inviter or a founder vouched for it.

Data carried over:
  * one platform workspace "HYRAK" with the fixed PLATFORM_WORKSPACE_ID
  * users.role admin -> founder, operator -> pilot, viewer -> viewer, all on
    HYRAK; then users.role is dropped
  * every zone -> layer 'regulatory' on HYRAK
  * every drone -> HYRAK

Downgrade puts users.role back from memberships with the same mapping the
compatibility role uses (founder -> admin; HYRAK pilot or manager anywhere
-> operator; anything else -> viewer) and drops everything this added.

Revision ID: f6c2a8d4e1b7
Revises: e4b7a2c9d013
Create Date: 2026-10-18
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "f6c2a8d4e1b7"
down_revision: Union[str, Sequence[str], None] = "e4b7a2c9d013"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Must equal app.db.models.PLATFORM_WORKSPACE_ID. Copied, not imported: a
# migration has to keep meaning the same thing if the app constant moves.
PLATFORM_ID = "00000000-0000-0000-0000-000000000001"


def upgrade() -> None:
    # ── workspaces ────────────────────────────────────────────────────────
    op.create_table(
        "workspaces",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("parent_id", sa.String(length=36), nullable=True),
        sa.Column("path", sa.String(length=400), nullable=False),
        sa.Column("operating_area", JSONB(), nullable=True),
        sa.Column("disabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_by", sa.String(length=36), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.CheckConstraint("kind IN ('platform', 'organization', 'individual', 'client')",
                           name="ck_workspaces_kind"),
        sa.CheckConstraint("(kind = 'platform') = (parent_id IS NULL)",
                           name="ck_workspaces_platform_root"),
        sa.ForeignKeyConstraint(["parent_id"], ["workspaces.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_workspaces_parent_id", "workspaces", ["parent_id"])
    # varchar_pattern_ops so `path LIKE '/root/org/%'` can use the index
    # whatever the database collation is.
    op.create_index("ix_workspaces_path", "workspaces", ["path"],
                    postgresql_ops={"path": "varchar_pattern_ops"})
    op.create_index("ux_workspaces_single_platform", "workspaces", ["kind"], unique=True,
                    postgresql_where=sa.text("kind = 'platform'"))

    # ── memberships ───────────────────────────────────────────────────────
    op.create_table(
        "memberships",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("workspace_id", sa.String(length=36), nullable=False),
        sa.Column("role", sa.String(length=16), nullable=False),
        sa.Column("area", JSONB(), nullable=True),
        sa.Column("title", sa.String(length=120), nullable=False, server_default=""),
        sa.Column("created_by", sa.String(length=36), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.CheckConstraint(
            "role IN ('founder', 'airspace', 'manager', 'owner', 'admin', 'pilot', 'viewer')",
            name="ck_memberships_role",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "workspace_id", name="uq_memberships_user_workspace"),
    )
    op.create_index("ix_memberships_user_id", "memberships", ["user_id"])
    op.create_index("ix_memberships_workspace_id", "memberships", ["workspace_id"])

    # ── invites ───────────────────────────────────────────────────────────
    op.create_table(
        "invites",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("workspace_id", sa.String(length=36), nullable=False),
        sa.Column("role", sa.String(length=16), nullable=False),
        sa.Column("area", JSONB(), nullable=True),
        sa.Column("title", sa.String(length=120), nullable=False, server_default=""),
        sa.Column("email", sa.String(length=254), nullable=True),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("created_by", sa.String(length=36), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("accepted_by", sa.String(length=36), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_invites_workspace_id", "invites", ["workspace_id"])
    op.create_index("ix_invites_token_hash", "invites", ["token_hash"], unique=True)

    # ── password_resets ───────────────────────────────────────────────────
    op.create_table(
        "password_resets",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("created_by", sa.String(length=36), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_password_resets_user_id", "password_resets", ["user_id"])
    op.create_index("ix_password_resets_token_hash", "password_resets", ["token_hash"], unique=True)

    # ── audit_events ──────────────────────────────────────────────────────
    op.create_table(
        "audit_events",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("actor_id", sa.String(length=36), nullable=True),
        sa.Column("actor_name", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("workspace_id", sa.String(length=36), nullable=True),
        sa.Column("action", sa.String(length=64), nullable=False),
        sa.Column("target_type", sa.String(length=32), nullable=False, server_default=""),
        sa.Column("target_id", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("detail", JSONB(), nullable=True),
        sa.Column("ip", sa.String(length=64), nullable=False, server_default=""),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_audit_events_at", "audit_events", ["at"])
    op.create_index("ix_audit_events_workspace_id", "audit_events", ["workspace_id"])

    # ── users: email, display_name, last_login_at ─────────────────────────
    op.add_column("users", sa.Column("email", sa.String(length=254), nullable=True))
    op.add_column("users", sa.Column("display_name", sa.String(length=120), nullable=False,
                                     server_default=""))
    op.add_column("users", sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True))
    # An email is an unverified claim until the inviter (email-locked
    # invite) or a founder vouches for it; nobody starts verified.
    op.add_column("users", sa.Column("email_verified", sa.Boolean(), nullable=False,
                                     server_default=sa.false()))
    op.create_index("ix_users_email", "users", ["email"], unique=True)
    op.create_check_constraint("ck_users_email_lower", "users", "email = lower(email)")

    # ── data: the platform row and everyone's role -> a membership on it ──
    op.execute(
        "INSERT INTO workspaces (id, kind, name, parent_id, path, disabled, created_at) "
        f"VALUES ('{PLATFORM_ID}', 'platform', 'HYRAK', NULL, '/{PLATFORM_ID}/', false, now())"
    )
    op.execute(
        "INSERT INTO memberships (id, user_id, workspace_id, role, title, created_at) "
        f"SELECT gen_random_uuid()::text, u.id, '{PLATFORM_ID}', "
        "       CASE u.role WHEN 'admin' THEN 'founder' "
        "                   WHEN 'operator' THEN 'pilot' "
        "                   ELSE 'viewer' END, "
        "       '', now() "
        "FROM users u"
    )
    op.drop_constraint("ck_users_role", "users", type_="check")
    op.drop_column("users", "role")

    # ── zones: layer + workspace + who/when ───────────────────────────────
    op.add_column("zones", sa.Column("layer", sa.String(length=16), nullable=False,
                                     server_default="regulatory"))
    op.add_column("zones", sa.Column("workspace_id", sa.String(length=36), nullable=False,
                                     server_default=PLATFORM_ID))
    op.add_column("zones", sa.Column("created_by", sa.String(length=36), nullable=True))
    op.add_column("zones", sa.Column("updated_by", sa.String(length=36), nullable=True))
    op.add_column("zones", sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True))
    op.create_check_constraint("ck_zones_layer", "zones",
                               "layer IN ('regulatory', 'area', 'site')")
    op.create_foreign_key("fk_zones_workspace_id", "zones", "workspaces",
                          ["workspace_id"], ["id"], ondelete="RESTRICT")
    op.create_index("ix_zones_workspace_id", "zones", ["workspace_id"])

    # ── drones: owning workspace ──────────────────────────────────────────
    op.add_column("drones", sa.Column("workspace_id", sa.String(length=36), nullable=False,
                                      server_default=PLATFORM_ID))
    op.create_foreign_key("fk_drones_workspace_id", "drones", "workspaces",
                          ["workspace_id"], ["id"], ondelete="RESTRICT")
    op.create_index("ix_drones_workspace_id", "drones", ["workspace_id"])


def downgrade() -> None:
    op.drop_index("ix_drones_workspace_id", table_name="drones")
    op.drop_constraint("fk_drones_workspace_id", "drones", type_="foreignkey")
    op.drop_column("drones", "workspace_id")

    op.drop_index("ix_zones_workspace_id", table_name="zones")
    op.drop_constraint("fk_zones_workspace_id", "zones", type_="foreignkey")
    op.drop_constraint("ck_zones_layer", "zones", type_="check")
    for col in ("updated_at", "updated_by", "created_by", "workspace_id", "layer"):
        op.drop_column("zones", col)

    # users.role back from memberships, with the compatibility mapping.
    op.add_column("users", sa.Column("role", sa.String(length=16), nullable=False,
                                     server_default="viewer"))
    op.execute(
        "UPDATE users u SET role = CASE "
        "  WHEN EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id "
        "               AND m.role = 'founder') THEN 'admin' "
        "  WHEN EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id "
        f"              AND ((m.role = 'pilot' AND m.workspace_id = '{PLATFORM_ID}') "
        "                    OR m.role = 'manager')) THEN 'operator' "
        "  ELSE 'viewer' END"
    )
    op.create_check_constraint("ck_users_role", "users", "role IN ('admin', 'operator', 'viewer')")
    op.drop_constraint("ck_users_email_lower", "users", type_="check")
    op.drop_index("ix_users_email", table_name="users")
    for col in ("email_verified", "last_login_at", "display_name", "email"):
        op.drop_column("users", col)

    op.drop_index("ix_audit_events_workspace_id", table_name="audit_events")
    op.drop_index("ix_audit_events_at", table_name="audit_events")
    op.drop_table("audit_events")
    op.drop_index("ix_password_resets_token_hash", table_name="password_resets")
    op.drop_index("ix_password_resets_user_id", table_name="password_resets")
    op.drop_table("password_resets")
    op.drop_index("ix_invites_token_hash", table_name="invites")
    op.drop_index("ix_invites_workspace_id", table_name="invites")
    op.drop_table("invites")
    op.drop_index("ix_memberships_workspace_id", table_name="memberships")
    op.drop_index("ix_memberships_user_id", table_name="memberships")
    op.drop_table("memberships")
    op.drop_index("ux_workspaces_single_platform", table_name="workspaces")
    op.drop_index("ix_workspaces_path", table_name="workspaces")
    op.drop_index("ix_workspaces_parent_id", table_name="workspaces")
    op.drop_table("workspaces")
