"""
Regenerate db/schema.sql from the SQLAlchemy models - the single canonical
PostgreSQL DDL for the whole platform.

WHY GENERATED, NEVER HAND-WRITTEN: the models in app/db/models.py are the
source of truth (Alembic migrates them, the app queries them). A schema file
maintained by hand is a second truth that silently drifts; this one is a
compilation, so it cannot.

Two ways to establish a fresh cloud database, both supported:

  1. alembic upgrade head        (preferred: replays the real migration
                                  history, works for upgrades too)
  2. psql -f db/schema.sql       (one shot on an empty database, for teams
                                  or dashboards that want a plain SQL file)

After option 2, stamp the migration head so future upgrades work:
  alembic stamp head

Run:  .venv/bin/python scripts/generate_schema_sql.py
"""
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import create_mock_engine
from sqlalchemy.dialects import postgresql

from app.db.models import Base

OUT = Path(__file__).resolve().parent.parent / "db" / "schema.sql"


def main() -> None:
    statements: list[str] = []

    def record(sql, *args, **kwargs):
        text = str(sql.compile(dialect=postgresql.dialect())).strip()
        if text:
            statements.append(text + ";")

    engine = create_mock_engine("postgresql+psycopg2://", record)
    Base.metadata.create_all(engine, checkfirst=False)

    head = "unknown"
    try:
        out = subprocess.run(
            [sys.executable, "-m", "alembic", "heads"], capture_output=True,
            text=True, cwd=OUT.parent.parent, timeout=30,
        )
        if out.returncode == 0 and out.stdout.strip():
            head = out.stdout.strip().split()[0]
    except Exception:
        pass

    tables = ", ".join(sorted(t.name for t in Base.metadata.sorted_tables))
    header = f"""--
-- HYRAK platform schema - PostgreSQL
--
-- GENERATED from app/db/models.py by scripts/generate_schema_sql.py
-- Do not edit by hand: regenerate after changing the models.
--
-- Generated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}
-- Alembic head at generation time: {head}
-- Tables: {tables}
--
-- Establishing a fresh cloud database:
--   psql "$DATABASE_URL" -f db/provision.sql   (role + database, run as admin)
--   psql "$DATABASE_URL" -f db/schema.sql      (this file, on the empty db)
--   alembic stamp head                         (so future migrations apply)
--
-- Or skip this file entirely and run the real history:
--   DATABASE_URL=... alembic upgrade head
--

BEGIN;

"""
    OUT.write_text(header + "\n\n".join(statements) + "\n\nCOMMIT;\n")
    print(f"wrote {OUT} ({len(statements)} statements, alembic head {head})")


if __name__ == "__main__":
    main()
