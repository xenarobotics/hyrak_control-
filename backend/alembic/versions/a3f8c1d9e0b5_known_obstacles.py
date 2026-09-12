"""known_obstacles - persistent shared hazard map

Revision ID: a3f8c1d9e0b5
Revises: c2d5e8b1f7a3
Create Date: 2026-09-12
"""
from alembic import op
import sqlalchemy as sa

revision = "a3f8c1d9e0b5"
down_revision = "c2d5e8b1f7a3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "known_obstacles",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("lat", sa.Float(), nullable=False),
        sa.Column("lng", sa.Float(), nullable=False),
        sa.Column("radius_m", sa.Float(), nullable=True),
        sa.Column("top_m", sa.Float(), nullable=True),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("hits", sa.Integer(), nullable=True),
        sa.Column("source", sa.String(length=20), nullable=True),
        sa.Column("first_seen", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_seen", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_known_obstacles_lat_lng", "known_obstacles",
                    ["lat", "lng"])


def downgrade() -> None:
    op.drop_index("ix_known_obstacles_lat_lng", table_name="known_obstacles")
    op.drop_table("known_obstacles")
