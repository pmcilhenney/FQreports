ALTER TABLE scorm_exports ADD COLUMN package_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_scorm_exports_package_token
  ON scorm_exports (package_token);

CREATE TABLE IF NOT EXISTS scorm_sessions (
  session_id TEXT PRIMARY KEY,
  package_token TEXT NOT NULL,
  quiz_id TEXT NOT NULL,
  moodle_student_id TEXT NOT NULL,
  moodle_student_name TEXT,
  flexiquiz_user_id TEXT NOT NULL,
  flexiquiz_user_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_checked_at TEXT,
  completed_at TEXT,
  response_id TEXT,
  score REAL,
  pass INTEGER,
  status TEXT
);

CREATE INDEX IF NOT EXISTS idx_scorm_sessions_lookup
  ON scorm_sessions (package_token, moodle_student_id);
