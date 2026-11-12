# Contributing

Thanks for helping. This project is small on purpose, so changes are easy to review.

## Setup

- Node.js 22 or newer.
- Run the tests with `npm test`. They need no Instagram or Cloudflare account.
- Work on the dashboard with `npm run dev:ui`. It serves a mock of the dashboard and its API at `http://localhost:8788/app`. The login key is `dev`.

## Rules

- **Zero runtime dependencies.** Keep it that way. Use Web APIs and Node built-ins.
- **Add tests with every change.** A bug fix needs a test that fails without the fix.
- **Update the docs** when behavior changes: the README, `docs/`, and `CHANGELOG.md`.
- **Never commit** `wrangler.toml`, `.secrets.local` or `config.local.json`. Do not put real tokens, account ids or usernames in code, tests, issues or pull requests.
- Keep pull requests focused. One change per pull request.

## Security issues

Do not open a public issue. Use the repository's Security tab to report it privately. See [SECURITY.md](SECURITY.md).
