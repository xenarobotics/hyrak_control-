"""avoidance_events - obstacle-avoidance state-change log

Revision ID: f1a9c3e7b2d4
Revises: d8e4f1a2b3c4
Create Date: 2026-09-12
"""
from alembic import op
import sqlalchemy as sa

revision = "f1a9c3e7b2d4"
down_revision = "d8e4f1a2b3c4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "avoidance_events",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("drone_id", sa.String(length=36), nullable=False,
                  server_default=""),
        sa.Column("t", sa.DateTime(timezone=True), nullable=True),
        sa.Column("action", sa.String(length=12), nullable=False),
        sa.Column("state", sa.String(length=12), nullable=False,
                  server_default=""),
        sa.Column("reason", sa.String(length=500), nullable=False,
                  server_default=""),
        sa.Column("armed", sa.Boolean(), nullable=True),
        sa.Column("obstacle_lat", sa.Float(), nullable=True),
        sa.Column("obstacle_lng", sa.Float(), nullable=True),
        sa.Column("obstacle_radius_m", sa.Float(), nullable=True),
        sa.Column("fused_distance_m", sa.Float(), nullable=True),
        sa.CheckConstraint(
            "action IN ('clear','hold','reroute','return')",
            name="ck_avoidance_events_action"),
    )
    op.create_index("ix_avoidance_events_drone_t", "avoidance_events",
                    ["drone_id", "t"])


def downgrade() -> None:
    op.drop_index("ix_avoidance_events_drone_t", table_name="avoidance_events")
    op.drop_table("avoidance_events")
