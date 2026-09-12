--
-- HYRAK platform schema - PostgreSQL
--
-- GENERATED from app/db/models.py by scripts/generate_schema_sql.py
-- Do not edit by hand: regenerate after changing the models.
--
-- Generated: 2026-09-12 12:53 UTC
-- Alembic head at generation time: c2d5e8b1f7a3
-- Tables: api_keys, avoidance_events, crowd_alerts, crowd_snapshots, drones, flight_samples, flights, map_features, missions, pads, permits, person_faces, person_sightings, persons, plate_events, route_profiles, task_events, tasks, zones
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

CREATE SEQUENCE task_order_seq START WITH 1;

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
	geometry JSONB NOT NULL, 
	floor_m FLOAT NOT NULL, 
	ceiling_m FLOAT, 
	active BOOLEAN NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE map_features (
	id VARCHAR(36) NOT NULL, 
	name VARCHAR(120) NOT NULL, 
	category VARCHAR(30) NOT NULL, 
	geometry JSONB NOT NULL, 
	active BOOLEAN NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	PRIMARY KEY (id)
);

CREATE INDEX ix_map_features_category ON map_features (category);

CREATE TABLE route_profiles (
	id VARCHAR(36) NOT NULL, 
	name VARCHAR(120) NOT NULL, 
	description VARCHAR(500) NOT NULL, 
	rules JSONB NOT NULL, 
	default_alt_m FLOAT NOT NULL, 
	default_speed_m_s FLOAT NOT NULL, 
	builtin BOOLEAN NOT NULL, 
	active BOOLEAN NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	PRIMARY KEY (id)
);

CREATE UNIQUE INDEX ix_route_profiles_name ON route_profiles (name);

CREATE TABLE pads (
	id VARCHAR(36) NOT NULL, 
	name VARCHAR(120) NOT NULL, 
	kind VARCHAR(16) DEFAULT 'pad' NOT NULL, 
	lat FLOAT NOT NULL, 
	lng FLOAT NOT NULL, 
	notes VARCHAR(500) NOT NULL, 
	active BOOLEAN NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	PRIMARY KEY (id)
);

CREATE UNIQUE INDEX ix_pads_name ON pads (name);

CREATE TABLE api_keys (
	id VARCHAR(36) NOT NULL, 
	name VARCHAR(120) NOT NULL, 
	prefix VARCHAR(12) NOT NULL, 
	key_hash VARCHAR(64) NOT NULL, 
	active BOOLEAN NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	last_used_at TIMESTAMP WITH TIME ZONE, 
	PRIMARY KEY (id)
);

CREATE UNIQUE INDEX ix_api_keys_key_hash ON api_keys (key_hash);

CREATE TABLE avoidance_events (
	id BIGSERIAL NOT NULL, 
	drone_id VARCHAR(36) NOT NULL, 
	t TIMESTAMP WITH TIME ZONE NOT NULL, 
	action VARCHAR(12) NOT NULL, 
	state VARCHAR(12) NOT NULL, 
	reason VARCHAR(500) NOT NULL, 
	armed BOOLEAN NOT NULL, 
	obstacle_lat FLOAT, 
	obstacle_lng FLOAT, 
	obstacle_radius_m FLOAT, 
	fused_distance_m FLOAT, 
	PRIMARY KEY (id), 
	CONSTRAINT ck_avoidance_events_action CHECK (action IN ('clear','hold','reroute','climb','return'))
);

CREATE INDEX ix_avoidance_events_drone_t ON avoidance_events (drone_id, t);

