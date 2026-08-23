--
-- HYRAK platform - one-time provisioning for a fresh PostgreSQL server.
-- Run as an admin user (postgres) BEFORE db/schema.sql or alembic.
--
--   psql -h <host> -U postgres -f db/provision.sql
--
-- Change the password before running against anything public. On managed
-- cloud Postgres (RDS, Neon, Supabase, DO, Vultr) the role and database
-- often come from the provider's console instead - then skip this file and
-- just point DATABASE_URL at what they gave you:
--
--   DATABASE_URL=postgresql+asyncpg://USER:PASS@HOST:5432/hyrak
--

CREATE ROLE hyrak WITH LOGIN PASSWORD 'CHANGE_ME';

CREATE DATABASE hyrak
    OWNER hyrak
    ENCODING 'UTF8'
    TEMPLATE template0;

-- The app owns its schema; nothing else needs access.
GRANT ALL PRIVILEGES ON DATABASE hyrak TO hyrak;

-- Connection hygiene for a small always-on service: the app pool holds 5,
-- so anything above ~20 total is headroom, not need.
ALTER ROLE hyrak SET statement_timeout = '30s';
