// Worker entry: webhook, OAuth callback, public pages, admin API, and cron.
import { extractPostbacks, handlePostback } from "./gate.js";
import { handshake, verifySignature, extractComments, ingest, poll, sweepPending, refreshToken, graph, ledger, log, newBudget, _resetCaches } from "./core.js";
import { admin } from "./admin.js";
import { api } from "./api.js";
import { watch } from "./alerts.js";
import APP_HTML from "./app/app.html";

const APP_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
    "connect-src 'self'; base-uri 'none'; " +
    "form-action 'self'; manifest-src 'self'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};
import { page, esc, privacyPage, dataDeletionPage } from "./pages.js";
export { Ledger } from "./ledger.js";
import { ICONS } from "./app/icons.js";

// Home-screen install: open full screen from an app icon on iOS and Android.
const MANIFEST = JSON.stringify({
  name: "ig-comment-dm", short_name: "Comment DM", start_url: "/app", scope: "/app", display: "standalone",
  background_color: "#F7F7F8", theme_color: "#FFFFFF",
  icons: [
    { src: "/app/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
    { src: "/app/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
});
const b64bytes = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));

async function authCallback(env, url) {
  const state = url.searchParams.get("state");
  const purpose = state ? await env.KV.get(`oauth_state:${state}`) : null; // "1" = main connection, "like" = like-only
  if (!purpose)
    return page("Link expired", "<p>Create a fresh link with <code>npm run admin -- connect</code>.</p>", 400);
  await env.KV.delete(`oauth_state:${state}`);

  const code = url.searchParams.get("code");
  if (!code) return page("Not connected", `<p>${esc(url.searchParams.get("error_description") ?? "No code returned.")}</p>`, 400);

  const t = new URL(`https://graph.facebook.com/${env.API_VERSION || "v27.0"}/oauth/access_token`);
  t.searchParams.set("client_id", env.APP_ID);
  t.searchParams.set("client_secret", env.APP_SECRET);
  t.searchParams.set("redirect_uri", `${url.origin}/auth/callback`);
  t.searchParams.set("code", code);
  const res = await fetch(t);
  const data = await res.json().catch(() => ({}));
  if (!data.access_token) {
    log("oauth_exchange_failed", { status: res.status, error: data.error?.message });
    return page("Not connected", `<p>Token exchange failed: ${esc(data.error?.message ?? res.status)}</p>`, 502);
  }
  if (purpose === "like") return likeConnected(env, data.access_token);
  // The token is stored server-side only; it is never shown in the browser or logs.
  await env.KV.put("token", JSON.stringify({ access_token: data.access_token, kind: "system_user", obtained_at: Date.now() }));
  _resetCaches();
  log("oauth_connected");

  // /me/assigned_instagram_accounts is often empty even when access works, so check IG_ID directly when known.
  let detail = "<p>Next: find your Instagram account ID (Business Settings → Accounts → Instagram accounts) and run <code>npm run admin -- set-ig-id &lt;id&gt;</code>.</p>";
  if (env.IG_ID) {
    const me = await graph(env, "GET", String(env.IG_ID), { query: { fields: "id,username" } });
    detail = me.ok
      ? `<p>This Worker can act as <b>@${esc(me.data.username)}</b> (id <code>${esc(me.data.id)}</code>). Next: <code>npm run admin -- check</code>.</p>`
      : `<p>Token saved, but it can't reach account <code>${esc(env.IG_ID)}</code> yet: ${esc(me.error)}. Make sure you selected that Instagram account on the login screen.</p>`;
  }
  return page("Connected ✅", detail);
}

async function likeConnected(env, token) {
  await env.KV.put("like_token", JSON.stringify({ access_token: token, obtained_at: Date.now() }));
  _resetCaches();
  log("oauth_like_connected");
  const perms = await graph(env, "GET", "me/permissions", { token });
  const granted = perms.ok ? perms.data.data.filter((p) => p.status === "granted").map((p) => p.permission) : [];
  return granted.includes("instagram_manage_engagement")
    ? page("Liking connected ✅", "<p>Matched comments will now get a like from your account. Your DM connection wasn't changed.</p>")
    : page("Connected, but liking isn't allowed", `<p>This login didn't grant <code>instagram_manage_engagement</code>${perms.ok ? "" : ` (${esc(perms.error)})`}. Check the likes configuration in Meta and connect again.</p>`, 400);
}

// Alerts link to the dashboard; the cron has no request URL, so remember it (KV write only on change).
let originSeen = null;
async function rememberOrigin(env, origin) {
  if (originSeen === origin) return;
  if ((await env.KV.get("origin").catch(() => null)) !== origin) await env.KV.put("origin", origin);
  originSeen = origin;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/") return Response.redirect(`${url.origin}/app`, 302);
    if (url.pathname === "/app" || url.pathname === "/app/") {
      ctx.waitUntil(rememberOrigin(env, url.origin));
      return new Response(APP_HTML, { headers: APP_HEADERS });
    }
    if (url.pathname === "/app/manifest.webmanifest")
      return new Response(MANIFEST, { headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=86400" } });
    if (url.pathname.startsWith("/app/icons/")) {
      const b = ICONS[url.pathname.slice("/app/icons/".length)];
      return b ? new Response(b64bytes(b), { headers: { "content-type": "image/png", "cache-control": "public, max-age=604800" } }) : new Response("Not found", { status: 404 });
    }
    if (url.pathname.startsWith("/api/")) {
      try {
        return await api(request, env, url);
      } catch (e) {
        log("api_error", { path: url.pathname, error: String(e?.message ?? e) });
        return Response.json({ error: String(e?.message ?? e) }, { status: 500, headers: { "cache-control": "no-store" } });
      }
    }
    if (url.pathname.startsWith("/admin/")) {
      try {
        return await admin(request, env, url);
      } catch (e) {
        return Response.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
      }
    }
    if (url.pathname === "/auth/callback") return authCallback(env, url);
    if (url.pathname === "/privacy") return privacyPage(env);
    if (url.pathname === "/data-deletion") return dataDeletionPage(env);
    if (url.pathname !== "/webhook") return new Response("Not found", { status: 404 });

    if (request.method === "GET") return handshake(url, env.VERIFY_TOKEN);
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

    const raw = await request.arrayBuffer();
    const matched = await verifySignature(raw, request.headers.get("x-hub-signature-256"), {
      meta_app_secret: env.APP_SECRET,
      ig_app_secret: env.IG_APP_SECRET, // only for the legacy Instagram-Login route
    });
    if (!matched) {
      log("bad_signature");
      return new Response("bad signature", { status: 401 });
    }
    let payload;
    try { payload = JSON.parse(new TextDecoder().decode(raw)); } catch { return new Response("bad json", { status: 400 }); }

    const comments = extractComments(payload);
    log("webhook", { secret: matched, comments: comments.length, object: payload.object });
    // Answer 200 immediately; enqueue + send run after the response.
    // If the isolate dies mid-way, the 5-minute sweep retries queued items and the poll re-finds missed comments.
    if (comments.length) ctx.waitUntil(ingest(comments, env).catch((e) => log("ingest_error", { error: String(e) })));
    for (const pb of extractPostbacks(payload, env.IG_ID)) ctx.waitUntil(handlePostback(env, pb).catch((e) => log("postback_error", { error: String(e) })));
    return new Response("EVENT_RECEIVED");
  },

  async scheduled(event, env, ctx) {
    const daily = event.cron === env.DAILY_CRON;
    const run = async () => {
      const budget = newBudget(env); // one send budget shared by the retry sweep and the poll
      await sweepPending(env, { budget });
      await poll(env, { full: daily, budget });
      if (daily) {
        await refreshToken(env); // system-user token: health check; ig_login token: refresh when < 20 days left
        await ledger(env)("prune");
      }
      await watch(env); // alerts on access down / back / failed DMs (no-op without an alert channel)
    };
    ctx.waitUntil(run().catch((e) => log("cron_error", { cron: event.cron, error: String(e) })));
  },
};
