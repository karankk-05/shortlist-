-- D1-only storage: no R2 subscription or public object URLs.
-- Each chunk stays below D1's 2 MB row limit. Maximum file size is 10 MiB.
CREATE TABLE objects (
  key TEXT PRIMARY KEY NOT NULL,
  size INTEGER NOT NULL,
  chunks INTEGER NOT NULL
);
CREATE TABLE object_chunks (
  object_key TEXT NOT NULL REFERENCES objects(key) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  PRIMARY KEY (object_key, chunk_index)
);
