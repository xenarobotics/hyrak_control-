--
-- HYRAK platform schema - PostgreSQL
--
-- GENERATED from app/db/models.py by scripts/generate_schema_sql.py
-- Do not edit by hand: regenerate after changing the models.
--
-- Generated: 2026-08-23 17:31 UTC
-- Alembic head at generation time: d5b91c07af42
-- Tables: crowd_alerts, crowd_snapshots, drones, flight_samples, flights, permits, person_faces, person_sightings, persons, plate_events, zones
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

CREATE TABLE drones (
	id VARCHAR(36) NOT NULL, 
	hardware_uid VARCHAR(64) NOT NULL, 
	name VARCHAR(120) NOT NULL, 
	is_simulated BOOLEAN NOT NULL, 
	first_seen TIMESTAMP WITH TIME ZONE NOT NULL, 
	last_seen TIMESTAMP WITH TIME ZONE NOT NULL, 
	PRIMARY KEY (id)
);

CREATE UNIQUE INDEX ix_drones_hardware_uid ON drones (hardware_uid);

CREATE TABLE zones (
	id VARCHAR(36) NOT NULL, 
	name VARCHAR(120) NOT NULL, 
	zone_class VARCHAR(10) NOT NULL, 
	geometry JSON NOT NULL, 
	floor_m FLOAT NOT NULL, 
	ceiling_m FLOAT, 
	active BOOLEAN NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE crowd_snapshots (
	id BIGSERIAL NOT NULL, 
	session_id VARCHAR(36) NOT NULL, 
	t TIMESTAMP WITH TIME ZONE NOT NULL, 
	current_count INTEGER NOT NULL, 
	peak_count INTEGER NOT NULL, 
	density_level VARCHAR(10) NOT NULL, 
	section_counts JSON NOT NULL, 
	PRIMARY KEY (id)
);

CREATE INDEX ix_crowd_snapshots_session_id ON crowd_snapshots (session_id);

CREATE TABLE crowd_alerts (
	id BIGSERIAL NOT NULL, 
	session_id VARCHAR(36) NOT NULL, 
	t TIMESTAMP WITH TIME ZONE NOT NULL, 
	level VARCHAR(10) NOT NULL, 
	section_idx INTEGER NOT NULL, 
	count INTEGER NOT NULL, 
	message VARCHAR(300) NOT NULL, 
	PRIMARY KEY (id)
);

CREATE INDEX ix_crowd_alerts_session_id ON crowd_alerts (session_id);

CREATE TABLE plate_events (
	id VARCHAR(36) NOT NULL, 
	session_id VARCHAR(36) NOT NULL, 
	track_id INTEGER NOT NULL, 
	vehicle_id VARCHAR(20), 
	plate_text VARCHAR(20) NOT NULL, 
	ocr_confidence FLOAT NOT NULL, 
	vehicle_type VARCHAR(20) NOT NULL, 
	vehicle_color VARCHAR(20) NOT NULL, 
	vehicle_color_conf FLOAT NOT NULL, 
	vehicle_box JSON, 
	plate_box JSON, 
	plate_px_w INTEGER NOT NULL, 
	plate_votes INTEGER NOT NULL, 
	plate_grammar_ok BOOLEAN NOT NULL, 
	heading_deg FLOAT, 
	against_flow BOOLEAN NOT NULL, 
	image_path VARCHAR(500), 
	vehicle_image_path VARCHAR(500), 
	lat FLOAT, 
	lng FLOAT, 
	alt_m FLOAT, 
	speed_est_kmh FLOAT, 
	first_seen TIMESTAMP WITH TIME ZONE NOT NULL, 
	last_seen TIMESTAMP WITH TIME ZONE NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	PRIMARY KEY (id)
);

CREATE INDEX ix_plate_events_session_id ON plate_events (session_id);

CREATE INDEX ix_plate_events_vehicle_id ON plate_events (vehicle_id);

CREATE INDEX ix_plate_events_plate_text ON plate_events (plate_text);

CREATE TABLE persons (
	id VARCHAR(36) NOT NULL, 
	name VARCHAR(120) NOT NULL, 
	notes VARCHAR(500) NOT NULL, 
	active BOOLEAN NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	PRIMARY KEY (id)
);

CREATE INDEX ix_persons_active ON persons (active);

CREATE INDEX ix_persons_name ON persons (name);

CREATE TABLE flights (
	id VARCHAR(36) NOT NULL, 
	drone_id VARCHAR(36) NOT NULL, 
	session_id VARCHAR(36) NOT NULL, 
	started_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	ended_at TIMESTAMP WITH TIME ZONE, 
	duration_s FLOAT NOT NULL, 
	max_alt_m FLOAT NOT NULL, 
	distance_m FLOAT NOT NULL, 
	samples_count INTEGER NOT NULL, 
	crossed_orange BOOLEAN NOT NULL, 
	crossed_red BOOLEAN NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(drone_id) REFERENCES drones (id)
);

CREATE INDEX ix_flights_drone_id ON flights (drone_id);

CREATE TABLE permits (
	id VARCHAR(36) NOT NULL, 
	drone_id VARCHAR(36) NOT NULL, 
	description VARCHAR(500) NOT NULL, 
	waypoints JSON NOT NULL, 
	mission_hash VARCHAR(64) NOT NULL, 
	zones JSON NOT NULL, 
	status VARCHAR(12) NOT NULL, 
	requested_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	decided_at TIMESTAMP WITH TIME ZONE, 
	PRIMARY KEY (id), 
	FOREIGN KEY(drone_id) REFERENCES drones (id)
);

CREATE INDEX ix_permits_drone_id ON permits (drone_id);

CREATE INDEX ix_permits_mission_hash ON permits (mission_hash);

CREATE TABLE person_faces (
	id VARCHAR(36) NOT NULL, 
	person_id VARCHAR(36) NOT NULL, 
	image_path VARCHAR(500), 
	embedding BYTEA NOT NULL, 
	embedding_dim INTEGER NOT NULL, 
	model_name VARCHAR(60) NOT NULL, 
	det_score FLOAT NOT NULL, 
	source_filename VARCHAR(255) NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(person_id) REFERENCES persons (id) ON DELETE CASCADE
);

CREATE INDEX ix_person_faces_person_id ON person_faces (person_id);

CREATE TABLE person_sightings (
	id VARCHAR(36) NOT NULL, 
	session_id VARCHAR(36) NOT NULL, 
	person_id VARCHAR(36), 
	person_name VARCHAR(120) NOT NULL, 
	t TIMESTAMP WITH TIME ZONE NOT NULL, 
	similarity FLOAT NOT NULL, 
	track_id INTEGER NOT NULL, 
	lat FLOAT, 
	lng FLOAT, 
	alt_m FLOAT, 
	image_path VARCHAR(500), 
	PRIMARY KEY (id), 
	FOREIGN KEY(person_id) REFERENCES persons (id) ON DELETE SET NULL
);

CREATE INDEX ix_person_sightings_session_id ON person_sightings (session_id);

CREATE INDEX ix_person_sightings_person_id ON person_sightings (person_id);

CREATE TABLE flight_samples (
	id BIGSERIAL NOT NULL, 
	flight_id VARCHAR(36) NOT NULL, 
	t TIMESTAMP WITH TIME ZONE NOT NULL, 
	lat FLOAT NOT NULL, 
	lng FLOAT NOT NULL, 
	alt_m FLOAT NOT NULL, 
	heading_deg FLOAT NOT NULL, 
	groundspeed_m_s FLOAT NOT NULL, 
	battery_pct FLOAT NOT NULL, 
	mode VARCHAR(24) NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(flight_id) REFERENCES flights (id)
);

CREATE INDEX ix_flight_samples_flight_id ON flight_samples (flight_id);

COMMIT;
