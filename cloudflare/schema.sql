-- Existing SQLite tables are preserved when importing the encrypted GitHub state.
CREATE TABLE IF NOT EXISTS entries (
 id INTEGER PRIMARY KEY AUTOINCREMENT, photo_file_id TEXT NOT NULL,
 media_type TEXT NOT NULL DEFAULT 'photo' CHECK(media_type IN ('photo','video','animation')),
 tweet_url TEXT NOT NULL, x_username TEXT NOT NULL, telegram_username TEXT NOT NULL,
 creator_name TEXT NOT NULL DEFAULT '', created_by INTEGER NOT NULL, created_at TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
-- Legacy archival tables are retained to avoid destructive data loss.
-- The gallery application never reads or writes these records.
CREATE TABLE IF NOT EXISTS votes (
 user_id INTEGER NOT NULL, entry_id INTEGER NOT NULL REFERENCES entries(id), updated_at TEXT NOT NULL,
 PRIMARY KEY(user_id,entry_id)
);
CREATE INDEX IF NOT EXISTS idx_votes_entry ON votes(entry_id);
CREATE TABLE IF NOT EXISTS ratings (
 user_id INTEGER NOT NULL, entry_id INTEGER NOT NULL REFERENCES entries(id),
 value INTEGER NOT NULL CHECK(value BETWEEN 1 AND 5), updated_at TEXT NOT NULL,
 PRIMARY KEY(user_id,entry_id)
);
CREATE INDEX IF NOT EXISTS idx_ratings_entry ON ratings(entry_id);
CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS drafts (admin_id INTEGER PRIMARY KEY,step TEXT NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS destinations (
 chat_id INTEGER PRIMARY KEY, title TEXT NOT NULL, chat_type TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 registered_by INTEGER NOT NULL, updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO config VALUES ('status','open');
CREATE TABLE IF NOT EXISTS webhook_updates (
 update_id INTEGER PRIMARY KEY, received_at TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS webhook_outbox (
 id INTEGER PRIMARY KEY AUTOINCREMENT, update_id INTEGER NOT NULL,
 method TEXT NOT NULL, payload TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_outbox_update ON webhook_outbox(update_id,delivered);
