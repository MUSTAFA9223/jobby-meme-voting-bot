# JOBBY on Cloudflare

`cloudflare/worker.js` receives Telegram webhooks immediately and stores gallery entries, drafts, destinations, and delivery state in D1. The Python implementation remains available as a rollback fallback.

No credential belongs in the repository. Deployment uses the existing GitHub secrets. The Cloudflare token needs the smallest account scope required for Workers Scripts and D1. Do not enable or change a paid plan for this bot.

Run **Deploy JOBBY to Cloudflare** manually. The workflow checks the bot identity, applies the non-destructive schema, deploys the Worker, configures the webhook, verifies it, and sends the organizer a test message. Scheduled GitHub polling skips automatically while the webhook is active.

Incoming updates, application changes, and queued outgoing messages are committed together. Retries resume undelivered responses without duplicating entry creation. Telegram itself does not provide an idempotency key for outgoing messages, so an external API success followed immediately by a network failure can still duplicate a message.

Legacy vote/rating tables and existing rows remain archived solely to avoid destructive data loss. The gallery does not read, display, rank, or write those records.

Do not run a poller alongside the webhook. Before rollback, export current D1 gallery state to encrypted GitHub state, remove the webhook, and only then enable polling.
