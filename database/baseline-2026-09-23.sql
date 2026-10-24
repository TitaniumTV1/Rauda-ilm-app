-- Schema-only recovery snapshot of deployed D1, 2026-09-23. No user data.

-- Fresh database only; do not execute against an existing database.

PRAGMA foreign_keys=ON;

CREATE TABLE admin_courses (     id INTEGER PRIMARY KEY AUTOINCREMENT,     admin_id INTEGER NOT NULL,     course_id INTEGER NOT NULL,      UNIQUE(admin_id, course_id),      FOREIGN KEY (admin_id)         REFERENCES users(id)         ON DELETE CASCADE,      FOREIGN KEY (course_id)         REFERENCES courses(id)         ON DELETE CASCADE );

CREATE TABLE admin_permissions (     id INTEGER PRIMARY KEY AUTOINCREMENT,     admin_id INTEGER NOT NULL,     permission TEXT NOT NULL,      UNIQUE(admin_id, permission),      FOREIGN KEY (admin_id)         REFERENCES users(id)         ON DELETE CASCADE );

CREATE TABLE audit_logs (     id INTEGER PRIMARY KEY AUTOINCREMENT,      admin_id INTEGER,     course_id INTEGER,      action TEXT NOT NULL,      entity_type TEXT,     entity_id INTEGER,      details TEXT,      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,      FOREIGN KEY (admin_id)         REFERENCES users(id)         ON DELETE SET NULL,      FOREIGN KEY (course_id)         REFERENCES courses(id)         ON DELETE SET NULL );

CREATE TABLE auth_sessions (     id INTEGER PRIMARY KEY AUTOINCREMENT,     user_id INTEGER NOT NULL,     token TEXT NOT NULL UNIQUE,     expires_at TEXT NOT NULL,     created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,     FOREIGN KEY (user_id) REFERENCES users(id) );

CREATE TABLE assessment_access (
            id INTEGER PRIMARY KEY AUTOINCREMENT,

            user_id INTEGER NOT NULL,

            assessment_type TEXT NOT NULL
                CHECK (
                    assessment_type IN (
                        'test',
                        'exam'
                    )
                ),

            assessment_id INTEGER NOT NULL,

            /*
             * NULL = inherit global state.
             * 0 = explicitly closed.
             * 1 = explicitly open.
             */
            is_open INTEGER,

            extra_attempts INTEGER
                NOT NULL DEFAULT 0,

            opens_at TEXT,
            closes_at TEXT,

            reason TEXT,

            granted_by INTEGER,

            created_at TEXT
                NOT NULL DEFAULT CURRENT_TIMESTAMP,

            updated_at TEXT
                NOT NULL DEFAULT CURRENT_TIMESTAMP,

            UNIQUE(
                user_id,
                assessment_type,
                assessment_id
            ),

            FOREIGN KEY (user_id)
                REFERENCES users(id)
                ON DELETE CASCADE,

            FOREIGN KEY (granted_by)
                REFERENCES users(id)
                ON DELETE SET NULL
        );

CREATE TABLE app_settings (     key TEXT PRIMARY KEY,     value TEXT,     updated_at TEXT DEFAULT CURRENT_TIMESTAMP );

CREATE TABLE certificates (     id INTEGER PRIMARY KEY AUTOINCREMENT,      user_id INTEGER NOT NULL,     course_id INTEGER NOT NULL,      certificate_number TEXT NOT NULL UNIQUE,      certificate_name TEXT NOT NULL,      template_key TEXT NOT NULL,      file_key TEXT,      issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,      revoked_at TEXT,      is_valid INTEGER NOT NULL DEFAULT 1,      FOREIGN KEY (user_id)         REFERENCES users(id)         ON DELETE CASCADE,      FOREIGN KEY (course_id)         REFERENCES courses(id)         ON DELETE CASCADE );

CREATE TABLE certificate_settings (     id INTEGER PRIMARY KEY AUTOINCREMENT,      course_id INTEGER NOT NULL UNIQUE,      template_key TEXT NOT NULL,      require_exam INTEGER NOT NULL DEFAULT 1,      require_passing_score INTEGER NOT NULL DEFAULT 1,      passing_score INTEGER NOT NULL DEFAULT 60,      allow_student_name INTEGER NOT NULL DEFAULT 1,      FOREIGN KEY (course_id)         REFERENCES courses(id)         ON DELETE CASCADE );

