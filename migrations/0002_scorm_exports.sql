CREATE TABLE IF NOT EXISTS flexiquiz_launch_urls (
  quiz_id TEXT PRIMARY KEY,
  launch_url TEXT NOT NULL,
  launch_mode TEXT NOT NULL DEFAULT 'new_window',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scorm_exports (
  export_id TEXT PRIMARY KEY,
  quiz_id TEXT NOT NULL,
  quiz_name TEXT NOT NULL,
  launch_url TEXT NOT NULL,
  launch_mode TEXT NOT NULL,
  package_object_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
