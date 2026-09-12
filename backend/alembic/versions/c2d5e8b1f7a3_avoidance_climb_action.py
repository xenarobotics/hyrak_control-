"""avoidance_events: allow the 'climb' action (3D avoidance)

Revision ID: c2d5e8b1f7a3
Revises: f1a9c3e7b2d4
Create Date: 2026-09-12
"""
from alembic import op

revision = "c2d5e8b1f7a3"
down_revision = "f1a9c3e7b2d4"
branch_labels = None
depends_on = None

_NEW = "action IN ('clear','hold','reroute','climb','return')"
_OLD = "action IN ('clear','hold','reroute','return')"


def _swap(check: str) -> None:
    op.drop_constraint("ck_avoidance_events_action", "avoidance_events",
                       type_="check")
    op.create_check_constraint("ck_avoidance_events_action",
                               "avoidance_events", check)


def upgrade() -> None:
    _swap(_NEW)


def downgrade() -> None:
    _swap(_OLD)
