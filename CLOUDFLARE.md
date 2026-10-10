# JOBBY on Cloudflare

The `cloudflare/worker.js` implementation receives Telegram webhooks immediately
and keeps contest data in D1. The existing Python bot remains available for rollback.
No bot token belongs in the repository. Use the existing GitHub secrets.

Deployment requires `CLOUDFLARE_API_TOKEN` as an Actions secret and
`CLOUDFLARE_ACCOUNT_ID` as an Actions variable. Scope the token to this account
with Workers Scripts Edit, D1 Edit, and the account permissions needed to read
the Workers subdomain. The account must already have a Workers subdomain.
Do not enable a paid plan to deploy this bot.

Run **Deploy JOBBY to Cloudflare** manually. It uses the same concurrency group
as polling to freeze the encrypted snapshot during migration. The script imports
entries, votes, ratings, contest status and unfinished admin drafts without
replacing the existing state encryption key. It checks bot identity and Worker
health before setting the webhook, retains queued Telegram updates, limits
webhook delivery to one connection to keep admin steps in order, verifies the
webhook configuration, and sends the organizer a test message.

Scheduled polling automatically skips when Telegram has a webhook. After deployment, set `JOBBY_ENABLED` to `false` in GitHub repository variables
to stop scheduled polling. Then send `/start`, `/add`, and a photo in Telegram.
Successful API delivery alone is not an end-to-end inbound webhook test.

Requests require Telegram's secret header. Business mutations, the update ID,
and outgoing messages commit in one D1 transaction. Retries resume undelivered
responses without repeating votes, ratings or entry creation. Telegram delivery
can still duplicate a message if the external API succeeds immediately before
a network failure; Telegram does not provide an idempotency key for messages.

Migration stops on existing unmarked D1 data. If a first migration is interrupted,
inspect the D1 database before retrying; never delete contest data automatically.
Do not run multiple bot pollers alongside a webhook. To roll back, first export
the current D1 contest data to encrypted GitHub state, remove the webhook, and
then enable polling; the old encrypted snapshot alone does not include new votes.

The leaderboard aggregates contest votes on each update. Large contests should
monitor D1 usage and optimize aggregates before hitting the free quota. This
implementation does not purchase resources or change billing plans.
