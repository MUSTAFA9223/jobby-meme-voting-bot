"""Minimal Telegram Bot API transport using only the Python standard library."""
import json
import urllib.error
import urllib.request


class TelegramError(Exception):
    pass


class TelegramAPI:
    def __init__(self, token: str):
        self.base_url = f"https://api.telegram.org/bot{token}/"

    def call(self, method: str, **params):
        payload = json.dumps(params, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            self.base_url + method,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=50 if method == "getUpdates" else 20) as response:
                result = json.load(response)
        except urllib.error.HTTPError as ex:
            # Do not emit the raw exception or URL: it contains the bot token.
            raise TelegramError(f"Telegram API HTTP status {ex.code}") from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise TelegramError("Telegram API connection failed") from None
        if not result.get("ok"):
            raise TelegramError("Telegram API rejected the request")
        return result["result"]

    def send(self, chat_id: int, text: str, reply_markup=None):
        data = {"chat_id": chat_id, "text": text, "parse_mode": "HTML",
                "disable_web_page_preview": True}
        if reply_markup:
            data["reply_markup"] = reply_markup
        return self.call("sendMessage", **data)

    def photo(self, chat_id: int, file_id: str, caption: str, reply_markup=None):
        data = {"chat_id": chat_id, "photo": file_id, "caption": caption, "parse_mode": "HTML"}
        if reply_markup:
            data["reply_markup"] = reply_markup
        return self.call("sendPhoto", **data)

    def ack(self, callback_id: str, text: str = ""):
        return self.call("answerCallbackQuery", callback_query_id=callback_id,
                         text=text[:200], show_alert=False)