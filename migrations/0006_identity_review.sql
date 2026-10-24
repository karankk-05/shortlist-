-- Existing versions remain confirmed six-column snapshots; reviews live alongside rows.
ALTER TABLE versions ADD COLUMN unresolved_count INTEGER NOT NULL DEFAULT 0;
