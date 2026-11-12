# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.5.0] - 2026-11-12

### Security
- Sign-in is rate limited: 10 attempts per IP address per 15 minutes, then `429` with a `Retry-After` header.
- Follow to unlock button taps are limited to 6 per minute per person.

### Changed
- Documentation refresh: the README, setup guide, API reference, how-it-works and troubleshooting pages now cover follow to unlock, liking and the home-screen app.
- Added CONTRIBUTING.md, issue and pull request templates, an `.editorconfig` and Dependabot for GitHub Actions.
- CI runs with read-only permissions. The local dashboard mock listens on 127.0.0.1 only.
- The setup wizard validates the Worker name before passing it to Wrangler.
- The icon route only serves known files.

## [1.4.0] - 2026-11-12

### Added
- Install the dashboard as a home-screen app. `/app/manifest.webmanifest` and `/app/icons/*` are served by the Worker. It opens full screen as "Comment DM".

## [1.3.0] - 2026-11-12

### Added
- Follow to unlock (per automation: `follow_gate`, `opener`, `opener_button`, `gate_text`, `gate_button`). The comment DM is a button, and the Worker checks that the person follows you before sending the link.
- Button taps arrive as `messaging_postbacks` webhooks. `npm run admin -- subscribe` now subscribes `comments` and `messaging_postbacks`.
- Dashboard health reports `webhook_postbacks`, with a "Button taps not subscribed" banner.
- Like their comment (`like`). After the DM succeeds, the Worker likes the comment on a best-effort basis.
- Optional like-only connection: `LIKE_CONFIG_ID` and `npm run admin -- connect --likes`.

## [1.2.0] - 2026-11-12

### Added
- Alerts: a health watcher that can post to a Discord or Slack webhook when Instagram access breaks, comes back, or DMs fail.
- `npm run admin -- alerts webhook <url>` and `POST /api/alerts/test`.

## [1.1.0] - 2026-11-11

### Added
- Web dashboard at `/app`: automations, editor with live DM preview and "Try a comment", waiting comments, posts grid, activity, and settings.
- The `/api/*` JSON API behind the dashboard.
- Per-post automations (config version 2). Version 1 configs are migrated automatically.

## [1.0.0] - 2026-11-10

### Added
- Self-hosted Instagram comment-to-DM tool on a Cloudflare Worker.
- Exactly-once sending with a Durable Object ledger, and retries that never send a DM twice.
- Fuzzy and exact keyword matching.
- Webhook delivery, a 5-minute poll and a daily 7-day sweep.
- Safe by default: nothing fires until a post is switched on, and only new comments fire.
- `npm run setup` and the `npm run admin` CLI.
