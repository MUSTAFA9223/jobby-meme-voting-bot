import unittest
import sqlite3
import tempfile
from pathlib import Path

from jobby_bot.store import Store
from jobby_bot.validation import normalize_x_handle, normalize_telegram_handle, normalize_tweet


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.store = Store(":memory:")
        self.a = self.store.create_entry("photo_1", "https://x.com/alpha/status/123", "alpha", "alphatest", 444)
        self.b = self.store.create_entry("photo_2", "https://x.com/bravo/status/456", "bravo", "bravotest", 444)

    def tearDown(self):
        self.store.close()

    def test_entries_and_soft_delete(self):
        self.assertEqual(self.store.entry_ids(), [1, 2])
        self.assertTrue(self.store.set_active(self.b, False))
        self.assertIsNone(self.store.entry(self.b))
        self.assertIsNotNone(self.store.entry(self.b, active_only=False))
        self.assertEqual(self.store.entry_ids(), [1])
        self.assertTrue(self.store.set_active(self.b, True))
        self.assertEqual(self.store.entry_ids(), [1, 2])

    def test_gallery_entries_are_in_publication_order(self):
        self.assertEqual([r["id"] for r in self.store.standings()], [self.a, self.b])
        self.store.set_active(self.b, False)
        self.assertEqual([r["id"] for r in self.store.standings()], [self.a])
        self.assertEqual(self.store.counts(), {"entries": 1, "hidden": 1})

    def test_draft_persists_with_cancel(self):
        self.store.save_draft(111, "photo", {"photo_file_id": "image"})
        self.assertEqual(self.store.draft(111), ("photo", {"photo_file_id": "image"}))
        self.store.save_draft(111, "tweet", {"photo_file_id": "image"})
        self.assertEqual(self.store.draft(111)[0], "tweet")
        self.store.clear_draft(111)
        self.assertIsNone(self.store.draft(111))

    def test_legacy_records_are_preserved_but_not_used_by_gallery(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = str(Path(directory) / "legacy.sqlite3")
            db = sqlite3.connect(filename)
            db.executescript("""
                CREATE TABLE entries (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, photo_file_id TEXT NOT NULL,
                    tweet_url TEXT NOT NULL, x_username TEXT NOT NULL,
                    telegram_username TEXT NOT NULL, created_by INTEGER NOT NULL,
                    created_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
                );
                CREATE TABLE votes (
                    user_id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL,
                    updated_at TEXT NOT NULL
                );
                INSERT INTO entries VALUES
                    (1,'a','https://x.com/a/status/1','a','aaaaa',1,'now',1),
                    (2,'b','https://x.com/b/status/2','b','bbbbb',1,'now',1);
                INSERT INTO votes VALUES (99,1,'now');
            """)
            db.close()
            migrated = Store(filename)
            try:
                rows = migrated.db.execute("SELECT user_id, entry_id FROM votes").fetchall()
                self.assertEqual([tuple(row) for row in rows], [(99, 1)])
                self.assertEqual([r["id"] for r in migrated.standings()], [1, 2])
            finally:
                migrated.close()


class ValidationTests(unittest.TestCase):
    def test_x_normalization(self):
        self.assertEqual(normalize_x_handle("@User_1"), "User_1")
        self.assertEqual(normalize_x_handle("https://x.com/User_1"), "User_1")
        with self.assertRaises(ValueError):
            normalize_x_handle("bad/name")

    def test_telegram_normalization(self):
        self.assertEqual(normalize_telegram_handle("https://t.me/creator_123"), "creator_123")
        with self.assertRaises(ValueError):
            normalize_telegram_handle("@a")

    def test_tweet_validation(self):
        self.assertEqual(normalize_tweet("https://twitter.com/User_1/status/129?t=test"),
                         "https://x.com/User_1/status/129")
        with self.assertRaises(ValueError):
            normalize_tweet("https://x.com.evil.example/User_1/status/129")
        with self.assertRaises(ValueError):
            normalize_tweet("http://x.com/User_1/status/129")
        with self.assertRaises(ValueError):
            normalize_tweet("https://example.com/fake")


if __name__ == "__main__":
    unittest.main()
