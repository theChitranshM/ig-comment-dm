import { Ledger } from "../src/ledger.js";
import defaultConfig from "./fixture-config.js";
import { _resetCaches } from "../src/core.js";

export const IG_ID = "17841400000000001";
export const SECRETS = { APP_SECRET: "appsecret", IG_APP_SECRET: "igsecret" };
export { _resetCaches };

export function makeKV() {
  const m = new Map();
  return {
    _m: m,
    async get(key, type) {
      if (!m.has(key)) return null;
      const v = m.get(key);
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key, value) { m.set(key, String(value)); },
    async delete(key) { m.delete(key); },
  };
}

function makeStorage() {
  const m = new Map();
  return {
    _m: m,
    async get(k) { await Promise.resolve(); const v = m.get(k); return v === undefined ? undefined : structuredClone(v); },
    async put(k, v) { await Promise.resolve(); m.set(k, structuredClone(v)); },
    async delete(k) { await Promise.resolve(); return m.delete(k); },
    async list({ prefix = "" } = {}) {
      await Promise.resolve();
      const out = new Map();
      for (const [k, v] of m) if (k.startsWith(prefix)) out.set(k, structuredClone(v));
      return out;
    },
  };
}

// One shared Ledger. Requests are serialized (a mutex) to mimic a Durable Object's
// one-request-at-a-time execution; real DOs do this via input/output gates.
export function makeLedgerNS() {
  const storage = makeStorage();
  const ledger = new Ledger({ storage });
  let chain = Promise.resolve();
  const stub = {
    fetch(url, init) {
      const req = new Request(url, init);
      const p = chain.then(() => ledger.fetch(req));
      chain = p.catch(() => {});
      return p;
    },
  };
  return { idFromName: (n) => n, get: () => stub, _storage: storage };
}

export function makeCtx() {
  const promises = [];
  return {
    waitUntil(p) { promises.push(p); },
    async flush() {
      while (promises.length) await Promise.allSettled(promises.splice(0));
    },
  };
}

export function makeEnv(extra = {}) {
  return {
    KV: makeKV(),
    LEDGER: makeLedgerNS(),
    IG_ID,
    IG_USERNAME: "testuser",
    IG_TOKEN: "tok",
    APP_SECRET: "appsecret",
    IG_APP_SECRET: "igsecret",
    VERIFY_TOKEN: "vt",
    ADMIN_KEY: "adm",
    DAILY_CRON: "17 10 * * *",
    ...extra,
  };
}

export async function putConfig(env, overrides = {}) {
  const cfg = {
    rules: structuredClone(defaultConfig.rules),
    scope: { mode: "allowlist", media_ids: ["M1", "TRIAL1"] },
    dry_run: false,
    ...overrides,
  };
  await env.KV.put("config", JSON.stringify(cfg));
  _resetCaches();
  return cfg;
}

export async function sign(body, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return "sha256=" + [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function webhookReq(payload, { secret = "appsecret", header, rawBody } = {}) {
  const body = rawBody ?? JSON.stringify(payload);
  const h = { "content-type": "application/json" };
  const sig = header === undefined ? await sign(body, secret) : header;
  if (sig !== null) h["x-hub-signature-256"] = sig;
  return new Request("https://x/webhook", { method: "POST", headers: h, body });
}

// ---- payload builders ----
export function commentValue({ id = "C1", text = "DIWALI", fromId = "555", username = "someuser", media = "M1" } = {}) {
  return { id, text, from: { id: fromId, username }, media: { id: media, media_product_type: "REELS" } };
}
export function changesPayload(value, entryId = IG_ID) {
  return { object: "instagram", entry: [{ id: entryId, time: 1, changes: [{ field: "comments", value }] }] };
}

// ---- fake Graph API ----
export function installGraph() {
  const realFetch = globalThis.fetch;
  const calls = [];
  const queues = { dm: [], reply: [], like: [], profile: [], refresh: [], comments: [], media: [], accounts: [] };
  const g = {
    calls,
    comments: {},                // mediaId -> array of rows {id,text,timestamp,from}
    media: [],                   // rows for GET /<IG_ID>/media
    follows: {},                 // IGSID -> true if they follow the account
    refreshResponse: { access_token: "newtok", token_type: "bearer", expires_in: 5184000 },
    // push one-shot override responses: {status, body} or "throw"
    failNext(kind, ...resps) { queues[kind].push(...resps); },
    byKind(kind) { return calls.filter((c) => c.kind === kind); },
    get posts() { return calls.filter((c) => c.method === "POST"); },
    get dms() { return calls.filter((c) => c.kind === "dm"); },
    get replies() { return calls.filter((c) => c.kind === "reply"); },
    restore() { globalThis.fetch = realFetch; },
  };
  const R = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers ?? {});
    let body = null;
    if (init.body) { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    const path = url.pathname;
    let kind = "unknown";
    let m;
    if (method === "POST" && path === `/v27.0/${IG_ID}/messages`) kind = "dm";
    else if (method === "POST" && (m = /^\/v27\.0\/([^/]+)\/replies$/.exec(path))) kind = "reply";
    else if (method === "POST" && path === `/v27.0/${IG_ID}/likes`) kind = "like";
    else if (method === "GET" && path === "/refresh_access_token") kind = "refresh";
    else if (method === "GET" && (m = /^\/v27\.0\/([^/]+)\/comments$/.exec(path))) kind = "comments";
    else if (method === "GET" && path === `/v27.0/${IG_ID}/media`) kind = "media";
    else if (method === "GET" && path === `/v27.0/${IG_ID}`) kind = "accounts";
    else if (method === "GET" && (m = /^\/v27\.0\/(\d+)$/.exec(path)) && url.searchParams.get("fields") === "is_user_follow_business") kind = "profile";
    const call = { kind, host: url.host, method, path, query: Object.fromEntries(url.searchParams), body, auth: headers.get("authorization"), target: m?.[1] };
    calls.push(call);
    const q = queues[kind];
    if (q?.length) {
      const o = q.shift();
      if (o === "throw") throw new TypeError("network down");
      return R(o.status, o.body ?? {});
    }
    switch (kind) {
      case "dm": return R(200, { recipient_id: "555", message_id: "mid" });
      case "reply": return R(200, { id: "reply1" });
      case "like": return R(200, { success: true });
      case "profile": return R(200, { id: call.target, is_user_follow_business: g.follows[call.target] === true });
      case "refresh": return R(200, g.refreshResponse);
      case "comments": return R(200, { data: g.comments[call.target] ?? [] });
      case "media": return R(200, { data: g.media });
      case "accounts": return R(200, { id: IG_ID, username: "testuser" });
      default: return R(404, { error: { message: "unrouted " + method + " " + path } });
    }
  };
  return g;
}

export const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();
export const H = 3_600_000;
export const D = 86_400_000;
