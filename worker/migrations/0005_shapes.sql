-- templated question-sets: the shape (fixed | chunks) and, for chunk sets, the recipe that turns a text into a request
ALTER TABLE question_sets ADD COLUMN shape_json TEXT;
ALTER TABLE question_sets ADD COLUMN recipe_json TEXT;
ALTER TABLE question_sets ADD COLUMN suggestions_json TEXT;
