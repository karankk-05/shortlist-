-- Keep human retry context separate from collector/agent notes and retained source bytes.
ALTER TABLE mail_jobs ADD COLUMN owner_comment TEXT NOT NULL DEFAULT '';
