-- Additive learning state. Existing courses/programs/semesters/subjects/lessons,
-- exams/questions/answers/attempts, groups/user_groups and certificates remain canonical.
CREATE TABLE IF NOT EXISTS school_exam_rules (
  exam_id INTEGER PRIMARY KEY REFERENCES exams(id) ON DELETE CASCADE,
  require_all_lessons INTEGER NOT NULL DEFAULT 1,
  required_lesson_ids TEXT NOT NULL DEFAULT '[]',
  assignment_required INTEGER NOT NULL DEFAULT 0,
  certificate_required INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS school_exam_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK(target_type IN ('user','group')),
  target_id INTEGER NOT NULL,
  is_open INTEGER NOT NULL DEFAULT 1,
  opens_at TEXT,
  closes_at TEXT,
  granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(exam_id,target_type,target_id)
);
CREATE TABLE IF NOT EXISTS school_exam_attempts (
  attempt_id INTEGER PRIMARY KEY REFERENCES exam_attempts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('started','submitted','timed_out')),
  deadline_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  answers_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  created_at TEXT NOT NULL,
  submitted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS school_exam_one_active
  ON school_exam_attempts(user_id,exam_id) WHERE status='started';
CREATE TABLE IF NOT EXISTS school_group_scopes (
  group_id INTEGER PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  program_id INTEGER REFERENCES programs(id) ON DELETE SET NULL,
  semester_id INTEGER REFERENCES semesters(id) ON DELETE SET NULL,
  cohort TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS school_certificate_rules (
  course_id INTEGER PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
  require_progress INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL DEFAULT 'Сертификат об окончании',
  issuer TEXT NOT NULL DEFAULT 'RAUDA ILM',
  accent TEXT NOT NULL DEFAULT '#126b55',
  footer TEXT NOT NULL DEFAULT 'Выдан по результатам обучения'
);
CREATE TABLE IF NOT EXISTS school_learning_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS school_telegram_exam_answers (
  telegram_id TEXT NOT NULL,
  attempt_id INTEGER NOT NULL REFERENCES school_exam_attempts(attempt_id) ON DELETE CASCADE,
  answers_json TEXT NOT NULL DEFAULT '{}',
  question_index INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(telegram_id,attempt_id)
);
CREATE TABLE IF NOT EXISTS assessment_access (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assessment_type TEXT NOT NULL CHECK(assessment_type IN ('test','exam')),
  assessment_id INTEGER NOT NULL,
  is_open INTEGER,
  extra_attempts INTEGER NOT NULL DEFAULT 0,
  opens_at TEXT,
  closes_at TEXT,
  reason TEXT,
  granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id,assessment_type,assessment_id)
);
