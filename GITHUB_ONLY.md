# JOBBY Meme Voting — GitHub only

This edition uses **GitHub Actions** to check Telegram periodically. It does **not** use Railway, Supabase, a VPS, a webhook server, or an external database. GitHub Pages cannot run Python bots; this is a scheduled workaround, **not continuous hosting**.

## Important limitations

- The bot checks for new messages on a **best-effort 5-minute schedule**. GitHub may delay or skip runs. People can wait several minutes for replies. Telegram may show a spinner timeout on an inline vote while the vote itself is recorded on the next scheduled run. Do not promise instant real-time behavior.
- GitHub Actions on public repositories is generally free using standard runners; private repositories consume included minutes and may incur costs. A run every 5 minutes can exhaust a private account's allowance. You can change the cron to `13,43 * * * *` (every 30 minutes) on private repos to reduce use.
- Data is encrypted (AES-256-CBC with PBKDF2) **before it is committed** to `.github/jobby_state.enc`. Never expose or reset `JOBBY_STATE_KEY` without backing up the data first. Private voting data includes Telegram user IDs. Encryption avoids publishing this database in plaintext, but does not replace careful secret management.
- If the run crashes after Telegram accepts a request but before the encrypted state commit, a message may be handled twice. Do not use this design for financial transactions or irreversible prize distribution.
- Do not run the same bot token on another server, or set a Telegram webhook simultaneously.

## Setup (new dedicated GitHub repository)

1. Create an empty **new dedicated repository** (`jobby-meme-voting-bot`) under your GitHub account. This bot should not be mixed with the live `jobby-site` repository.
2. Upload the **contents** of this ZIP to the **default branch** (usually `main`), including `.github/workflows/jobby-poll.yml`, `jobby_bot/`, and `tests/`. **Scheduled workflows only run from the default branch.**
3. Create a Telegram bot with [@BotFather](https://t.me/BotFather) using `/newbot`. Keep its token private.
4. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**; set:
   - `JOBBY_BOT_TOKEN` — private Telegram bot token from BotFather.
   - `JOBBY_ADMIN_IDS` — comma-separated numeric Telegram IDs authorized to upload memes (for example, `123456789`). Obtain your ID from @userinfobot or via `/myid` after initial start.
   - `JOBBY_STATE_KEY` — a **new unique 32+ character random secret** used for SQLite encryption. Store a backup privately; losing it loses access to old contest data. Generate, for example, with `openssl rand -hex 32` on a trusted computer.
5. Optional: **Settings → Secrets and variables → Actions → Variables**: `JOBBY_REQUIRED_CHAT_ID=@JOBBYChat` to require community membership (may require bot admin permissions in the group). By default this is empty.
6. Repo → **Actions → JOBBY Meme Voting — GitHub-only polling → Run workflow**, then inspect run logs (they should not reveal tokens). Scheduled runs will use the workflow from the default branch.
7. DM the bot `/start`, then `/add` from the Telegram account whose numeric ID appears in `JOBBY_ADMIN_IDS`.

## Verify

- Confirm Actions run shows **green**.
- `/myid` and `/start` should respond on the next run.
- Upload a test meme with `/add`, send image + X tweet URL + handles, then tap Publish.
- Vote from a second account, check `/leaderboard` after the subsequent scheduled cycle.
- `.github/jobby_state.enc` should appear in repo after the first successful run; the plaintext `state/*.sqlite3` must **never** appear in commits.

## Operational notes

- To disable the bot, disable the workflow via the Actions tab; do not delete encrypted state.
- Adding a new secret does **not** automatically trigger a run; use `Run workflow` or wait for cron.
- The GitHub-only schedule is unsuitable when users need immediate contest feedback; a continuously hosted bot is the proper solution for instant voting.
- No subscriptions/paid services are required by this code, but users should monitor their GitHub Actions billing/quota.
