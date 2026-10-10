import unittest

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

    def test_one_global_vote_can_change(self):
        self.assertEqual(self.store.cast_vote(99, self.a), "saved")
        self.assertEqual(self.store.cast_vote(99, self.a), "same")
        self.assertEqual(self.store.cast_vote(99, self.b), "changed")
        self.assertEqual(self.store.vote_for(99), self.b)
        standings = self.store.standings()
        self.assertEqual([(r["id"], r["votes"]) for r in standings], [(self.b, 1), (self.a, 0)])
        self.assertEqual(self.store.counts()["voters"], 1)

    def test_ratings_can_be_changed_but_not_duplicated(self):
        self.assertEqual(self.store.rate(99, self.a, 1), "saved")
        self.assertEqual(self.store.rate(99, self.a, 5), "saved")
        self.assertEqual(self.store.rate(100, self.a, 3), "saved")
        a = next(x for x in self.store.standings() if x["id"] == self.a)
        self.assertEqual(a["rating_count"], 2)
        self.assertEqual(a["average_stars"], 4.0)
        self.assertEqual(self.store.rating_for(99, self.a), 5)
        self.assertEqual(self.store.counts()["ratings"], 2)
        with self.assertRaises(ValueError):
            self.store.rate(99, self.a, 6)

    def test_pause_and_close_block_actions(self):
        self.store.set_status("paused")
        self.assertEqual(self.store.cast_vote(99, self.a), "closed")
        self.assertEqual(self.store.rate(99, self.a, 5), "closed")
        self.store.set_status("closed")
        self.assertEqual(self.store.cast_vote(99, self.a), "closed")
        self.store.set_status("open")
        self.assertEqual(self.store.cast_vote(99, self.a), "saved")

    def test_hidden_entries_disappear_from_rankings_and_cannot_be_voted(self):
        self.store.cast_vote(99, self.b)
        self.store.set_active(self.b, False)
        self.assertEqual(self.store.cast_vote(100, self.b), "missing")
        self.assertEqual([r["id"] for r in self.store.standings()], [self.a])
        self.assertEqual(self.store.counts()["voters"], 0)
        self.store.cast_vote(99, self.a)
        self.assertEqual(self.store.counts()["voters"], 1)

    def test_draft_persists_with_cancel(self):
        self.store.save_draft(111, "photo", {"photo_file_id": "image"})
        self.assertEqual(self.store.draft(111), ("photo", {"photo_file_id": "image"}))
        self.store.save_draft(111, "tweet", {"photo_file_id": "image"})
        self.assertEqual(self.store.draft(111)[0], "tweet")
        self.store.clear_draft(111)
        self.assertIsNone(self.store.draft(111))

    def test_stars_break_vote_ties(self):
        self.store.cast_vote(99, self.a)
        self.store.cast_vote(100, self.b)
        self.store.rate(101, self.a, 4)
        self.store.rate(102, self.b, 5)
        self.assertEqual(self.store.standings()[0]["id"], self.b)


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
