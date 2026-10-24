-- Additive school commerce schema. Apply after account-link migrations.
-- No legacy payment/access data is rewritten.

CREATE TABLE IF NOT EXISTS school_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_by INTEGER, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS school_offers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, scope_type TEXT NOT NULL CHECK(scope_type IN ('course','program','semester')),
        scope_id INTEGER NOT NULL, course_id INTEGER, program_id INTEGER, semester_id INTEGER,
        amount_minor INTEGER NOT NULL CHECK(amount_minor>0), currency TEXT NOT NULL CHECK(currency='RUB'),
        access_days INTEGER CHECK(access_days>0), access_unlimited INTEGER NOT NULL DEFAULT 0 CHECK(access_unlimited IN(0,1)),
        is_active INTEGER NOT NULL DEFAULT 0 CHECK(is_active IN(0,1)), yookassa_enabled INTEGER NOT NULL DEFAULT 0,
        tribute_product_id INTEGER UNIQUE, tribute_stars_amount INTEGER, tribute_link TEXT, tribute_web_link TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        CHECK((access_unlimited=1 AND access_days IS NULL) OR (access_unlimited=0 AND access_days IS NOT NULL)));

CREATE TABLE IF NOT EXISTS school_tribute_products (
        product_id INTEGER PRIMARY KEY, offer_id TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS school_orders (
        id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), telegram_id TEXT, offer_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN('yookassa','tribute')), request_key TEXT NOT NULL,
        idempotence_key TEXT NOT NULL UNIQUE, provider_payment_id TEXT, snapshot_json TEXT NOT NULL,
        request_json TEXT, amount_minor INTEGER NOT NULL CHECK(amount_minor>0), currency TEXT NOT NULL CHECK(currency='RUB'),
        status TEXT NOT NULL CHECK(status IN('creating','pending','uncertain','paid','partially_refunded','canceled','failed','refunded','needs_review')),
        confirmation_url TEXT, refunded_minor INTEGER NOT NULL DEFAULT 0, receipt_registration TEXT, charged_amount INTEGER, charged_currency TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, paid_at TEXT, last_error TEXT,
        UNIQUE(user_id,request_key), UNIQUE(provider,provider_payment_id));

CREATE TRIGGER IF NOT EXISTS school_orders_immutable BEFORE UPDATE OF offer_id,provider,request_key,idempotence_key,snapshot_json,request_json,amount_minor,currency ON school_orders
        WHEN NEW.offer_id IS NOT OLD.offer_id OR NEW.provider IS NOT OLD.provider
        OR NEW.request_key IS NOT OLD.request_key OR NEW.idempotence_key IS NOT OLD.idempotence_key
        OR NEW.snapshot_json IS NOT OLD.snapshot_json OR NEW.request_json IS NOT OLD.request_json
        OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.currency IS NOT OLD.currency
        BEGIN SELECT RAISE(ABORT,'Immutable payment snapshot'); END;

CREATE TRIGGER IF NOT EXISTS school_orders_user_transfer BEFORE UPDATE OF user_id ON school_orders
        WHEN NEW.user_id IS NOT OLD.user_id AND NOT EXISTS(
            SELECT 1 FROM users source JOIN users target ON target.id=NEW.user_id
            JOIN school_link_challenges c ON c.user_id=target.id AND c.telegram_id=target.telegram_id AND c.status='confirmed'
            JOIN school_link_receipts r ON r.challenge_id=c.id
            WHERE source.id=OLD.user_id AND source.status='blocked'
              AND source.blocked_reason='Аккаунт перенесён при подтверждённой привязке' AND target.status='active'
              AND OLD.telegram_id=CAST(target.telegram_id AS TEXT))
        BEGIN SELECT RAISE(ABORT,'Payment ownership requires confirmed account transfer'); END;

CREATE TRIGGER IF NOT EXISTS school_orders_provider_id_immutable BEFORE UPDATE OF provider_payment_id ON school_orders
        WHEN OLD.provider_payment_id IS NOT NULL AND NEW.provider_payment_id IS NOT OLD.provider_payment_id
        BEGIN SELECT RAISE(ABORT,'Immutable provider payment id'); END;

CREATE TABLE IF NOT EXISTS school_entitlements (
        id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), source TEXT NOT NULL, source_order_id TEXT NOT NULL,
        scope_type TEXT NOT NULL CHECK(scope_type IN('course','program','semester')), scope_id INTEGER NOT NULL,
        course_id INTEGER, program_id INTEGER, semester_id INTEGER,
        status TEXT NOT NULL CHECK(status IN('active','revoked')), starts_at TEXT NOT NULL, expires_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(source,source_order_id));

CREATE INDEX IF NOT EXISTS school_entitlements_user ON school_entitlements(user_id,status);

CREATE TABLE IF NOT EXISTS school_payment_events (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, event_key TEXT NOT NULL, event_type TEXT NOT NULL,
        order_id TEXT, payload_json TEXT NOT NULL, status TEXT NOT NULL, reason TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(provider,event_key));

CREATE TABLE IF NOT EXISTS school_refund_tombstones (
        provider TEXT NOT NULL, purchase_id TEXT NOT NULL, product_id INTEGER, telegram_id TEXT,
        created_at TEXT NOT NULL, PRIMARY KEY(provider,purchase_id));

CREATE TABLE IF NOT EXISTS school_refunds (
        id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES school_orders(id), request_key TEXT NOT NULL,
        idempotence_key TEXT NOT NULL UNIQUE, provider_refund_id TEXT UNIQUE, amount_minor INTEGER NOT NULL,
        status TEXT NOT NULL, request_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(order_id,request_key));

CREATE UNIQUE INDEX IF NOT EXISTS school_refunds_one_request ON school_refunds(order_id)
        WHERE request_key NOT LIKE 'provider:%' AND status IN('creating','submitting','uncertain','pending','needs_review','succeeded');

CREATE TABLE IF NOT EXISTS school_checkout_intents (
        id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), request_key TEXT NOT NULL,
        offer_id TEXT NOT NULL, product_id INTEGER NOT NULL, snapshot_json TEXT NOT NULL,
        confirmation_url TEXT NOT NULL, channel TEXT NOT NULL CHECK(channel IN('web','telegram')), created_at TEXT NOT NULL, UNIQUE(user_id,request_key));

CREATE INDEX IF NOT EXISTS school_orders_user ON school_orders(user_id,created_at);
