// /api/* — the dashboard's JSON API (contract: docs/API.md).
// Auth: an HMAC-signed session cookie from POST /api/login, or `Authorization: Bearer <ADMIN_KEY>`.
import { graph, getConfig, ledger, poll, matchRule, newBudget, _resetCaches, log } from "./core.js";
import { normalizeConfig, normalizeAutomation, validateAutomation, applyEdit, runsOn } from "./automations.js";
import { alertChannels, notify } from "./alerts.js";

const SESSION_DAYS = 30;
const CSRF_HEADER = "x-requested-with";
const CSRF_VALUE = "ig-comment-dm";
const enc = new TextEncoder();

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const fail = (status, error) => json({ error }, status);
const v = (env) => env.API_VERSION || "v27.0";

// ---------- auth ----------

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function same(a, b) { // constant-time via digests
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest("SHA-256", enc.encode(String(s)))));
  const u = new Uint8Array(x), w = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < u.length; i++) d |= u[i] ^ w[i];
  return d === 0;
}
const cookie = (req, name) => (req.headers.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);

async function makeSession(env) {
  const exp = Date.now() + SESSION_DAYS * 86_400_000;
  return `${exp}.${await hmac(env.ADMIN_KEY, `sid:${exp}`)}`;
}
async function validSession(env, sid) {
  const [exp, sig] = String(sid ?? "").split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return same(sig, await hmac(env.ADMIN_KEY, `sid:${exp}`));
}
async function authed(req, env) {
  if (!env.ADMIN_KEY) return { ok: false };
  const bearer = req.headers.get("authorization");
  if (bearer && (await same(bearer, `Bearer ${env.ADMIN_KEY}`))) return { ok: true, via: "bearer" };
  if (await validSession(env, cookie(req, "sid"))) return { ok: true, via: "cookie" };
  return { ok: false };
}
const sessionCookie = (value, maxAge) => `sid=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

// ---------- config helpers ----------

async function saveConfig(env, cfg) {
  await env.KV.put("config", JSON.stringify(normalizeConfig(cfg)));
  _resetCaches();
}
async function readBody(req) {
  try { return await req.json(); } catch { return null; }
}
const EDITABLE = ["name", "enabled", "keyword", "aliases", "match", "dm", "link", "ack", "like", "follow_gate", "opener", "opener_button", "gate_text", "gate_button", "all_posts", "media_ids"];
const pick = (o) => Object.fromEntries(EDITABLE.filter((k) => o && k in o).map((k) => [k, o[k]]));

function withStats(a, stats) {
  const s = stats.by[a.id] ?? { sent: 0, failed: 0, pending: 0, last_sent_at: null };
  const legacy = stats.by[`kw:${a.keyword}`]; // records from before automations had ids
  const sum = legacy && a.id === `a_${a.keyword.toLowerCase().replace(/[^a-z0-9]+/g, "")}`
    ? { sent: s.sent + legacy.sent, failed: s.failed + legacy.failed, pending: s.pending + legacy.pending, last_sent_at: Math.max(s.last_sent_at ?? 0, legacy.last_sent_at ?? 0) || null }
    : s;
  const { allowed_at, all_posts_since, ...pub } = a;
  return { ...pub, stats: { ...sum, last_sent_at: sum.last_sent_at ? new Date(sum.last_sent_at).toISOString() : null } };
}

// ---------- health (shared with the overview) ----------

async function health(env, origin) {
  const h = { ok: false, token: false, account: false, account_error: null, webhook_callback: false, webhook_comments: false, account_subscribed: false };
  h.token = Boolean((await env.KV.get("token", "json").catch(() => null))?.access_token ?? env.IG_TOKEN);
  let account = null;
  if (h.token && env.IG_ID) {
    const r = await graph(env, "GET", String(env.IG_ID), { query: { fields: "id,username,name,profile_picture_url,followers_count" } });
    h.account = r.ok;
    h.account_error = r.ok ? null : r.error;
    if (r.ok) account = { id: r.data.id, username: r.data.username, name: r.data.name ?? null, picture: r.data.profile_picture_url ?? null, followers: r.data.followers_count ?? null };
    const s = await graph(env, "GET", `${env.IG_ID}/subscribed_apps`);
    h.account_subscribed = s.ok && (s.data.data ?? []).some((a) => String(a.app_id) === String(env.APP_ID) && (a.subscribed_fields ?? []).includes("comments"));
  } else if (!env.IG_ID) h.account_error = "Instagram account ID isn't set (npm run admin -- set-ig-id).";
  else h.account_error = "Instagram isn't connected yet.";
  if (env.APP_ID && env.APP_SECRET) {
    const u = new URL(`https://graph.facebook.com/${v(env)}/${env.APP_ID}/subscriptions`);
    u.searchParams.set("access_token", `${env.APP_ID}|${env.APP_SECRET}`);
    const a = await fetch(u).then((r) => r.json()).catch(() => ({}));
    const ig = (a.data ?? []).find((x) => x.object === "instagram");
    h.webhook_callback = Boolean(ig?.active && ig?.callback_url === `${origin}/webhook`);
    h.webhook_comments = Boolean(ig?.fields?.some((f) => f.name === "comments"));
  }
  h.ok = h.token && h.account && h.webhook_callback && h.webhook_comments && h.account_subscribed;
  return { health: h, account };
}

