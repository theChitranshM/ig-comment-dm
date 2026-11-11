# Dashboard API

The dashboard at `/app` is a single page served by the Worker. It talks to `/api/*`. You can call the same API from scripts; this page describes what `src/api.js` does.

**Auth:**
- `POST /api/login` with the admin key sets an HttpOnly, Secure, `SameSite=Strict` session cookie (`sid`, valid 30 days).
- Every other `/api/*` route needs that cookie, or `Authorization: Bearer <ADMIN_KEY>`.
- Mutating requests (any method other than GET) made with the **cookie** must also send `X-Requested-With: ig-comment-dm`, or they fail with `403`. That's the CSRF guard. Bearer requests don't need it.
- The key and the cookie signature are compared in constant time. Responses are sent with `Cache-Control: no-store`.

**Responses:**
- Success: `200` with JSON.
- Failure: a non-2xx status with `{ "error": "human readable message" }`.
- `401` means "not logged in". Show the login screen.
- `403` means a cookie-authenticated mutation is missing the CSRF header.

---

## Data shapes

### Automation

```jsonc
{
  "id": "a_k3j9x2",                 // server-generated
  "name": "Diwali code",            // display name
  "enabled": true,
  "keyword": "DIWALI",              // trigger, case-insensitive, must stand alone
  "aliases": ["DEEPAWALI"],         // extra triggers
  "match": "fuzzy",                 // "fuzzy" | "exact"
  "dm": "here's the code 🪔 build your own",
  "link": "https://github.com/…",   // optional, "" if none
  "ack": "sent 🪔 check your dms",  // optional public reply, "" if none
  "all_posts": false,               // true = every post except settings.exclude_media_ids (including future posts)
  "media_ids": ["1792…", "1819…"],  // posts it runs on when all_posts is false
  "created_at": "2026-11-11T03:00:00.000Z",
  "updated_at": "2026-11-11T03:00:00.000Z",
  "stats": { "sent": 12, "failed": 0, "pending": 1, "last_sent_at": "2026-11-11T05:00:00.000Z" } // read-only
}
```

Only comments posted **after** a post was added to an automation fire automatically. Older ones show up in `/api/automations/:id/waiting` and are sent on request.

The server keeps an internal record of when each post was added (`allowed_at`, `all_posts_since`). Those fields are not returned by the API. Legacy ledger records from before automations had ids are folded into the stats of the automation with the same keyword.

### Post

```jsonc
{
  "id": "17900000000000001",
  "caption": "this is the part where…",
  "media_type": "VIDEO",            // IMAGE | VIDEO | CAROUSEL_ALBUM
  "product_type": "REELS",          // FEED | REELS | STORY | AD
  "thumbnail": "https://…",         // image URL to show (thumbnail_url for video, media_url for image), may be null
  "permalink": "https://www.instagram.com/reel/…",
  "timestamp": "2026-11-09T02:14:35+0000",
  "comments_count": 4,
  "trial": false,                   // reel not shared to the main feed (likely a trial reel)
  "automation_ids": ["a_k3j9x2"]    // automations currently running on this post
}
```

### Activity item

```jsonc
{
  "comment_id": "1808…",
  "automation_id": "a_k3j9x2",      // may be null for very old records
  "automation_name": "Diwali code",
  "keyword": "DIWALI",
  "user": "someone",                // commenter username
  "text": "diwali pls",
  "media_id": "1792…",
  "source": "webhook",              // webhook | poll
  "stage": "done",                  // new | dm_sent | done | done_noack | failed
  "attempts": 1,
  "note": null,                     // error text for failed / retries
  "updated_at": "2026-11-11T05:00:00.000Z"
}
```

---

## Endpoints

