-- every request through a key, including the ones that were rejected or failed: the request log is the product's front page
CREATE TABLE IF NOT EXISTS request_log (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, t REAL NOT NULL, via TEXT, status INTEGER NOT NULL, error TEXT, served TEXT, ms INTEGER, example_id TEXT, fallback_json TEXT);
CREATE INDEX IF NOT EXISTS request_log_project ON request_log (project_id, t);
