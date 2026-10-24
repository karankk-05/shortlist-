CREATE TABLE mail_state (
  account_id TEXT PRIMARY KEY NOT NULL,
  uid_validity TEXT,
  last_uid INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  lock_token TEXT,
  lock_until TEXT
);
CREATE TABLE mail_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  message_key TEXT UNIQUE NOT NULL,
  message_id TEXT NOT NULL,
  uid INTEGER NOT NULL,
  subject TEXT NOT NULL,
  sender TEXT NOT NULL,
  received_at TEXT,
  object_key TEXT NOT NULL,
  source_upload_ids TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  duplicate_of TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','processing','needs_review','done','ignored')),
  note TEXT NOT NULL DEFAULT '',
  claimed_by TEXT,
  lease_hash TEXT,
  lease_until TEXT,
  result_version_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX mail_jobs_status_created ON mail_jobs(status, created_at);
CREATE INDEX mail_jobs_content_hash ON mail_jobs(content_hash);
ALTER TABLE versions ADD COLUMN source_mail_job_id TEXT REFERENCES mail_jobs(id);
CREATE UNIQUE INDEX mail_job_shortlist_version ON versions(source_mail_job_id, shortlist_id) WHERE source_mail_job_id IS NOT NULL;
