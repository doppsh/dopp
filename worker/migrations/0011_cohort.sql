-- which requests a version was trained on (the cohort filter the user picked), for the record and for "train again like v3"
ALTER TABLE models ADD COLUMN cohort_json TEXT;