CREATE TABLE checkout_access_grants (checkout_order_id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,scope_type TEXT NOT NULL CHECK(scope_type IN ('program','semester')),program_id INTEGER NOT NULL,semester_id INTEGER,status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,revoked_at TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,CHECK((scope_type='program' AND semester_id IS NULL) OR (scope_type='semester' AND semester_id IS NOT NULL)),FOREIGN KEY(checkout_order_id) REFERENCES checkout_orders(id) ON DELETE RESTRICT,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,FOREIGN KEY(program_id) REFERENCES programs(id) ON DELETE RESTRICT,FOREIGN KEY(semester_id) REFERENCES semesters(id) ON DELETE RESTRICT);

CREATE TABLE books (
            id INTEGER PRIMARY KEY AUTOINCREMENT,

            course_id INTEGER NOT NULL,
            program_id INTEGER,
            semester_id INTEGER,
            subject_id INTEGER,

            title TEXT NOT NULL,
            author TEXT,
            description TEXT,
            cover_key TEXT,

            sort_order INTEGER NOT NULL DEFAULT 0,
            is_active INTEGER NOT NULL DEFAULT 1,

            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

            FOREIGN KEY (course_id)
                REFERENCES courses(id)
                ON DELETE CASCADE,

            FOREIGN KEY (program_id)
                REFERENCES programs(id)
                ON DELETE SET NULL,

            FOREIGN KEY (semester_id)
                REFERENCES semesters(id)
                ON DELETE SET NULL,

            FOREIGN KEY (subject_id)
                REFERENCES subjects(id)
                ON DELETE SET NULL
        );

CREATE TABLE bot_states (
            chat_id INTEGER PRIMARY KEY,
            state TEXT NOT NULL,
            updated_at TEXT NOT NULL
                DEFAULT CURRENT_TIMESTAMP
        );

CREATE TABLE bot_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

CREATE TABLE checkout_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    program_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    currency TEXT NOT NULL DEFAULT 'rub'
        CHECK (currency IN ('rub', 'eur', 'usd')),
    period TEXT NOT NULL DEFAULT 'onetime'
        CHECK (period IN ('onetime', 'weekly', 'monthly', 'quarterly', 'halfyearly', 'yearly')),
    active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE RESTRICT
);

CREATE TABLE checkout_orders (
    id TEXT PRIMARY KEY,
    plan_id INTEGER NOT NULL,
    program_id INTEGER NOT NULL,
    email TEXT NOT NULL,
    email_hash TEXT NOT NULL,
    title TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    currency TEXT NOT NULL,
    period TEXT NOT NULL DEFAULT 'onetime',
    tribute_order_uuid TEXT UNIQUE,
    tribute_payment_url TEXT,
    status TEXT NOT NULL DEFAULT 'creating'
        CHECK (status IN ('creating', 'pending', 'paid', 'failed', 'cancelled', 'refunded', 'rejected')),
    fulfillment_status TEXT NOT NULL DEFAULT 'not_granted'
        CHECK (fulfillment_status IN ('not_granted', 'waiting_for_telegram_link', 'granted', 'revoked')),
    provider_error TEXT,
    paid_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (plan_id) REFERENCES checkout_plans(id) ON DELETE RESTRICT,
    FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE RESTRICT
);

CREATE TABLE checkout_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_fingerprint TEXT NOT NULL,
    email_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE checkout_plan_scopes (
    plan_id INTEGER PRIMARY KEY,
    scope_type TEXT NOT NULL DEFAULT 'program'
        CHECK (scope_type IN ('program', 'semester')),
    program_id INTEGER NOT NULL,
    semester_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CHECK (
        (scope_type = 'program' AND semester_id IS NULL)
        OR
        (scope_type = 'semester' AND semester_id IS NOT NULL)
    ),

    FOREIGN KEY (plan_id) REFERENCES checkout_plans(id) ON DELETE CASCADE,
    FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE RESTRICT,
    FOREIGN KEY (semester_id) REFERENCES semesters(id) ON DELETE RESTRICT
);

CREATE TABLE checkout_order_scopes (
    checkout_order_id TEXT PRIMARY KEY,
    scope_type TEXT NOT NULL
        CHECK (scope_type IN ('program', 'semester')),
    program_id INTEGER NOT NULL,
    semester_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CHECK (
        (scope_type = 'program' AND semester_id IS NULL)
        OR
        (scope_type = 'semester' AND semester_id IS NOT NULL)
    ),

    FOREIGN KEY (checkout_order_id) REFERENCES checkout_orders(id) ON DELETE CASCADE,
    FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE RESTRICT,
    FOREIGN KEY (semester_id) REFERENCES semesters(id) ON DELETE RESTRICT
);

