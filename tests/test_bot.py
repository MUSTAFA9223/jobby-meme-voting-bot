import unittest
from jobby_bot.bot import MemeBot
from jobby_bot.store import Store


class FakeAPI:
    def __init__(self):
        self.calls = []
        self.member_result = {"status": "member"}

    def send(self, chat_id, text, reply_markup=None):
        self.calls.append(("send", chat_id, text, reply_markup))
        return {"message_id": len(self.calls)}

    def photo(self, chat_id, file_id, caption, reply_markup=None):
        self.calls.append(("photo", chat_id, file_id, caption, reply_markup))
        return {"message_id": len(self.calls)}

    def ack(self, callback_id, text=""):
        self.calls.append(("ack", callback_id, text))
        return True

    def call(self, method, **kwargs):
        self.calls.append(("call", method, kwargs))
        if method == "getChatMember":
            return self.member_result
        return True


class BotTests(unittest.TestCase):
    def setUp(self):
        self.db = Store(":memory:")
        self.api = FakeAPI()
        self.bot = MemeBot(self.api, self.db, {444})
        self.bot.username = "JOBBYMemeVoteBot"

    def tearDown(self):
        self.db.close()

    def message(self, user_id, text=None, photo=None, chat_type="private", username=None):
        item = {"from": {"id": user_id, "username": username or f"user{user_id}"},
                "chat": {"id": user_id, "type": chat_type}, "message_id": 11}
        if text is not None:
            item["text"] = text
        if photo is not None:
            item["photo"] = [{"file_id": photo, "width": 100, "height": 100}]
        self.bot.handle_update({"message": item})

    def callback(self, user_id, action, username=None, has_photo=True):
        message = {"message_id": 20, "chat": {"id": user_id, "type": "private"}}
        if has_photo:
            message["photo"] = [{"file_id": "img"}]
        self.bot.handle_update({"callback_query": {
            "id": f"callback-{user_id}-{action}", "data": action,
            "from": {"id": user_id, "username": username or f"user{user_id}"},
            "message": message,
        }})

    def test_admin_upload_and_gallery_flow(self):
        self.message(444, "/add")
        self.assertEqual(self.db.draft(444)[0], "photo")
        self.message(444, photo="telegram-photo-file-id")
        self.assertEqual(self.db.draft(444)[0], "tweet")
        self.message(444, "https://x.com/artist/status/1888123?ref=abc")
        self.message(444, "@artist")
        self.message(444, "@artisttelegram")
        self.assertEqual(self.db.draft(444)[0], "confirm")
        self.assertEqual(self.api.calls[-1][0], "photo")
        self.callback(444, "admin:confirm")
        self.assertIsNone(self.db.draft(444))
        self.assertEqual(self.db.entry_ids(), [1])
        entry = self.db.entry(1)
        self.assertEqual(entry["photo_file_id"], "telegram-photo-file-id")
        cards = [c for c in self.api.calls if c[0] == "photo"]
        caption, markup = cards[-1][3], cards[-1][4]
        self.assertIn("JOBBY MEME ENTRY", caption)
        self.assertIn("Original X post", caption)
        callbacks = [button.get("callback_data", "") for row in markup["inline_keyboard"] for button in row]
        self.assertFalse(any(x.startswith(("vote:", "rate:")) for x in callbacks))

    def test_non_admin_cannot_publish(self):
        self.message(123, "/add")
        self.assertIsNone(self.db.draft(123))
        self.callback(123, "admin:add")
        self.assertIsNone(self.db.draft(123))
        self.callback(123, "admin:confirm")
        self.assertEqual(self.db.entry_ids(), [])

    def test_admin_forward_prepares_media_link_and_usernames(self):
        forwarded = {
            "from": {"id": 444, "username": "admin"},
            "chat": {"id": 444, "type": "private"},
            "message_id": 12,
            "photo": [{"file_id": "small"}, {"file_id": "forwarded-meme"}],
            "caption": "Entry https://twitter.com/MemeArtist/status/98765?s=20",
            "forward_origin": {"type": "user", "sender_user": {"id": 77, "username": "memeartisttg"}},
        }
        self.bot.handle_update({"message": forwarded})
        step, data = self.db.draft(444)
        self.assertEqual(step, "confirm")
        self.assertEqual(data["photo_file_id"], "forwarded-meme")
        self.assertEqual(data["tweet_url"], "https://x.com/MemeArtist/status/98765")
        self.assertEqual(data["x_username"], "MemeArtist")
        self.assertEqual(data["telegram_username"], "memeartisttg")
        self.callback(444, "admin:confirm")
        entry = self.db.entry(1)
        self.assertEqual(entry["telegram_username"], "memeartisttg")

    def test_forward_asks_only_for_missing_x_link(self):
        forwarded = {
            "from": {"id": 444}, "chat": {"id": 444, "type": "private"},
            "message_id": 13, "photo": [{"file_id": "meme"}],
            "forward_origin": {"type": "user", "sender_user": {"id": 88, "username": "creatorname"}},
        }
        self.bot.handle_update({"message": forwarded})
        self.assertEqual(self.db.draft(444)[0], "tweet")
        self.message(444, "https://x.com/creator/status/456")
        step, data = self.db.draft(444)
        self.assertEqual(step, "confirm")
        self.assertEqual(data["x_username"], "creator")
        self.assertEqual(data["telegram_username"], "creatorname")

    def test_forwarded_x_preview_then_photo_completes_draft(self):
        preview_only = {
            "from": {"id": 444}, "chat": {"id": 444, "type": "private"},
            "message_id": 14,
            "text": "First entry\nhttps://x.com/Simdavv/status/2108992018710245825",
            "forward_origin": {"type": "user", "sender_user": {"id": 91, "username": "simdav"}},
        }
        self.bot.handle_update({"message": preview_only})
        step, data = self.db.draft(444)
        self.assertEqual(step, "photo")
        self.assertEqual(data["tweet_url"], "https://x.com/Simdavv/status/2108992018710245825")
        self.message(444, photo="actual-meme")
        step, data = self.db.draft(444)
        self.assertEqual(step, "confirm")
        self.assertEqual(data["photo_file_id"], "actual-meme")

    def test_legacy_vote_and_rating_callbacks_are_disabled(self):
        self.db.create_entry("photo", "https://x.com/user/status/2", "artist", "artisttelegram", 444)
        self.callback(101, "vote:1")
        self.callback(101, "rate:1:5")
        self.assertEqual(self.db.db.execute("SELECT COUNT(*) FROM votes").fetchone()[0], 0)
        self.assertEqual(self.db.db.execute("SELECT COUNT(*) FROM ratings").fetchone()[0], 0)
        notices = [c[2] for c in self.api.calls if c[0] == "ack"]
        self.assertEqual(notices[-2:], ["This action is no longer available."] * 2)

    def test_nav_edits_existing_photo_message(self):
        self.db.create_entry("photo", "https://x.com/user/status/2", "artist", "artisttelegram", 444)
        self.callback(101, "nav:1")
        self.assertTrue(any(c[0] == "call" and c[1] == "editMessageMedia" for c in self.api.calls))

    def test_cancel_no_publication(self):
        self.message(444, "/add")
        self.message(444, photo="photo")
        self.message(444, "/cancel")
        self.assertIsNone(self.db.draft(444))
        self.assertEqual(self.db.entry_ids(), [])

    def test_reject_invalid_user_inputs(self):
        self.message(444, "/add")
        self.message(444, photo="photo")
        self.message(444, "https://evil.example/status/1")
        self.assertEqual(self.db.draft(444)[0], "tweet")
        self.message(444, "https://x.com/user/status/1")
        self.message(444, "bad/name")
        self.assertEqual(self.db.draft(444)[0], "x")

if __name__ == "__main__":
    unittest.main()
