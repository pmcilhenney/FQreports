CREATE TABLE IF NOT EXISTS flexiquiz_quiz_cache (
  quiz_id TEXT PRIMARY KEY,
  name TEXT,
  status TEXT,
  date_created TEXT,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS flexiquiz_response_cache (
  response_id TEXT PRIMARY KEY,
  quiz_id TEXT NOT NULL,
  status TEXT,
  date_submitted TEXT,
  learner_name TEXT,
  email TEXT,
  percentage_score REAL,
  pass INTEGER,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_flexiquiz_response_cache_quiz_date
  ON flexiquiz_response_cache (quiz_id, date_submitted);

CREATE TABLE IF NOT EXISTS report_runs (
  run_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  filters TEXT NOT NULL,
  summary TEXT NOT NULL,
  csv_object_key TEXT NOT NULL
);
