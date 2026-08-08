"""plate_events vehicle image + plate pixel width

Revision ID: c3d7e18b52a9
Revises: 8a1f2c4e9b31
Create Date: 2026-08-07 16:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c3d7e18b52a9'
down_revision: Union[str, Sequence[str], None] = '8a1f2c4e9b31'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # server_default on plate_px_w is required, not cosmetic: it is a NOT NULL
    # column being added to a table that already has rows, and Postgres has no
    # value to put in them without one. 0 reads correctly as "plate width was
    # never recorded for this row" rather than implying a measured zero.
    op.add_column('plate_events', sa.Column(
        'plate_px_w', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('plate_events', sa.Column(
        'vehicle_image_path', sa.String(length=500), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('plate_events', 'vehicle_image_path')
    op.drop_column('plate_events', 'plate_px_w')
