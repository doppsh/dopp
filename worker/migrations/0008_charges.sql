-- every paid step a project causes, at cost (labels, generator calls, training minutes); credits shown = cost × margin
CREATE TABLE IF NOT EXISTS charges (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, t REAL NOT NULL, kind TEXT NOT NULL, units REAL NOT NULL, usd REAL NOT NULL, note TEXT);
CREATE INDEX IF NOT EXISTS charges_project ON charges (project_id, t);