CREATE TABLE checkout_claims (checkout_order_id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,token_nonce TEXT NOT NULL,delivery_revision INTEGER NOT NULL DEFAULT 1,expires_at TEXT NOT NULL,issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK(delivery_status IN ('pending','sending','sent','failed','uncertain','not_configured')),delivery_provider TEXT,delivery_message_id TEXT,delivery_attempts INTEGER NOT NULL DEFAULT 0,last_delivery_error TEXT,last_delivery_http_status INTEGER,email_sent_at TEXT,claimed_user_id INTEGER,claimed_at TEXT,granted_at TEXT,resend_requested_by INTEGER,resend_requested_at TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(checkout_order_id) REFERENCES checkout_orders(id) ON DELETE CASCADE,FOREIGN KEY(claimed_user_id) REFERENCES users(id) ON DELETE SET NULL,FOREIGN KEY(resend_requested_by) REFERENCES users(id) ON DELETE SET NULL);

CREATE TABLE courses (     id INTEGER PRIMARY KEY AUTOINCREMENT,     name TEXT NOT NULL,     description TEXT,     purpose TEXT,     cover_image TEXT,     certificate_template_key TEXT,     certificate_enabled INTEGER NOT NULL DEFAULT 1,     certificate_passing_score INTEGER NOT NULL DEFAULT 60,     is_active INTEGER NOT NULL DEFAULT 1,     created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,     updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP );

CREATE TABLE exam_answers (     id INTEGER PRIMARY KEY AUTOINCREMENT,     question_id INTEGER NOT NULL,     answer_text TEXT NOT NULL,     is_correct INTEGER NOT NULL DEFAULT 0,     sort_order INTEGER NOT NULL DEFAULT 0,      FOREIGN KEY (question_id) REFERENCES exam_questions(id) ON DELETE CASCADE );

CREATE TABLE exam_attempts (     id INTEGER PRIMARY KEY AUTOINCREMENT,     exam_id INTEGER NOT NULL,     user_id INTEGER NOT NULL,     course_id INTEGER NOT NULL,     attempt_number INTEGER NOT NULL DEFAULT 1,     score INTEGER NOT NULL DEFAULT 0,     max_score INTEGER NOT NULL DEFAULT 100,     percentage REAL NOT NULL DEFAULT 0,     passed INTEGER NOT NULL DEFAULT 0,     grade TEXT,     started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,     submitted_at TEXT, snapshot_json TEXT, answers_json TEXT NOT NULL DEFAULT '{}', deadline_at TEXT,      FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,     FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,     FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE );

CREATE TABLE checkout_webhook_events (
    event_id TEXT PRIMARY KEY,
    checkout_order_id TEXT,
    tribute_order_uuid TEXT,
    event_name TEXT NOT NULL,
    event_created_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (checkout_order_id) REFERENCES checkout_orders(id) ON DELETE SET NULL
);

CREATE TABLE email_auth_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, code_hash TEXT NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN ('register','login')), expires_at INTEGER NOT NULL, used_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);

CREATE TABLE course_channels (     course_id INTEGER PRIMARY KEY,     telegram_chat_id TEXT NOT NULL UNIQUE,     telegram_title TEXT,     is_active INTEGER NOT NULL DEFAULT 1,     created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,     updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP );

CREATE TABLE exams (     id INTEGER PRIMARY KEY AUTOINCREMENT,     course_id INTEGER NOT NULL,     program_id INTEGER,     semester_id INTEGER,     subject_id INTEGER,     title TEXT NOT NULL,     description TEXT,     max_score INTEGER NOT NULL DEFAULT 100,     passing_score INTEGER NOT NULL DEFAULT 60,     attempts_allowed INTEGER NOT NULL DEFAULT 1,     time_limit_minutes INTEGER,     starts_at TEXT,     ends_at TEXT,     is_active INTEGER NOT NULL DEFAULT 1,     created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,     updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, book_id INTEGER,      FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,     FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE SET NULL,     FOREIGN KEY (semester_id) REFERENCES semesters(id) ON DELETE SET NULL,     FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE SET NULL );

