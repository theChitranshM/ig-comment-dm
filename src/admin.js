// /admin/* — owner-only operations, guarded by `Authorization: Bearer <ADMIN_KEY>`.
// Driven by `npm run admin -- <command>` (scripts/admin.mjs); every route is also plain curl-able.
import { graph, getLikeToken, getConfig, ledger, poll, sweepPending, refreshToken, ingest, extractComments, _resetCaches } from "./core.js";
import { normalizeConfig, validateAutomation } from "./automations.js";

const json = (data, status = 200) => Response.json(data, { status });

// Constant-time comparison (hash both sides, then compare digests byte by byte).
async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map((v) => crypto.subtle.digest("SHA-256", enc.encode(v))));
  const u = new Uint8Array(x), w = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ w[i];
  return diff === 0;
}
const v = (env) => env.API_VERSION || "v27.0";
const appToken = (env) => `${env.APP_ID}|${env.APP_SECRET}`;

async function appSubscriptions(env) {
  const u = new URL(`https://graph.facebook.com/${v(env)}/${env.APP_ID}/subscriptions`);
  u.searchParams.set("access_token", appToken(env));
  return (await fetch(u)).json();
}

async function tokenInfo(env) {
  const kv = await env.KV.get("token", "json");
  if (env.TOKEN_KIND !== "ig_login") {
    return { kind: "system_user", expires: "never", source: kv ? "connect flow (KV)" : env.IG_TOKEN ? "IG_TOKEN secret" : "missing" };
  }
  if (!kv) return { kind: "ig_login", source: env.IG_TOKEN ? "IG_TOKEN secret (expiry unknown until first refresh)" : "missing" };
  return { kind: "ig_login", source: "KV", daysLeft: Math.round((kv.expires_at - Date.now()) / 86_400_000) };
}

// One call that answers "is everything wired up?" — used by `admin check`.
async function check(env, origin) {
  const out = {};
  out.token = await tokenInfo(env);
  out.account = env.IG_ID
    ? await graph(env, "GET", String(env.IG_ID), { query: { fields: "id,username" } })
    : { ok: false, error: "IG_ID not set — run: npm run admin -- set-ig-id <id>" };
  const perms = await graph(env, "GET", "me/permissions");
  const likeToken = await getLikeToken(env);
  if (likeToken) {
    const lp = await graph(env, "GET", "me/permissions", { token: likeToken });
    out.like_permissions = lp.ok ? lp.data.data.filter((p) => p.status === "granted").map((p) => p.permission) : lp.error;
  }
  out.permissions = perms.ok ? perms.data.data.filter((p) => p.status === "granted").map((p) => p.permission) : perms.error;
  if (env.IG_ID) {
    const s = await graph(env, "GET", `${env.IG_ID}/subscribed_apps`);
    const mine = s.ok ? (s.data.data ?? []).find((a) => String(a.app_id) === String(env.APP_ID)) : null;
    out.account_subscribed = Boolean(mine?.subscribed_fields?.includes("comments"));
    out.account_postbacks = Boolean(mine?.subscribed_fields?.includes("messaging_postbacks"));
  }
  if (env.APP_ID && env.APP_SECRET) {
    const a = await appSubscriptions(env);
    const ig = (a.data ?? []).find((x) => x.object === "instagram");
    out.app_webhook = {
      callback_ok: ig?.callback_url === `${origin}/webhook`,
      active: Boolean(ig?.active),
      comments_field: Boolean(ig?.fields?.some((f) => f.name === "comments")),
      postbacks_field: Boolean(ig?.fields?.some((f) => f.name === "messaging_postbacks")),
    };
  }
  const cfg = await getConfig(env);
  out.config = {
    automations: cfg.automations.map((a) => ({ name: a.name, keyword: a.keyword, enabled: a.enabled, posts: a.all_posts ? "all" : a.media_ids.length })),
    dry_run: cfg.dry_run,
  };
  return out;
}

