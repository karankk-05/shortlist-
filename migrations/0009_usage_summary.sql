CREATE TABLE usage_hourly (
  hour TEXT NOT NULL,
  category TEXT NOT NULL,
  samples INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  client_errors INTEGER NOT NULL DEFAULT 0,
  server_errors INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  duration_ms REAL NOT NULL DEFAULT 0,
  slow INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, category)
) WITHOUT ROWID;
INSERT OR IGNORE INTO settings (key, value) VALUES ('usage_started_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
