# ig-comment-dm

[![test](https://github.com/theChitranshM/ig-comment-dm/actions/workflows/test.yml/badge.svg)](https://github.com/theChitranshM/ig-comment-dm/actions/workflows/test.yml)

**Comment a keyword. Get the link in your DMs.**

A self-hosted Instagram comment-to-DM tool with a web dashboard. Someone comments `GUIDE` on your reel → they get a private DM with your link → a public "sent! check your dms 📩" appears under their comment. You set it all up from a dashboard on your own free Cloudflare Worker and your own Meta app. No subscription, and no third party holds your account.

**The dashboard** lives at `https://<your-worker>/app` and works on a phone:

- **Automations:** create, toggle, reorder and delete keyword automations.
- **Editor:** trigger, message and posts, with a live Instagram DM preview and a "Try a comment" tester.
- **Waiting comments:** see who commented before you switched a post on, and send to them when you choose.
- **Posts:** a grid of your recent posts and reels, with trial reels marked.
- **Activity:** every send, retry and failure, with filters.
- **Settings:** preview mode, health checks, reconnect Instagram, light or dark theme.
- **Install as an app:** open `/app` on your phone and choose Add to Home Screen. It opens full screen as "Comment DM". On iPhone you sign in once inside the installed app.

```
@someone: "guidee pls 🙏"     →   DM to @someone:  "here's the guide 📘
                                                    https://example.com/guide"
                              →   public reply:    "sent! check your dms 📩"
```

## Why this one

- **Exactly once, every time.** Meta retries webhooks for up to 36 hours, and polling re-reads old comments. Each comment is claimed atomically in a Durable Object, so nobody gets two DMs, even when the same event arrives three times in the same second.
- **DM first, then the like and the public reply.** The "check your dms" reply is posted only after the DM succeeds, so you never publicly promise a message that didn't go out.
- **One automation per job.** Each automation has its own keyword, message and posts, so the same keyword can send different links on different posts.
- **Follow to unlock (optional).** The DM carries a button instead of the link. Tapping it checks whether they follow you: followers get the link, everyone else is asked to follow first, and an "I'm following" button checks again.
- **Forgiving matching.** `GUIDE`, `guide pls`, `#guide`, `guidee`, `gude` and `G U I D E` all count, with no false hits like "misguided". You choose fuzzy or exact per keyword.
- **Doesn't miss comments.** Webhooks deliver in about a second. A poll every 5 minutes and a daily sweep catch anything a webhook missed (downtime, a bad deploy), within Instagram's 7-day reply window. Trial reels work too.
- **Safe by default.**
  - Nothing fires until you add a post to an automation, and then only for **new** comments.
  - Older comments show up as "waiting" and are sent only when you choose.
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
5. **Publish the app** in Meta, then **open your dashboard** at `https://<your-worker>/app` and sign in with `ADMIN_KEY` from `.secrets.local`. `npm run setup` prints the exact URL.

## Create an automation

1. Open the dashboard and go to **Automations → New automation**.
2. Set the **trigger**: a keyword such as `GUIDE`, plus any aliases. Leave matching on fuzzy unless you need exact spelling.
3. Write the **message**: the DM, an optional link, an optional public reply, and whether to like their comment.
4. Pick the **posts** it runs on, or choose all posts. The preview on the right shows the DM as people will see it.
5. Use **Try a comment** to check a phrase, then save. New comments on those posts get the DM from now on.

Comments that were already there when you added a post are not sent automatically. They appear as "N people waiting" on the automation, and you choose whether to send to them.

<details>
<summary>Prefer the terminal?</summary>

Everything above also works from the CLI. Create the first automation in the dashboard, or edit the config file directly:

```bash
npm run admin -- config pull     # writes config.local.json
# edit it
npm run admin -- config push     # live within about a minute, no redeploy
```

`config.local.json` is plain JSON, so comments aren't allowed in it:

```json
{
  "version": 2,
  "automations": [
    {
      "id": "a_guide",
      "name": "Free guide",
      "enabled": true,
      "keyword": "GUIDE",
      "aliases": ["GUIDES", "THE GUIDE"],
      "match": "fuzzy",
      "dm": "here's the guide 📘",
      "link": "https://example.com/guide",
      "ack": "sent! check your dms 📩",
      "like": true,
      "all_posts": false,
      "media_ids": ["<MEDIA_ID>"],
      "allowed_at": {}
    }
  ],
  "exclude_media_ids": [],
  "skip_comment_ids": [],
  "dry_run": false
}
```

**Automation fields**

| Field | Meaning |
|---|---|
| `id` | Stable identifier. Leave it out on a new automation and one is generated. |
| `name` | Display name in the dashboard |
| `enabled` | `false` pauses the automation |
| `keyword` | The trigger. Case-insensitive, and it must stand alone: `guide pls` ✓, `#guide` ✓, `misguided` ✗ |
| `aliases` | Other words that trigger the same reply: plurals, nicknames, other languages |
| `match` | **`"fuzzy"`** (default) also forgives accents, stretched letters (`guideeee`), spaced letters (`g u i d e`), and **one typo for keywords of 5+ letters** (two for 9+). Keywords under 5 letters never get typo tolerance, so `EYE` won't fire on "bye". **`"exact"`** means spelling must match. |
| `dm` | The private reply. Required. |
| `link` | Optional. Added on its own line under `dm` |
| `ack` | Optional public reply, posted only after the DM succeeds |
| `follow_gate` | `true` sends a button first and gives the link only to people who follow you |
| `opener`, `opener_button` | With `follow_gate`: the first DM (max 600 characters) and its button label (max 20). Empty uses the default |
| `gate_text`, `gate_button` | With `follow_gate`: what non-followers see (max 600 characters), and the re-check button (max 20). Empty uses the default. Needs the `messaging_postbacks` subscription from `npm run admin -- subscribe` |
| `like` | `true` likes their comment from your account after the DM succeeds. Needs the optional like connection ([SETUP](docs/SETUP.md#optional-liking-comments)) |
| `all_posts` | `true` runs on every post except `exclude_media_ids` |
| `media_ids` | The posts it runs on when `all_posts` is `false` |
| `allowed_at` | When each post was added. Comments older than this wait for a backfill. The CLI and dashboard set it for you. |

**Top-level fields**

| Field | Meaning |
|---|---|
| `exclude_media_ids` | Posts no automation ever touches |
| `skip_comment_ids` | Individual comments to never touch |
| `dry_run` | `true` is preview mode: comments are matched but nothing is sent |

Two enabled automations can't share a keyword or alias on overlapping posts; the push is rejected. Automations are checked top to bottom, and an exact match on any automation beats a fuzzy match on an earlier one. Configs from earlier versions (`rules` and `scope`) are migrated automatically when read.

Day-to-day commands:

```bash
npm run admin -- posts                       # numbered list of recent posts
npm run admin -- allow 3 --to GUIDE          # add post 3 to the GUIDE automation
npm run admin -- preview                     # who would get a DM right now, sends nothing
npm run admin -- backfill                    # send to waiting comments, after you confirm
npm run admin -- try "guidee pls 🙏"         # which automation would this trigger?
```

`--to <KEYWORD|id>` is required for `allow` when you have more than one automation.

</details>

## CLI reference

The dashboard covers daily use. The CLI is still supported for scripting and for setup.

| Command | What it does |
|---|---|
| `npm run admin -- connect [--likes]` | Log in with Instagram and save the token. `--likes` adds the optional like-only connection ([SETUP](docs/SETUP.md#optional-liking-comments)) |
| `npm run admin -- set-ig-id <id>` | Save your Instagram account ID and redeploy |
| `npm run admin -- subscribe` | Subscribe your account and app to `comments` and `messaging_postbacks` |
| `npm run admin -- check` | Is everything wired up? Checks the token, account, permissions, both webhook subscriptions (comments and button taps) and liking |
| `npm run admin -- posts` | Your recent posts, numbered, with comment counts and which are switched on |
| `npm run admin -- allow <n\|id>... [--to KEYWORD]` | Add posts to an automation. Only comments from now on fire automatically. `--to` is required with more than one automation |
| `npm run admin -- disallow <n\|id>... [--to KEYWORD]` | Remove posts from one automation, or from all of them |
| `npm run admin -- skip <comment_id>` | Never act on one comment |
| `npm run admin -- preview` | Who would get a DM right now, older comments included. Sends nothing |
| `npm run admin -- backfill` | Preview, confirm, then answer waiting comments (up to 7 days old) |
| `npm run admin -- try "<text>"` | Which automation a comment would trigger |
| `npm run admin -- config pull\|push` | Edit the automations JSON locally |
| `npm run admin -- status` | Recent sends and retries |
| `npm run admin -- logs` | Live logs from the Worker (same as `npm run logs`) |
| `npm run admin -- alerts webhook <url>` | Optional: a Discord or Slack message when Instagram access breaks, comes back, or DMs fail |

**Updating** after a `git pull`: run `npm run deploy`. Your config, token and history are kept.

**Working on the dashboard?** `npm run dev:ui` serves a local mock of the dashboard and its API at `http://localhost:8788/app`. The login key is `dev`. No Instagram or Cloudflare account is needed.

## How it works

```
Instagram comment
   │
   ├─ webhook (≈1s) ──▶ /webhook ─ verify X-Hub-Signature-256 ─ 200 OK
   │                                     │ (after the response)
   └─ poll (every 5 min, daily 7-day sweep)
                                         ▼
          own comment? · skip-listed? · already answered? · automation on this post? · keyword?
                                         ▼
          Ledger (Durable Object): claim comment_id atomically
                                         ▼
          POST /<IG_ID>/messages {recipient:{comment_id}}   ── fails → no public reply, retry if temporary
                                         ▼ ok, recorded as dm_sent
          POST /<IG_ID>/likes {comment_id}                  ── optional, best effort, once, never retried
                                         ▼
          POST /<COMMENT_ID>/replies {message: ack}         ── fails → retry the reply only, never the DM
                                         ▼
                                       done
```

With follow to unlock on, the DM is a button. The tap arrives as a `messaging_postbacks` webhook, and the Worker sends the link only if the person follows you. The like and public reply still happen right after the button DM.

More detail, including the automation model and why it uses a Durable Object instead of KV: [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).

## Instagram's rules (apply to every tool like this)

- **One private reply per comment**, and only within **7 days** of the comment.
- The DM lands in the person's main inbox if they follow you, and in **Message requests** if they don't. That's what the public "check your dms" reply is for.
- Up to **750 private replies per hour** per account.
- Comment webhooks only fire for **public** accounts, and only once your Meta app is **Live**.

## Cost

Everything runs on Cloudflare's free plan: Workers, one SQLite Durable Object, Workers KV, and cron triggers. Meta's API is free. A free-plan Worker can make about 50 outbound calls per run, so the tool sends up to 5 DMs per run. If a viral post brings in a burst, the rest follow in the next 5-minute run, each exactly once.

## Troubleshooting

[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) covers every snag found while building this, with the fix for each. For example: "Instagram login is not available for newer apps", dashboard login problems, the health banner, the token losing access to your account, webhooks saved but nothing arriving, and comments visible in the app but not to the API.

The dashboard's JSON API is documented in [docs/API.md](docs/API.md). Security details are in [SECURITY.md](SECURITY.md).

## Tests

```bash
npm test
```

There are no runtime dependencies. `npm test` runs the full suite, covering:
- signature checks and both webhook payload shapes
- fuzzy and exact matching
- the self filter and switch-on safety
- automations: validation, per-post routing and v1 migration
- the dashboard API: login, sessions, CSRF guard, sign-in rate limit and every endpoint
- follow to unlock: button taps, follow checks, fallbacks and tap limits
- liking comments
- the home-screen manifest and icons
- concurrent replays
- retries that never double-send
- the send budget, trial-reel polling, the 7-day backfill, and the token check

## Disclaimer

Not affiliated with Meta or Instagram. You run this on your own account under [Meta's Platform Terms](https://developers.facebook.com/terms). Only send people what they asked for.

[MIT](LICENSE) © Chitransh Motwani