### Session
| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/login` | `{ "key": "<ADMIN_KEY>" }` | `{ "ok": true }` + cookie. `401` on a wrong key |
| POST | `/api/logout` | | `{ "ok": true }`, clears the cookie |

### Overview
`GET /api/overview` returns:
```jsonc
{
  "account": { "id": "1784…", "username": "yourname", "name": "Your Name", "picture": "https://…", "followers": 1200 } | null,
  "health": {
    "ok": true,                      // everything below is fine
    "token": true,                   // a token exists
    "account": true,                 // token can act on the account
    "account_error": null,
    "webhook_callback": true,        // app webhook points at this Worker
    "webhook_comments": true,        // app subscribed to the "comments" field
    "account_subscribed": true       // account subscribed to the app
  },
  "totals": { "automations": 3, "active": 3, "sent_24h": 3, "sent_total": 3, "failed": 0, "pending": 0 },
  "settings": { "dry_run": false, "exclude_media_ids": [] }
}
```

`totals.automations` and `totals.active` come from the config; `sent_24h`, `failed` and `pending` come from the ledger's last 24 hours, and `sent_total` is the ledger's all-time sent count. `account` is `null` when it can't be read. `health` makes live calls to Meta, so this route is the slowest one.

### Automations
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/automations` | | `{ "automations": [Automation] }`, in priority order |
| POST | `/api/automations` | Automation fields (no `id`/`stats`/timestamps). `enabled` defaults to `true` and `match` to `"fuzzy"` | `{ "automation": Automation }` |
| PUT | `/api/automations/:id` | any subset of the editable fields (a partial update) | `{ "automation": Automation }`. `404` if the id doesn't exist |
| DELETE | `/api/automations/:id` | | `{ "ok": true }` |
| POST | `/api/automations/reorder` | `{ "ids": ["a_1","a_2"] }` | `{ "ok": true }` |

Editable fields: `name`, `enabled`, `keyword`, `aliases`, `match`, `dm`, `link`, `ack`, `all_posts`, `media_ids`. Anything else in the body is ignored. Keywords and aliases are stored uppercase.

Validation errors come back as `400 { "error": "…" }`:
- `keyword` (at most 60 characters) and `dm` are required. `name` is at most 80.
- `link` must be `http(s)://…` or empty.
- The DM, including the link, is at most 1000 characters. `ack` is at most 300.
- A keyword or alias already used by **another enabled automation on an overlapping post** is rejected, and the message names that automation. An all-posts automation overlaps with every other one. Paused automations are ignored, so the check also runs when you re-enable one.

New posts in `media_ids` get an `allowed_at` timestamp of "now". Switching `all_posts` from false to true does the same for all posts, so existing comments wait instead of firing.

`POST /api/automations/reorder` sorts by the given ids. Automations not listed go last, in their current order. Order only matters for tie-breaking between fuzzy matches.

### Waiting comments (backfill)
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/automations/:id/waiting` | | `{ "comments": [{ "comment_id","user","text","media_id","timestamp" }] }`: comments on this automation's posts that match it and are waiting. Sends nothing. |
| POST | `/api/automations/:id/send-waiting` | `{ "comment_ids": [...] }` (optional, default all) | `{ "sent": 2, "queued": 1, "failed": 0, "results": [{ "comment_id","result","note" }] }`. Queued ones go out within 5 minutes. Returns `409` while preview mode is on. |

**What counts as waiting.** The route does a dry-run poll with backfill for that one automation, so:
- Only **enabled** automations are considered. A paused one returns an empty list.
- The comment must be within the 7-day window, match the automation, and not be skip-listed, excluded, or already replied to by you.
- Comments the ledger has already handled (sent, failed or in flight) are excluded.
- Because it reads from Instagram, an automation set to all posts looks at the most recent posts only (`FULL_SWEEP_MEDIA`, default 8).

`send-waiting` runs the same logic for real. `comment_ids` limits it to specific comments; leave it out to send to everyone waiting. It shares the per-run send budget (5 on the free plan), so the rest come back as `queued`.

### Posts
`GET /api/posts?limit=24&after=<cursor>` returns `{ "posts": [Post], "next": "<cursor>" | null }`, newest first. Returns `409` if the Instagram account ID isn't set and `502` if Instagram rejects the call. `limit` is capped at 50.

### Tools
| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/try` | `{ "text": "diwalii pls", "media_id": "…" (optional) }` | `{ "match": { "automation_id","name","keyword","mode" } \| null }`. Tests **saved, enabled** automations only; unsaved edits in the editor aren't included. With `media_id`, only automations running on that post are considered. `text` is cut to 500 characters. |
| GET | `/api/activity?limit=50` | | `{ "items": [Activity] }`, newest first |
| POST | `/api/reconnect` | | `{ "link": "https://www.facebook.com/…" }`: open it to reconnect Instagram. The link is valid for 15 minutes. `409` if `APP_ID` or `LOGIN_CONFIG_ID` isn't set |
| PUT | `/api/settings` | `{ "dry_run"?: bool, "exclude_media_ids"?: [...] }` | `{ "settings": { "dry_run", "exclude_media_ids" } }` |

`PUT /api/settings` is a **partial update**: only fields present in the body change, and an omitted field keeps its current value. `dry_run` is `true` only for a literal `true`. `exclude_media_ids` replaces the whole list, and invalid ids are dropped.

`GET /api/activity` also fills in `automation_id` and `automation_name` for older records by matching on keyword.
