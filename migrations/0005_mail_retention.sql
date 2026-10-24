ALTER TABLE mail_jobs ADD COLUMN completed_at TEXT;
ALTER TABLE mail_jobs ADD COLUMN source_deleted_at TEXT;
ALTER TABLE uploads ADD COLUMN purged_at TEXT;

-- Preserve the best available completion time for jobs finished before retention existed.
UPDATE mail_jobs SET completed_at = updated_at WHERE status = 'done';
CREATE INDEX mail_jobs_retention ON mail_jobs(status, source_deleted_at, completed_at);

-- Also cover a completion handled by the previous Worker during deployment.
CREATE TRIGGER mail_jobs_record_completion AFTER UPDATE OF status ON mail_jobs
WHEN NEW.status = 'done' AND NEW.completed_at IS NULL
BEGIN
  UPDATE mail_jobs SET completed_at = NEW.updated_at WHERE id = NEW.id;
END;

-- Close the race between a new draft's source validation and attachment cleanup.
CREATE TRIGGER versions_require_available_sources BEFORE INSERT ON versions
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.source_upload_ids) source
  LEFT JOIN uploads u ON u.id = source.value
  WHERE u.id IS NULL OR u.purged_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'source_upload_unavailable');
END;
