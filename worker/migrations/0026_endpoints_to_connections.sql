-- Old per-route services become account connections, once, here (this used to run as a write inside every key lookup).
INSERT OR IGNORE INTO connections (id, workspace_id, kind, name, url, auth_enc, created_at)
  SELECT e.id, p.workspace_id, 'systemone', e.name, e.url, e.auth_enc, e.created_at FROM endpoints e JOIN projects p ON p.id = e.project_id;
