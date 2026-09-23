import {run,addColumn} from './school-core.js';

// Additive compatibility migration: preserves existing accounts, payments and access.
// The same statements are exported for the offline migration/verification command.
export const CORE_SCHEMA = [
`CREATE TABLE IF NOT EXISTS app_settings(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS school_email_codes(id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL,code_hash TEXT NOT NULL,purpose TEXT NOT NULL CHECK(purpose IN('register','login','link','reset','unlink')),expires_at INTEGER NOT NULL,used_at INTEGER,attempts INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL)`,
`CREATE INDEX IF NOT EXISTS school_email_codes_lookup ON school_email_codes(email,purpose,created_at)`,
`CREATE TABLE IF NOT EXISTS support_state(user_id TEXT PRIMARY KEY,waiting INTEGER NOT NULL DEFAULT 0)`,
`CREATE TABLE IF NOT EXISTS support_messages(id INTEGER PRIMARY KEY AUTOINCREMENT,admin_id TEXT,admin_message_id INTEGER,user_id TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS school_playback(user_id INTEGER NOT NULL REFERENCES users(id),lesson_id INTEGER NOT NULL REFERENCES lessons(id),position_seconds REAL NOT NULL DEFAULT 0,duration_seconds REAL NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,PRIMARY KEY(user_id,lesson_id))`,
`CREATE TABLE IF NOT EXISTS school_media_progress(user_id INTEGER NOT NULL REFERENCES users(id),lesson_id INTEGER NOT NULL REFERENCES lessons(id),file_id INTEGER NOT NULL DEFAULT 0,position_seconds REAL NOT NULL DEFAULT 0,duration_seconds REAL NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,PRIMARY KEY(user_id,lesson_id,file_id))`,
`CREATE TABLE IF NOT EXISTS school_course_rules(course_id INTEGER PRIMARY KEY REFERENCES courses(id),sequential_lessons INTEGER NOT NULL DEFAULT 1 CHECK(sequential_lessons IN(0,1)))`,
`CREATE TABLE IF NOT EXISTS school_link_challenges(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),token_hash TEXT NOT NULL UNIQUE,telegram_id INTEGER,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','claimed','confirmed','cancelled')),expires_at TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,confirmed_at TEXT)`,
`CREATE TABLE IF NOT EXISTS school_link_receipts(challenge_id TEXT NOT NULL PRIMARY KEY REFERENCES school_link_challenges(id))`,
`CREATE TABLE IF NOT EXISTS school_identity_aliases(telegram_id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS school_account_events(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL REFERENCES users(id),action TEXT NOT NULL,telegram_id INTEGER,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS school_migration_markers(name TEXT PRIMARY KEY,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`
];
export const CORE_COLUMNS = {
    users: {account_id:'INTEGER',login:'TEXT',password_hash:'TEXT',email:'TEXT',email_verified_at:'TEXT',avatar_key:'TEXT',avatar_source:'TEXT'},
    lesson_progress: {is_completed:'INTEGER NOT NULL DEFAULT 0',completed:'INTEGER NOT NULL DEFAULT 0',progress_percent:'INTEGER NOT NULL DEFAULT 0'},
    lessons: {video_url:'TEXT',audio_url:'TEXT'},
    auth_sessions: {auth_method:"TEXT NOT NULL DEFAULT 'legacy'"}
};
const ready = new WeakMap();
export async function ensureSchoolSchema(db) {
    if(ready.has(db)) return ready.get(db);
    const pending=(async()=>{
        await run(db,`CREATE TABLE IF NOT EXISTS auth_sessions(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,token TEXT NOT NULL UNIQUE,expires_at TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,auth_method TEXT NOT NULL DEFAULT 'legacy')`);
        for(const sql of CORE_SCHEMA) await run(db,sql);
        for(const [table,fields] of Object.entries(CORE_COLUMNS)) for(const [name,type] of Object.entries(fields)) await addColumn(db,table,name,type);
        await run(db,'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_login_unique ON users(login) WHERE login IS NOT NULL AND login<>\'\'');
        await run(db,'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email) WHERE email IS NOT NULL AND email<>\'\'');
    })();
    ready.set(db,pending);
    try {await pending;}catch(e){ready.delete(db);throw e;}
}
