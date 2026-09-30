-- Analytics: the two latencies behind "end to end, as your app sees it" and "upstream call" (their difference is Dopp's overhead).
-- e2e_ms: Worker received the request -> reply handed back. upstream_ms: time waited on answerers before the reply.
ALTER TABLE request_log ADD COLUMN e2e_ms INTEGER;
ALTER TABLE request_log ADD COLUMN upstream_ms INTEGER;
