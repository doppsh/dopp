-- why a version's browser export failed (null when it hasn't, or once it succeeds), so the page can say so and offer a retry
ALTER TABLE models ADD COLUMN web_error TEXT;
