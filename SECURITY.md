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
- **Connect flow:** the OAuth `state` is single-use and expires after 15 minutes, so a stranger can't connect their own account to your Worker.
- **Admin key check:** compared in constant time.
- **Read-only diagnostics:** `/admin/graph` can only make `GET` requests. The only admin routes that write to Instagram are:
  - `/admin/poll` and `/admin/sweep`, which send DMs and replies (sends nothing with `?dry=1`)
  - `/admin/test-comment` (POST and DELETE), which posts or removes a comment as your account. It's for proving the self filter, and own comments never fire.
  - `/admin/replay`, which runs a webhook payload through the pipeline to test dedupe.

## If something leaks

| Leaked | Fix |
|---|---|
| `ADMIN_KEY` | Delete the line from `.secrets.local` and re-run `npm run setup`. That generates a new key and sets it. |
| App secret | Reset it in Meta (App settings → Basic), then re-run `npm run setup`. |
| Access token | In Business Settings, remove the app's access to your Instagram account, then run `npm run admin -- connect`. |

## Reporting

If you find a vulnerability, please open a private security advisory on this repository rather than a public issue.
