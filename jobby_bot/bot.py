"""JOBBY meme gallery: private admin uploads and public browsing."""
from __future__ import annotations

import html
import logging
import os
import re
import time
from pathlib import Path

from .api import TelegramAPI, TelegramError
from .store import Store
from .validation import normalize_telegram_handle, normalize_tweet, normalize_x_handle

LOGGER = logging.getLogger("jobby_meme_bot")
TWEET_URL = re.compile(r"https://(?:www\.)?(?:x\.com|twitter\.com)/[A-Za-z0-9_]{1,15}/status/\d+[^\s<>]*", re.I)


def esc(value) -> str:
    return html.escape(str(value), quote=True)


def inline(*rows):
    return {"inline_keyboard": list(rows)}


def data_button(text: str, action: str):
    return {"text": text, "callback_data": action}


def url_button(text: str, url: str):
    return {"text": text, "url": url}


def tweet_from_message(message: dict) -> str:
    candidates = [message.get("caption", ""), message.get("text", "")]
    for field, source_field in (("caption_entities", "caption"), ("entities", "text")):
        source = message.get(source_field, "")
        for entity in message.get(field) or []:
            if entity.get("type") == "text_link" and entity.get("url"):
                candidates.append(entity["url"])
            elif entity.get("type") == "url":
                start, length = entity.get("offset", 0), entity.get("length", 0)
                candidates.append(source[start:start + length])
    for candidate in candidates:
        for match in TWEET_URL.findall(str(candidate)):
            try:
                return normalize_tweet(match.rstrip("),.;!?"))
            except ValueError:
                pass
    return ""


def forwarded_telegram_username(message: dict) -> str:
    origin = message.get("forward_origin") or {}
    if origin.get("type") == "user":
        return (origin.get("sender_user") or {}).get("username", "")
    if origin.get("type") in ("chat", "channel"):
        return (origin.get("sender_chat") or origin.get("chat") or {}).get("username", "")
    return ((message.get("forward_from") or {}).get("username") or
            (message.get("forward_from_chat") or {}).get("username", ""))


