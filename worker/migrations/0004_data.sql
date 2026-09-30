-- v3: the data layer moves off Modal. Question-sets, examples, corrections, routing, models and the routing cache live here.
CREATE TABLE IF NOT EXISTS question_sets (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, questions_json TEXT NOT NULL, declared INTEGER NOT NULL DEFAULT 0, first_seen REAL, last_seen REAL);
CREATE INDEX IF NOT EXISTS idx_qs_project ON question_sets(project_id);
CREATE TABLE IF NOT EXISTS examples (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, schema_id TEXT NOT NULL, line INTEGER NOT NULL, t REAL NOT NULL, state_json TEXT NOT NULL,
  source TEXT NOT NULL, via TEXT, holdout INTEGER NOT NULL DEFAULT 0, answers_json TEXT NOT NULL DEFAULT '{}', served TEXT, ms_json TEXT, meta_json TEXT, extra_json TEXT);
CREATE INDEX IF NOT EXISTS idx_ex_project_t ON examples(project_id, t);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ex_schema_line ON examples(schema_id, line);
CREATE INDEX IF NOT EXISTS idx_ex_project_source ON examples(project_id, source);
CREATE TABLE IF NOT EXISTS corrections (example_id TEXT NOT NULL, qid TEXT NOT NULL, label_json TEXT, "by" TEXT, t REAL, PRIMARY KEY (example_id, qid));
CREATE TABLE IF NOT EXISTS routing (project_id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS models (project_id TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL, trained_rows INTEGER, t REAL, holdout_agreement_json TEXT, error TEXT, job TEXT, trained_on INTEGER,
  PRIMARY KEY (project_id, version));
CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, expires REAL NOT NULL);
