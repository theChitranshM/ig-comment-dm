// Pure-ish logic, importable from Node tests (no cloudflare:* imports).
import defaultConfig from "./config.js";
import { normalizeConfig, runsOn, coveredSince } from "./automations.js";

const enc = new TextEncoder();
const DAY = 86_400_000;
export const REPLY_WINDOW_MS = 7 * DAY;

export const log = (event, data = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));

// ---------- webhook handshake + signature ----------

export function handshake(url, verifyToken) {
  const p = url.searchParams;
  if (
    p.get("hub.mode") === "subscribe" &&
    typeof verifyToken === "string" &&
    verifyToken.length > 0 &&
    p.get("hub.verify_token") === verifyToken
  ) {
    return new Response(p.get("hub.challenge") ?? "", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }
  return new Response("forbidden", { status: 403 });
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

// Returns the name of the secret that matched, or null. Meta's docs are ambiguous
// about which secret signs IG-Login webhooks, so both are accepted and the match is logged.
export async function verifySignature(rawBody, header, secrets) {
  if (!header) return null;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) return null;
  const sig = hexToBytes(m[1]);
  for (const [name, secret] of Object.entries(secrets)) {
    if (!secret) continue;
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
    );
    if (await crypto.subtle.verify("HMAC", key, sig, rawBody)) return name; // constant-time
  }
  return null;
}

// ---------- payload parsing ----------

function toComment(v, accountId, source) {
  const id = v?.id ?? v?.comment_id;
  if (id == null || typeof v.text !== "string") return null;
  return {
    commentId: String(id),
    fromId: v.from?.id != null ? String(v.from.id) : null,
    fromUsername: v.from?.username ?? v.username ?? null,
    text: v.text,
    mediaId: v.media?.id != null ? String(v.media.id) : v.mediaId ?? null,
    mediaType: v.media?.media_product_type ?? null,
    parentId: v.parent_id ?? null,
    timestamp: v.timestamp ?? null,
    replyUsers: (v.replies?.data ?? []).map((r) => (r.username ?? "").toLowerCase()),
    accountId: accountId != null ? String(accountId) : null,
    source,
  };
}

// Accepts both shapes Meta documents: entry[].changes[].{field,value} and flat entry[].{field,value}.
export function extractComments(payload) {
  const out = [];
  for (const entry of payload?.entry ?? []) {
    const values = [];
    for (const c of entry?.changes ?? []) if (c?.field === "comments" && c.value) values.push(c.value);
    if (entry?.value && (entry.field == null || entry.field === "comments")) values.push(entry.value);
    for (const v of values) {
      const c = toComment(v, entry.id, "webhook");
      if (c) out.push(c);
    }
  }
  return out;
}

// ---------- matching ----------