CREATE TABLE exam_questions (     id INTEGER PRIMARY KEY AUTOINCREMENT,     exam_id INTEGER NOT NULL,     question TEXT NOT NULL,     question_type TEXT NOT NULL DEFAULT 'single',     points INTEGER NOT NULL DEFAULT 1,     sort_order INTEGER NOT NULL DEFAULT 0,      FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE );

CREATE TABLE grading_scales (     id INTEGER PRIMARY KEY AUTOINCREMENT,     course_id INTEGER NOT NULL,     name TEXT NOT NULL,     min_score INTEGER NOT NULL,     max_score INTEGER NOT NULL,     grade TEXT NOT NULL,     description TEXT,      FOREIGN KEY (course_id)         REFERENCES courses(id)         ON DELETE CASCADE );

CREATE TABLE exam_forms (exam_id INTEGER PRIMARY KEY REFERENCES exams(id) ON DELETE CASCADE, questions_json TEXT NOT NULL);

CREATE TABLE group_posts (id INTEGER PRIMARY KEY AUTOINCREMENT,group_id INTEGER NOT NULL REFERENCES groups(id),user_id INTEGER NOT NULL REFERENCES users(id),request_id TEXT NOT NULL,body TEXT NOT NULL,hidden INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(user_id,request_id));