export async function admin(request, env, url) {
  if (!env.ADMIN_KEY || !(await sameSecret(request.headers.get("authorization") ?? "", `Bearer ${env.ADMIN_KEY}`)))
    return json({ error: "unauthorized" }, 401);
  const q = url.searchParams;

  switch (`${request.method} ${url.pathname}`) {
    // ---- health ----
    case "GET /admin/status":
      return json({ ledger: await ledger(env)("status"), token: await tokenInfo(env), config: await getConfig(env) });
    case "GET /admin/check":
      return json(await check(env, url.origin));
    case "GET /admin/whoami":
      return json(await graph(env, "GET", String(env.IG_ID), { query: { fields: "id,username,followers_count" } }));
    case "GET /admin/account": // verify an IG account id before saving it as IG_ID
      return json(await graph(env, "GET", String(q.get("id")), { query: { fields: "id,username" } }));

    // ---- connect (Unified login / Facebook Login for Business) ----
    case "POST /admin/connect-link": {
      const forLikes = q.get("purpose") === "like";
      const configId = forLikes ? env.LIKE_CONFIG_ID : env.LOGIN_CONFIG_ID;
      if (!env.APP_ID || !configId) return json({ error: `APP_ID and ${forLikes ? "LIKE_CONFIG_ID" : "LOGIN_CONFIG_ID"} must be set in wrangler.toml` }, 400);
      const state = crypto.randomUUID();
      await env.KV.put(`oauth_state:${state}`, forLikes ? "like" : "1", { expirationTtl: 900 });
      const u = new URL(`https://www.facebook.com/${v(env)}/dialog/oauth`);
      u.searchParams.set("client_id", env.APP_ID);
      u.searchParams.set("config_id", configId);
      u.searchParams.set("redirect_uri", `${url.origin}/auth/callback`);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("override_default_response_type", "true");
      u.searchParams.set("state", state);
      return json({ link: u.toString(), redirect_uri: `${url.origin}/auth/callback`, expires_in_min: 15 });
    }

    // ---- webhook subscriptions ----
    case "POST /admin/subscribe": { // account → app (comments) and app → callback (comments field)
      if (!env.IG_ID) return json({ error: "IG_ID not set — run: npm run admin -- set-ig-id <id>" }, 400);
      const account = await graph(env, "POST", `${env.IG_ID}/subscribed_apps`, { query: { subscribed_fields: "comments,messaging_postbacks" } });
      const body = new URLSearchParams({
        object: "instagram", callback_url: `${url.origin}/webhook`, fields: "comments,messaging_postbacks",
        include_values: "true", verify_token: env.VERIFY_TOKEN, access_token: appToken(env),
      });
      const app = await (await fetch(`https://graph.facebook.com/${v(env)}/${env.APP_ID}/subscriptions`, { method: "POST", body })).json();
      return json({ account, app });
    }
    case "GET /admin/app-subscriptions":
      return json(await appSubscriptions(env));

    // ---- posts, polling, backfill ----
    case "GET /admin/media":
      return json(await graph(env, "GET", `${env.IG_ID}/media`, {
        query: { fields: "id,caption,media_product_type,timestamp,permalink,comments_count,is_shared_to_feed", limit: q.get("limit") ?? "20" },
      }));
    // ?full=1 sweeps the 7-day window · ?backfill=1 includes comments from before a post was switched on
    // ?dry=1 previews without sending or recording anything
    case "POST /admin/poll":
      return json(await poll(env, { full: q.get("full") === "1", dryRun: q.get("dry") === "1", backfill: q.get("backfill") === "1" }));
    case "POST /admin/sweep": // send anything still queued (the CLI calls this until the queue is empty)
      return json(await sweepPending(env));
    case "POST /admin/replay": // run a webhook payload through the same pipeline (minus signature) — dedupe testing
      return json(await ingest(extractComments(await request.json()), env));
    case "GET /admin/comment":
      return json(await ledger(env)("get", { id: q.get("id") }));

    // ---- config ----
    case "GET /admin/config":
      return json(await getConfig(env));
    case "PUT /admin/config": {
      const raw = await request.json().catch(() => null);
      if (!raw || (!Array.isArray(raw.automations) && !Array.isArray(raw.rules))) return json({ error: "config needs an automations[] list" }, 400);
      const cfg = normalizeConfig(raw);
      for (const a of cfg.automations) {
        const err = validateAutomation(a, cfg.automations.filter((o) => o.id !== a.id));
        if (err) return json({ error: `${a.name}: ${err}` }, 400);
      }
      await env.KV.put("config", JSON.stringify(cfg));
      _resetCaches();
      return json({ ok: true });
    }

    // ---- token ----
    case "POST /admin/refresh-token":
      return json(await refreshToken(env, { force: q.get("force") === "1" }));

    // ---- diagnostics + live testing ----
    case "POST /admin/like": // like (or ?undo=1 unlike) one comment with the like token, for testing
    case "DELETE /admin/like": {
      const id = q.get("comment_id");
      if (!/^\d{5,30}$/.test(id ?? "")) return json({ error: "comment_id required" }, 400);
      const token = (await getLikeToken(env)) ?? undefined;
      return json(await graph(env, request.method, `${env.IG_ID}/likes`, { body: { comment_id: id }, token }));
    }
    case "GET /admin/graph": { // read-only Graph GET: ?path=...&fields=...
      const query = Object.fromEntries([...q].filter(([k]) => k !== "path"));
      return json(await graph(env, "GET", q.get("path") ?? "me", { query }));
    }
    case "POST /admin/test-comment": { // comment as the account (self-comments never fire — proves the self filter)
      const b = await request.json();
      return json(await graph(env, "POST", `${b.media_id}/comments`, { body: { message: b.message } }));
    }
    case "DELETE /admin/test-comment":
      return json(await graph(env, "DELETE", String(q.get("id"))));
  }
  return json({ error: "not found" }, 404);
}
