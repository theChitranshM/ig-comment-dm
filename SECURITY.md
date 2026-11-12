# Security

## What's secret, and where it lives

| Secret | Stored in | Never in |
|---|---|---|
| Meta app secret (`APP_SECRET`) | Cloudflare Worker secret | the repo, logs, the browser |
| Access token | Workers KV, written by the connect flow | the repo, logs, the browser, your terminal |
| `VERIFY_TOKEN`, `ADMIN_KEY` | Cloudflare Worker secrets, plus `.secrets.local` on your machine (git-ignored, mode 600) | the repo |

`wrangler.toml`, `.secrets.local` and `config.local.json` are git-ignored. They hold your ids and live config, so don't commit them.

## Built-in protections

- **Webhooks:** every `POST /webhook` must carry a valid `X-Hub-Signature-256` for your app secret, checked in constant time. Unsigned or tampered requests get `401`, and nothing runs.
- **Admin API:** every `/admin/*` route needs `Authorization: Bearer <ADMIN_KEY>`.
- **Dashboard API:** every `/api/*` route except login and logout needs a valid session cookie or the same bearer header.
- **Connect flow:** the OAuth `state` is single-use and expires after 15 minutes, so a stranger can't connect their own account to your Worker.
- **Admin key check:** compared in constant time.
- **Read-only diagnostics:** `/admin/graph` can only make `GET` requests. The only admin routes that write to Instagram are:
  - `/admin/poll` and `/admin/sweep`, which send DMs and replies (sends nothing with `?dry=1`)
  - `/admin/test-comment` (POST and DELETE), which posts or removes a comment as your account. It's for proving the self filter, and own comments never fire.
  - `/admin/replay`, which runs a webhook payload through the pipeline to test dedupe.
  - `/admin/like` (POST and DELETE), which likes or unlikes one comment as your account, for testing.
- **Button taps (follow to unlock):** they arrive through the same signed webhook. Only taps whose payload this Worker created (`unlock:<automation>:<step>`) are acted on, each tap once even if Meta retries it, and at most 6 taps a minute per person, so nobody can make the tool spam Instagram. Message text in your DMs is never parsed, stored or logged.
- **Follow check fails open:** if Instagram won't say whether someone follows you, they get the link rather than being stuck. The gate is a nudge, not access control, so don't put anything secret behind it.

## The dashboard

The dashboard is served at `/app` and signs you in with `ADMIN_KEY`.

**Sessions**
- `POST /api/login` compares the key you send with `ADMIN_KEY` in constant time. A wrong key gets `401` and logs `login_failed` (no key value).
- Sign-in is rate limited to 10 attempts per IP address per 15 minutes (`429` with `Retry-After` after that), on top of the key being 256 random bits.
- A correct key sets a `sid` cookie: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, valid for 30 days. It holds an expiry time and an HMAC-SHA-256 signature made with `ADMIN_KEY`. Nothing is stored server-side.
- The signature is checked in constant time. Because it's derived from `ADMIN_KEY`, changing the key signs out every browser at once. There's no separate per-session revocation; logging out clears the cookie in that browser.
- `HttpOnly` means page scripts can't read the cookie. `Secure` means it's never sent over plain HTTP. `SameSite=Strict` means other sites can't make your browser send it.
- The dashboard never receives the Instagram token or the app secret.

**CSRF**
- Any non-GET request authenticated by cookie must carry `X-Requested-With: ig-comment-dm`, or it's rejected with `403`. A cross-site form or image can't set that header, and a cross-origin script can't without a CORS preflight, which the Worker doesn't allow.
- The Worker sends no CORS headers, so other origins can't read API responses.
- Bearer-authenticated requests skip the header check, because they don't ride on browser cookies.

**Content security policy and headers on `/app`**
- `default-src 'none'`, so everything not listed is blocked. Scripts and styles are inline only (`'unsafe-inline'`), with no external fonts, scripts or stylesheets and nothing loaded from a CDN.
- `connect-src 'self'`: the page can only call its own Worker.
- `img-src https: data:`: needed to show Instagram thumbnails and profile pictures.
- `manifest-src 'self'`: lets the page be installed to a home screen from its own manifest.
- `base-uri 'none'`, `form-action 'self'`, `frame-ancestors 'none'` plus `X-Frame-Options: DENY`, so the page can't be framed (no clickjacking).
- `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and `Cache-Control: no-store` on the page and every API response.

**Things to know**
- `ADMIN_KEY` is the only credential. Treat it like a password, and keep `.secrets.local` private.
- `npm run setup` generates the key as 64 random hex characters. Don't replace it with a short one: the sign-in rate limit is per IP, and a long key is what makes guessing hopeless.
- Because the CSP allows inline scripts, the protection against script injection relies on the dashboard building the page with text nodes rather than HTML strings. Report any place where that isn't true.

## If something leaks

| Leaked | Fix |
|---|---|
| `ADMIN_KEY` | Delete the line from `.secrets.local` and re-run `npm run setup`. That generates a new key and sets it. Every dashboard session signs out. |
| App secret | Reset it in Meta (App settings → Basic), then re-run `npm run setup`. |
| Access token | In Business Settings, remove the app's access to your Instagram account, then run `npm run admin -- connect`. |

## Reporting a vulnerability

Please don't open a public issue. Use GitHub's **Report a vulnerability** button on the repository's Security tab (private vulnerability reporting), with steps to reproduce. You'll get a reply within a week.
