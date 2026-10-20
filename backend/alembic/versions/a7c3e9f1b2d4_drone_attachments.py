"""attachments: the drone_attachments table

What is fitted to each physical drone (release, gripper, winch, light,
speaker, sprayer, custom) and how the flight controller drives it
(app/attachments, docs/ATTACHMENTS.md). One row per attachment, keyed by
its id (unique across drones: the live app keys state by it) and indexed
by drone, the record itself in a JSONB column. Rows go with their drone
(ON DELETE CASCADE).

Downgrade drops the table.

Revision ID: a7c3e9f1b2d4
Revises: e2f3a4b5c6d7
Create Date: 2026-10-21
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "a7c3e9f1b2d4"
down_revision: Union[str, Sequence[str], None] = "e2f3a4b5c6d7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "drone_attachments",
        sa.Column("id", sa.String(length=16), primary_key=True),
        sa.Column("drone_id", sa.String(length=36),
                  sa.ForeignKey("drones.id", ondelete="CASCADE"), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("data", sa.JSON().with_variant(postgresql.JSONB(), "postgresql"),
                  nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_index("ix_drone_attachments_drone_id", "drone_attachments", ["drone_id"])


def downgrade() -> None:
    op.drop_index("ix_drone_attachments_drone_id", table_name="drone_attachments")
    op.drop_table("drone_attachments")
