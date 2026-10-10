"""JOBBY meme contest: private admin uploads, public votes and star ratings."""
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


def esc(value) -> str:
    return html.escape(str(value), quote=True)


def inline(*rows):
    return {"inline_keyboard": list(rows)}


def data_button(text: str, action: str):
    return {"text": text, "callback_data": action}


def url_button(text: str, url: str):
    return {"text": text, "url": url}


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

    def has_access(self, user_id: int) -> bool:
        if not self.required_chat or self.is_admin(user_id):
            return True
        try:
            result = self.api.call("getChatMember", chat_id=self.required_chat, user_id=user_id)
            status = result.get("status")
            return status in ("member", "administrator", "creator") or (
                status == "restricted" and result.get("is_member") is True
            )
        except TelegramError:
            return False  # Fail closed when the optional membership guard cannot be verified.

    def welcome(self, chat_id: int, is_admin: bool):
        text = (
            "🏆 <b>JOBBY Meme Voting</b>\n\n"
            "Explore official JOBBY meme entries, rate their creativity from 1–5 stars, "
            "and cast ONE contest vote for your favorite. You can change your choice "
            "before voting closes.\n\n"
            "Only the contest organizer can submit entries."
        )
        rows = [
            [data_button("🖼 Browse memes", "menu:entries")],
            [data_button("🏆 Leaderboard", "menu:leaderboard"),
             data_button("ℹ️ Rules", "menu:rules")],
        ]
        if is_admin:
            rows.append([data_button("➕ Add meme (admin)", "admin:add")])
        self.api.send(chat_id, text, {"inline_keyboard": rows})

    def rules(self, chat_id: int):
        status = self.store.status()
        self.api.send(chat_id,
            "<b>Contest rules</b>\n"
            "• One active contest vote per Telegram account, across all entries.\n"
            "• Each meme can also receive one 1–5 star rating per account.\n"
            "• You can change your vote or rating while voting is open.\n"
            "• Vote counts rank entries first; star averages break ties.\n"
            "• Organizers upload the memes and original X post links.\n"
            f"• Voting status: <b>{esc(status.upper())}</b>.\n\n"
            "Please vote fairly. Multiple accounts or coordinated manipulation "
            "may lead to organizer review.")

    def entry_caption(self, row: dict, user_id: int | None = None) -> str:
        votes = int(row.get("votes", 0))
        rating_count = int(row.get("rating_count", 0))
        stars = float(row.get("average_stars", 0))
        text = (f"🏆 <b>JOBBY MEME CONTEST — #{row['id']:03d}</b>\n\n"
                f"🐦 X creator: <b>@{esc(row['x_username'])}</b>\n"
                f"💬 Telegram: <b>@{esc(row['telegram_username'])}</b>\n\n"
                f"🗳 Votes: <b>{votes}</b>  |  ⭐ Rating: <b>{stars:.2f}/5</b> "
                f"({rating_count} ratings)\n"
                f"Contest: <b>{esc(self.store.status().upper())}</b>")
        if user_id is not None:
            current_vote = self.store.vote_for(user_id)
            current_stars = self.store.rating_for(user_id, row["id"])
            text += (f"\n\nYour vote: <b>{('#' + str(current_vote)) if current_vote else 'None'}</b>"
                     f"  |  Your rating: <b>{str(current_stars) if current_stars else '—'}</b>")
        return text

    def entry_keyboard(self, row: dict):
        ids = self.store.entry_ids()
        if not ids:
            return inline([data_button("🏆 Leaderboard", "menu:leaderboard")])
        index = ids.index(row["id"])
        before = ids[(index - 1) % len(ids)]
        after = ids[(index + 1) % len(ids)]
        i = row["id"]
        return inline(
            [data_button(f"⭐ {n}", f"rate:{i}:{n}") for n in range(1, 6)],
            [data_button("🗳 Vote for this meme", f"vote:{i}")],
            [url_button("🔗 Original X post", row["tweet_url"])],
            [url_button("X creator", f"https://x.com/{row['x_username']}"),
             url_button("Telegram creator", f"https://t.me/{row['telegram_username']}")],
            [data_button("◀ Previous", f"nav:{before}"),
             data_button("🏆 Top", "menu:leaderboard"),
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

    def refresh_entry(self, chat_id: int, message: dict, entry_id: int, user_id: int):
        row = self.enriched_entry(entry_id)
        if row and message.get("photo"):
            self.api.call("editMessageCaption", chat_id=chat_id,
                message_id=message["message_id"], caption=self.entry_caption(row, user_id),
                parse_mode="HTML", reply_markup=self.entry_keyboard(row))

    def leaderboard(self, chat_id: int):
        rows = self.store.standings()
        if not rows:
            self.api.send(chat_id, "No memes have been added yet. Check back soon!")
            return
        lines = [f"🏆 <b>JOBBY Leaderboard</b>  ({esc(self.store.status().upper())})", ""]
        for rank, row in enumerate(rows[:10], start=1):
            lines.append(f"{rank}. <b>#{row['id']:03d} @{esc(row['x_username'])}</b> — "
                         f"{row['votes']} votes | ⭐ {row['average_stars']:.2f} "
                         f"({row['rating_count']})")
        lines.append("\nRanked by votes, then average star rating.")
        buttons = [[data_button(f"View #{row['id']:03d}", f"nav:{row['id']}")
                    for row in rows[j:j + 3]] for j in range(0, min(9, len(rows)), 3)]
        if len(rows) > 9:
            buttons.append([data_button(f"View #{rows[9]['id']:03d}", f"nav:{rows[9]['id']}")])
        buttons.append([data_button("🖼 Browse all memes", "menu:entries")])
        self.api.send(chat_id, "\n".join(lines), {"inline_keyboard": buttons})

    def admin_help(self, chat_id: int):
        self.api.send(chat_id,
            "<b>JOBBY Meme Bot — Admin</b>\n\n"
            "/add — Submit a meme (photo → X post → X handle → TG handle → confirm)\n"
            "/cancel — Cancel current upload\n"
            "/list — See entries\n"
            "/remove 12 — Hide entry #12 (votes retained)\n"
            "/restore 12 — Restore hidden entry #12\n"
            "/pause — Freeze voting temporarily\n"
            "/resume — Reopen voting\n"
            "/close — End voting\n"
            "/results — Show leaderboard\n"
            "/stats — Overall counters\n"
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
            self.store.save_draft(user_id, "tweet", data)
            self.api.send(chat_id, "Step 2/4: Paste the original X post URL (https://x.com/user/status/...).")
            return True
        raw = (message.get("text") or "").strip()
        try:
            if step == "tweet":
                data["tweet_url"] = normalize_tweet(raw)
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
            self.api.send(chat_id, "Please open the voting bot in a private chat to participate.")
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
        if command in ("/leaderboard", "/results"):
            self.leaderboard(chat_id)
            return
        if command == "/rules":
            self.rules(chat_id)
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
        elif command == "/pause":
            self.store.set_status("paused")
            self.api.send(chat_id, "⏸ Voting and ratings are now paused.")
        elif command == "/resume":
            self.store.set_status("open")
            self.api.send(chat_id, "✅ Voting and ratings are now open.")
        elif command == "/close":
            self.store.set_status("closed")
            self.api.send(chat_id, "🏁 Voting and ratings are closed. Results are preserved. /resume reopens.")
        elif command == "/list":
            rows = self.store.db.execute("SELECT id, x_username, active FROM entries ORDER BY id DESC LIMIT 50").fetchall()
            line = [f"#{r['id']:03d} @{esc(r['x_username'])} — {'visible' if r['active'] else 'hidden'}" for r in rows]
            self.api.send(chat_id, "<b>Latest entries</b>\n" + ("\n".join(line) or "None"))
        elif command == "/stats":
            counts = self.store.counts()
            self.api.send(chat_id,
                f"<b>Contest stats</b>\nActive: {counts['entries']}\n"
                f"Hidden: {counts['hidden']}\nValid votes: {counts['voters']}\n"
                f"Ratings: {counts['ratings']}\nStatus: {esc(self.store.status())}")
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
        if action == "menu:leaderboard":
            self.safe_ack(cid)
            self.leaderboard(chat_id)
            return
        if action == "menu:rules":
            self.safe_ack(cid)
            self.rules(chat_id)
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
        if len(chunks) >= 2 and chunks[0] in ("nav", "vote", "rate") and chunks[1].isdigit():
            entry_id = int(chunks[1])
            if not self.store.entry(entry_id):
                self.safe_ack(cid, "Entry is unavailable.")
                return
            if chunks[0] == "nav":
                self.safe_ack(cid)
                self.show_entry(chat_id, entry_id, user_id, message)
                return
            if not self.has_access(user_id):
                self.safe_ack(cid, "Join the official community first, then try again.")
                return
            entry = self.store.entry(entry_id)
            # The organizer supplies the Telegram handle; prevent obvious self-voting.
            if (user.get("username", "").casefold() == entry["telegram_username"].casefold()):
                self.safe_ack(cid, "Creators cannot rate or vote for their own meme.")
                return
            if chunks[0] == "vote" and len(chunks) == 2:
                result = self.store.cast_vote(user_id, entry_id)
                messages = {"saved": "Vote recorded!", "changed": "Vote changed!",
                            "same": "You already voted for this meme.", "closed": "Voting is closed.",
                            "missing": "Entry unavailable."}
            elif (chunks[0] == "rate" and len(chunks) == 3
                  and chunks[2] in ("1", "2", "3", "4", "5")):
                result = self.store.rate(user_id, entry_id, int(chunks[2]))
                messages = {"saved": "Rating saved!", "closed": "Rating is closed.",
                            "missing": "Entry unavailable."}
            else:
                self.safe_ack(cid, "Unknown action.")
                return
            if not self.safe_ack(cid, messages[result]):
                self.api.send(chat_id, messages[result])
            if result in ("saved", "changed", "same"):
                try:
                    self.refresh_entry(chat_id, message, entry_id, user_id)
                except TelegramError:
                    # Valid votes/ratings persist even if Telegram cannot edit stale UI.
                    LOGGER.warning("Could not refresh an older entry message")
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
            if self.handle_draft(chat_id, user_id, message):
                return
        if chat.get("type") == "private":
            self.api.send(chat_id, "Use /start to browse memes and vote. Only the organizer can submit entries.")

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
                {"command": "start", "description": "Open the contest"},
                {"command": "entries", "description": "Browse memes"},
                {"command": "leaderboard", "description": "View rankings"},
                {"command": "rules", "description": "View voting rules"},
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