CREATE TABLE group_notes (id INTEGER PRIMARY KEY AUTOINCREMENT,group_id INTEGER NOT NULL REFERENCES groups(id),title TEXT NOT NULL,body TEXT NOT NULL,is_published INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE lessons (     id INTEGER PRIMARY KEY AUTOINCREMENT,     course_id INTEGER NOT NULL,     program_id INTEGER NOT NULL,     semester_id INTEGER NOT NULL,     subject_id INTEGER,     title TEXT NOT NULL,     description TEXT,     lesson_number INTEGER,     content TEXT,     sort_order INTEGER NOT NULL DEFAULT 0,     is_visible INTEGER NOT NULL DEFAULT 1,     created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,     updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, book_id INTEGER,     FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,     FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE,     FOREIGN KEY (semester_id) REFERENCES semesters(id) ON DELETE CASCADE,     FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE SET NULL );

CREATE TABLE lesson_files (     id INTEGER PRIMARY KEY AUTOINCREMENT,     lesson_id INTEGER NOT NULL,     course_id INTEGER NOT NULL,     file_name TEXT NOT NULL,     storage_key TEXT NOT NULL,     file_type TEXT,     mime_type TEXT,     file_size INTEGER,     sort_order INTEGER NOT NULL DEFAULT 0,     created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,     FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE CASCADE,     FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE );

CREATE TABLE lesson_progress (     id INTEGER PRIMARY KEY AUTOINCREMENT,     user_id INTEGER NOT NULL,     course_id INTEGER NOT NULL,     lesson_id INTEGER NOT NULL,     completed INTEGER NOT NULL DEFAULT 0,     completed_at TEXT,     created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,     updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, progress_percent
            INTEGER NOT NULL DEFAULT 0, is_completed
            INTEGER NOT NULL DEFAULT 0,     UNIQUE(user_id, lesson_id),     FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,     FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,     FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE CASCADE );

CREATE TABLE notifications (     id INTEGER PRIMARY KEY AUTOINCREMENT,      course_id INTEGER,      title TEXT NOT NULL,     message TEXT NOT NULL,      type TEXT NOT NULL DEFAULT 'general',      created_by INTEGER,      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,      FOREIGN KEY (course_id)         REFERENCES courses(id)         ON DELETE CASCADE,      FOREIGN KEY (created_by)         REFERENCES users(id)         ON DELETE SET NULL );

CREATE TABLE groups (     id INTEGER PRIMARY KEY AUTOINCREMENT,      course_id INTEGER NOT NULL,      name TEXT NOT NULL,     description TEXT,      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,      FOREIGN KEY (course_id)         REFERENCES courses(id)         ON DELETE CASCADE );

CREATE TABLE media_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    storage_key TEXT NOT NULL UNIQUE,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'document'
        CHECK (kind IN ('cover', 'video', 'audio', 'document', 'image')),
    course_id INTEGER,
    uploaded_by INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
    FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE programs (     id INTEGER PRIMARY KEY AUTOINCREMENT,     course_id INTEGER NOT NULL,     name TEXT NOT NULL,     description TEXT,     purpose TEXT,     is_active INTEGER NOT NULL DEFAULT 1,     created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,     updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,     FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE );

CREATE TABLE payments (     id INTEGER PRIMARY KEY AUTOINCREMENT,      user_id INTEGER NOT NULL,     course_id INTEGER NOT NULL,      amount INTEGER NOT NULL,     currency TEXT NOT NULL DEFAULT 'KZT',      status TEXT NOT NULL DEFAULT 'pending'         CHECK (             status IN (                 'pending',                 'waiting_confirmation',                 'paid',                 'rejected',                 'refunded'             )         ),      provider TEXT NOT NULL DEFAULT 'tribute',      tribute_product_id TEXT,     tribute_purchase_id TEXT,     tribute_subscription_id TEXT,      payment_type TEXT NOT NULL DEFAULT 'one_time'         CHECK (             payment_type IN (                 'one_time',                 'subscription'             )         ),      payment_url TEXT,     telegram_payment_url TEXT,      webhook_event_id TEXT UNIQUE,      paid_at TEXT,     expires_at TEXT,      raw_data TEXT,      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,     updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,      FOREIGN KEY (user_id)         REFERENCES users(id)         ON DELETE CASCADE,      FOREIGN KEY (course_id)         REFERENCES courses(id)         ON DELETE CASCADE );

CREATE TABLE schedules (     id INTEGER PRIMARY KEY AUTOINCREMENT,      course_id INTEGER NOT NULL,     program_id INTEGER,     semester_id INTEGER,     subject_id INTEGER,      title TEXT NOT NULL,     description TEXT,      starts_at TEXT NOT NULL,     ends_at TEXT,      location TEXT,     meeting_url TEXT,      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, is_active INTEGER NOT NULL DEFAULT 1,      FOREIGN KEY (course_id)         REFERENCES courses(id)         ON DELETE CASCADE,      FOREIGN KEY (program_id)         REFERENCES programs(id)         ON DELETE SET NULL,      FOREIGN KEY (semester_id)         REFERENCES semesters(id)         ON DELETE SET NULL,      FOREIGN KEY (subject_id)         REFERENCES subjects(id)         ON DELETE SET NULL );

CREATE TABLE semester_payment_grants (
        order_label TEXT PRIMARY KEY, user_id INTEGER NOT NULL, semester_id INTEGER NOT NULL,
        granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE scientific_competitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, course_id INTEGER NOT NULL, program_id INTEGER,
        title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', starts_at TEXT, ends_at TEXT,
        meeting_url TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '', is_active INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, semester_id INTEGER);

CREATE TABLE price_edit_state (
            chat_id INTEGER PRIMARY KEY,
            waiting INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

CREATE TABLE semesters (     id INTEGER PRIMARY KEY AUTOINCREMENT,     course_id INTEGER NOT NULL,     program_id INTEGER NOT NULL,     number INTEGER NOT NULL,     name TEXT,     description TEXT,     is_active INTEGER NOT NULL DEFAULT 1,     created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, price_rub INTEGER NOT NULL DEFAULT 3000, access_months INTEGER NOT NULL DEFAULT 3, payment_enabled INTEGER NOT NULL DEFAULT 1,     UNIQUE(program_id, number),     FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,     FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE );

CREATE TABLE subjects (     id INTEGER PRIMARY KEY AUTOINCREMENT,     course_id INTEGER NOT NULL,     program_id INTEGER NOT NULL,     semester_id INTEGER NOT NULL,     name TEXT NOT NULL,     description TEXT,     sort_order INTEGER NOT NULL DEFAULT 0,     is_active INTEGER NOT NULL DEFAULT 1,     created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,     FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,     FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE,     FOREIGN KEY (semester_id) REFERENCES semesters(id) ON DELETE CASCADE );

CREATE TABLE test_answers (     id INTEGER PRIMARY KEY AUTOINCREMENT,     question_id INTEGER NOT NULL,     answer_text TEXT NOT NULL,     is_correct INTEGER NOT NULL DEFAULT 0,     sort_order INTEGER NOT NULL DEFAULT 0,      FOREIGN KEY (question_id) REFERENCES test_questions(id) ON DELETE CASCADE );

CREATE TABLE semester_payment_methods (
        semester_id INTEGER PRIMARY KEY, yoomoney_enabled INTEGER NOT NULL DEFAULT 1,
        tribute_enabled INTEGER NOT NULL DEFAULT 0, tribute_url TEXT NOT NULL DEFAULT ''
    );

CREATE TABLE support_state (     user_id TEXT PRIMARY KEY,     waiting INTEGER NOT NULL DEFAULT 0 );

CREATE TABLE support_messages (     id INTEGER PRIMARY KEY AUTOINCREMENT,     admin_id TEXT NOT NULL,     admin_message_id INTEGER NOT NULL,     user_id TEXT NOT NULL,     created_at TEXT DEFAULT CURRENT_TIMESTAMP );

CREATE TABLE tests (     id INTEGER PRIMARY KEY AUTOINCREMENT,     course_id INTEGER NOT NULL,     program_id INTEGER,     semester_id INTEGER,     subject_id INTEGER,     title TEXT NOT NULL,     description TEXT,     time_limit_minutes INTEGER,     max_score INTEGER NOT NULL DEFAULT 100,     passing_score INTEGER NOT NULL DEFAULT 60,     attempts_allowed INTEGER NOT NULL DEFAULT 1,     shuffle_questions INTEGER NOT NULL DEFAULT 0,     show_results INTEGER NOT NULL DEFAULT 1,     is_active INTEGER NOT NULL DEFAULT 1,     starts_at TEXT,     ends_at TEXT,     created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,     updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, book_id INTEGER,      FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,     FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE SET NULL,     FOREIGN KEY (semester_id) REFERENCES semesters(id) ON DELETE SET NULL,     FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE SET NULL );

CREATE TABLE test_questions (     id INTEGER PRIMARY KEY AUTOINCREMENT,     test_id INTEGER NOT NULL,     question TEXT NOT NULL,     question_type TEXT NOT NULL DEFAULT 'single',     points INTEGER NOT NULL DEFAULT 1,     sort_order INTEGER NOT NULL DEFAULT 0,      FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE );

CREATE TABLE test_attempts (     id INTEGER PRIMARY KEY AUTOINCREMENT,     test_id INTEGER NOT NULL,     user_id INTEGER NOT NULL,     course_id INTEGER NOT NULL,     attempt_number INTEGER NOT NULL DEFAULT 1,     score INTEGER NOT NULL DEFAULT 0,     max_score INTEGER NOT NULL DEFAULT 100,     percentage REAL NOT NULL DEFAULT 0,     passed INTEGER NOT NULL DEFAULT 0,     started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,     submitted_at TEXT,      FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE,     FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,     FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE );

CREATE TABLE test_attempt_answers (     id INTEGER PRIMARY KEY AUTOINCREMENT,     attempt_id INTEGER NOT NULL,     question_id INTEGER NOT NULL,     answer_id INTEGER,     text_answer TEXT,     is_correct INTEGER NOT NULL DEFAULT 0,     points_awarded INTEGER NOT NULL DEFAULT 0,      FOREIGN KEY (attempt_id) REFERENCES test_attempts(id) ON DELETE CASCADE,     FOREIGN KEY (question_id) REFERENCES test_questions(id) ON DELETE CASCADE,     FOREIGN KEY (answer_id) REFERENCES test_answers(id) ON DELETE SET NULL );

CREATE TABLE tribute_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL UNIQUE,
            event_type TEXT,
            payment_status TEXT,
            user_id INTEGER,
            program_id INTEGER,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

CREATE TABLE tribute_orders (     id INTEGER PRIMARY KEY AUTOINCREMENT,      order_uid TEXT NOT NULL UNIQUE,      user_id INTEGER NOT NULL,     semester_id INTEGER NOT NULL,      amount_rub INTEGER NOT NULL,     currency TEXT NOT NULL DEFAULT 'RUB',      status TEXT NOT NULL DEFAULT 'pending'         CHECK (             status IN (                 'pending',                 'paid',                 'failed',                 'cancelled'             )         ),      tribute_order_id TEXT,     tribute_payment_id TEXT,      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,     paid_at TEXT,      FOREIGN KEY (user_id)         REFERENCES users(id)         ON DELETE CASCADE,      FOREIGN KEY (semester_id)         REFERENCES semesters(id)         ON DELETE CASCADE );

CREATE TABLE user_courses (     id INTEGER PRIMARY KEY AUTOINCREMENT,     user_id INTEGER NOT NULL,     course_id INTEGER NOT NULL,     status TEXT NOT NULL DEFAULT 'pending_payment',     access_until TEXT,     payment_required INTEGER NOT NULL DEFAULT 1,     created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,     updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,     UNIQUE(user_id, course_id),     FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,     FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE );

CREATE TABLE user_notifications (     id INTEGER PRIMARY KEY AUTOINCREMENT,      notification_id INTEGER NOT NULL,     user_id INTEGER NOT NULL,      is_read INTEGER NOT NULL DEFAULT 0,     read_at TEXT,      UNIQUE(notification_id, user_id),      FOREIGN KEY (notification_id)         REFERENCES notifications(id)         ON DELETE CASCADE,      FOREIGN KEY (user_id)         REFERENCES users(id)         ON DELETE CASCADE );

CREATE TABLE user_groups (     id INTEGER PRIMARY KEY AUTOINCREMENT,      user_id INTEGER NOT NULL,     group_id INTEGER NOT NULL,      UNIQUE(user_id, group_id),      FOREIGN KEY (user_id)         REFERENCES users(id)         ON DELETE CASCADE,      FOREIGN KEY (group_id)         REFERENCES groups(id)         ON DELETE CASCADE );

CREATE TABLE tribute_product_programs (
    tribute_product_id TEXT PRIMARY KEY,
    program_id INTEGER NOT NULL,
    FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE
);

CREATE TABLE tribute_webhook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    event_name TEXT NOT NULL,
    product_id TEXT,
    telegram_user_id TEXT,
    purchase_id TEXT,
    transaction_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tribute_product_edit_state (
        chat_id INTEGER PRIMARY KEY,
        waiting INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

CREATE TABLE "users" (     id INTEGER PRIMARY KEY AUTOINCREMENT,     telegram_id INTEGER UNIQUE,     username TEXT,     first_name TEXT,     last_name TEXT,     phone TEXT,     role TEXT NOT NULL DEFAULT 'student',     status TEXT NOT NULL DEFAULT 'active',     blocked_reason TEXT,     blocked_at TEXT,     created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,     updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,     login TEXT UNIQUE,     password_hash TEXT , email TEXT, email_verified_at TEXT, avatar_key TEXT, avatar_source TEXT, account_id INTEGER);

CREATE TABLE user_programs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    program_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'expired', 'blocked')),
    access_until TEXT,
    granted_by INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, program_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE,
    FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE user_profile_settings (
    user_id INTEGER PRIMARY KEY,
    email TEXT UNIQUE,
    notify_email INTEGER NOT NULL DEFAULT 0
        CHECK (notify_email IN (0, 1)),
    notify_telegram INTEGER NOT NULL DEFAULT 1
        CHECK (notify_telegram IN (0, 1)),
    telegram_linked_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE user_semesters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    program_id INTEGER NOT NULL,
    semester_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'expired', 'blocked')),
    access_until TEXT,
    granted_by INTEGER,
    source_checkout_order_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (user_id, semester_id),

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE,
    FOREIGN KEY (semester_id) REFERENCES semesters(id) ON DELETE CASCADE,
    FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (source_checkout_order_id) REFERENCES checkout_orders(id) ON DELETE SET NULL
);

