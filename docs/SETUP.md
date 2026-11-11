# Setup guide

This takes about 30 minutes the first time, and most of it is clicking through Meta's dashboard. Every step below was done for real while building this tool, including the parts Meta doesn't document well.

**You'll go through:**
- Part A: Meta app
- Part B: `npm run setup`
- Part C: paste values into Meta
- Part D: connect your account
- Part E: go Live
- Part F: switch on your first post

---

## Before you start

- [ ] Your Instagram account is a **professional** account (Creator or Business) and is **public**.
- [ ] You have a **Meta business portfolio** at [business.facebook.com](https://business.facebook.com), and your Instagram account is in it. Check **Settings → Accounts → Instagram accounts**. If it's not there, click **Add** and log in to Instagram.
- [ ] You have a free [Cloudflare](https://dash.cloudflare.com/sign-up) account.
- [ ] **Node.js 22+** is installed (`node -v`). On Windows, use [WSL](https://learn.microsoft.com/windows/wsl/install).

---

## Part A: Create the Meta app

1. Go to [developers.facebook.com](https://developers.facebook.com) → **My Apps** → **Create app**.
2. Use case: **Manage messaging & content on Instagram**. Connect it to your business portfolio when asked.
3. Open **Use cases → Customize** on that use case.

   > **"API setup with Instagram login is not available for newer apps"**
   > Expected. New apps use **API setup with Unified login** (Facebook Login for Business with a system-user token). This tool is built for that route. Its token never expires, so there's no 60-day refresh.

4. On **API setup with Unified login → 1. Configure your app**, click **Create new configuration**:
   - Access token: **System-user access token** (never expires)
   - Assets: **Instagram account**
   - Permissions: keep `instagram_basic`, `instagram_manage_comments`, `instagram_manage_messages`

   Save it and copy the **Configuration ID** shown on the card.
5. **App settings → Basic:** copy the **App ID**, then click **Show** next to **App secret** and keep that page open.

You now have three values: **App ID**, **App secret**, **Configuration ID**.

---

## Part B: Run the setup

```bash
git clone https://github.com/theChitranshM/ig-comment-dm.git
cd ig-comment-dm
npm run setup
```

The wizard:
1. Logs you in to Cloudflare. A browser tab opens; approve it straight away, because the login times out.
2. Asks for a Worker name (Enter keeps `ig-comment-dm`), your name, your Instagram username, the App ID and the Configuration ID.
3. Creates your KV storage and writes `wrangler.toml`. Both stay on your machine and are git-ignored.
4. Generates a webhook verify token and an admin key into `.secrets.local`.
5. Deploys the Worker and asks for your App secret. Input is hidden, and the secret goes straight to Cloudflare.
6. Prints the five values for Part C.

> **"You need to register a workers.dev subdomain"**
> First Worker on this Cloudflare account? Pick a subdomain in the dashboard link the wizard prints. It becomes part of your URLs (`ig-comment-dm.<subdomain>.workers.dev`). Then re-run `npm run setup`; it picks up where it stopped.
>
> **"More than one account"**: your Cloudflare login can see several accounts. Uncomment `account_id` in `wrangler.toml`, set it to the account from `npx wrangler whoami`, and re-run.
>
> A brand-new subdomain can take a couple of minutes to get its HTTPS certificate. If a URL fails with an SSL error right after setup, wait two minutes.

---

## Part C: Paste values into Meta

All of these are printed at the end of `npm run setup`.

| Value | Where it goes in Meta |
|---|---|
| `https://<worker>/auth/callback` | Use cases → Customize → API setup with Unified login → **Redirect URL** → Register → Save |
| `https://<worker>/webhook` | Same page → **Configure webhooks** → Callback URL |
| verify token (copied to your clipboard) | Same page → Configure webhooks → Verify token → **Verify and save** |
| `https://<worker>/privacy` | App settings → Basic → **Privacy Policy URL** |
| `https://<worker>/data-deletion` | App settings → Basic → **User data deletion** → Data deletion instructions URL |

On **App settings → Basic**, also set a **category** and click **Save changes**.

> Under Configure webhooks, clicking **Subscribe** next to `comments` is easy to miss. You don't have to hunt for it: `npm run admin -- subscribe` in Part D subscribes that field for you, and `check` confirms it.

---

## Part D: Connect your Instagram account

```bash
npm run admin -- connect
```

This opens Meta's login. **On the assets screen, select your Instagram account**, then finish. You'll land on a "Connected ✅" page. The token is stored inside your Worker and is never shown.

Now tell the Worker which account it acts as:

1. Get your **Instagram account ID** from [business.facebook.com](https://business.facebook.com) → Settings → Accounts → **Instagram accounts** → click your account. The ID is under the username.
2. Save it and subscribe the webhooks:
   ```bash
   npm run admin -- set-ig-id 17841400000000000
   npm run admin -- subscribe
   npm run admin -- check
   ```

`check` should show all green:

```
Connection
  ✓ Token: system_user, connect flow (KV), never expires
  ✓ Account: @yourname (17841400000000000)
  ✓ Permissions: instagram_basic, instagram_manage_comments, instagram_manage_messages
Webhooks
  ✓ App callback points at this Worker
  ✓ App subscribed to the "comments" field
  ✓ Your account subscribed to the app

Config
  Keywords: GUIDE · mode: allowlist · posts allowed: 0
! No posts allowed yet, so nothing will fire. Add one: npm run admin -- allow 1
```

> **Why not read the ID automatically?** Meta's `/me/assigned_instagram_accounts` often comes back **empty** for this kind of token, even when it can act on your account. Reading the ID from Business Settings is the reliable way.

---

## Part E: Go Live

Comment webhooks only reach the app once it's **Live**.

1. **Testing** (left menu) lists the permissions that need one successful API call each. `npm run admin -- check` and `npm run admin -- posts` already make the calls that count.
   - If **`ads_read` / `ads_management`** are listed, remove them. The tool doesn't need them. Go to Use cases → Customize → your configuration → **Edit permissions**.
   - The ticks can take **up to 24 hours** to show up.
2. **Publish** (left menu) → Publish. The sidebar should say **Published**.

You don't need **"Become a Tech Provider"** or App Review. Those are for apps that act on *other people's* accounts. Standard Access covers your own.

---

## Part F: Switch on your first post

```bash
npm run admin -- posts          # numbered list, newest first. 'trial?' = reel not shared to feed
npm run admin -- allow 1        # switch on post 1: new comments fire from now on
npm run admin -- preview        # older comments waiting on it? (sends nothing)
npm run admin -- backfill       # answer them, after you confirm
```

**Test it properly.** Comment your keyword from a **second account** (not one with a role on the app) and watch:

```bash
npm run admin -- logs
```

You should see `webhook`, then `dm_sent`, then `ack_sent` within a few seconds. Comments from your own account never fire; that's the self filter working. To check a spelling without commenting, use `npm run admin -- try "guidee pls"`.

**Running another comment-to-DM tool at the same time?** Don't switch on a post that the other tool also handles. Instagram allows one private reply per comment, so whichever tool replies first wins and the other errors. `preview` and `backfill` also skip comments you've already replied to publicly, so a backfill won't double-message anyone the other tool already handled.

When you're confident, go wide:

```bash
npm run admin -- config pull
# set "mode": "all", list posts to leave alone in "exclude_media_ids"
npm run admin -- config push
```

## Updating

```bash
git pull
npm run deploy
```

Your `wrangler.toml`, keys, config, token and history are all kept.
