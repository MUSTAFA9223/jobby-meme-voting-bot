"""Persistent SQLite gallery storage; no external service is required."""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, filename: str):
        if filename != ":memory:":
            Path(filename).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(filename, timeout=30)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.execute("PRAGMA busy_timeout = 30000")
        if filename != ":memory:":
            self.db.execute("PRAGMA journal_mode = WAL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                photo_file_id TEXT NOT NULL,
                tweet_url TEXT NOT NULL,
                x_username TEXT NOT NULL,
                telegram_username TEXT NOT NULL,
                created_by INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
            );
            -- Legacy archival tables are retained to avoid destroying historical data.
            CREATE TABLE IF NOT EXISTS votes (
                user_id INTEGER NOT NULL,
                entry_id INTEGER NOT NULL REFERENCES entries(id),
                updated_at TEXT NOT NULL,
                PRIMARY KEY (user_id, entry_id)
            );
            CREATE INDEX IF NOT EXISTS idx_votes_entry ON votes(entry_id);
            CREATE TABLE IF NOT EXISTS ratings (
                user_id INTEGER NOT NULL,
                entry_id INTEGER NOT NULL REFERENCES entries(id),
                value INTEGER NOT NULL CHECK (value BETWEEN 1 AND 5),
                updated_at TEXT NOT NULL,
                PRIMARY KEY (user_id, entry_id)
            );
            CREATE INDEX IF NOT EXISTS idx_ratings_entry ON ratings(entry_id);
            CREATE TABLE IF NOT EXISTS config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS drafts (
                admin_id INTEGER PRIMARY KEY,
                step TEXT NOT NULL,
                data TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            INSERT OR IGNORE INTO config(key, value) VALUES ('status', 'open');
        """)
        primary_key = [row[1] for row in sorted(
            (row for row in self.db.execute("PRAGMA table_info(votes)") if row[5]),
            key=lambda row: row[5])]
        if primary_key != ["user_id", "entry_id"]:
            self.db.execute("DROP INDEX IF EXISTS idx_votes_entry")
            self.db.execute("ALTER TABLE votes RENAME TO votes_single_choice")
            self.db.execute("""CREATE TABLE votes (
                user_id INTEGER NOT NULL,
                entry_id INTEGER NOT NULL REFERENCES entries(id),
                updated_at TEXT NOT NULL,
                PRIMARY KEY (user_id, entry_id)
            )""")
            self.db.execute("""INSERT OR IGNORE INTO votes(user_id, entry_id, updated_at)
                SELECT user_id, entry_id, updated_at FROM votes_single_choice""")
            self.db.execute("DROP TABLE votes_single_choice")
            self.db.execute("CREATE INDEX idx_votes_entry ON votes(entry_id)")
        self.db.commit()

    def close(self):
        self.db.close()

    def last_update_offset(self) -> int:
        row = self.db.execute("SELECT value FROM config WHERE key='update_offset'").fetchone()
        return int(row[0]) if row else 0

    def save_update_offset(self, offset: int):
        with self.db:
            self.db.execute("""INSERT INTO config(key,value) VALUES ('update_offset',?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value""", (str(offset),))

    def create_entry(self, photo_file_id: str, tweet_url: str, x_username: str,
                     telegram_username: str, created_by: int) -> int:
        with self.db:
            cur = self.db.execute(
                """INSERT INTO entries(photo_file_id, tweet_url, x_username,
                telegram_username, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)""",
                (photo_file_id, tweet_url, x_username, telegram_username, created_by, now()),
            )
            return cur.lastrowid

    def entry(self, entry_id: int, active_only: bool = True) -> dict | None:
        sql = "SELECT * FROM entries WHERE id=?" + (" AND active=1" if active_only else "")
        row = self.db.execute(sql, (entry_id,)).fetchone()
        return dict(row) if row else None

    def entry_ids(self) -> list[int]:
        return [row[0] for row in self.db.execute("SELECT id FROM entries WHERE active=1 ORDER BY id")]

    def set_active(self, entry_id: int, active: bool) -> bool:
        with self.db:
            cur = self.db.execute("UPDATE entries SET active=? WHERE id=?", (int(active), entry_id))
            return cur.rowcount > 0

    def standings(self) -> list[dict]:
        """Return visible gallery entries in publication order."""
        rows = self.db.execute("SELECT * FROM entries WHERE active=1 ORDER BY id ASC").fetchall()
        return [dict(row) for row in rows]

    def counts(self) -> dict:
        row = self.db.execute("""
            SELECT (SELECT COUNT(*) FROM entries WHERE active=1),
                   (SELECT COUNT(*) FROM entries WHERE active=0)
        """).fetchone()
        return dict(zip(("entries", "hidden"), row))

    def save_draft(self, admin_id: int, step: str, data: dict):
        with self.db:
            self.db.execute("""INSERT INTO drafts(admin_id, step, data, updated_at)
                VALUES (?, ?, ?, ?) ON CONFLICT(admin_id) DO UPDATE
                SET step=excluded.step, data=excluded.data, updated_at=excluded.updated_at""",
                (admin_id, step, json.dumps(data), now()))

    def draft(self, admin_id: int) -> tuple[str, dict] | None:
        row = self.db.execute("SELECT step, data FROM drafts WHERE admin_id=?", (admin_id,)).fetchone()
        return (row["step"], json.loads(row["data"])) if row else None

    def clear_draft(self, admin_id: int):
        with self.db:
            self.db.execute("DELETE FROM drafts WHERE admin_id=?", (admin_id,))
