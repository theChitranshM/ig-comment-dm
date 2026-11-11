# How it works

## The pieces

| Piece | Cloudflare product | Holds |
|---|---|---|
| `src/index.js` | Worker | webhook endpoint, OAuth callback, privacy pages, the `/app` dashboard page, cron |
| `src/app/app.html` | served by the Worker | the dashboard: one HTML file with inline CSS and JS, no external assets |
| `src/api.js` | Worker routes | the `/api/*` JSON API behind the dashboard ([API.md](API.md)) |
| `src/admin.js` | Worker routes | the `/admin/*` API behind `npm run admin` (bearer-key protected) |
| `src/automations.js` | none | the automation model, validation, and migration from v1 configs |
| `src/core.js` | none | signature check, payload parsing, matching, the `classify()` decision, Graph API calls, polling |
| `src/ledger.js` | Durable Object (SQLite) | one record per comment: the dedupe gate and retry queue |
| Workers KV | KV | live config (automations and settings) and the access token |

## The automation model

The live config is stored in KV under `config`:

```json
{
  "version": 2,
  "automations": [],
  "exclude_media_ids": [],
  "skip_comment_ids": [],
  "dry_run": false
}
```

An **automation** is a keyword (plus aliases and a match mode), a DM with an optional link, an optional public reply, and the posts it runs on. Its posts are either `all_posts: true` or an explicit `media_ids` list. Each automation has a stable `id` (`a_` plus a short random string) so that history, activity and the dashboard can refer to it even if you rename it.

### Per-post routing

Routing is per automation, not global. For a comment on post P, the candidates are the automations that are enabled, whose post list includes P (or that run on all posts), and where P is not in `exclude_media_ids`.

That's what lets the same keyword send different links on different posts: two automations can both use `CODE` as long as their posts don't overlap. Validation enforces that. Saving an enabled automation is rejected if one of its triggers (keyword or alias) is already used by another enabled automation on any overlapping post. An all-posts automation overlaps with everything. A paused automation doesn't count.

### Only new comments fire

Each automation records `allowed_at[media_id]`, the time a post was added to it. For all-posts automations, `all_posts_since` records when it was switched to all posts. Comments older than that moment never fire automatically; polls and webhooks skip them as `before_allow`. They appear in the dashboard as "N people waiting". Sending to them is an explicit backfill: from the dashboard, or `npm run admin -- backfill`. Removing a post drops its `allowed_at` entry.

"Waiting" means all of the following hold: the automation is enabled, the comment is on one of its posts, it matches, it's within the 7-day reply window, it isn't skip-listed or already answered by you, and the ledger hasn't already handled it.

### Migration from v1

Earlier versions stored `{ rules, scope }`. The Worker converts that on every read, so existing installs keep working without any action:

- each rule becomes an automation with id `a_<keyword>` (lowercased, non-alphanumerics removed) and a name derived from the keyword
- `scope.mode: "all"` becomes `all_posts: true`; `"allowlist"` copies `scope.media_ids` into each automation's `media_ids`
- `scope.allowed_at`, `exclude_media_ids` and `skip_comment_ids` carry over, and `dry_run` is kept
- ledger records that only have a keyword are still matched to the automation with that keyword, and the stats are summed

The converted config is written back in v2 form the first time you save from the dashboard or run `config push`. Pushing a v1 file with the CLI also works.

## One comment's journey

