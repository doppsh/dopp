-- Setup v2, the request path: each request remembers the route it went through and its grounded answer
-- (the first of that route's oracle that answered; a person's fix still wins on top, from `corrections`), the request log keeps
-- the path a request took, and a version remembers the training plan that made it. Rows written before this (or by a worker
-- still on the old code) get route and grounded answer filled in by the Worker the next time the model's data is read.
ALTER TABLE examples ADD COLUMN route TEXT;
ALTER TABLE examples ADD COLUMN grounded_json TEXT;
ALTER TABLE examples ADD COLUMN grounded_by TEXT;
CREATE INDEX IF NOT EXISTS idx_ex_project_route ON examples(project_id, route);
ALTER TABLE request_log ADD COLUMN path_json TEXT;
ALTER TABLE models ADD COLUMN plan TEXT;