async function connectLink(env, origin) {
  const state = crypto.randomUUID();
  await env.KV.put(`oauth_state:${state}`, "1", { expirationTtl: 900 });
  const u = new URL(`https://www.facebook.com/${v(env)}/dialog/oauth`);
  for (const [k, val] of Object.entries({
    client_id: env.APP_ID, config_id: env.LOGIN_CONFIG_ID, redirect_uri: `${origin}/auth/callback`,
    response_type: "code", override_default_response_type: "true", state,
  })) u.searchParams.set(k, val);
  return u.toString();
}

// ---------- router ----------

export async function api(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (method === "POST" && path === "/api/login") {
    const body = await readBody(request);
    if (!env.ADMIN_KEY || !body?.key || !(await same(body.key, env.ADMIN_KEY))) {
      log("login_failed");
      return fail(401, "That key doesn't match ADMIN_KEY.");
    }
    return json({ ok: true }, 200, { "set-cookie": sessionCookie(await makeSession(env), SESSION_DAYS * 86_400) });
  }
  if (method === "POST" && path === "/api/logout") return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });

  const auth = await authed(request, env);
  if (!auth.ok) return fail(401, "Not logged in.");
  if (method !== "GET" && auth.via === "cookie" && request.headers.get(CSRF_HEADER) !== CSRF_VALUE) return fail(403, "Missing request header.");

  const cfg = await getConfig(env);
  const call = ledger(env);
  const seg = path.split("/").filter(Boolean); // ["api", ...]

  // GET /api/overview
  if (method === "GET" && path === "/api/overview") {
    const [{ health: h, account }, stats] = await Promise.all([health(env, url.origin), call("stats")]);
    return json({
      account, health: h,
      totals: { automations: cfg.automations.length, active: cfg.automations.filter((a) => a.enabled).length, ...stats.totals, sent_total: stats.totals.sent },
      settings: { dry_run: cfg.dry_run, exclude_media_ids: cfg.exclude_media_ids },
      alerts: alertChannels(env),
    });
  }

  // /api/automations…
  if (seg[1] === "automations") {
    const id = seg[2];
    if (method === "GET" && !id) {
      const stats = await call("stats");
      return json({ automations: cfg.automations.map((a) => withStats(a, stats)) });
    }
    if (method === "POST" && id === "reorder") {
      const body = await readBody(request);
      const order = Array.isArray(body?.ids) ? body.ids.map(String) : [];
      const rank = (a) => { const i = order.indexOf(a.id); return i === -1 ? Infinity : i; };
      await saveConfig(env, { ...cfg, automations: [...cfg.automations].sort((a, b) => rank(a) - rank(b)) });
      return json({ ok: true });
    }
    if (method === "POST" && !id) {
      const next = applyEdit(null, { enabled: true, match: "fuzzy", ...pick(await readBody(request)) });
      const err = validateAutomation(next, cfg.automations);
      if (err) return fail(400, err);
      await saveConfig(env, { ...cfg, automations: [...cfg.automations, next] });
      return json({ automation: withStats(next, await call("stats")) });
    }
    const current = cfg.automations.find((a) => a.id === id);
    if (id && !current) return fail(404, "That automation doesn't exist.");

    if (method === "PUT" && id && !seg[3]) {
      const next = applyEdit(current, pick(await readBody(request)));
      const err = validateAutomation(next, cfg.automations.filter((a) => a.id !== id));
      if (err) return fail(400, err);
      await saveConfig(env, { ...cfg, automations: cfg.automations.map((a) => (a.id === id ? next : a)) });
      return json({ automation: withStats(next, await call("stats")) });
    }
    if (method === "DELETE" && id && !seg[3]) {
      await saveConfig(env, { ...cfg, automations: cfg.automations.filter((a) => a.id !== id) });
      return json({ ok: true });
    }
    if (method === "GET" && seg[3] === "waiting") {
      const r = await poll(env, { full: true, dryRun: true, backfill: true, onlyAutomation: id });
      return json({
        comments: r.results.filter((x) => x.result === "dry_run")
          .map((x) => ({ comment_id: x.id, user: x.user, text: x.text, media_id: x.mediaId, timestamp: x.timestamp })),
      });
    }
    if (method === "POST" && seg[3] === "send-waiting") {
      if (cfg.dry_run) return fail(409, "Preview mode is on, so nothing can be sent. Turn it off in Settings first.");
      const body = await readBody(request);
      const only = Array.isArray(body?.comment_ids) && body.comment_ids.length ? body.comment_ids.map(String) : null;
      const r = await poll(env, { full: true, backfill: true, onlyAutomation: id, onlyComments: only, budget: newBudget(env) });
      const results = r.results.map((x) => ({ comment_id: x.id, result: x.result, note: x.note ?? x.error ?? null }));
      return json({
        sent: results.filter((x) => x.result === "done" || x.result === "done_noack").length,
        queued: results.filter((x) => x.result === "queued" || x.result === "retry").length,
        failed: results.filter((x) => x.result === "failed").length,
        results,
      });
    }
  }

  // GET /api/posts
  if (method === "GET" && path === "/api/posts") {
    if (!env.IG_ID) return fail(409, "Instagram account ID isn't set yet.");
    const query = {
      fields: "id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp,comments_count,is_shared_to_feed",
      limit: String(Math.min(Number(url.searchParams.get("limit")) || 24, 50)),
    };
    if (url.searchParams.get("after")) query.after = url.searchParams.get("after");
    const r = await graph(env, "GET", `${env.IG_ID}/media`, { query });
    if (!r.ok) return fail(502, `Instagram: ${r.error}`);
    return json({
      posts: (r.data.data ?? []).map((m) => ({
        id: m.id, caption: m.caption ?? "", media_type: m.media_type, product_type: m.media_product_type,
        thumbnail: m.thumbnail_url ?? (m.media_type === "IMAGE" || m.media_type === "CAROUSEL_ALBUM" ? m.media_url : null) ?? null,
        permalink: m.permalink, timestamp: m.timestamp, comments_count: m.comments_count ?? 0,
        trial: m.media_product_type === "REELS" && m.is_shared_to_feed === false,
        automation_ids: cfg.automations.filter((a) => runsOn(a, m.id, cfg)).map((a) => a.id),
      })),
      next: r.data.paging?.next ? r.data.paging?.cursors?.after ?? null : null,
    });
  }

  // POST /api/try
  if (method === "POST" && path === "/api/try") {
    const body = await readBody(request);
    const text = String(body?.text ?? "").slice(0, 500);
    const pool = cfg.automations.filter((a) => a.enabled && (!body?.media_id || runsOn(a, body.media_id, cfg)));
    const m = text ? matchRule(text, pool) : null;
    return json({ match: m ? { automation_id: m.id, name: m.name, keyword: m.keyword, mode: m.match } : null });
  }

  // GET /api/activity
  if (method === "GET" && path === "/api/activity") {
    const r = await call("activity", { limit: url.searchParams.get("limit") ?? 50 });
    const names = Object.fromEntries(cfg.automations.map((a) => [a.id, a.name]));
    const byKw = Object.fromEntries(cfg.automations.map((a) => [a.keyword, a]));
    return json({
      items: r.items.map((i) => {
        const a = i.automation_id ? null : byKw[i.keyword];
        return { ...i, automation_id: i.automation_id ?? a?.id ?? null, automation_name: names[i.automation_id] ?? i.automation_name ?? a?.name ?? i.keyword };
      }),
    });
  }

  if (method === "POST" && path === "/api/alerts/test") {
    const ch = alertChannels(env);
    if (!ch.webhook) return fail(409, "No alert webhook is set up. Run: npm run admin -- alerts webhook <url>");
    const sent = await notify(env, { title: "Test alert", message: "Alerts from ig-comment-dm reach you here." });
    return json({ sent: sent.filter((s) => s.ok).length, channels: sent });
  }

  if (method === "POST" && path === "/api/reconnect") {
    if (!env.APP_ID || !env.LOGIN_CONFIG_ID) return fail(409, "APP_ID and LOGIN_CONFIG_ID must be set in wrangler.toml.");
    return json({ link: await connectLink(env, url.origin) });
  }

  if (method === "PUT" && path === "/api/settings") {
    const body = (await readBody(request)) ?? {};
    const next = { ...cfg };
    if ("dry_run" in body) next.dry_run = body.dry_run === true;
    if ("exclude_media_ids" in body) next.exclude_media_ids = body.exclude_media_ids;
    await saveConfig(env, next);
    const saved = normalizeConfig(next);
    return json({ settings: { dry_run: saved.dry_run, exclude_media_ids: saved.exclude_media_ids } });
  }

  return fail(404, "Not found.");
}

export { normalizeAutomation }; // re-exported for tests
