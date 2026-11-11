# Troubleshooting

Start with:

```bash
npm run admin -- check
```

It points at most problems directly. Each entry below is something that actually happened while building this tool.

---

### "API setup with Instagram login is not available for newer apps"
This is expected for any app created recently. Use **API setup with Unified login**, which is what this tool is built for. See [SETUP Part A](SETUP.md#part-a-create-the-meta-app).

### `check`: ✗ Account — "Object with ID … does not exist, cannot be loaded due to missing permissions"
The token is valid, but the system user behind it **can no longer act on your Instagram account**. This happens after asset or access changes in Business Settings, and sometimes with no visible change at all.

**Fix:**
1. Run `npm run admin -- connect` again, and **select your Instagram account** on the assets screen.
2. Run `npm run admin -- check`.

**While it's broken:** set `"dry_run": true` (`config pull` → edit → `config push`) so incoming comments aren't recorded as failed sends. After reconnecting, run `npm run admin -- backfill` to answer anything that came in meanwhile.

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
First check the text matches: `npm run admin -- try "the exact comment"`.

Then run `npm run admin -- logs` and have someone comment again. Every webhook comment that doesn't fire logs a `skip` line with a reason:

| reason | meaning |
|---|---|
| `self` | You commented from your own account. Own comments never fire. |
| `no_sender` | The webhook had no commenter info, so it can't be answered |
| `outside_7d` | Instagram only allows private replies within 7 days |
| `skip_listed` | The comment is in `skip_comment_ids` |
| `excluded_media` | The post is in `exclude_media_ids` |
| `not_in_allowlist` | That post isn't switched on: `npm run admin -- allow <n>` |
| `before_allow` | Posted before you switched the post on. Answer it with `npm run admin -- backfill` |
| `already_replied` | You (or another tool) already replied publicly. Only detectable by the poll, which sees replies. |
| `no_match` | No rule matched. Use `try`, add an alias, or switch the rule to `"match": "fuzzy"` |

No `webhook` line at all means Meta never delivered it. The 5-minute poll still picks the comment up, as long as its post is switched on. Polls don't log skips: they re-read the same comments every 5 minutes, so the log would fill with noise.

### `dm_failed` in the logs
- **One private reply per comment:** if another tool already DM'd from that comment, Instagram refuses a second one. The tool marks it failed and does **not** post the public reply.
- **Temporary errors** (rate limits, 5xx) are retried automatically every 5 minutes, up to 5 attempts. Use `npm run admin -- status` to see retries.

### Some DMs went out a few minutes late after a burst of comments
That's expected. A free-plan Worker can make about 50 outbound calls per run, so the tool sends up to 5 DMs per run (`MAX_SENDS_PER_RUN`). The rest stay queued and go out on the next 5-minute run, each exactly once. On a paid Workers plan you can raise `MAX_SENDS_PER_RUN`.

### Some comments I can see in the app don't show up in `preview`
Instagram hides some comments from the API: ones caught by hidden-word filters, spam filtering, or restricted accounts. `posts` shows Instagram's own comment count, so a count higher than what `preview` finds means some comments are hidden. Those can only be answered from the Instagram app.

### Trial reels
Trial reels appear in your post list (as `trial?` in `posts`) and fire comment webhooks like any other reel. Switch them on with `allow` as usual.

### Cloudflare login says "Timed out waiting for authorization code"
Wrangler waits a limited time for you to approve in the browser. Run `npm run setup` again and approve straight away.

### "You need to register a workers.dev subdomain"
Your first Worker on this Cloudflare account. Pick a subdomain in the Cloudflare dashboard (Workers & Pages), then re-run `npm run setup`.

### I want to move to a different Meta app or account
1. Re-run `npm run setup` with the new App ID and Configuration ID.
2. Run `npm run admin -- connect`, then `set-ig-id`, then `subscribe`.

Your rules and history are kept.