CREATE TABLE user_program_access (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            program_id INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            source TEXT,
            granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            expires_at TEXT,
            UNIQUE(user_id, program_id)
        );

CREATE TABLE yookassa_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,

            order_uid TEXT NOT NULL UNIQUE,

            user_id INTEGER NOT NULL,
            telegram_id TEXT NOT NULL,

            course_id INTEGER NOT NULL,
            program_id INTEGER,
            semester_id INTEGER NOT NULL,

            amount_rub INTEGER NOT NULL,
            currency TEXT NOT NULL DEFAULT 'RUB',

            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (
                    status IN (
                        'pending',
                        'paid',
                        'canceled',
                        'failed'
                    )
                ),

            idempotence_key TEXT NOT NULL UNIQUE,

            yookassa_payment_id TEXT UNIQUE,
            confirmation_url TEXT,

            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            paid_at TEXT,

            FOREIGN KEY (user_id)
                REFERENCES users(id)
                ON DELETE CASCADE,

            FOREIGN KEY (course_id)
                REFERENCES courses(id)
                ON DELETE CASCADE,

            FOREIGN KEY (semester_id)
                REFERENCES semesters(id)
                ON DELETE CASCADE
        );

CREATE INDEX idx_audit_logs_admin     ON audit_logs(admin_id);

