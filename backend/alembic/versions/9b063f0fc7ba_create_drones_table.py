"""create drones table

Revision ID: 9b063f0fc7ba
Revises: 
Create Date: 2026-07-17 15:49:08.414367

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '9b063f0fc7ba'
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "drones",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("hardware_uid", sa.String(64), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("is_simulated", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("first_seen", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.Column("last_seen", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
    )
    op.create_index("ix_drones_hardware_uid", "drones", ["hardware_uid"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_drones_hardware_uid", table_name="drones")
    op.drop_table("drones")
