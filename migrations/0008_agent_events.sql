CREATE TABLE agent_subscriptions (
  id TEXT PRIMARY KEY NOT NULL,
  principal_id TEXT NOT NULL,
  grant_id TEXT,
  user_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  callback_url TEXT NOT NULL,
  signing_secret TEXT NOT NULL,
  previous_secret TEXT,
  previous_secret_until TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_fingerprint TEXT,
  last_notified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX agent_subscriptions_active ON agent_subscriptions(revoked_at, expires_at);
CREATE TABLE agent_deliveries (
  id TEXT PRIMARY KEY NOT NULL,
  subscription_id TEXT NOT NULL REFERENCES agent_subscriptions(id),
  fingerprint TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','delivering','delivered','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  lock_until TEXT,
  last_status INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  UNIQUE(subscription_id, fingerprint)
);
CREATE INDEX agent_deliveries_due ON agent_deliveries(status, next_attempt_at);