CREATE INDEX idx_admin_permissions_admin ON admin_permissions(admin_id);

CREATE INDEX idx_assessment_access_user
        ON assessment_access(user_id)
        ;

CREATE INDEX idx_assessment_access_item
        ON assessment_access(
            assessment_type,
            assessment_id
        )
        ;

CREATE TABLE yoomoney_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT NOT NULL UNIQUE,
            user_id INTEGER NOT NULL,
            program_id INTEGER NOT NULL,
            semester_id INTEGER NOT NULL,
            amount_rub INTEGER NOT NULL,
            expected_withdraw_minor INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            operation_id TEXT UNIQUE,
            expires_at INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            paid_at TEXT
        , access_months INTEGER NOT NULL DEFAULT 3);

CREATE TABLE yoomoney_notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            operation_id TEXT NOT NULL UNIQUE,
            order_label TEXT NOT NULL,
            withdraw_amount_minor INTEGER NOT NULL,
            received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

CREATE INDEX idx_audit_logs_course     ON audit_logs(course_id);

CREATE INDEX idx_auth_sessions_token ON auth_sessions(token);

CREATE INDEX idx_checkout_attempts_email_created
ON checkout_attempts(email_hash, created_at);

CREATE INDEX idx_checkout_access_grants_user_scope ON checkout_access_grants(user_id,status,program_id,semester_id);

