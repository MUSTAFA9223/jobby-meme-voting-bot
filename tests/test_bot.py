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

    def test_admin_upload_and_vote_flow(self):
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
        self.callback(200, "vote:1")
        self.callback(200, "rate:1:5")
        self.assertTrue(self.db.has_voted(200, 1))
        self.assertEqual(self.db.rating_for(200, 1), 5)
        self.assertEqual(self.db.standings()[0]["votes"], 1)
        self.assertEqual(self.db.standings()[0]["average_stars"], 5)
        self.assertTrue(any(c[0] == "call" and c[1] == "editMessageCaption" for c in self.api.calls))

    def test_non_admin_cannot_publish(self):
        self.message(123, "/add")
        self.assertIsNone(self.db.draft(123))
        self.callback(123, "admin:add")
        self.assertIsNone(self.db.draft(123))
        self.callback(123, "admin:confirm")
        self.assertEqual(self.db.entry_ids(), [])

    def test_self_vote_and_rating_block(self):
        self.db.create_entry("photo", "https://x.com/user/status/2", "artist", "artisttelegram", 444)
        self.callback(101, "vote:1", username="ARTISTTELEGRAM")
        self.callback(101, "rate:1:5", username="artisttelegram")
        self.assertEqual(self.db.counts()["voters"], 0)
        self.assertEqual(self.db.counts()["ratings"], 0)

    def test_membership_guard(self):
        self.bot.required_chat = "@JOBBYChat"
        self.db.create_entry("photo", "https://x.com/user/status/2", "artist", "artisttelegram", 444)
        self.api.member_result = {"status": "left"}
        self.callback(101, "vote:1")
        self.assertFalse(self.db.has_voted(101, 1))
        self.api.member_result = {"status": "member"}
        self.callback(101, "vote:1")
        self.assertTrue(self.db.has_voted(101, 1))

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

    def test_admin_close_and_reopen(self):
        self.db.create_entry("photo", "https://x.com/user/status/2", "artist", "artisttelegram", 444)
        self.message(444, "/close")
        self.callback(101, "vote:1")
        self.assertFalse(self.db.has_voted(101, 1))
        self.message(444, "/resume")
        self.callback(101, "vote:1")
        self.assertTrue(self.db.has_voted(101, 1))


if __name__ == "__main__":
    unittest.main()
