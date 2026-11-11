# ig-comment-dm

**Comment a keyword. Get the link in your DMs.**

A self-hosted Instagram comment-to-DM tool. Someone comments `GUIDE` on your reel → they get a private DM with your link → a public "sent! check your dms 📩" appears under their comment. It runs on your own free Cloudflare Worker and your own Meta app. No subscription, and no third party holds your account.

[![test](https://github.com/theChitranshM/ig-comment-dm/actions/workflows/test.yml/badge.svg)](https://github.com/theChitranshM/ig-comment-dm/actions/workflows/test.yml)

```
@someone: "guidee pls 🙏"     →   DM to @someone:  "here's the guide 📘
                                                    https://example.com/guide"
                              →   public reply:    "sent! check your dms 📩"
```

## Why this one

- **Exactly once, every time.** Meta retries webhooks for up to 36 hours, and polling re-reads old comments. Each comment is claimed atomically in a Durable Object, so nobody gets two DMs, even when the same event arrives three times in the same second.
- **DM first, then the public reply.** The "check your dms" reply is posted only after the DM succeeds, so you never publicly promise a message that didn't go out.
- **Forgiving matching.** `GUIDE`, `guide pls`, `#guide`, `guidee`, `gude` and `G U I D E` all count, with no false hits like "misguided". You choose fuzzy or exact per keyword.
- **Doesn't miss comments.** Webhooks deliver in about a second. A poll every 5 minutes and a daily sweep catch anything a webhook missed (downtime, a bad deploy), within Instagram's 7-day reply window. Trial reels work too.
- **Safe by default.**
  - Nothing fires until you switch a post on, and then only for **new** comments.
  - Older comments wait until you `preview` and `backfill` them yourself.
  - It ignores your own comments.
  - Polls skip comments you've already answered, whether by hand or with another tool.
- **$0.** Everything fits in Cloudflare's free tier. The token never expires, so there's nothing to renew every 60 days.

## What you need

| | |
|---|---|
| Instagram | A **professional** account (Creator or Business). It must be **public**, or comment webhooks don't fire. |
| Meta | A free [developer account](https://developers.facebook.com) and a **business portfolio** that your Instagram account is in |
| Cloudflare | A free account |
| Your machine | **Node.js 22+** and git, on macOS, Linux, or Windows with WSL |

## Install

```bash
git clone https://github.com/theChitranshM/ig-comment-dm.git
cd ig-comment-dm
npm run setup
```

The full walkthrough, with every click, is **[docs/SETUP.md](docs/SETUP.md)**. In short:

1. **Create a Meta app** with the "Manage messaging & content on Instagram" use case and a Unified login configuration ([Part A](docs/SETUP.md#part-a-create-the-meta-app)).
2. **`npm run setup`** logs you in to Cloudflare, deploys the Worker, sets the secrets, and prints exactly what to paste into Meta.
3. **Paste those values into Meta:** redirect URL, webhook URL, verify token, privacy URLs.
4. **Connect your account:**
   ```bash
   npm run admin -- connect
   npm run admin -- set-ig-id <id>
   npm run admin -- subscribe
   npm run admin -- check
   ```
5. **Publish the app** in Meta, then switch on a post:
   ```bash
   npm run admin -- posts
   npm run admin -- allow 1
   ```

## Set your keywords

```bash
npm run admin -- config pull     # writes config.local.json
# edit it
npm run admin -- config push     # live within about a minute, no redeploy
```

`config.local.json` is plain JSON, so comments aren't allowed in it:

```json
{
  "rules": [
    {
      "keyword": "GUIDE",
      "match": "fuzzy",
      "aliases": ["GUIDES", "THE GUIDE"],
      "dm": "here's the guide 📘",
      "link": "https://example.com/guide",
      "ack": "sent! check your dms 📩"
    }
  ],
  "scope": {
    "mode": "allowlist",
    "media_ids": ["<MEDIA_ID>"],
    "exclude_media_ids": [],
    "skip_comment_ids": []
  },
  "dry_run": false
}
```

**`rules`**

| Field | Meaning |
|---|---|
| `keyword` | The trigger. Case-insensitive, and it must stand alone: `guide pls` ✓, `#guide` ✓, `misguided` ✗ |
| `match` | **`"fuzzy"`** (default) also forgives accents, stretched letters (`guideeee`), spaced letters (`g u i d e`), and **one typo for keywords of 5+ letters** (two for 9+). Keywords under 5 letters never get typo tolerance, so `EYE` won't fire on "bye". **`"exact"`** means spelling must match. |
| `aliases` | Other words that trigger the same reply: plurals, nicknames, other languages |
| `dm` | The private reply |
| `link` | Optional. Added on its own line under `dm` |
| `ack` | Optional public reply, posted only after the DM succeeds |

**`scope`**

| Field | Meaning |
|---|---|
| `mode` | `"allowlist"`: only `media_ids` · `"all"`: every post except `exclude_media_ids` |
| `skip_comment_ids` | Individual comments to never touch |

Rules are checked top to bottom. An exact match on any rule beats a fuzzy match on an earlier one. To test a phrase without posting anything:

```bash
npm run admin -- try "guidee pls 🙏"
```

## Everyday commands

| Command | What it does |
|---|---|
| `npm run admin -- check` | Is everything wired up? Checks the token, account, permissions and both webhook subscriptions |
| `npm run admin -- posts` | Your recent posts, numbered, with comment counts and which are switched on |
| `npm run admin -- allow 3` | Switch on post 3 (or pass a media id). Only comments from now on fire automatically |
| `npm run admin -- preview` | Who would get a DM right now, older comments included. Sends nothing |
| `npm run admin -- backfill` | Preview, confirm, then answer waiting comments (up to 7 days old) |
| `npm run admin -- try "<text>"` | Which rule a comment would trigger |
| `npm run admin -- status` | Recent sends and retries |
| `npm run admin -- logs` | Live logs from the Worker (same as `npm run logs`) |

**Updating** after a `git pull`: run `npm run deploy`. Your config, token and history are kept.

## How it works

```
Instagram comment
   │
   ├─ webhook (≈1s) ──▶ /webhook ─ verify X-Hub-Signature-256 ─ 200 OK
   │                                     │ (after the response)
   └─ poll (every 5 min, daily 7-day sweep)
                                         ▼
          own comment? · skip-listed? · already answered? · post switched on? · keyword?
                                         ▼
          Ledger (Durable Object): claim comment_id atomically
                                         ▼
          POST /<IG_ID>/messages {recipient:{comment_id}}   ── fails → no public reply, retry if temporary
                                         ▼ ok, recorded as dm_sent
          POST /<COMMENT_ID>/replies {message: ack}         ── fails → retry the reply only, never the DM
                                         ▼
                                       done
```

More detail, including why it uses a Durable Object instead of KV: [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).

## Instagram's rules (apply to every tool like this)

- **One private reply per comment**, and only within **7 days** of the comment.
- The DM lands in the person's main inbox if they follow you, and in **Message requests** if they don't. That's what the public "check your dms" reply is for.
- Up to **750 private replies per hour** per account.
- Comment webhooks only fire for **public** accounts, and only once your Meta app is **Live**.

## Cost

Everything runs on Cloudflare's free plan: Workers, one SQLite Durable Object, Workers KV, and cron triggers. Meta's API is free. A free-plan Worker can make about 50 outbound calls per run, so the tool sends up to 5 DMs per run. If a viral post brings in a burst, the rest follow in the next 5-minute run, each exactly once.

## Troubleshooting

[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) covers every snag found while building this, with the fix for each. For example: "Instagram login is not available for newer apps", the token losing access to your account, webhooks saved but nothing arriving, and comments visible in the app but not to the API.

## Tests

```bash
npm test
```

There are no dependencies. The suite covers:
- signature checks and both webhook payload shapes
- fuzzy and exact matching
- the self filter and switch-on safety
- concurrent replays
- retries that never double-send
- the send budget, trial-reel polling, the 7-day backfill, and the token check

## Disclaimer

Not affiliated with Meta or Instagram. You run this on your own account under [Meta's Platform Terms](https://developers.facebook.com/terms). Only send people what they asked for.

[MIT](LICENSE) © Chitransh Motwani
