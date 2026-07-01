-- Enable PostGIS before any table creation (T1.3 requirement 2).
-- geography(Point,4326) columns and ST_DWithin/ST_Distance depend on this.
CREATE EXTENSION IF NOT EXISTS postgis;
