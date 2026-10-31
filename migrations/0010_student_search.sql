CREATE TABLE student_search_versions (
  version_id TEXT PRIMARY KEY NOT NULL REFERENCES versions(id) ON DELETE CASCADE
);
CREATE TABLE student_search_entries (
  version_id TEXT NOT NULL REFERENCES student_search_versions(version_id) ON DELETE CASCADE,
  roll TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('confirmed', 'possible')),
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  source_name TEXT NOT NULL,
  email TEXT NOT NULL,
  row_data TEXT NOT NULL CHECK (json_valid(row_data)),
  PRIMARY KEY (version_id, kind, position, roll)
);
CREATE INDEX student_search_roll ON student_search_entries(roll, version_id);
CREATE VIRTUAL TABLE student_search_terms USING fts5(name, roll, email, source_name, content='student_search_entries', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER student_search_insert AFTER INSERT ON student_search_entries BEGIN
  INSERT INTO student_search_terms(rowid, name, roll, email, source_name) VALUES (new.rowid, new.name, new.roll, new.email, new.source_name);
END;
CREATE TRIGGER student_search_delete AFTER DELETE ON student_search_entries BEGIN
  INSERT INTO student_search_terms(student_search_terms, rowid, name, roll, email, source_name) VALUES ('delete', old.rowid, old.name, old.roll, old.email, old.source_name);
END;