CREATE TABLE crowd_snapshots (
	id BIGSERIAL NOT NULL, 
	session_id VARCHAR(36) NOT NULL, 
	t TIMESTAMP WITH TIME ZONE NOT NULL, 
	current_count INTEGER NOT NULL, 
	peak_count INTEGER NOT NULL, 
	density_level VARCHAR(10) NOT NULL, 
	section_counts JSONB NOT NULL, 
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
	vehicle_box JSONB, 
	plate_box JSONB, 
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

CREATE INDEX ix_plate_events_plate_text ON plate_events (plate_text);

CREATE INDEX ix_plate_events_vehicle_id ON plate_events (vehicle_id);

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

CREATE TABLE missions (
	id VARCHAR(36) NOT NULL, 
	drone_id VARCHAR(36), 
	requested_by VARCHAR(120) NOT NULL, 
	profile_id VARCHAR(36), 
	profile_name VARCHAR(120) NOT NULL, 
	status VARCHAR(12) NOT NULL, 
	held_takeoff BOOLEAN DEFAULT 'false' NOT NULL, 
	start_lat FLOAT NOT NULL, 
	start_lng FLOAT NOT NULL, 
	goal_lat FLOAT NOT NULL, 
	goal_lng FLOAT NOT NULL, 
	cruise_alt_m FLOAT NOT NULL, 
	speed_m_s FLOAT NOT NULL, 
	waypoints JSONB NOT NULL, 
	mission_hash VARCHAR(64) NOT NULL, 
	distance_m FLOAT NOT NULL, 
	est_duration_s FLOAT NOT NULL, 
	zones JSONB NOT NULL, 
	coverage JSONB NOT NULL, 
	report JSONB NOT NULL, 
	scheduled_at TIMESTAMP WITH TIME ZONE, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT ck_missions_status CHECK (status IN ('planned','uploaded','flying','completed','aborted','failed')), 
	FOREIGN KEY(drone_id) REFERENCES drones (id), 
	FOREIGN KEY(profile_id) REFERENCES route_profiles (id)
);

CREATE INDEX ix_missions_drone_id ON missions (drone_id);

CREATE INDEX ix_missions_mission_hash ON missions (mission_hash);

CREATE INDEX ix_missions_status ON missions (status);

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
	waypoints JSONB NOT NULL, 
	mission_hash VARCHAR(64) NOT NULL, 
	zones JSONB NOT NULL, 
	status VARCHAR(12) NOT NULL, 
	requested_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	decided_at TIMESTAMP WITH TIME ZONE, 
	PRIMARY KEY (id), 
	FOREIGN KEY(drone_id) REFERENCES drones (id)
);

CREATE INDEX ix_permits_mission_hash ON permits (mission_hash);

CREATE INDEX ix_permits_drone_id ON permits (drone_id);

CREATE INDEX ix_permits_status ON permits (status);

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

CREATE INDEX ix_person_sightings_person_id ON person_sightings (person_id);

CREATE INDEX ix_person_sightings_session_id ON person_sightings (session_id);

CREATE TABLE tasks (
	id VARCHAR(36) NOT NULL, 
	order_no VARCHAR(20) NOT NULL, 
	api_key_id VARCHAR(36), 
	client_name VARCHAR(120) NOT NULL, 
	status VARCHAR(12) NOT NULL, 
	pickup_pad_id VARCHAR(36), 
	dropoff_pad_id VARCHAR(36), 
	pickup_name VARCHAR(120) NOT NULL, 
	pickup_lat FLOAT NOT NULL, 
	pickup_lng FLOAT NOT NULL, 
	dropoff_name VARCHAR(120) NOT NULL, 
	dropoff_lat FLOAT NOT NULL, 
	dropoff_lng FLOAT NOT NULL, 
	payload_desc VARCHAR(300) NOT NULL, 
	payload_kg FLOAT NOT NULL, 
	window_start TIMESTAMP WITH TIME ZONE, 
	window_end TIMESTAMP WITH TIME ZONE, 
	profile_name VARCHAR(120) NOT NULL, 
	mission_id VARCHAR(36), 
	mission_to_pickup_id VARCHAR(36), 
	drone_id VARCHAR(36), 
	fail_reason VARCHAR(500) NOT NULL, 
	archived BOOLEAN DEFAULT 'false' NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT ck_tasks_status CHECK (status IN ('received','planned','assigned','to_pickup','loading','to_dropoff','delivered','returned','failed','cancelled')), 
	FOREIGN KEY(api_key_id) REFERENCES api_keys (id), 
	FOREIGN KEY(pickup_pad_id) REFERENCES pads (id), 
	FOREIGN KEY(dropoff_pad_id) REFERENCES pads (id), 
	FOREIGN KEY(mission_id) REFERENCES missions (id), 
	FOREIGN KEY(mission_to_pickup_id) REFERENCES missions (id), 
	FOREIGN KEY(drone_id) REFERENCES drones (id)
);

CREATE INDEX ix_tasks_status_drone_id ON tasks (status, drone_id);

CREATE INDEX ix_tasks_api_key_id ON tasks (api_key_id);

CREATE INDEX ix_tasks_status ON tasks (status);

CREATE INDEX ix_tasks_archived ON tasks (archived);

CREATE INDEX ix_tasks_drone_id ON tasks (drone_id);

CREATE UNIQUE INDEX ix_tasks_order_no ON tasks (order_no);

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

CREATE TABLE task_events (
	id BIGSERIAL NOT NULL, 
	task_id VARCHAR(36) NOT NULL, 
	t TIMESTAMP WITH TIME ZONE NOT NULL, 
	status VARCHAR(12) NOT NULL, 
	note VARCHAR(500) NOT NULL, 
	actor VARCHAR(20) NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(task_id) REFERENCES tasks (id) ON DELETE CASCADE
);

CREATE INDEX ix_task_events_task_id ON task_events (task_id);

COMMIT;
