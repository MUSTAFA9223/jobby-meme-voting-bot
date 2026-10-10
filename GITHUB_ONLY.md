# JOBBY Meme Gallery — GitHub-only fallback

This polling workflow is a rollback option, not the production service. Cloudflare Workers provides the live Telegram webhook.

GitHub checks for updates on a best-effort schedule and responses may be delayed. State is encrypted before `.github/jobby_state.enc` is committed. Keep `JOBBY_STATE_KEY` backed up privately.

Configure `JOBBY_BOT_TOKEN`, `JOBBY_ADMIN_IDS`, and `JOBBY_STATE_KEY` as GitHub Actions secrets. Then open Actions, choose **JOBBY Meme Gallery — GitHub-only polling**, and run it manually. Never enable polling while the Cloudflare webhook is active because Telegram allows only one update delivery mode at a time.

Test `/start`, entry navigation, and organizer-only management commands. Confirm the encrypted state changes without revealing secrets in logs.
