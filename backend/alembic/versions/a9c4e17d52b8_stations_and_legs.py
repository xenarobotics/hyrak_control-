"""pads.kind (pad|station) and tasks.mission_to_pickup_id (positioning leg)

Revision ID: a9c4e17d52b8
Revises: f3b8d02a71c5
Create Date: 2026-08-25
"""
import sqlalchemy as sa
from alembic import op

revision = "a9c4e17d52b8"
down_revision = "f3b8d02a71c5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("pads", sa.Column("kind", sa.String(16), nullable=False,
                                    server_default="pad"))
    op.add_column("tasks", sa.Column("mission_to_pickup_id", sa.String(36),
                                     sa.ForeignKey("missions.id"), nullable=True))


def downgrade() -> None:
    op.drop_column("tasks", "mission_to_pickup_id")
    op.drop_column("pads", "kind")