class MemeBot:
    def __init__(self, api: TelegramAPI, store: Store, admins: set[int],
                 required_chat: str = ""):
        self.api = api
        self.store = store
        self.admins = admins
        self.required_chat = required_chat
        self.username = ""

    def is_admin(self, user_id: int) -> bool:
        return user_id in self.admins

    def welcome(self, chat_id: int, is_admin: bool):
        text = (
            "🖼 <b>JOBBY Meme Gallery</b>\n\n"
            "Explore official JOBBY meme entries and open each creator's original X post.\n\n"
            "Only the organizer can add or publish entries."
        )
        rows = [
            [data_button("🖼 Browse entries", "menu:entries")],
            [data_button("ℹ️ About the gallery", "menu:about")],
        ]
        if is_admin:
            rows.append([data_button("➕ Add meme (admin)", "admin:add")])
        self.api.send(chat_id, text, {"inline_keyboard": rows})

    def about(self, chat_id: int):
        self.api.send(chat_id,
            "<b>JOBBY Meme Gallery</b>\n"
            "• Browse every official entry.\n"
            "• Open the original X post and creator profiles from each card.\n"
            "• Only the organizer can add, hide, restore, or publish entries.")

    def entry_caption(self, row: dict, user_id: int | None = None) -> str:
        text = (f"🖼 <b>JOBBY MEME ENTRY — #{row['id']:03d}</b>\n\n"
                f"🐦 X creator: <b>@{esc(row['x_username'])}</b>\n"
                f"💬 Telegram: <b>@{esc(row['telegram_username'])}</b>\n"
                f"🔗 Original X post: {esc(row['tweet_url'])}")
        return text

    def entry_keyboard(self, row: dict):
        ids = self.store.entry_ids()
        if not ids:
            return inline([data_button("🖼 Gallery", "menu:entries")])
        index = ids.index(row["id"])
        before = ids[(index - 1) % len(ids)]
        after = ids[(index + 1) % len(ids)]
        i = row["id"]
        return inline(
            [url_button("🔗 Original X post", row["tweet_url"])],
            [url_button("X creator", f"https://x.com/{row['x_username']}"),
             url_button("Telegram creator", f"https://t.me/{row['telegram_username']}")],
            [data_button("◀ Previous", f"nav:{before}"),
             data_button("🖼 Gallery", "menu:entries"),
             data_button("Next ▶", f"nav:{after}")],
        )

    def enriched_entry(self, entry_id: int) -> dict | None:
        for row in self.store.standings():
            if row["id"] == entry_id:
                return row
        return None

    def show_entry(self, chat_id: int, entry_id: int, user_id: int,
                   origin_message: dict | None = None):
        row = self.enriched_entry(entry_id)
        if not row:
            self.api.send(chat_id, "That entry is not available. Select Browse memes to continue.")
            return
        caption = self.entry_caption(row, user_id)
        markup = self.entry_keyboard(row)
        if origin_message and origin_message.get("photo"):
            self.api.call("editMessageMedia", chat_id=chat_id,
                message_id=origin_message["message_id"],
                media={"type": "photo", "media": row["photo_file_id"],
                       "caption": caption, "parse_mode": "HTML"},
                reply_markup=markup)
        else:
            self.api.photo(chat_id, row["photo_file_id"], caption, markup)

    def admin_help(self, chat_id: int):
        self.api.send(chat_id,
            "<b>JOBBY Meme Bot — Admin</b>\n\n"
            "Forward a participant meme here to detect its image, X link, and usernames automatically.\n"
            "/add — Submit a meme (photo → X post → X handle → TG handle → confirm)\n"
            "/cancel — Cancel current upload\n"
            "/list — See entries\n"
            "/remove 12 — Hide entry #12\n"
            "/restore 12 — Restore hidden entry #12\n"
            "/stats — Entry counters\n"
            "/share 12 — Get a link directly to entry #12\n\n"
            "<b>Only the IDs in ADMIN_IDS can use these commands.</b>")

    def start_draft(self, admin_id: int, chat_id: int):
        self.store.save_draft(admin_id, "photo", {})
        self.api.send(chat_id, "➕ <b>Add JOBBY meme</b>\n\nStep 1/4: Send the meme image as a <b>photo</b> (not a file).\n\n/cancel to stop.")

    def preview(self, chat_id: int, admin_id: int):
        draft = self.store.draft(admin_id)
        if not draft or draft[0] != "confirm":
            self.api.send(chat_id, "No complete draft. Use /add.")
            return
        entry = draft[1]
        self.api.photo(chat_id, entry["photo_file_id"],
            "<b>Review this entry before publishing</b>\n\n"
            f"X post: {esc(entry['tweet_url'])}\n"
            f"X creator: @{esc(entry['x_username'])}\n"
            f"Telegram: @{esc(entry['telegram_username'])}",
            inline([data_button("✅ Publish entry", "admin:confirm"),
                    data_button("❌ Cancel", "admin:cancel")]))

    def handle_forwarded(self, chat_id: int, user_id: int, message: dict) -> bool:
        if not any(message.get(key) for key in
                   ("forward_origin", "forward_from", "forward_from_chat", "is_automatic_forward")):
            return False
        photos = message.get("photo") or []
        data = {"forwarded_import": True}
        if photos:
            data["photo_file_id"] = photos[-1]["file_id"]
        tweet_url = tweet_from_message(message)
        if tweet_url:
            data["tweet_url"] = tweet_url
            data["x_username"] = tweet_url.split("/")[3]
        telegram_username = forwarded_telegram_username(message)
        if telegram_username:
            try:
                data["telegram_username"] = normalize_telegram_handle(telegram_username)
            except ValueError:
                pass
        if not photos:
            if data.get("tweet_url"):
                self.store.save_draft(user_id, "photo", data)
                self.api.send(chat_id, "✅ X link and available usernames detected. The picture shown above is only an X link preview, so Telegram did not provide the media file. Now send the meme itself as a photo.")
            else:
                self.api.send(chat_id, "Forward a meme containing a photo, or include its original X post link.")
            return True
        if "tweet_url" not in data:
            self.store.save_draft(user_id, "tweet", data)
            self.api.send(chat_id, "Meme received. Send the original X post URL to finish the entry.")
        elif "telegram_username" not in data:
            self.store.save_draft(user_id, "tg", data)
            self.api.send(chat_id, "Meme and X link detected. Send the participant's Telegram username.")
        else:
            self.store.save_draft(user_id, "confirm", data)
            self.api.send(chat_id, "✅ Meme, X link, X username, and Telegram username detected automatically.")
            self.preview(chat_id, user_id)
        return True

    def handle_draft(self, chat_id: int, user_id: int, message: dict):
        draft = self.store.draft(user_id)
        if not draft:
            return False
        step, data = draft
        if step == "confirm":
            self.api.send(chat_id, "Please tap Publish or Cancel on the preview. Use /cancel to discard.")
            return True
        if step == "photo":
            photos = message.get("photo") or []
            if not photos:
                self.api.send(chat_id, "Please send the meme as a Telegram photo. To stop, /cancel.")
                return True
            data["photo_file_id"] = photos[-1]["file_id"]
            if data.get("forwarded_import") and data.get("tweet_url"):
                if data.get("telegram_username"):
                    self.store.save_draft(user_id, "confirm", data)
                    self.preview(chat_id, user_id)
                else:
                    self.store.save_draft(user_id, "tg", data)
                    self.api.send(chat_id, "Media and X link detected. Send the participant's Telegram username.")
            else:
                self.store.save_draft(user_id, "tweet", data)
                self.api.send(chat_id, "Step 2/4: Paste the original X post URL (https://x.com/user/status/...).")
            return True
        raw = (message.get("text") or "").strip()
        try:
            if step == "tweet":
                data["tweet_url"] = normalize_tweet(raw)
                if data.get("forwarded_import"):
                    data["x_username"] = data["tweet_url"].split("/")[3]
                    if data.get("telegram_username"):
                        self.store.save_draft(user_id, "confirm", data)
                        self.preview(chat_id, user_id)
                    else:
                        self.store.save_draft(user_id, "tg", data)
                        self.api.send(chat_id, "X link detected. Send the participant's Telegram username.")
                else:
                    self.store.save_draft(user_id, "x", data)
                    self.api.send(chat_id, "Step 3/4: Send the participant's X username, for example @creator.")
            elif step == "x":
                data["x_username"] = normalize_x_handle(raw)
                self.store.save_draft(user_id, "tg", data)
                self.api.send(chat_id, "Step 4/4: Send the participant's Telegram username, for example @creatorname.")
            elif step == "tg":
                data["telegram_username"] = normalize_telegram_handle(raw)
                self.store.save_draft(user_id, "confirm", data)
                self.preview(chat_id, user_id)
            else:
                self.api.send(chat_id, "Unknown draft state; /cancel and then /add.")
        except ValueError as exc:
            self.api.send(chat_id, f"⚠️ {esc(exc)} Try again.")
        return True

    def handle_command(self, update: dict):
        message = update["message"]
        user = message.get("from") or {}
        user_id = user.get("id", 0)
        chat = message["chat"]
        chat_id = chat["id"]
        parts = (message.get("text") or "").split()
        command = parts[0].split("@")[0].lower()
        private = chat.get("type") == "private"

        if command == "/myid":
            self.api.send(chat_id, f"Your Telegram numeric ID is: <code>{user_id}</code>.")
            return
        if not private:
            self.api.send(chat_id, "Please open the gallery bot in a private chat to browse entries.")
            return
        if command == "/start":
            if len(parts) == 2 and re.fullmatch(r"m\d{1,9}", parts[1]):
                self.show_entry(chat_id, int(parts[1][1:]), user_id)
                return
            self.welcome(chat_id, self.is_admin(user_id))
            return
        if command in ("/entries", "/memes"):
            ids = self.store.entry_ids()
            if ids:
                self.show_entry(chat_id, ids[0], user_id)
            else:
                self.api.send(chat_id, "No meme entries yet. Check back soon!")
            return
        if command in ("/about", "/rules"):
            self.about(chat_id)
            return
        if not self.is_admin(user_id):
            self.api.send(chat_id, "That is an organizer-only command. Try /start.")
            return
        if command in ("/admin", "/help"):
            self.admin_help(chat_id)
        elif command == "/add":
            self.start_draft(user_id, chat_id)
        elif command == "/cancel":
            self.store.clear_draft(user_id)
            self.api.send(chat_id, "Draft canceled. Nothing was published.")
        elif command == "/list":
            rows = self.store.db.execute("SELECT id, x_username, active FROM entries ORDER BY id DESC LIMIT 50").fetchall()
            line = [f"#{r['id']:03d} @{esc(r['x_username'])} — {'visible' if r['active'] else 'hidden'}" for r in rows]
            self.api.send(chat_id, "<b>Latest entries</b>\n" + ("\n".join(line) or "None"))
        elif command == "/stats":
            counts = self.store.counts()
            self.api.send(chat_id,
                f"<b>Gallery stats</b>\nVisible entries: {counts['entries']}\n"
                f"Hidden entries: {counts['hidden']}")
        elif command in ("/remove", "/restore", "/share"):
            if len(parts) != 2 or not parts[1].isdigit():
                self.api.send(chat_id, f"Usage: {esc(command)} &lt;entry number&gt;")
                return
            entry_id = int(parts[1])
            if command == "/share":
                if not self.store.entry(entry_id):
                    self.api.send(chat_id, "Entry not found or hidden.")
                elif self.username:
                    self.api.send(chat_id, f"Share this entry: https://t.me/{esc(self.username)}?start=m{entry_id}")
                else:
                    self.api.send(chat_id, "Bot username is not available yet. Try again after startup.")
                return
            changed = self.store.set_active(entry_id, command == "/restore")
            self.api.send(chat_id, f"Entry #{entry_id} {'restored' if command == '/restore' else 'hidden'}." if changed else "Entry not found.")
        else:
            self.api.send(chat_id, "Unknown command. Try /admin.")

    def safe_ack(self, callback_id: str, text: str = ""):
        """Callback queries expire quickly; scheduled GitHub runs see stale callbacks."""
        try:
            self.api.ack(callback_id, text)
            return True
        except TelegramError:
            LOGGER.info("Callback acknowledgement expired; responding in private chat instead")
            return False

    def handle_callback(self, callback: dict):
        user = callback.get("from") or {}
        user_id = user.get("id", 0)
        message = callback.get("message") or {}
        chat = message.get("chat") or {}
        chat_id = chat.get("id")
        action = callback.get("data", "")
        cid = callback["id"]
        if not chat_id:
            self.safe_ack(cid, "Please use a private chat.")
            return
        if chat.get("type") != "private":
            self.safe_ack(cid, "Please use this bot in a private chat.")
            return

        if action == "menu:entries":
            self.safe_ack(cid)
            ids = self.store.entry_ids()
            if ids:
                self.show_entry(chat_id, ids[0], user_id)
            else:
                self.api.send(chat_id, "No entries have been added yet.")
            return
        if action in ("menu:about", "menu:rules"):
            self.safe_ack(cid)
            self.about(chat_id)
            return
        if action == "admin:add":
            if not self.is_admin(user_id):
                self.safe_ack(cid, "Organizer only.")
                return
            self.safe_ack(cid)
            self.start_draft(user_id, chat_id)
            return
        if action == "admin:cancel":
            if not self.is_admin(user_id):
                self.safe_ack(cid, "Organizer only.")
                return
            self.store.clear_draft(user_id)
            self.safe_ack(cid, "Draft canceled")
            self.api.send(chat_id, "Draft canceled; nothing was published.")
            return
        if action == "admin:confirm":
            if not self.is_admin(user_id):
                self.safe_ack(cid, "Organizer only.")
                return
            draft = self.store.draft(user_id)
            if not draft or draft[0] != "confirm":
                self.safe_ack(cid, "Draft was already handled or expired.")
                return
            d = draft[1]
            entry_id = self.store.create_entry(d["photo_file_id"], d["tweet_url"],
                d["x_username"], d["telegram_username"], user_id)
            self.store.clear_draft(user_id)
            self.safe_ack(cid, f"Entry #{entry_id} published")
            self.api.send(chat_id, f"✅ Entry #{entry_id:03d} is published inside this bot. Use /share {entry_id} for its link.")
            self.show_entry(chat_id, entry_id, user_id)
            return

        chunks = action.split(":")
        if len(chunks) >= 2 and chunks[0] == "nav" and chunks[1].isdigit():
            entry_id = int(chunks[1])
            if not self.store.entry(entry_id):
                self.safe_ack(cid, "Entry is unavailable.")
                return
            self.safe_ack(cid)
            self.show_entry(chat_id, entry_id, user_id, message)
            return
        if action.startswith("vote:") or action.startswith("rate:"):
            self.safe_ack(cid, "This action is no longer available.")
            return
        self.safe_ack(cid, "Unknown action")

    def handle_update(self, update: dict):
        if "callback_query" in update:
            self.handle_callback(update["callback_query"])
            return
        message = update.get("message")
        if not message:
            return
        user = message.get("from") or {}
        user_id = user.get("id", 0)
        chat = message.get("chat") or {}
        chat_id = chat.get("id")
        if not chat_id or not user_id:
            return
        raw = message.get("text") or ""
        if raw.startswith("/"):
            self.handle_command(update)
            return
        if self.is_admin(user_id) and chat.get("type") == "private":
            if not self.store.draft(user_id) and self.handle_forwarded(chat_id, user_id, message):
                return
            if self.handle_draft(chat_id, user_id, message):
                return
        if chat.get("type") == "private":
            self.api.send(chat_id, "Use /start to browse meme entries. Only the organizer can submit entries.")

    def run(self):
        # RUN_SECONDS=0 is the original continuous mode. GitHub Actions uses a
        # bounded run because hosted runners are not persistent servers.
        seconds = max(0, int(os.environ.get("RUN_SECONDS", "0")))
        deadline = time.monotonic() + seconds if seconds else None
        identity = self.api.call("getMe")
        self.username = identity.get("username", "")
        LOGGER.info("JOBBY meme bot ready (@%s)", self.username)
        try:
            self.api.call("setMyCommands", commands=[
                {"command": "start", "description": "Open the JOBBY meme gallery"},
                {"command": "entries", "description": "Browse meme entries"},
                {"command": "about", "description": "About the gallery"},
                {"command": "myid", "description": "Show your Telegram numeric ID"},
            ])
        except TelegramError:
            LOGGER.warning("Could not publish menu commands")
        offset = self.store.last_update_offset()
        while True:
            if deadline is not None and time.monotonic() >= deadline:
                break
            timeout = 30 if deadline is None else max(0, min(5, int(deadline - time.monotonic())))
            try:
                updates = self.api.call("getUpdates", offset=offset, timeout=timeout,
                                        limit=30, allowed_updates=["message", "callback_query"])
                for update in updates:
                    try:
                        self.handle_update(update)
                    except TelegramError:
                        LOGGER.warning("Telegram rejected one update; continuing")
                    except Exception:
                        LOGGER.exception("Error handling update; continuing")
                    offset = update["update_id"] + 1
                    self.store.save_update_offset(offset)
            except TelegramError:
                LOGGER.warning("Telegram connection interrupted; retrying")
                if deadline is not None:
                    raise  # Make the scheduled GitHub run fail visibly.
                time.sleep(5)


def main():
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    token = os.environ.get("BOT_TOKEN", "").strip()
    if not token or ":" not in token:
        raise SystemExit("BOT_TOKEN is missing. Create a bot with @BotFather and set the token as an environment variable.")
    admin_raw = os.environ.get("ADMIN_IDS", "").strip()
    try:
        admins = {int(x.strip()) for x in admin_raw.split(",") if x.strip()}
    except ValueError:
        raise SystemExit("ADMIN_IDS must contain Telegram numeric IDs separated by commas.") from None
    if not admins:
        LOGGER.warning("ADMIN_IDS is empty: only /myid and public commands will work until configured")
    db_path = os.environ.get("DB_PATH", "./data/jobby_meme.sqlite3").strip()
    if db_path != ":memory:":
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    store = Store(db_path)
    bot = MemeBot(TelegramAPI(token), store, admins,
                  os.environ.get("REQUIRED_CHAT_ID", "").strip())
    try:
        bot.run()
    finally:
        store.close()


if __name__ == "__main__":
    main()
