"""JSONB columns, dispatcher indexes, status CHECKs, held-takeoff flag

Batches the platform-audit database findings into one migration:
  - every JSON column -> JSONB (binary, indexable, no reparse on read)
  - composite ix_tasks_status_drone_id + ix_tasks_archived (dispatcher hot
    queries), ix_permits_status (approval queue / fleet gate)
  - CHECK constraints pinning tasks.status and missions.status to their
    lifecycle vocabularies at the storage layer
  - missions.held_takeoff so a takeoff deferred for overhead traffic survives
    a server restart instead of stranding the aircraft

Revision ID: d8e4f1a2b3c4
Revises: c7e2f94a61d3
Create Date: 2026-09-09
"""
from alembic import op
import sqlalchemy as sa

revision = "d8e4f1a2b3c4"
down_revision = "c7e2f94a61d3"
branch_labels = None
depends_on = None

# (table, column) for every JSON column in the schema.
_JSON_COLS = [
    ("zones", "geometry"),
    ("map_features", "geometry"),
    ("route_profiles", "rules"),
    ("crowd_snapshots", "section_counts"),
    ("plate_events", "vehicle_box"),
    ("plate_events", "plate_box"),
    ("missions", "waypoints"),
    ("missions", "zones"),
    ("missions", "coverage"),
    ("missions", "report"),
    ("permits", "waypoints"),
    ("permits", "zones"),
]


def upgrade() -> None:
    # JSON -> JSONB. USING col::jsonb rewrites in place; a column already JSONB
    # is left as-is (the cast is a no-op), so this is safe to re-run.
    for table, col in _JSON_COLS:
        op.execute(
            f'ALTER TABLE {table} ALTER COLUMN "{col}" '
            f'TYPE JSONB USING "{col}"::jsonb'
        )

    op.add_column(
        "missions",
        sa.Column("held_takeoff", sa.Boolean(), nullable=False,
                  server_default=sa.text("false")),
    )

    op.create_index("ix_tasks_status_drone_id", "tasks", ["status", "drone_id"])
    op.create_index("ix_tasks_archived", "tasks", ["archived"])
    op.create_index("ix_permits_status", "permits", ["status"])

    op.create_check_constraint(
        "ck_tasks_status", "tasks",
        "status IN ('received','planned','assigned','to_pickup','loading',"
        "'to_dropoff','delivered','returned','failed','cancelled')",
    )
    op.create_check_constraint(
        "ck_missions_status", "missions",
        "status IN ('planned','uploaded','flying','completed','aborted',"
        "'failed')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_missions_status", "missions", type_="check")
    op.drop_constraint("ck_tasks_status", "tasks", type_="check")
    op.drop_index("ix_permits_status", table_name="permits")
    op.drop_index("ix_tasks_archived", table_name="tasks")
    op.drop_index("ix_tasks_status_drone_id", table_name="tasks")
    op.drop_column("missions", "held_takeoff")
    for table, col in _JSON_COLS:
        op.execute(
            f'ALTER TABLE {table} ALTER COLUMN "{col}" '
            f'TYPE JSON USING "{col}"::json'
        )
