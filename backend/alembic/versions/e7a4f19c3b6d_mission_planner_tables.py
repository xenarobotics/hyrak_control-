"""mission planner: map_features, route_profiles, missions

Revision ID: e7a4f19c3b6d
Revises: d5b91c07af42
Create Date: 2026-08-24

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e7a4f19c3b6d'
down_revision: Union[str, Sequence[str], None] = 'd5b91c07af42'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('map_features',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('category', sa.String(length=30), nullable=False),
    sa.Column('geometry', sa.JSON(), nullable=False),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_map_features_category'), 'map_features', ['category'], unique=False)

    op.create_table('route_profiles',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('description', sa.String(length=500), nullable=False),
    sa.Column('rules', sa.JSON(), nullable=False),
    sa.Column('default_alt_m', sa.Float(), nullable=False),
    sa.Column('default_speed_m_s', sa.Float(), nullable=False),
    sa.Column('builtin', sa.Boolean(), nullable=False),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_route_profiles_name'), 'route_profiles', ['name'], unique=True)

    op.create_table('missions',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('drone_id', sa.String(length=36), nullable=True),
    sa.Column('requested_by', sa.String(length=120), nullable=False),
    sa.Column('profile_id', sa.String(length=36), nullable=True),
    sa.Column('profile_name', sa.String(length=120), nullable=False),
    sa.Column('status', sa.String(length=12), nullable=False),
    sa.Column('start_lat', sa.Float(), nullable=False),
    sa.Column('start_lng', sa.Float(), nullable=False),
    sa.Column('goal_lat', sa.Float(), nullable=False),
    sa.Column('goal_lng', sa.Float(), nullable=False),
    sa.Column('cruise_alt_m', sa.Float(), nullable=False),
    sa.Column('speed_m_s', sa.Float(), nullable=False),
    sa.Column('waypoints', sa.JSON(), nullable=False),
    sa.Column('mission_hash', sa.String(length=64), nullable=False),
    sa.Column('distance_m', sa.Float(), nullable=False),
    sa.Column('est_duration_s', sa.Float(), nullable=False),
    sa.Column('zones', sa.JSON(), nullable=False),
    sa.Column('coverage', sa.JSON(), nullable=False),
    sa.Column('report', sa.JSON(), nullable=False),
    sa.Column('scheduled_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['drone_id'], ['drones.id'], ),
    sa.ForeignKeyConstraint(['profile_id'], ['route_profiles.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_missions_drone_id'), 'missions', ['drone_id'], unique=False)
    op.create_index(op.f('ix_missions_mission_hash'), 'missions', ['mission_hash'], unique=False)
    op.create_index(op.f('ix_missions_status'), 'missions', ['status'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_missions_status'), table_name='missions')
    op.drop_index(op.f('ix_missions_mission_hash'), table_name='missions')
    op.drop_index(op.f('ix_missions_drone_id'), table_name='missions')
    op.drop_table('missions')
    op.drop_index(op.f('ix_route_profiles_name'), table_name='route_profiles')
    op.drop_table('route_profiles')
    op.drop_index(op.f('ix_map_features_category'), table_name='map_features')
    op.drop_table('map_features')
