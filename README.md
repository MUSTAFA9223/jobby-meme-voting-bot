# JOBBY Meme Voting Bot

Telegram meme voting bot. Private organizer uploads images, X post links and creator handles. Public users vote once per contest and rate each meme 1–5 stars; `/leaderboard` shows rankings.

**GitHub-only deployment:** `.github/workflows/jobby-poll.yml` runs scheduled Telegram polling; not real-time or 24/7 hosting. State is encrypted before it is committed to the repository. Add `JOBBY_BOT_TOKEN`, `JOBBY_ADMIN_IDS` and `JOBBY_STATE_KEY` to repository Actions secrets before enabling it. Never commit tokens.

See `GITHUB_ONLY.md` for instructions. Source and workflow are being added to this new dedicated repository without changes to the existing JOBBY website.
