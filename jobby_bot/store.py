"""Persistent SQLite contest storage; no external service is required."""
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

    def status(self) -> str:
        return self.db.execute("SELECT value FROM config WHERE key='status'").fetchone()[0]

    def set_status(self, status: str):
        if status not in ("open", "paused", "closed"):
            raise ValueError("Invalid contest status")
        with self.db:
            self.db.execute("UPDATE config SET value=? WHERE key='status'", (status,))

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

    def cast_vote(self, user_id: int, entry_id: int) -> str:
        """Record one permanent vote per Telegram account and meme."""
        with self.db:
            if self.status() != "open":
                return "closed"
            if not self.entry(entry_id):
                return "missing"
            if self.has_voted(user_id, entry_id):
                return "same"
            self.db.execute("INSERT OR IGNORE INTO votes(user_id, entry_id, updated_at) VALUES (?, ?, ?)",
                            (user_id, entry_id, now()))
            return "saved"

    def rate(self, user_id: int, entry_id: int, value: int) -> str:
        if value not in range(1, 6):
            raise ValueError("Rating must be from 1 to 5")
        with self.db:
            if self.status() != "open":
                return "closed"
            if not self.entry(entry_id):
                return "missing"
            self.db.execute("""INSERT INTO ratings(user_id, entry_id, value, updated_at)
                VALUES (?, ?, ?, ?) ON CONFLICT(user_id, entry_id)
                DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at""",
                (user_id, entry_id, value, now()))
            return "saved"

    def vote_for(self, user_id: int) -> int | None:
        row = self.db.execute("SELECT entry_id FROM votes WHERE user_id=?", (user_id,)).fetchone()
        return row[0] if row else None

    def has_voted(self, user_id: int, entry_id: int) -> bool:
        row = self.db.execute(
            "SELECT 1 FROM votes WHERE user_id=? AND entry_id=?", (user_id, entry_id)
        ).fetchone()
        return row is not None

    def rating_for(self, user_id: int, entry_id: int) -> int | None:
        row = self.db.execute("SELECT value FROM ratings WHERE user_id=? AND entry_id=?", (user_id, entry_id)).fetchone()
        return row[0] if row else None

    def standings(self) -> list[dict]:
        """Order by vote count, then mean stars and number of star ratings."""
        rows = self.db.execute("""
            SELECT e.*,
                COALESCE(v.n, 0) AS votes,
                COALESCE(r.n, 0) AS rating_count,
                COALESCE(r.avg_stars, 0) AS average_stars
            FROM entries e
            LEFT JOIN (SELECT entry_id, COUNT(*) AS n FROM votes GROUP BY entry_id) v
                ON v.entry_id=e.id
            LEFT JOIN (SELECT entry_id, COUNT(*) AS n, AVG(value) AS avg_stars
                FROM ratings GROUP BY entry_id) r ON r.entry_id=e.id
            WHERE e.active=1
            ORDER BY votes DESC, average_stars DESC, rating_count DESC, e.id ASC
        """).fetchall()
        return [dict(row) for row in rows]

    def counts(self) -> dict:
        row = self.db.execute("""
            SELECT (SELECT COUNT(*) FROM entries WHERE active=1),
                   (SELECT COUNT(*) FROM entries WHERE active=0),
                   (SELECT COUNT(*) FROM votes v JOIN entries e ON e.id=v.entry_id WHERE e.active=1),
                   (SELECT COUNT(*) FROM ratings r JOIN entries e ON e.id=r.entry_id WHERE e.active=1)
        """).fetchone()
        return dict(zip(("entries", "hidden", "voters", "ratings"), row))

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
