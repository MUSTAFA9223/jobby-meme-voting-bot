"""Normalize and validate external profile handles and X post URLs."""
import re
from urllib.parse import urlparse

_X_HANDLE = re.compile(r"^[A-Za-z0-9_]{1,15}$")
_TG_HANDLE = re.compile(r"^[A-Za-z0-9_]{5,32}$")
_POST_PATH = re.compile(r"^/([A-Za-z0-9_]{1,15})/status/(\d+)(?:/)?$")


def normalize_x_handle(value: str) -> str:
    value = value.strip().removeprefix("@")
    if value.lower().startswith(("https://x.com/", "https://twitter.com/")):
        value = urlparse(value).path.strip("/").split("/")[0]
    if not _X_HANDLE.fullmatch(value):
        raise ValueError("Enter a valid X handle, such as @creator.")
    return value


def normalize_telegram_handle(value: str) -> str:
    value = value.strip().removeprefix("@")
    if value.lower().startswith("https://t.me/"):
        value = urlparse(value).path.strip("/")
    if not _TG_HANDLE.fullmatch(value):
        raise ValueError("Enter a valid Telegram username, such as @creatorname.")
    return value


def normalize_tweet(value: str) -> str:
    value = value.strip()
    try:
        parsed = urlparse(value)
        if parsed.scheme != "https" or parsed.hostname not in ("x.com", "www.x.com", "twitter.com", "www.twitter.com"):
            raise ValueError()
        found = _POST_PATH.fullmatch(parsed.path)
        if not found:
            raise ValueError()
        return f"https://x.com/{found.group(1)}/status/{found.group(2)}"
    except ValueError:
        raise ValueError("Send a valid X post URL: https://x.com/user/status/123...") from None
