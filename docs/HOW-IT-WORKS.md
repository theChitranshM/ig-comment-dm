# How it works

## The pieces

| Piece | Cloudflare product | Holds |
|---|---|---|
| `src/index.js` | Worker | webhook endpoint, OAuth callback, privacy pages, cron |
| `src/admin.js` | Worker routes | the `/admin/*` API behind `npm run admin` (bearer-key protected) |
| `src/core.js` | none | signature check, payload parsing, matching, Graph API calls, polling |
| `src/ledger.js` | Durable Object (SQLite) | one record per comment: the dedupe gate and retry queue |
| Workers KV | KV | live config (rules, scope) and the access token |

## One comment's journey

1. **Arrival.** Comments arrive two ways:
   - **Webhook:** Meta POSTs to `/webhook`. The Worker checks `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with your Meta app secret), answers `200` immediately, and does the rest after the response.
   - **Poll:** every 5 minutes it reads the newest comments on posts that are switched on. Once a day it sweeps everything in Instagram's 7-day reply window. This catches comments a webhook missed: downtime, a bad deploy, anything Meta didn't deliver.
2. **Filters**, in this order:
   1. no commenter info
   2. your own comment
   3. older than 7 days
   4. on the skip list
   5. already replied to by you (poll only, since webhooks don't carry replies)
   6. post excluded
   7. post not switched on
   8. posted before the post was switched on (polls only; `backfill` overrides)
   9. no keyword match
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

In `allowlist` mode, each 5-minute poll is one API call per switched-on post. In `all` mode, it's one call for the media list plus one per recent post (`POLL_RECENT_MEDIA`, default 4). That's about 60 calls an hour, far below Meta's limits. The daily sweep reads up to two pages of comments on up to `FULL_SWEEP_MEDIA` posts (default 8).

A free-plan Worker can make about 50 outbound calls per run, and each send costs about 5 (ledger and Graph API). So each run sends at most `MAX_SENDS_PER_RUN` (default 5). The rest stay queued in the ledger, and the next run's retry sweep sends them, still exactly once.

## Tokens

The default route is **Unified login** (Facebook Login for Business), which uses a system-user access token that **never expires**. The daily job checks that the token can still reach your account and logs `token_unhealthy` if it can't.

A legacy route, **Instagram Login** (`graph.instagram.com`), only exists on older Meta apps. To use it, set `GRAPH_HOST = "graph.instagram.com"` and `TOKEN_KIND = "ig_login"`. The daily job then refreshes the 60-day token when fewer than 20 days are left.

## Matching

Every rule matches case-insensitively, and the keyword has to stand alone as a word or phrase. Each rule picks a mode:

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

Rules are checked top to bottom. Exact matches are tried across all rules first, so an exact hit on a later rule beats a fuzzy hit on an earlier one.
