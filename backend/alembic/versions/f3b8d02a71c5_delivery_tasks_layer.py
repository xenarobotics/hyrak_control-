"""delivery tasks: pads, api_keys, tasks, task_events + order sequence

Revision ID: f3b8d02a71c5
Revises: e7a4f19c3b6d
Create Date: 2026-08-25

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f3b8d02a71c5'
down_revision: Union[str, Sequence[str], None] = 'e7a4f19c3b6d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('pads',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('lat', sa.Float(), nullable=False),
    sa.Column('lng', sa.Float(), nullable=False),
    sa.Column('notes', sa.String(length=500), nullable=False),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_pads_name'), 'pads', ['name'], unique=True)

    op.create_table('api_keys',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('prefix', sa.String(length=12), nullable=False),
    sa.Column('key_hash', sa.String(length=64), nullable=False),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('last_used_at', sa.DateTime(timezone=True), nullable=True),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_api_keys_key_hash'), 'api_keys', ['key_hash'], unique=True)

    op.create_table('tasks',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('order_no', sa.String(length=20), nullable=False),
    sa.Column('api_key_id', sa.String(length=36), nullable=True),
    sa.Column('client_name', sa.String(length=120), nullable=False),
    sa.Column('status', sa.String(length=12), nullable=False),
    sa.Column('pickup_pad_id', sa.String(length=36), nullable=True),
    sa.Column('dropoff_pad_id', sa.String(length=36), nullable=True),
    sa.Column('pickup_name', sa.String(length=120), nullable=False),
    sa.Column('pickup_lat', sa.Float(), nullable=False),
    sa.Column('pickup_lng', sa.Float(), nullable=False),
    sa.Column('dropoff_name', sa.String(length=120), nullable=False),
    sa.Column('dropoff_lat', sa.Float(), nullable=False),
    sa.Column('dropoff_lng', sa.Float(), nullable=False),
    sa.Column('payload_desc', sa.String(length=300), nullable=False),
    sa.Column('payload_kg', sa.Float(), nullable=False),
    sa.Column('window_start', sa.DateTime(timezone=True), nullable=True),
    sa.Column('window_end', sa.DateTime(timezone=True), nullable=True),
    sa.Column('profile_name', sa.String(length=120), nullable=False),
    sa.Column('mission_id', sa.String(length=36), nullable=True),
    sa.Column('drone_id', sa.String(length=36), nullable=True),
    sa.Column('fail_reason', sa.String(length=500), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['api_key_id'], ['api_keys.id'], ),
    sa.ForeignKeyConstraint(['drone_id'], ['drones.id'], ),
    sa.ForeignKeyConstraint(['dropoff_pad_id'], ['pads.id'], ),
    sa.ForeignKeyConstraint(['mission_id'], ['missions.id'], ),
    sa.ForeignKeyConstraint(['pickup_pad_id'], ['pads.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_tasks_api_key_id'), 'tasks', ['api_key_id'], unique=False)
    op.create_index(op.f('ix_tasks_drone_id'), 'tasks', ['drone_id'], unique=False)
    op.create_index(op.f('ix_tasks_order_no'), 'tasks', ['order_no'], unique=True)
    op.create_index(op.f('ix_tasks_status'), 'tasks', ['status'], unique=False)

    op.create_table('task_events',
    sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
    sa.Column('task_id', sa.String(length=36), nullable=False),
    sa.Column('t', sa.DateTime(timezone=True), nullable=False),
    sa.Column('status', sa.String(length=12), nullable=False),
    sa.Column('note', sa.String(length=500), nullable=False),
    sa.Column('actor', sa.String(length=20), nullable=False),
    sa.ForeignKeyConstraint(['task_id'], ['tasks.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_task_events_task_id'), 'task_events', ['task_id'], unique=False)

    # Order numbers come from a sequence: HYK-00042. A SELECT COUNT would
    # race under concurrent order creation; nextval cannot.
    op.execute("CREATE SEQUENCE IF NOT EXISTS task_order_seq START WITH 1")


def downgrade() -> None:
    """Downgrade schema."""
    op.execute("DROP SEQUENCE IF EXISTS task_order_seq")
    op.drop_index(op.f('ix_task_events_task_id'), table_name='task_events')
    op.drop_table('task_events')
    op.drop_index(op.f('ix_tasks_status'), table_name='tasks')
    op.drop_index(op.f('ix_tasks_order_no'), table_name='tasks')
    op.drop_index(op.f('ix_tasks_drone_id'), table_name='tasks')
    op.drop_index(op.f('ix_tasks_api_key_id'), table_name='tasks')
    op.drop_table('tasks')
    op.drop_index(op.f('ix_api_keys_key_hash'), table_name='api_keys')
    op.drop_table('api_keys')
    op.drop_index(op.f('ix_pads_name'), table_name='pads')
    op.drop_table('pads')
