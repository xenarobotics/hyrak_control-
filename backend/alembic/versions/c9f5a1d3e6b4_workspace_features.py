"""workspace features (paid extras, e.g. the cloud simulator)

workspaces.features: a JSON object of entitlements a founder switches on
per workspace, e.g. {"cloud_sim": true} (docs/ACCESS_MODEL.md 8b). Every
existing workspace starts with none.

Revision ID: c9f5a1d3e6b4
Revises: f6c2a8d4e1b7
Create Date: 2026-10-18
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "c9f5a1d3e6b4"
down_revision: Union[str, Sequence[str], None] = "f6c2a8d4e1b7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("workspaces", sa.Column("features", JSONB(), nullable=False,
                                          server_default=sa.text("'{}'::jsonb")))


def downgrade() -> None:
    op.drop_column("workspaces", "features")
