ALTER TABLE courses ADD COLUMN cover_image TEXT NOT NULL DEFAULT '';
ALTER TABLE school_offers ADD COLUMN payment_links_json TEXT NOT NULL DEFAULT '[]';
