# JOBBY Meme Voting Bot

A standalone, admin-curated Telegram meme contest. The organizer adds each meme, its original X post URL, X username, and Telegram username. Users can vote once for every meme and separately give each meme a 1–5-star rating.

## Features

- Private admin upload wizard: photo → original X post → X creator → Telegram creator → publish confirmation.
- Organized cards with the meme, source link, X + Telegram accounts, vote count and average rating.
- Exactly one permanent vote **per Telegram user ID and meme**; users may vote for every meme, but repeated taps never add another vote.
- One rating **per Telegram user ID per entry**, editable during the contest.
- Leaderboard: number of votes is primary, average stars and number of ratings are tiebreakers.
- Entry share links, next/previous browsing, admin entry hiding/restoring, pause/resume/close, and counters.
- Optional membership check against a Telegram community.
- Durable SQLite database and Telegram file IDs. No third-party AI services or paid packages needed.

**Limitations:** A Telegram user ID is not proof of one human. Multiple accounts can still manipulate voting; manual organizer review is needed for suspicious patterns. Telegram usernames can change over time. The bot cannot discover, validate authorship of, or pay out prizes automatically. The organizer is responsible for eligibility and prize distribution.

## GitHub-only scheduling (no other hosting)

See [GITHUB_ONLY.md](GITHUB_ONLY.md) for GitHub Actions deployment, three required
GitHub Secrets, encrypted vote storage and key limitations. GitHub Actions is
**periodic, not an always-on Telegram service**. The continuous local/Docker
instructions below are alternatives, not required by the GitHub-only edition.

## Step 1: Register an official Telegram bot