1. **Arrival.** Comments arrive two ways:
   - **Webhook:** Meta POSTs to `/webhook`. The Worker checks `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with your Meta app secret), answers `200` immediately, and does the rest after the response.
   - **Poll:** every 5 minutes it reads the newest comments on posts that are switched on. Once a day it sweeps everything in Instagram's 7-day reply window. This catches comments a webhook missed: downtime, a bad deploy, anything Meta didn't deliver.
2. **Filters**, in the order `classify()` in `src/core.js` applies them. The first that matches skips the comment, and the reason is logged for webhook comments:
   1. no commenter info (`no_sender`)
   2. your own comment, by account ID or username (`self`)
   3. older than 7 days (`outside_7d`)
   4. on the skip list (`skip_listed`)
   5. already replied to publicly by you (`already_replied`; needs the reply list, which polls read and webhooks usually don't carry)
   6. post in `exclude_media_ids` (`excluded_media`)
   7. no enabled automation runs on this post (`not_in_allowlist`)
   8. posted before the post was added to the automation (`before_allow`; polls and webhooks, and `backfill` overrides it)
   9. no keyword match among the remaining automations (`no_match`)

   Steps 7 and 8 work on the candidate automations for the post. A comment that matches only an automation it predates is `before_allow`, not `no_match`.

   After `classify()`, matching comments are checked against the ledger. Ones the ledger has already finished are dropped, so they never count as waiting and don't use up the send budget.
3. **Claim.** Matching comments go into the ledger with insert-if-absent. A worker must then `begin` the comment, which takes a 2-minute lease atomically. Only one caller can hold it.
4. **DM.** `POST /<IG_ID>/messages` with `recipient: { comment_id }`. On success the stage becomes `dm_sent`. On a temporary error the lease is released for retry. On a permanent error the comment is marked `failed`, and **no public reply is posted**.
5. **Public reply.** `POST /<COMMENT_ID>/replies`. On a temporary error only this step is retried. The DM is never sent twice, because the stage already says `dm_sent`.
6. **Done.** Records are pruned after 30 days.

## Why a Durable Object and not KV for dedupe

KV has no compare-and-set. "Read: not sent yet → send → write: sent" in KV can race: two webhook retries, or a webhook plus a poll arriving together, can both read "not sent". A Durable Object runs one request at a time, and its storage read-then-write is atomic. The claim is exactly-once even when the same event arrives three times in the same second (that's a test case).

There's a second reason. KV's free tier allows 1,000 writes a day, while a Durable Object's SQLite storage allows 100,000. Per-comment state belongs in the Durable Object.

## Why DM first

If the public "sent, check your dms" went out first and the DM then failed (the user blocks message requests, or another tool already used the comment's one private reply), you'd have publicly promised something that never arrived. So the public reply only happens after a successful DM.

## Polling cost and the send budget

Each 5-minute poll is one API call per post listed in an enabled automation. If any enabled automation runs on all posts, it adds one call for the media list plus one per recent post (`POLL_RECENT_MEDIA`, default 4). That's about 60 calls an hour, far below Meta's limits. The daily sweep reads up to two pages of comments on up to `FULL_SWEEP_MEDIA` posts (default 8).

A free-plan Worker can make about 50 outbound calls per run, and each send costs about 5 (ledger and Graph API). So each run sends at most `MAX_SENDS_PER_RUN` (default 5). The rest stay queued in the ledger, and the next run's retry sweep sends them, still exactly once.

## Tokens

The default route is **Unified login** (Facebook Login for Business), which uses a system-user access token that **never expires**. The daily job checks that the token can still reach your account and logs `token_unhealthy` if it can't.

A legacy route, **Instagram Login** (`graph.instagram.com`), only exists on older Meta apps. To use it, set `GRAPH_HOST = "graph.instagram.com"` and `TOKEN_KIND = "ig_login"`. The daily job then refreshes the 60-day token when fewer than 20 days are left.

## Matching

Every automation matches case-insensitively, and the keyword has to stand alone as a word or phrase. Each automation picks a mode:

- **`exact`:** the spelling must match.
- **`fuzzy`** (the default) also:
  - ignores accents
  - squeezes stretched letters (`guideeee` → `guide`)
  - joins spaced letters (`g u i d e`) and, for longer keywords, a word split in two (`gu ide`)
  - allows typos, measured as edit distance (insert, delete, swap or transpose one letter): **one** for keywords of 5–8 letters, **two** for 9+. Keywords under 5 letters get none, since three-letter words are too close to everyday words.

| Comment | `GUIDE` (exact) | `GUIDE` (fuzzy) | `EYE` (fuzzy) |
|---|---|---|---|
| `guide pls 🙏` / `#GUIDE` | ✓ | ✓ | |
| `guideee` / `gùide` / `g u i d e` | ✗ | ✓ | |
| `gude` / `giude` / `guides` | ✗ | ✓ | |
| `misguided` | ✗ | ✗ | |
| `eyeee` / `the eye` | | | ✓ |
| `bye` / `aye` / `eyes` | | | ✗ (use `aliases` for "eyes") |

Matching runs over the candidate automations for the post, in list order (the order you set in the dashboard). Exact matches are tried across all candidates first, so an exact hit on a later automation beats a fuzzy hit on an earlier one. Keywords and aliases both count as triggers.

## The dashboard

`GET /app` returns a single HTML page. It signs in through `POST /api/login`, then calls `/api/*` for everything. Edits write the config to KV. Workers cache the config for 60 seconds, so a change is live everywhere within about a minute. The dashboard never sees the Instagram token. See [API.md](API.md) for the endpoints and [SECURITY.md](../SECURITY.md) for the session and CSRF design.
