"""missions, pads, route profiles and permits per workspace; permit windows

Phase 2b of docs/ACCESS_MODEL.md (section 8b): customers plan their own
missions and request permits.

  * missions, pads, route_profiles, permits gain workspace_id (FK, cascade
    with the workspace; every existing row goes to HYRAK).
  * missions gain a name (saved plans).
  * pads and route_profiles names become unique per workspace instead of
    globally (two customers may both have a "Home" pad).
  * permits: drone_id becomes nullable (null = any drone of the
    workspace), plus mission_id, area (area permits), the time window
    valid_from / valid_until, and who requested and who decided. Existing
    permits keep no window: they stay valid as they were.
  * zones gain permission_required (red zones only: whether a permit can
    be requested at all). Every existing zone admits one, as today.

Revision ID: a7d3e9b1c4f2
Revises: b8e4f0c2d5a3
Create Date: 2026-10-18
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "a7d3e9b1c4f2"
down_revision: Union[str, Sequence[str], None] = "b8e4f0c2d5a3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Must equal app.db.models.PLATFORM_WORKSPACE_ID (copied, see f6c2a8d4e1b7).
PLATFORM_ID = "00000000-0000-0000-0000-000000000001"

_OWNED = ("missions", "pads", "route_profiles", "permits")


def _workspace_column(table: str) -> None:
    op.add_column(table, sa.Column("workspace_id", sa.String(length=36), nullable=False,
                                   server_default=PLATFORM_ID))
    op.create_foreign_key(f"fk_{table}_workspace_id", table, "workspaces",
                          ["workspace_id"], ["id"], ondelete="CASCADE")
    op.create_index(f"ix_{table}_workspace_id", table, ["workspace_id"])


def upgrade() -> None:
    for table in _OWNED:
        _workspace_column(table)

    op.add_column("missions", sa.Column("name", sa.String(length=120), nullable=False,
                                        server_default=""))

    # Names unique per workspace, not globally.
    for table in ("pads", "route_profiles"):
        op.drop_index(f"ix_{table}_name", table_name=table)
        op.create_index(f"ix_{table}_name", table, ["name"], unique=False)
        op.create_unique_constraint(f"uq_{table}_workspace_name", table, ["workspace_id", "name"])

    op.alter_column("permits", "drone_id", existing_type=sa.String(length=36), nullable=True)
    op.add_column("permits", sa.Column("mission_id", sa.String(length=36), nullable=True))
    op.create_foreign_key("fk_permits_mission_id", "permits", "missions",
                          ["mission_id"], ["id"], ondelete="SET NULL")
    op.add_column("permits", sa.Column("area", JSONB(), nullable=True))
    op.add_column("permits", sa.Column("valid_from", sa.DateTime(timezone=True), nullable=True))
    op.add_column("permits", sa.Column("valid_until", sa.DateTime(timezone=True), nullable=True))
    op.add_column("permits", sa.Column("requested_by", sa.String(length=36), nullable=True))
    op.add_column("permits", sa.Column("requested_by_name", sa.String(length=120),
                                       nullable=False, server_default=""))
    op.add_column("permits", sa.Column("decided_by", sa.String(length=36), nullable=True))
    op.add_column("permits", sa.Column("decided_by_name", sa.String(length=120),
                                       nullable=False, server_default=""))
    op.add_column("permits", sa.Column("decision_note", sa.String(length=500),
                                       nullable=False, server_default=""))

    op.add_column("zones", sa.Column("permission_required", sa.Boolean(), nullable=False,
                                     server_default=sa.true()))


def downgrade() -> None:
    op.drop_column("zones", "permission_required")

    for col in ("decision_note", "decided_by_name", "decided_by", "requested_by_name",
                "requested_by", "valid_until", "valid_from", "area"):
        op.drop_column("permits", col)
    op.drop_constraint("fk_permits_mission_id", "permits", type_="foreignkey")
    op.drop_column("permits", "mission_id")
    # Area permits and "any drone" permits have no drone to fall back to.
    op.execute("DELETE FROM permits WHERE drone_id IS NULL")
    op.alter_column("permits", "drone_id", existing_type=sa.String(length=36), nullable=False)

    # Customer pads / profiles / missions / permits do not survive a
    # downgrade: the old schema has no owner column, and keeping them would
    # hand them to HYRAK (and break the global name uniqueness).
    op.execute(f"DELETE FROM permits WHERE workspace_id <> '{PLATFORM_ID}'")
    op.execute(f"UPDATE tasks SET mission_id = NULL WHERE mission_id IN "
               f"(SELECT id FROM missions WHERE workspace_id <> '{PLATFORM_ID}')")
    op.execute(f"UPDATE tasks SET mission_to_pickup_id = NULL WHERE mission_to_pickup_id IN "
               f"(SELECT id FROM missions WHERE workspace_id <> '{PLATFORM_ID}')")
    op.execute(f"DELETE FROM missions WHERE workspace_id <> '{PLATFORM_ID}'")
    op.execute(f"DELETE FROM pads WHERE workspace_id <> '{PLATFORM_ID}'")
    op.execute(f"UPDATE missions SET profile_id = NULL WHERE profile_id IN "
               f"(SELECT id FROM route_profiles WHERE workspace_id <> '{PLATFORM_ID}')")
    op.execute(f"DELETE FROM route_profiles WHERE workspace_id <> '{PLATFORM_ID}'")

    for table in ("pads", "route_profiles"):
        op.drop_constraint(f"uq_{table}_workspace_name", table, type_="unique")
        op.drop_index(f"ix_{table}_name", table_name=table)
        op.create_index(f"ix_{table}_name", table, ["name"], unique=True)

    op.drop_column("missions", "name")

    for table in reversed(_OWNED):
        op.drop_index(f"ix_{table}_workspace_id", table_name=table)
        op.drop_constraint(f"fk_{table}_workspace_id", table, type_="foreignkey")
        op.drop_column(table, "workspace_id")
