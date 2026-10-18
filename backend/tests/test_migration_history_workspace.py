"""
Revision b8e4f0c2d5a3 (docs/ACCESS_MODEL.md 8b) as offline SQL: no database
needed. The live upgrade / downgrade / backfill runs against Postgres in
test_auth_dbstore.py (opt in).
"""
import os
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
TABLES = ("flights", "crowd_snapshots", "crowd_alerts", "plate_events", "person_sightings")
HYRAK = "00000000-0000-0000-0000-000000000001"


def _alembic_sql(*args) -> str:
    env = {**os.environ, "DATABASE_URL": "postgresql+asyncpg://offline@localhost/offline_only"}
    out = subprocess.run([sys.executable, "-m", "alembic", *args, "--sql"], cwd=BACKEND, env=env,
                         capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    return out.stdout


def test_revision_chain():
    from alembic.config import Config
    from alembic.script import ScriptDirectory
    script = ScriptDirectory.from_config(Config(str(BACKEND / "alembic.ini")))
    rev = script.get_revision("b8e4f0c2d5a3")
    # Linearized after the cloud-SITL migration when the 2b streams merged.
    assert rev.down_revision == "c9f5a1d3e6b4"
    assert len(script.get_heads()) == 1


def test_upgrade_sql_adds_a_hyrak_defaulted_indexed_column():
    sql = _alembic_sql("upgrade", "c9f5a1d3e6b4:b8e4f0c2d5a3")
    for t in TABLES:
        assert (f"ALTER TABLE {t} ADD COLUMN workspace_id VARCHAR(36) DEFAULT '{HYRAK}' NOT NULL"
                in sql), t
        assert f"CREATE INDEX ix_{t}_workspace_id ON {t} (workspace_id)" in sql
    assert "FOREIGN KEY" not in sql


def test_downgrade_sql_drops_them_again():
    sql = _alembic_sql("downgrade", "b8e4f0c2d5a3:c9f5a1d3e6b4")
    for t in TABLES:
        assert f"DROP INDEX ix_{t}_workspace_id" in sql
        assert f"ALTER TABLE {t} DROP COLUMN workspace_id" in sql
