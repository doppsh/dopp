-- the generator's read of a question-set's request format (derived from real requests, confirmable by the user)
ALTER TABLE question_sets ADD COLUMN plan_json TEXT;
