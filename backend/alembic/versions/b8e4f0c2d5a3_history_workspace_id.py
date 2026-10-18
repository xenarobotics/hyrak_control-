"""history rows belong to a workspace

Phase 2b of docs/ACCESS_MODEL.md (section 8b): flights, crowd snapshots and
alerts, plate events and face sightings get a workspace_id, stamped at
record time (flights from the drone's workspace, the vision tables from the
session's), so customers read their own history and staff read it per
workspace by permission.

Every existing row goes to HYRAK: they were all recorded by staff sessions
before customers could open one. The column is a plain indexed string, not
a foreign key, like audit_events.workspace_id: history must never fail to
write, and a deleted workspace's rows stay readable by founders.

Downgrade drops the columns and their indexes.

Revision ID: b8e4f0c2d5a3
Revises: f6c2a8d4e1b7
Create Date: 2026-10-18
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "b8e4f0c2d5a3"
down_revision: Union[str, Sequence[str], None] = "f6c2a8d4e1b7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Must equal app.db.models.PLATFORM_WORKSPACE_ID. Copied, not imported: a
# migration has to keep meaning the same thing if the app constant moves.
PLATFORM_ID = "00000000-0000-0000-0000-000000000001"

TABLES = ("flights", "crowd_snapshots", "crowd_alerts", "plate_events", "person_sightings")


def upgrade() -> None:
    for table in TABLES:
        # NOT NULL with a server default: Postgres fills every existing row
        # with HYRAK's id as part of the ADD COLUMN.
        op.add_column(table, sa.Column("workspace_id", sa.String(length=36), nullable=False,
                                       server_default=PLATFORM_ID))
        op.create_index(f"ix_{table}_workspace_id", table, ["workspace_id"])


def downgrade() -> None:
    for table in reversed(TABLES):
        op.drop_index(f"ix_{table}_workspace_id", table_name=table)
        op.drop_column(table, "workspace_id")
