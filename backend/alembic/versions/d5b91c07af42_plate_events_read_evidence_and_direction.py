"""plate_events read evidence + direction of travel

Revision ID: d5b91c07af42
Revises: c3d7e18b52a9
Create Date: 2026-08-09 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd5b91c07af42'
down_revision: Union[str, Sequence[str], None] = 'c3d7e18b52a9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # server_default is required on every NOT NULL column here for the same
    # reason plate_px_w needed one: these are being added to a table that
    # already has rows, and Postgres has no value to put in them otherwise.
    #
    # The defaults are chosen so an OLD row reads correctly rather than
    # misleadingly: 0 votes is "agreement was never recorded", false grammar is
    # "not checked", false against_flow is "no wrong-way finding" — which is
    # true of every row written before this migration, since nothing was
    # looking.
    op.add_column('plate_events', sa.Column(
        'plate_votes', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('plate_events', sa.Column(
        'plate_grammar_ok', sa.Boolean(), nullable=False,
        server_default=sa.false()))
    # Nullable, unlike the others: there is a real difference between "was not
    # moving fast enough for a heading to mean anything" and any particular
    # bearing, and 0 would read as due North.
    op.add_column('plate_events', sa.Column(
        'heading_deg', sa.Float(), nullable=True))
    op.add_column('plate_events', sa.Column(
        'against_flow', sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('plate_events', 'against_flow')
    op.drop_column('plate_events', 'heading_deg')
    op.drop_column('plate_events', 'plate_grammar_ok')
    op.drop_column('plate_events', 'plate_votes')
