"""avoidance_events: allow the local planner's actions ('avoid', 'resume', 'track')

The grid + Offboard local planner (2026-09-26) records 'avoid' (took the
aircraft) and 'resume' (handed it back to the mission). The check constraint
only knew the legacy planner's actions, so every one of those inserts was
rejected - the Mission-tab timeline showed nothing for the new planner.

Revision ID: b7e2c4a9d1f6
Revises: a3f8c1d9e0b5
Create Date: 2026-09-26
"""
from alembic import op

revision = "b7e2c4a9d1f6"
down_revision = "a3f8c1d9e0b5"
branch_labels = None
depends_on = None

_NEW = "action IN ('clear','hold','reroute','climb','return','avoid','resume','track')"
_OLD = "action IN ('clear','hold','reroute','climb','return')"


def _swap(check: str) -> None:
    op.drop_constraint("ck_avoidance_events_action", "avoidance_events", type_="check")
    op.create_check_constraint("ck_avoidance_events_action", "avoidance_events", check)


def upgrade() -> None:
    _swap(_NEW)


def downgrade() -> None:
    # Rows the old constraint cannot hold must go first, or the swap fails.
    op.execute("DELETE FROM avoidance_events WHERE action IN ('avoid','resume','track')")
    _swap(_OLD)
