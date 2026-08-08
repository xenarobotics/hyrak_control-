"""plate_events vehicle_id

Revision ID: 8a1f2c4e9b31
Revises: 27bf66c11c2c
Create Date: 2026-08-07 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '8a1f2c4e9b31'
down_revision: Union[str, Sequence[str], None] = '27bf66c11c2c'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Nullable, no server_default needed: existing rows simply predate the
    # feature and NULL reads correctly as "no persistent vehicle identity was
    # assigned to this reading".
    op.add_column('plate_events', sa.Column('vehicle_id', sa.String(length=20), nullable=True))
    op.create_index(op.f('ix_plate_events_vehicle_id'), 'plate_events', ['vehicle_id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_plate_events_vehicle_id'), table_name='plate_events')
    op.drop_column('plate_events', 'vehicle_id')
