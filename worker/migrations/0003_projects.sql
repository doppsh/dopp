CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT, tags_json TEXT NOT NULL DEFAULT '[]', keywords_json TEXT NOT NULL DEFAULT '[]', tenant TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, settings_json TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS idx_projects_ws ON projects(workspace_id);
ALTER TABLE proxy_keys ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_keys_project ON proxy_keys(project_id);
CREATE TABLE IF NOT EXISTS endpoints (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, auth_enc TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_endpoints_project ON endpoints(project_id);
