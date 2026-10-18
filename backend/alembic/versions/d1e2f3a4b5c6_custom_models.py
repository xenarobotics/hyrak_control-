"""custom models: the models and model_versions tables

docs/custom_models/DESIGN.md section 0 (step 1): a workspace's model
library. `models` is one card (an uploaded ONNX file or a public Hugging
Face repo pinned to a commit), `model_versions` one received file of it
with what its check found. Both go with their workspace (cascade); the
files themselves live under HYRAK_DATA_DIR, not in the database. A
published model is pinned: `published_version` and the `catalogue`
snapshot are what other workspaces see and run, and only a founder sets
or moves them.

Revision ID: d1e2f3a4b5c6
Revises: a7d3e9b1c4f2
Create Date: 2026-10-18
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "d1e2f3a4b5c6"
down_revision: Union[str, Sequence[str], None] = "a7d3e9b1c4f2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "models",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("workspace_id", sa.String(length=36),
                  sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("description", sa.String(length=500), nullable=False, server_default=""),
        sa.Column("task", sa.String(length=16), nullable=False, server_default=""),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("hf_repo", sa.String(length=200), nullable=True),
        sa.Column("hf_revision", sa.String(length=64), nullable=True),
        sa.Column("hf_file", sa.String(length=300), nullable=True),
        sa.Column("status", sa.String(length=12), nullable=False),
        sa.Column("error", sa.String(length=500), nullable=False, server_default=""),
        sa.Column("error_hint", sa.String(length=500), nullable=False, server_default=""),
        sa.Column("current_version", sa.Integer(), nullable=True),
        sa.Column("published", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("published_version", sa.Integer(), nullable=True),
        sa.Column("catalogue", JSONB(), nullable=True),
        sa.Column("settings", JSONB(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("created_by", sa.String(length=36), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("source IN ('upload', 'huggingface')", name="ck_models_source"),
        sa.CheckConstraint("status IN ('checking', 'ready', 'failed')", name="ck_models_status"),
    )
    op.create_index("ix_models_workspace_id", "models", ["workspace_id"])
    op.create_index("ix_models_published", "models", ["published"])

    op.create_table(
        "model_versions",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("model_id", sa.String(length=36),
                  sa.ForeignKey("models.id", ondelete="CASCADE"), nullable=False),
        sa.Column("n", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False, server_default=sa.text("0")),
        sa.Column("file_name", sa.String(length=300), nullable=False, server_default=""),
        sa.Column("hf_revision", sa.String(length=64), nullable=True),
        sa.Column("status", sa.String(length=12), nullable=False),
        sa.Column("error", sa.String(length=500), nullable=False, server_default=""),
        sa.Column("error_hint", sa.String(length=500), nullable=False, server_default=""),
        sa.Column("task", sa.String(length=16), nullable=False, server_default=""),
        sa.Column("input_shape", JSONB(), nullable=True),
        sa.Column("labels", JSONB(), nullable=False, server_default=sa.text("'[]'")),
        sa.Column("details", JSONB(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("latency_ms", sa.Float(), nullable=True),
        sa.Column("gpu_mem_mb", sa.Float(), nullable=True),
        sa.Column("preview_path", sa.String(length=500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("model_id", "n", name="uq_model_versions_model_n"),
        sa.CheckConstraint("status IN ('checking', 'ready', 'failed')",
                           name="ck_model_versions_status"),
    )
    op.create_index("ix_model_versions_model_id", "model_versions", ["model_id"])


def downgrade() -> None:
    # The rows go; the files under HYRAK_DATA_DIR stay for an operator to
    # remove (a downgrade must never delete customer files by itself).
    op.drop_index("ix_model_versions_model_id", table_name="model_versions")
    op.drop_table("model_versions")
    op.drop_index("ix_models_published", table_name="models")
    op.drop_index("ix_models_workspace_id", table_name="models")
    op.drop_table("models")