export const normalize = (s) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const exactHit = (t, kw) => {
  const k = escapeRe(normalize(kw)).replace(/ /g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${k}(?![\\p{L}\\p{N}])`, "u").test(t);
};

// ---- fuzzy: accents ignored, stretched letters squeezed, small typos allowed on longer keywords ----
const fold = (s) => s.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
const squeeze = (s) => s.replace(/(.)\1+/gu, "$1"); // "diwaaaliii" → "diwali" (applied to both sides)
const words = (s) => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
export const typoBudget = (len) => (len >= 9 ? 2 : len >= 5 ? 1 : 0); // short keywords ("eye", "orb") never get typos

// Optimal-string-alignment distance (insert, delete, substitute, swap adjacent), early exit past `max`.
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = [], prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2] + 1);
      cur[j] = d;
      rowMin = Math.min(rowMin, d);
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

export function fuzzyHit(text, kw) {
  const kwWords = words(kw);
  if (!kwWords.length) return false;
  const target = squeeze(kwWords.join(""));
  const max = typoBudget(target.length);
  // Also try one extra word ("di wali") and glued single letters ("d i w a l i").
  const raw = words(text);
  const glued = raw.join(" ").replace(/\b(?:\p{L} )+\p{L}\b/gu, (m) => m.replace(/ /g, "")).split(" ");
  const hit = (w) => w === target || (max && editDistance(w, target, max) <= max);
  for (const t of [raw, glued]) {
    for (const n of max ? [kwWords.length, kwWords.length + 1] : [kwWords.length]) { // short keywords: no word-gap joins ("a or b" ≠ ORB)
      for (let i = 0; i + n <= t.length; i++) if (hit(squeeze(t.slice(i, i + n).join("")))) return true;
    }
  }
  return false;
}

// Rules match case-insensitively and must stand alone ("diwali pls" ✓, "#diwali" ✓, "misguided" ✗ for GUIDE).
// rule.match: "fuzzy" (default) also forgives accents, stretched letters and small typos · "exact" doesn't.
// An exact hit on any rule beats a fuzzy hit on an earlier one.
export function matchRule(text, rules) {
  const t = normalize(text);
  const live = (rules ?? []).filter((r) => r.enabled !== false);
  const kws = (r) => [r.keyword, ...(r.aliases ?? [])].filter(Boolean);
  for (const r of live) if (kws(r).some((kw) => exactHit(t, kw))) return r;
  for (const r of live) if ((r.match ?? "fuzzy") === "fuzzy" && kws(r).some((kw) => fuzzyHit(text, kw))) return r;
  return null;
}

export const dmText = (rule) => (rule.link ? `${rule.dm}\n${rule.link}` : rule.dm);

// ---------- config + token (KV) ----------

let configCache = null;
export async function getConfig(env) {
  if (configCache && configCache.until > Date.now()) return configCache.value;
  const kv = await env.KV.get("config", "json").catch(() => null);
  const value = normalizeConfig(kv ?? defaultConfig); // v1 rules are migrated on read
  configCache = { value, until: Date.now() + 60_000 };
  return value;
}
export const _resetCaches = () => { configCache = null; tokenCache = null; };

let tokenCache = null;
export async function getToken(env) {
  if (tokenCache && tokenCache.until > Date.now()) return tokenCache.value;
  const rec = await env.KV.get("token", "json").catch(() => null);
  const value = rec?.access_token ?? env.IG_TOKEN;
  if (!value) throw new Error("no access token: set secret IG_TOKEN or KV token");
  tokenCache = { value, until: Date.now() + 300_000 };
  return value;
}

const REFRESH_BEFORE_DAYS = 20;
// Unified login (default): the system-user token never expires, so the daily job is a
// health check that logs loudly if the token was revoked. TOKEN_KIND="ig_login" keeps
// the 60-day refresh path for the Instagram-Login route.
export async function refreshToken(env, opts = {}) {
  if (env.TOKEN_KIND !== "ig_login") {
    // Check access to the account itself — /me/assigned_instagram_accounts can be empty
    // even when the system user can act on the account (seen live, Nov 2026).
    const r = await graph(env, "GET", String(env.IG_ID), { query: { fields: "id,username" } });
    const ok = r.ok && String(r.data?.id) === String(env.IG_ID);
    log(ok ? "token_healthy" : "token_unhealthy", { status: r.status, error: r.error });
    return { ok, kind: "system_user", expires: "never", account: r.data ?? null, error: r.error };
  }
  return refreshIgLoginToken(env, opts);
}

async function refreshIgLoginToken(env, { force = false } = {}) {
  const now = Date.now();
  const rec = (await env.KV.get("token", "json")) ?? (env.IG_TOKEN ? { access_token: env.IG_TOKEN } : null);
  if (!rec) return { ok: false, reason: "no_token" };
  const daysLeft = rec.expires_at ? (rec.expires_at - now) / DAY : null;
  // Unknown expiry (seed from secret) → try daily until one refresh succeeds and pins the date.
  if (!force && daysLeft != null && daysLeft > REFRESH_BEFORE_DAYS) return { ok: true, skipped: true, daysLeft };
  const url = new URL("https://graph.instagram.com/refresh_access_token");
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", rec.access_token);
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    log("token_refresh_failed", { status: res.status, error: data.error?.message, daysLeft });
    return { ok: false, status: res.status, error: data.error?.message, daysLeft };
  }
  const next = { access_token: data.access_token, expires_at: now + (data.expires_in ?? 5_184_000) * 1000, refreshed_at: now };
  await env.KV.put("token", JSON.stringify(next));
  tokenCache = null;
  log("token_refreshed", { daysLeft: Math.round((next.expires_at - now) / DAY) });
  return { ok: true, daysLeft: (next.expires_at - now) / DAY };
}

// ---------- Graph API ----------

const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);
export async function graph(env, method, path, { query, body } = {}) {
  const url = new URL(`https://${env.GRAPH_HOST || "graph.facebook.com"}/${env.API_VERSION || "v27.0"}/${path}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const init = { method, headers: { authorization: `Bearer ${await getToken(env)}` } };
  if (body) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res, data;
  try {
    res = await fetch(url, init);
    data = await res.json().catch(() => ({}));
  } catch (e) {
    return { ok: false, transient: true, status: 0, error: String(e) };
  }
  if (res.ok && !data.error) return { ok: true, status: res.status, data };
  const err = data.error ?? {};
  const transient = res.status >= 500 || res.status === 429 || err.is_transient === true || TRANSIENT_CODES.has(err.code);
  return { ok: false, transient, status: res.status, code: err.code, error: err.message ?? `HTTP ${res.status}` };
}

// ---------- ledger (Durable Object) client ----------

export function ledger(env) {
  const stub = env.LEDGER.get(env.LEDGER.idFromName("ledger"));
  return async (op, args = {}) => {
    const res = await stub.fetch("https://ledger/", {
      method: "POST",
      body: JSON.stringify({ op, now: Date.now(), ...args }),
    });
    if (!res.ok) throw new Error(`ledger ${op} ${res.status}`);
    return res.json();
  };
}

// ---------- the decision: should this comment fire? ----------

export function classify(c, config, env, { backfill = false, onlyAutomation = null } = {}) {
  const selfIds = [env.IG_ID, c.accountId].filter(Boolean).map(String);
  if (!c.fromId && !c.fromUsername) return { action: "skip", reason: "no_sender" };
  if (c.fromId && selfIds.includes(c.fromId)) return { action: "skip", reason: "self" };
  if (env.IG_USERNAME && c.fromUsername && c.fromUsername.toLowerCase() === env.IG_USERNAME.toLowerCase())
    return { action: "skip", reason: "self" };
  if (c.timestamp && Date.now() - Date.parse(c.timestamp) > REPLY_WINDOW_MS) return { action: "skip", reason: "outside_7d" };
  if (config.skip_comment_ids.includes(c.commentId)) return { action: "skip", reason: "skip_listed" };
  // Someone (another tool, or you by hand) already answered this comment publicly → treat as handled.
  if (env.IG_USERNAME && (c.replyUsers ?? []).includes(env.IG_USERNAME.toLowerCase())) return { action: "skip", reason: "already_replied" };
  if (c.mediaId && config.exclude_media_ids.includes(String(c.mediaId))) return { action: "skip", reason: "excluded_media" };

  let candidates = config.automations.filter((a) => runsOn(a, c.mediaId, config));
  if (onlyAutomation) candidates = candidates.filter((a) => a.id === onlyAutomation);
  if (!candidates.length) return { action: "skip", reason: "not_in_allowlist" };
  // Comments older than the moment a post was added only go out through an explicit backfill.
  const current = (a) => {
    const since = coveredSince(a, c.mediaId);
    return backfill || !since || !c.timestamp || Date.parse(c.timestamp) >= Date.parse(since);
  };
  const eligible = candidates.filter(current);
  const rule = matchRule(c.text, eligible);
  if (rule) return { action: "fire", rule };
  return { action: "skip", reason: matchRule(c.text, candidates) ? "before_allow" : "no_match" };
}

// ---------- processing ----------

// Free-plan Workers allow ~50 outbound calls per invocation; one send costs ~5 (ledger + DM + reply).
// Sends past the budget stay queued and go out on the next 5-minute sweep.
export const newBudget = (env) => ({ sends: Number(env.MAX_SENDS_PER_RUN || 5) });

// Enqueue matched comments in the ledger (atomic insert-if-absent), then process them.
export async function ingest(comments, env, { dryRun = false, backfill = false, onlyAutomation = null, onlyComments = null, budget = newBudget(env) } = {}) {
  const base = await getConfig(env);
  const config = dryRun ? { ...base, dry_run: true } : base;
  const call = ledger(env);
  const fire = [];
  for (const c of comments) {
    if (onlyComments && !onlyComments.includes(c.commentId)) continue;
    const d = classify(c, config, env, { backfill, onlyAutomation });
    if (d.action !== "fire") {
      if (c.source === "webhook") log("skip", { id: c.commentId, reason: d.reason }); // polls re-read old comments; logging those is noise
      continue;
    }
    fire.push({ ...c, keyword: d.rule.keyword, automationId: d.rule.id, automationName: d.rule.name });
  }
  // Drop comments the ledger already finished: they're not "waiting", and re-processing them
  // would only spend this run's send budget on dedupe no-ops. (In-flight ones are left to the sweep.)
  if (fire.length) {
    const { stages } = await call("lookup", { ids: fire.map((c) => c.commentId) });
    for (let i = fire.length - 1; i >= 0; i--) if (stages[fire[i].commentId]) fire.splice(i, 1);
  }
  // Dry run = preview only: nothing enqueued, nothing marked, so a later real run still sends.
  if (config.dry_run) {
    return fire.map((c) => {
      const rule = config.automations.find((a) => a.id === c.automationId);
      log("dry_run", { id: c.commentId, user: c.fromUsername, text: c.text, automation: rule.name });
      return {
        id: c.commentId, result: "dry_run", user: c.fromUsername, text: c.text, mediaId: c.mediaId, timestamp: c.timestamp,
        automationId: rule.id, automationName: rule.name, dm: dmText(rule), ack: rule.ack,
      };
    });
  }
  if (fire.length) await call("enqueue", { items: fire });
  const results = [];
  for (const c of fire) {
    if (budget.sends <= 0) { results.push({ id: c.commentId, result: "queued" }); continue; }
    budget.sends--;
    results.push(await processOne(c.commentId, env, config, call));
  }
  return results;
}

// Process one queued comment. The ledger's `begin` is the atomic gate: only one
// caller holds the lease, and the stored stage means a retry never re-sends a DM.
export async function processOne(commentId, env, config, call = ledger(env)) {
  config ??= await getConfig(env);
  if (config.dry_run) return { id: commentId, result: "dry_run_skipped" }; // never act on queued items while previewing
  const lease = await call("begin", { id: commentId });
  if (!lease.go) return { id: commentId, result: "dedupe", stage: lease.stage };
  const c = lease.item;
  // Older ledger items carry only the keyword; newer ones carry the automation id.
  const rule =
    config.automations.find((a) => a.id === c.automationId) ??
    (!c.automationId ? config.automations.find((a) => a.keyword === c.keyword) : undefined);
  if (!rule || rule.enabled === false) return finish(call, commentId, "failed", "automation removed or paused");

  if (lease.stage === "new") {
    const dm = await graph(env, "POST", `${env.IG_ID}/messages`, {
      body: { recipient: { comment_id: commentId }, message: { text: dmText(rule) } },
    });
    if (!dm.ok) {
      log("dm_failed", { id: commentId, status: dm.status, code: dm.code, error: dm.error, transient: dm.transient });
      return dm.transient ? release(call, commentId, dm.error) : finish(call, commentId, "failed", `dm: ${dm.error}`);
    }
    await call("advance", { id: commentId, stage: "dm_sent" });
    log("dm_sent", { id: commentId, keyword: rule.keyword, from: c.fromUsername });
  }

  if (!rule.ack) return finish(call, commentId, "done");
  const ack = await graph(env, "POST", `${commentId}/replies`, { body: { message: rule.ack } });
  if (!ack.ok) {
    log("ack_failed", { id: commentId, status: ack.status, error: ack.error, transient: ack.transient });
    return ack.transient ? release(call, commentId, ack.error) : finish(call, commentId, "done_noack", `ack: ${ack.error}`);
  }
  log("ack_sent", { id: commentId });
  return finish(call, commentId, "done");
}

async function finish(call, id, stage, note) {
  await call("advance", { id, stage, note });
  return { id, result: stage, note };
}
async function release(call, id, error) {
  const r = await call("release", { id, error });
  return { id, result: r.stage === "failed" ? "failed" : "retry", error };
}

// Retry anything queued but unfinished (lease expired).
export async function sweepPending(env, { budget = newBudget(env) } = {}) {
  const config = await getConfig(env);
  const call = ledger(env);
  const { ids } = await call("pending");
  const out = [];
  for (const id of ids) {
    if (budget.sends <= 0) { out.push({ id, result: "queued" }); continue; }
    budget.sends--;
    out.push(await processOne(id, env, config, call));
  }
  return out;
}

// ---------- polling backfill ----------

async function listComments(env, mediaId, maxPages) {
  const out = [];
  let after;
  for (let page = 0; page < maxPages; page++) {
    const r = await graph(env, "GET", `${mediaId}/comments`, {
      query: { fields: "id,text,timestamp,username,from,parent_id,replies{username}", limit: "50", ...(after ? { after } : {}) },
    });
    if (!r.ok) { log("poll_comments_failed", { mediaId, error: r.error }); break; }
    const rows = r.data.data ?? [];
    for (const v of rows) {
      const c = toComment({ ...v, mediaId }, env.IG_ID, "poll");
      if (c) out.push(c);
    }
    after = r.data.paging?.cursors?.after;
    // Newest first: once a page ends outside the 7-day window, stop.
    const last = rows.at(-1);
    if (!r.data.paging?.next || !after || (last && Date.now() - Date.parse(last.timestamp) > REPLY_WINDOW_MS)) break;
  }
  return out;
}

export async function poll(env, { full = false, dryRun = false, backfill = false, onlyAutomation = null, onlyComments = null, budget = newBudget(env) } = {}) {
  const config = await getConfig(env);
  const active = config.automations.filter((a) => a.enabled !== false && (!onlyAutomation || a.id === onlyAutomation));
  const mediaIds = new Set(active.flatMap((a) => a.media_ids));
  if (active.some((a) => a.all_posts)) {
    const limit = full ? Number(env.FULL_SWEEP_MEDIA || 8) : Number(env.POLL_RECENT_MEDIA || 4);
    const r = await graph(env, "GET", `${env.IG_ID}/media`, { query: { fields: "id,timestamp", limit: String(limit) } });
    if (r.ok) for (const m of r.data.data ?? []) mediaIds.add(String(m.id));
    else log("poll_media_failed", { error: r.error });
  }
  for (const id of config.exclude_media_ids) mediaIds.delete(id);
  let comments = [];
  for (const id of mediaIds) comments = comments.concat(await listComments(env, id, full ? 2 : 1));
  const results = await ingest(comments, env, { dryRun, backfill, onlyAutomation, onlyComments, budget });
  const summary = {
    full, dryRun, media: mediaIds.size, comments: comments.length,
    fired: results.filter((r) => r.result === "done").length,
    queued: results.filter((r) => r.result === "queued").length,
  };
  log("poll", summary);
  return { ...summary, results };
}
