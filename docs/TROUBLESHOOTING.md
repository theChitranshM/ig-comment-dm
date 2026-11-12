# Troubleshooting

Start with:

```bash
npm run admin -- check
```

It points at most problems directly. The dashboard's **Settings → Connection** shows the same checks. Each entry below is something that actually happened while building this tool.

Contents: [Dashboard login](#i-cant-sign-in-to-the-dashboard) · [Health banner](#the-dashboard-shows-a-health-banner) · [People waiting](#the-dashboard-says-n-people-waiting) · [Nothing fires](#a-keyword-comment-didnt-get-a-dm)

---

### I can't sign in to the dashboard
Open `https://<worker>/app`. The Worker URL is in `.secrets.local` as `WORKER`.

| Symptom | Cause and fix |
|---|---|
| "That key didn't work" | The key must match `ADMIN_KEY` exactly. Copy it from `.secrets.local` with no spaces or quotes. If you lost the file, delete the `ADMIN_KEY` line and re-run `npm run setup`, which generates and sets a new one. |
| "That key didn't work", but the key is right | `.secrets.local` and the Worker can disagree if setup stopped partway. Re-run `npm run setup` to set `ADMIN_KEY` on the Worker again. |
| Sign-in succeeds, then you land back on the login screen | The session cookie is `Secure`, so the browser only keeps it over **HTTPS**. Use the `https://…workers.dev` address, not `http://`. Plain-HTTP local servers such as `wrangler dev` won't keep a login. |
| Same, on HTTPS | Cookies may be blocked for the site, or you're in a private window with cookies off. Allow cookies for the Worker's domain. |
| Signed out after a while | Sessions last 30 days. Changing `ADMIN_KEY` signs out every device. |
| A change fails with "Missing request header" (403) | Only seen when calling the API yourself with the cookie. Send `X-Requested-With: ig-comment-dm`, or use `Authorization: Bearer <ADMIN_KEY>` instead. See [API.md](API.md). |

### The dashboard shows a health banner
The banner and the health dot in the top bar come from the same checks as `npm run admin -- check`. Messages and fixes:

| Banner | Meaning | Fix |
|---|---|---|
| **Not connected** (red) | No Instagram access token is saved. | **Reconnect Instagram** in the banner, or `npm run admin -- connect`. Select your Instagram account on the assets screen. |
| **Instagram disconnected** (red) | A token exists, but Instagram rejected it or it can't act on your account. Nothing can be sent. | Same as above. If the message says the account ID isn't set, run `npm run admin -- set-ig-id <id>`. See the `check` entry below. |
| **Webhook misdirected** | The callback URL in your Meta app doesn't point at this Worker. | Set it to `https://<worker>/webhook` under Use cases → Customize → Configure webhooks, then run `check`. |
| **Comments not subscribed** | Your Meta app isn't subscribed to the `comments` field. Live delivery is off, but the 5-minute poll still catches comments. | `npm run admin -- subscribe`, or click **Subscribe** next to `comments` in Meta. |
| **Account not subscribed** | Your Instagram account isn't subscribed to the app. | `npm run admin -- subscribe`. |
| **Needs attention** | A check is failing without a more specific cause. | Run `npm run admin -- check` for details. |

A blue **Preview mode** banner isn't a fault. It means nothing is being sent. Turn it off in Settings or from the banner.

### The dashboard says "N people waiting"
These are comments that already existed when you added a post to an automation (or switched it to all posts). Only comments from that moment on fire automatically, so a new automation never surprises anyone with an old reply.

A comment counts as waiting only if all of these are true:
- The automation is **enabled** and runs on that post.
- The comment matches its keyword.
- It's within Instagram's **7-day** reply window.
- It isn't skip-listed, and you haven't already replied to it publicly.
- The ledger hasn't already handled it (sent, or finished with a failure).

Open the list to review it, uncheck anyone you don't want, then send. Sending is blocked while **preview mode** is on. If a number looks too low, remember that Instagram hides some comments from the API (see below), and that older than 7 days can't be answered at all. If you don't want to reply to the backlog, ignore it; the count doesn't expire anything, but comments age out of the 7-day window on their own.

### "API setup with Instagram login is not available for newer apps"
This is expected for any app created recently. Use **API setup with Unified login**, which is what this tool is built for. See [SETUP Part A](SETUP.md#part-a-create-the-meta-app).

### `check`: ✗ Account — "Object with ID … does not exist, cannot be loaded due to missing permissions"
The token is valid, but the system user behind it **can no longer act on your Instagram account**. This happens after asset or access changes in Business Settings, and sometimes with no visible change at all.

**Fix:**
1. Run `npm run admin -- connect` again, and **select your Instagram account** on the assets screen.
2. Run `npm run admin -- check`.

**While it's broken:** turn on **preview mode** (Settings in the dashboard, or `"dry_run": true` via `config pull` and `config push`) so incoming comments aren't recorded as failed sends. After reconnecting, turn it off and send to the **waiting** comments in the dashboard (or `npm run admin -- backfill`).

### Connected, but `/me/assigned_instagram_accounts` is empty
That's normal for Unified-login system-user tokens: the list can be empty even when access works. The tool checks your account ID directly instead (`set-ig-id`). If `check` shows ✓ Account, you're fine.

### Webhook "Verify and save" fails
- Make sure the verify token matches `VERIFY_TOKEN` in `.secrets.local` exactly. `npm run setup` copies it to your clipboard.
- Check the callback URL ends in `/webhook`.
- Brand-new `workers.dev` subdomains can fail HTTPS for a few minutes. Wait and retry.

### Webhook saved, but nothing arrives
Run `npm run admin -- check` and look at the **Webhooks** section:

| ✗ on… | Fix |
|---|---|
| App subscribed to the "comments" field | `npm run admin -- subscribe` (or click **Subscribe** next to `comments` under Configure webhooks) |
| Your account subscribed to the app | `npm run admin -- subscribe` |

If all three are green, also check:
- The app must be **Published** (Live).
- Your Instagram account must be **public**.

### A keyword comment didn't get a DM
First check the text matches: type it into **Try a comment** in the automation editor, or run `npm run admin -- try "the exact comment"`. Both test saved, enabled automations only.

Then run `npm run admin -- logs` and have someone comment again. Every webhook comment that doesn't fire logs a `skip` line with a reason:

| reason | meaning |
|---|---|
| `self` | You commented from your own account. Own comments never fire. |
| `no_sender` | The webhook had no commenter info, so it can't be answered |
| `outside_7d` | Instagram only allows private replies within 7 days |
| `skip_listed` | The comment is in `skip_comment_ids` |
| `excluded_media` | The post is in `exclude_media_ids` |
| `not_in_allowlist` | No enabled automation runs on that post. Add the post to an automation, or enable it. |
| `before_allow` | Posted before the post was added to the automation. Send it from the "waiting" list, or `npm run admin -- backfill` |
| `already_replied` | You (or another tool) already replied publicly. Only detectable by the poll, which sees replies. |
| `no_match` | No automation on that post matched. Use Try a comment, add an alias, or switch the automation to fuzzy matching |

No `webhook` line at all means Meta never delivered it. The 5-minute poll still picks the comment up, as long as an enabled automation runs on its post. Polls don't log skips: they re-read the same comments every 5 minutes, so the log would fill with noise.

### Follow to unlock: people tap the button and nothing happens
Button taps arrive as `messaging_postbacks` webhooks. Run `npm run admin -- subscribe`, then `npm run admin -- check`; it warns if that field is missing. Logs show `unlocked`, `gate_sent`, or `follow_check_failed` for every tap. If Instagram won't say whether someone follows you, they get the link anyway rather than being stuck. If Instagram refuses the button message itself (`gate_dm_rejected`), the plain link is sent instead.

### Comments aren't getting liked
Liking needs the `instagram_manage_engagement` permission on your connection. Follow [SETUP: Optional: liking comments](SETUP.md#optional-liking-comments). `npm run admin -- check` shows the state of that connection.

A failed like is logged as `like_failed` and never holds up the DM or the public reply. Comments from private accounts can't be liked.

### `dm_failed` in the logs
- **One private reply per comment:** if another tool already DM'd from that comment, Instagram refuses a second one. The tool marks it failed and does **not** post the public reply.
- **Temporary errors** (rate limits, 5xx) are retried automatically every 5 minutes, up to 5 attempts. Use `npm run admin -- status` to see retries.

### Some DMs went out a few minutes late after a burst of comments
That's expected. A free-plan Worker can make about 50 outbound calls per run, so the tool sends up to 5 DMs per run (`MAX_SENDS_PER_RUN`). The rest stay queued and go out on the next 5-minute run, each exactly once. On a paid Workers plan you can raise `MAX_SENDS_PER_RUN`.

### Some comments I can see in the app don't show up as waiting
Instagram hides some comments from the API: ones caught by hidden-word filters, spam filtering, or restricted accounts. The Posts view and `posts` show Instagram's own comment count, so a count higher than what the waiting list or `preview` finds means some comments are hidden. Those can only be answered from the Instagram app.

### Trial reels
Trial reels appear in the Posts view (marked as trial) and as `trial?` in `posts`, and fire comment webhooks like any other reel. Add them to an automation as usual.

### Cloudflare login says "Timed out waiting for authorization code"
Wrangler waits a limited time for you to approve in the browser. Run `npm run setup` again and approve straight away.

### "You need to register a workers.dev subdomain"
Your first Worker on this Cloudflare account. Pick a subdomain in the Cloudflare dashboard (Workers & Pages), then re-run `npm run setup`.

### I want to move to a different Meta app or account
1. Re-run `npm run setup` with the new App ID and Configuration ID.
2. Run `npm run admin -- connect`, then `set-ig-id`, then `subscribe`.

Your automations and history are kept.

### How do I find out when something breaks?
Meta can restrict a new app without warning; every API call then fails with "API access blocked." Nothing is lost while that lasts. Once access returns, the 5-minute poll answers anything missed on active posts, as long as it's within Instagram's 7-day window.

- **Dashboard:** a red banner explains what's wrong and offers **Reconnect Instagram** when that's the fix.
- **Optional push:** `npm run admin -- alerts webhook <discord-or-slack-webhook-url>`. You get a message when access stays down for 10 minutes, when it comes back, and when DMs fail. Messages contain counts and reasons only, never usernames or comment text.
- **Why not phone push via ntfy?** Its public server isn't reachable from Cloudflare Workers.

