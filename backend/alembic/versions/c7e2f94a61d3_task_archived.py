"""tasks.archived - operator-side shelving, order stays in the database

Revision ID: c7e2f94a61d3
Revises: a9c4e17d52b8
Create Date: 2026-08-25
"""
import sqlalchemy as sa
from alembic import op

revision = "c7e2f94a61d3"
down_revision = "a9c4e17d52b8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("tasks", sa.Column("archived", sa.Boolean(), nullable=False,
                                     server_default="false"))


def downgrade() -> None:
    op.drop_column("tasks", "archived")
