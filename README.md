# JOBBY Meme Gallery Bot

An admin-curated Telegram gallery for JOBBY meme entries. The organizer adds each image, video, or GIF together with its original X post, X username, and Telegram username. Visitors can browse entries and open the supplied creator links. There is no voting, rating, ranking, or public editing.

## Features

- Image, video, and GIF entry cards with original X links and creator profiles.
- Previous/next browsing and private entry share links.
- Admin-only add, publish, hide, restore, destination registration, and statistics.
- Admin fast import: forward a participant's community message to the bot to detect its media, original X link, X username, and Telegram username, then confirm the prepared entry.
- Publishing to registered groups and channels without interactive public controls.
- Cloudflare Worker webhook deployment with D1 persistence and idempotent Telegram delivery.
- GitHub-only polling fallback with encrypted state.

## Security model

- Only Telegram IDs in `JOBBY_ADMIN_IDS` can change gallery contents.
- Bot, webhook, Cloudflare, and state-encryption secrets stay outside repository files and logs.
- Public users can only browse and open links.
- Existing legacy vote/rating database rows are retained only to avoid destructive data loss; the application never reads or writes them.

## User commands

| Command | Purpose |
|---|---|
| `/start` | Open the gallery |
| `/entries` | Browse entries |
| `/about` | Explain the gallery |
| `/myid` | Show your Telegram numeric ID |

## Organizer commands

| Command | Purpose |
|---|---|
| `/add` | Add an entry through the guided upload flow |
| `/cancel` | Cancel the current draft |
| `/list` | List recent visible and hidden entries |
| `/remove 12` | Hide entry #12 |
| `/restore 12` | Restore entry #12 |
| `/share 12` | Get a private deep link for entry #12 |
| `/publish 12` | Publish entry #12 to registered destinations |
| `/publish all` | Choose a connected destination and publish every visible meme at once, or send them to all destinations |
| `/destinations` | List registered destinations |
| `/unregister <chat_id>` | Remove a destination |
| `/stats` | Show visible and hidden entry counts |
| `/admin` | Show organizer help |

To register a group or channel destination, add the bot with permission to post and send `/register` there from the configured organizer account. Only the organizer can register or change destinations.

To import a community submission, forward its original message to the bot's private chat from the organizer account. Keep the X post URL in the message or caption. Telegram may hide the original sender's username because of their privacy settings; when a value cannot be detected, the bot asks only for that missing field.

## Deployment

The production service is deployed from GitHub Actions to Cloudflare Workers. Required GitHub Actions secrets are `JOBBY_BOT_TOKEN`, `JOBBY_ADMIN_IDS`, `JOBBY_STATE_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `JOBBY_WEBHOOK_SECRET`.

See [CLOUDFLARE.md](CLOUDFLARE.md) for the webhook deployment and [GITHUB_ONLY.md](GITHUB_ONLY.md) for the non-production polling fallback.

## Local verification

```bash
python -m unittest discover -s tests
node --test cloudflare/test/*.test.js
node --check cloudflare/worker.js
```

The repository name, Worker/D1 resource names, and Telegram username may still contain the historical word `voting` for compatibility; these identifiers do not enable a voting feature.
