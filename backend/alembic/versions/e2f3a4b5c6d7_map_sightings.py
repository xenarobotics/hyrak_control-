"""detections on the map: the map_sightings table

Every detection from an AI model gets a ground position estimated from the
drone's telemetry at capture (app/mapdetect). Repeated detections of one
object fold into one sighting; with "Record to map" on, sightings are kept
here per session and flight, under the session's workspace (a plain indexed
string like the phase 2b history columns, docs/ACCESS_MODEL.md 8b).

Downgrade drops the table.

Revision ID: e2f3a4b5c6d7
Revises: d1e2f3a4b5c6
Create Date: 2026-10-18
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "e2f3a4b5c6d7"
down_revision: Union[str, Sequence[str], None] = "d1e2f3a4b5c6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Must equal app.db.models.PLATFORM_WORKSPACE_ID (copied, not imported).
PLATFORM_ID = "00000000-0000-0000-0000-000000000001"


def upgrade() -> None:
    op.create_table(
        "map_sightings",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("session_id", sa.String(length=36), nullable=False),
        sa.Column("flight_id", sa.String(length=36), nullable=True),
        sa.Column("workspace_id", sa.String(length=36), nullable=False,
                  server_default=PLATFORM_ID),
        sa.Column("drone_id", sa.String(length=36), nullable=True),
        sa.Column("source", sa.String(length=80), nullable=False),
        sa.Column("model_name", sa.String(length=120), nullable=False),
        sa.Column("label", sa.String(length=80), nullable=False),
        sa.Column("task", sa.String(length=16), nullable=False),
        sa.Column("lat", sa.Float(), nullable=False),
        sa.Column("lng", sa.Float(), nullable=False),
        sa.Column("accuracy_m", sa.Float(), nullable=False),
        sa.Column("count", sa.Integer(), nullable=False),
        sa.Column("first_seen", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen", sa.DateTime(timezone=True), nullable=False),
        sa.Column("best_score", sa.Float(), nullable=True),
        sa.Column("agl_m", sa.Float(), nullable=True),
        sa.Column("angle_source", sa.String(length=16), nullable=False),
        sa.Column("thumb", sa.String(length=60000), nullable=True),
        sa.CheckConstraint("task IN ('detect', 'classify')", name="ck_map_sightings_task"),
    )
    op.create_index("ix_map_sightings_session_id", "map_sightings", ["session_id"])
    op.create_index("ix_map_sightings_flight_id", "map_sightings", ["flight_id"])
    op.create_index("ix_map_sightings_workspace_id", "map_sightings", ["workspace_id"])


def downgrade() -> None:
    op.drop_index("ix_map_sightings_workspace_id", table_name="map_sightings")
    op.drop_index("ix_map_sightings_flight_id", table_name="map_sightings")
    op.drop_index("ix_map_sightings_session_id", table_name="map_sightings")
    op.drop_table("map_sightings")
