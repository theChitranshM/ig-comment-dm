// Worker entry: webhook, OAuth callback, public pages, admin API, and cron.
import { handshake, verifySignature, extractComments, ingest, poll, sweepPending, refreshToken, graph, ledger, log, newBudget, _resetCaches } from "./core.js";
import { admin } from "./admin.js";
import { page, esc, privacyPage, dataDeletionPage } from "./pages.js";
export { Ledger } from "./ledger.js";

async function authCallback(env, url) {
  const state = url.searchParams.get("state");
  if (!state || !(await env.KV.get(`oauth_state:${state}`)))
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
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
    if (url.pathname !== "/webhook") return new Response("ok");

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
    };
    ctx.waitUntil(run().catch((e) => log("cron_error", { cron: event.cron, error: String(e) })));
  },
};