1. Open [@BotFather](https://t.me/BotFather) in Telegram.
2. Send `/newbot`.
3. Suggested display name: **JOBBY Meme Voting**.
4. Suggested username (availability dependent): `JOBBYMemeVoteBot` — it **must end in `bot`**.
5. Copy the bot token privately. **Never commit it to GitHub or paste it into a public chat.**

## Step 2: Configure

Copy `.env.example` to `.env` and edit:

```env
BOT_TOKEN=<your_private_token>
ADMIN_IDS=123456789
DB_PATH=/data/jobby_meme.sqlite3
REQUIRED_CHAT_ID=
```

To learn your numeric Telegram ID, you can initially **leave `ADMIN_IDS=` empty**, start the bot using the instructions below, then send `/myid` privately to your new bot. Update `ADMIN_IDS` with that number and restart the service. Until `ADMIN_IDS` is filled in, no one (including the owner) can add entries or administer the contest.

To require voters to join the community first, set `REQUIRED_CHAT_ID=@JOBBYChat` (optional). The bot typically needs to be an admin in that group for membership checks of other users to work reliably. If membership verification fails, votes and ratings are blocked until it works. Keep blank if you do not want this restriction.

## Step 3A: Run locally with Python 3.11+

No Python packages are required beyond the standard library.

Linux/macOS:

```bash
cp .env.example .env
# Edit .env in a text editor with your private token and ADMIN_IDS.
set -a; . ./.env; set +a
# Local DB path (NOT /data if /data is unavailable on your computer):
export DB_PATH=./data/jobby_meme.sqlite3
python3 -m jobby_bot
```

Windows PowerShell: set the same variables with `$env:BOT_TOKEN="..."`, `$env:ADMIN_IDS="..."`, and `$env:DB_PATH="./data/jobby_meme.sqlite3"`, then `python -m jobby_bot`.

## Step 3B: Run with Docker (recommended for an always-on host)

```bash
cp .env.example .env
# Edit .env and fill in BOT_TOKEN + ADMIN_IDS.
docker compose up -d --build
# View logs:
docker compose logs -f
```

The Docker Compose deployment stores its database in the persistent **`jobby_meme_data`** volume, not the ephemeral container filesystem. Keep only **one** running bot process per token and one database. Regularly back up the volume or the SQLite `.sqlite3` file. Do not share it publicly. A server/hosting provider may charge fees; this project itself has no paid dependency.

**Railway:** If you deploy on Railway, use a *new, separate* bot service; configure the token and IDs in Railway environment variables. Attach a persistent volume to `/data` (the default `DB_PATH` in the Dockerfile), and check the current Railway billing before provisioning it. Without a persistent volume the data will be lost on redeploy. This repository does not automatically create or modify Railway infrastructure.

## Organizer commands (private chat only)

| Command | Action |
|---|---|
| `/admin` | Help / list admin commands |
| `/add` | Step-by-step upload of an entry |
| `/cancel` | Discard an incomplete upload |
| `/list` | Show the latest 50 entries and hidden status |
| `/remove 12` | Hide #12; keep its old votes and ratings in case you restore it |
| `/restore 12` | Restore #12 |
| `/pause` | Temporarily prevent votes and ratings |
| `/resume` | Reopen votes and ratings |
| `/close` | End voting (does not reset historical data) |
| `/results` | View leaderboard |
| `/stats` | Overview |
| `/share 12` | Copyable bot deep link to #12 |

Users can send `/start`, `/entries`, `/leaderboard`, `/rules`, and `/myid`. The original tweet, author X page, and author's Telegram profile are clickable from each meme card.

## Voting policy

1. Every Telegram account can vote once for **each visible contest entry**. A recorded vote is permanent and repeated taps do not increase the count.
2. Every account can star-rate multiple entries, but only **once per entry**. A repeated rating updates the same record.
3. Votes and ratings are locked by `/pause` or `/close`.
4. An entry creator cannot vote/rate their own meme if their **current Telegram username** matches the stored author username; this is an advisory check, not a strong identity verification scheme.
5. Leaderboard ranks by **vote count**. Average rating and rating count break ties.
6. Hidden memes do not appear in active results. Their stored historical records are not destroyed.

## Test

```bash
python3 -m unittest discover -s tests -v
```

## Files

- `jobby_bot/bot.py`: Telegram command handling and private admin wizard.
- `jobby_bot/store.py`: SQLite schema and business rules.
- `jobby_bot/api.py`: Telegram API transport.
- `jobby_bot/validation.py`: X post / profile validation.
- `tests/`: offline unit and bot workflow tests with fake Telegram transport.

## Safety notes

- Never expose `BOT_TOKEN`. Git ignores `.env` by default.
- Do not start a second instance of this poller with the same bot token.
- Hosting must provide a persistent filesystem/volume for SQLite storage; the Telegram photo `file_id` itself is stored in SQLite.
- Optional community membership only verifies the user at voting time and depends on Telegram permissions. It is not proof against fake accounts.
- To close a five-day contest, use `/close` at the agreed deadline; no automatic deadline is configured.
- Contest prizes must be handled separately. There is no wallet, payment integration, or automated payouts.

## العربية — التشغيل السريع

1. افتح [@BotFather](https://t.me/BotFather) وأرسل `/newbot` لإنشاء حساب بوت جديد، ثم احتفظ بالرمز السري لنفسك.
2. املأ `BOT_TOKEN` و`ADMIN_IDS` في ملف `.env` (معرّف حسابك الرقمي؛ يمكنك تشغيل البوت مؤقتًا بدون `ADMIN_IDS` واستعمال `/myid` لمعرفة الرقم).
3. شغّل البرنامج باستخدام Python أو Docker. للحفظ المستمر استخدم مساحة تخزين دائمة.
4. أرسل للبوت `/add` من حساب الإدارة. سيطلب الصورة، ورابط التغريدة، وحساب X، وحساب تيليجرام، ثم يُظهر معاينة تؤكدها قبل نشر المشاركة.
5. شارك رابط البوت مع الأعضاء. يصوّتون لميم واحد في المسابقة، ويقيّمون أي ميم من 1 إلى 5 نجوم.
6. استخدم `/results` لمشاهدة الترتيب، و`/close` عند نهاية المسابقة.

هذا مشروع مستقل، ولا يغيّر الموقع الرسمي أو المجموعات أو خدمات SUMMECA.
