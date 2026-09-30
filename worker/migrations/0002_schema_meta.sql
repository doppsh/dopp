CREATE TABLE IF NOT EXISTS schema_meta (workspace_id TEXT NOT NULL, schema_id TEXT NOT NULL, name TEXT, archived_at INTEGER, PRIMARY KEY (workspace_id, schema_id));
