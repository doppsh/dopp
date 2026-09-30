-- which base model a version was trained from (laya | kev-0.8b | kev-4b); the project remembers the last choice
ALTER TABLE models ADD COLUMN base TEXT NOT NULL DEFAULT 'laya';
