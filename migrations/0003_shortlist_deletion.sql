-- Keep versions and the published pointer so an owner can undo a deletion.
ALTER TABLE shortlists ADD COLUMN deleted_at TEXT;
ALTER TABLE shortlists ADD COLUMN deleted_by TEXT;