CREATE INDEX idx_books_course
        ON books(course_id)
        ;

CREATE INDEX idx_books_subject
        ON books(subject_id)
        ;

CREATE INDEX idx_checkout_orders_tribute_uuid
ON checkout_orders(tribute_order_uuid);

CREATE INDEX idx_checkout_orders_email_hash
ON checkout_orders(email_hash);

CREATE INDEX idx_checkout_attempts_fingerprint_created
ON checkout_attempts(request_fingerprint, created_at);

CREATE INDEX idx_checkout_order_scopes_program
ON checkout_order_scopes(program_id, semester_id);

CREATE INDEX idx_checkout_claims_delivery ON checkout_claims(delivery_status,expires_at);

CREATE INDEX idx_checkout_claims_user ON checkout_claims(claimed_user_id,claimed_at);

CREATE INDEX idx_checkout_plans_active
ON checkout_plans(active, slug);

CREATE INDEX idx_checkout_webhooks_order
ON checkout_webhook_events(tribute_order_uuid);

CREATE INDEX idx_checkout_plan_scopes_program
ON checkout_plan_scopes(program_id, semester_id);

CREATE INDEX idx_email_auth_codes_email ON email_auth_codes(email);

CREATE INDEX idx_email_auth_codes_lookup ON email_auth_codes(email, purpose, created_at);

CREATE INDEX idx_exams_book
        ON exams(book_id)
        ;

CREATE INDEX idx_lesson_files_lesson ON lesson_files(lesson_id);

CREATE INDEX idx_lesson_progress_user_id ON lesson_progress(user_id);

CREATE INDEX idx_lessons_book
        ON lessons(book_id)
        ;

CREATE INDEX idx_group_posts_group_id ON group_posts(group_id,id);

CREATE INDEX idx_group_posts_rate ON group_posts(user_id,created_at);

CREATE INDEX idx_group_notes_group_id ON group_notes(group_id,id);

CREATE INDEX idx_media_assets_course ON media_assets(course_id);

CREATE INDEX idx_profile_settings_email
ON user_profile_settings(email);

CREATE INDEX idx_tests_book
        ON tests(book_id)
        ;

CREATE INDEX idx_support_reply ON support_messages(admin_id, admin_message_id);

CREATE INDEX idx_payments_access ON payments(user_id, course_id, status, expires_at);

CREATE INDEX idx_payments_course_access ON payments(course_id, status, expires_at);

CREATE INDEX idx_user_programs_user ON user_programs(user_id);

CREATE INDEX idx_user_semesters_user_program
ON user_semesters(user_id, program_id, semester_id);

CREATE UNIQUE INDEX idx_users_email_unique
        ON users(LOWER(email))
        WHERE email IS NOT NULL
          AND email != ''
        ;

CREATE UNIQUE INDEX idx_users_login_unique
        ON users(login)
        WHERE login IS NOT NULL
          AND login != ''
        ;

CREATE UNIQUE INDEX idx_users_account_id
                ON users(account_id)
                ;

CREATE INDEX idx_yookassa_orders_payment
        ON yookassa_orders(yookassa_payment_id)
    ;

CREATE INDEX idx_yoomoney_orders_user_semester ON yoomoney_orders(user_id, semester_id, status);

CREATE INDEX idx_yookassa_orders_user
        ON yookassa_orders(user_id)
    ;
