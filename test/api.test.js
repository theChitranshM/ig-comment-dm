import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/api.js";
import { ingest, poll, sweepPending, extractComments, getConfig, ledger } from "../src/core.js";
import { normalizeConfig, normalizeAutomation, applyEdit, validateAutomation } from "../src/automations.js";
import {
  IG_ID, makeEnv, makeCtx, putConfig, installGraph, commentValue, changesPayload, _resetCaches, isoAgo, H, D,
} from "./helpers.js";

const realLog = console.log;
let env, g, extra;
const ORIGIN = "https://x";
const XRW = { "x-requested-with": "ig-comment-dm" };

beforeEach(() => {
  console.log = () => {};
  env = makeEnv({ APP_ID: "999", ADMIN_KEY: "adm" });
  g = installGraph();
  // Extra Graph routes layered over helpers' fake fetch.
  extra = {
    account: { id: IG_ID, username: "testuser", name: "Test User", profile_picture_url: "https://pic/x.jpg", followers_count: 42 },
    subscribedApps: { data: [{ app_id: "999", subscribed_fields: ["comments"] }] },
    subscriptions: { data: [{ object: "instagram", active: true, callback_url: `${ORIGIN}/webhook`, fields: [{ name: "comments" }] }] },
    media: null,
    calls: [],
  };
  const inner = globalThis.fetch;
  const R = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") {
      extra.calls.push(url.pathname);
      if (url.pathname === `/v27.0/${IG_ID}`) return R(extra.account);
      if (url.pathname === `/v27.0/${IG_ID}/subscribed_apps`) return R(extra.subscribedApps);
      if (url.pathname === "/v27.0/999/subscriptions") return R(extra.subscriptions);
      if (url.pathname === `/v27.0/${IG_ID}/media` && extra.media) { extra.mediaQuery = Object.fromEntries(url.searchParams); return R(extra.media); }
    }
    return inner(input, init);
  };
  _resetCaches();
});
afterEach(() => { g.restore(); console.log = realLog; });

// ---------- helpers ----------
const mk = (o = {}) => normalizeAutomation({
  id: "a_1", name: "One", keyword: "DIWALI", dm: "dm one", link: "", ack: "", media_ids: ["A"],
  created_at: "2026-01-01T00:00:00.000Z", ...o,
});
async function putV2(automations, more = {}) {
  await env.KV.put("config", JSON.stringify({ version: 2, automations, exclude_media_ids: [], skip_comment_ids: [], dry_run: false, ...more }));
  _resetCaches();
}
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Make a request through api(). auth: "bearer" (default) | "cookie" | "none".
async function req(method, path, { body, auth = "bearer", headers = {}, csrf } = {}) {
  const h = { ...headers };
  if (auth === "bearer") h.authorization = "Bearer adm";
  if (auth === "cookie") { h.cookie = `sid=${await sid()}`; if (csrf !== false) Object.assign(h, XRW); }
  if (typeof auth === "object") Object.assign(h, auth);
  if (body !== undefined) h["content-type"] = "application/json";
  const url = ORIGIN + path;
  const res = await api(new Request(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env, new URL(url));
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, headers: res.headers };
}
async function sid() {
  const r = await req("POST", "/api/login", { auth: "none", body: { key: "adm" } });
  return /sid=([^;]+)/.exec(r.headers.get("set-cookie"))[1];
}
const webhook = (o) => ingest(extractComments(changesPayload(commentValue(o))), env);
const row = (id, text, ts, from = { id: "555", username: "someuser" }) => ({ id, text, timestamp: ts, from });
const dmTexts = () => g.dms.map((d) => d.body.message.text);

// =====================================================================
describe("migration v1 -> v2", () => {
  const v1 = () => ({
    rules: [
      { keyword: "DIWALI", dm: "d", link: "https://a.example/x", ack: "ok" },
      { keyword: "EYE", dm: "e" },
    ],
    scope: { mode: "allowlist", media_ids: ["M1", "M2"], allowed_at: { M1: "2026-01-02T00:00:00.000Z" }, skip_comment_ids: ["S1"], exclude_media_ids: ["X1"] },
    dry_run: true,
  });

  test("allowlist scope -> per-automation media_ids/allowed_at, global fields lifted", () => {
    const c = normalizeConfig(v1());
    assert.equal(c.version, 2);
    assert.equal(c.automations.length, 2);
    const [d, e] = c.automations;
    assert.equal(d.id, "a_diwali");
    assert.equal(d.name, "Diwali");
    assert.equal(d.all_posts, false);
    assert.deepEqual(d.media_ids, ["M1", "M2"]);
    assert.deepEqual(d.allowed_at, { M1: "2026-01-02T00:00:00.000Z" });
    assert.equal(d.all_posts_since, null);
    assert.equal(e.id, "a_eye");
    assert.deepEqual(e.media_ids, ["M1", "M2"]);
    assert.deepEqual(c.exclude_media_ids, ["X1"]);
    assert.deepEqual(c.skip_comment_ids, ["S1"]);
    assert.equal(c.dry_run, true);
  });

  test("allowlist allowed_at objects are copies (not shared between automations)", () => {
    const c = normalizeConfig(v1());
    c.automations[0].allowed_at.M9 = "z";
    assert.equal(c.automations[1].allowed_at.M9, undefined);
  });

  test("scope.mode=all -> all_posts true and no media_ids", () => {
    const c = normalizeConfig({ rules: [{ keyword: "ORB", dm: "o" }], scope: { mode: "all", media_ids: ["M1"] } });
    assert.equal(c.automations[0].all_posts, true);
    assert.deepEqual(c.automations[0].media_ids, []);
    assert.ok(c.automations[0].all_posts_since);
  });

  test("empty/missing input normalizes without throwing", () => {
    assert.deepEqual(normalizeConfig(null).automations, []);
    assert.deepEqual(normalizeConfig({}).automations, []);
  });

  test("v2 round-trips unchanged (idempotent) and via KV save", async () => {
    const once = normalizeConfig(v1());
    assert.deepEqual(normalizeConfig(JSON.parse(JSON.stringify(once))), once);
    await putV2(once.automations, { exclude_media_ids: ["X1"], dry_run: true });
    const got = await getConfig(env);
    assert.deepEqual(got.automations, once.automations);
    assert.equal(got.dry_run, true);
  });

  test("v1 config in KV is served by GET /api/automations with migrated ids", async () => {
    await putConfig(env, v1());
    const r = await req("GET", "/api/automations");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.automations.map((a) => a.id), ["a_diwali", "a_eye"]);
    assert.ok(!("allowed_at" in r.json.automations[0]));
    assert.ok(!("all_posts_since" in r.json.automations[0]));
  });

  test("legacy ledger record (keyword, no automationId) is processed by the migrated automation", async () => {
    await putConfig(env, { scope: { mode: "allowlist", media_ids: ["M1"] }, dry_run: false });
    const call = ledger(env);
    await call("enqueue", { now: Date.now(), items: [{ commentId: "L1", keyword: "DIWALI", text: "diwali", fromId: "555", fromUsername: "u", mediaId: "M1", source: "webhook" }] });
    const out = await sweepPending(env);
    assert.equal(out[0].result, "done");
    assert.equal(g.dms.length, 1);
    assert.equal(g.dms[0].body.message.text, "here's the code 🪔 build your own\nhttps://github.com/theChitranshM/hands-on-fire");
    assert.equal(g.dms[0].body.recipient.comment_id, "L1");
  });

  test("legacy ledger record whose keyword no longer exists fails (not sent)", async () => {
    await putConfig(env);
    const call = ledger(env);
    await call("enqueue", { now: Date.now(), items: [{ commentId: "L2", keyword: "GONE", text: "gone", fromId: "5", mediaId: "M1", source: "webhook" }] });
    const out = await sweepPending(env);
    assert.equal(out[0].result, "failed");
    assert.equal(g.dms.length, 0);
  });
});

// =====================================================================
describe("applyEdit", () => {
  const NOW = "2026-06-01T00:00:00.000Z";
  const T0 = "2026-01-01T00:00:00.000Z";

  test("create: stamps every initial post, id/timestamps assigned", () => {
    const a = applyEdit(null, { keyword: "x", dm: "d", media_ids: ["A", "B"] }, NOW);
    assert.match(a.id, /^a_/);
    assert.equal(a.keyword, "X");
    assert.deepEqual(a.allowed_at, { A: NOW, B: NOW });
    assert.equal(a.created_at, NOW);
    assert.equal(a.updated_at, NOW);
  });

  test("only newly added posts are stamped; existing stamps untouched", () => {
    const cur = mk({ media_ids: ["A"], allowed_at: { A: T0 } });
    const next = applyEdit(cur, { media_ids: ["A", "B"] }, NOW);
    assert.equal(next.allowed_at.A, T0);
    assert.equal(next.allowed_at.B, NOW);
    assert.equal(next.updated_at, NOW);
    assert.equal(next.created_at, cur.created_at);
  });

  test("post that was covered but lacks a stamp is not stamped (already in media_ids)", () => {
    const cur = mk({ media_ids: ["A"], allowed_at: {} });
    const next = applyEdit(cur, { name: "Renamed" }, NOW);
    assert.deepEqual(next.allowed_at, {});
  });

  test("removing a post drops its stamp; re-adding stamps afresh", () => {
    const cur = mk({ media_ids: ["A", "B"], allowed_at: { A: T0, B: T0 } });
    const removed = applyEdit(cur, { media_ids: ["A"] }, NOW);
    assert.deepEqual(removed.allowed_at, { A: T0 });
    const readded = applyEdit(removed, { media_ids: ["A", "B"] }, "2026-07-01T00:00:00.000Z");
    assert.equal(readded.allowed_at.B, "2026-07-01T00:00:00.000Z");
  });

  test("switching to all_posts sets all_posts_since = now; staying all keeps it", () => {
    const cur = mk({ all_posts: false });
    const all = applyEdit(cur, { all_posts: true }, NOW);
    assert.equal(all.all_posts, true);
    assert.equal(all.all_posts_since, NOW);
    const again = applyEdit(all, { name: "n" }, "2027-01-01T00:00:00.000Z");
    assert.equal(again.all_posts_since, NOW);
    const off = applyEdit(all, { all_posts: false }, "2027-01-01T00:00:00.000Z");
    assert.equal(off.all_posts_since, null);
  });

  test("creating with all_posts:true gets all_posts_since = now", () => {
    const a = applyEdit(null, { keyword: "k", dm: "d", all_posts: true }, NOW);
    assert.equal(a.all_posts_since, NOW);
  });

  test("patch cannot change id", () => {
    const next = applyEdit(mk(), { id: "evil" }, NOW);
    assert.equal(next.id, "a_1");
  });
});

// =====================================================================
describe("validateAutomation", () => {
  const ok = (o = {}) => mk(o);
  test("valid passes", () => assert.equal(validateAutomation(ok(), []), null));
  test("keyword required", () => assert.match(validateAutomation(ok({ keyword: "  " }), []), /keyword/i));
  test("dm required", () => assert.match(validateAutomation(ok({ dm: "" }), []), /DM/));
  test("keyword length limit (60)", () => {
    assert.equal(validateAutomation(ok({ keyword: "K".repeat(60) }), []), null);
    assert.ok(validateAutomation(ok({ keyword: "K".repeat(61) }), []));
  });
  test("link must be http(s)", () => {
    for (const bad of ["ftp://a.com/x", "example.com", "javascript:alert(1)", "http://", "https://no spaces.com"])
      assert.match(validateAutomation(ok({ link: bad }), []) ?? "", /http/, bad);
    assert.equal(validateAutomation(ok({ link: "https://a.example/x?y=1" }), []), null);
    assert.equal(validateAutomation(ok({ link: "HTTP://A.EXAMPLE" }), []), null);
    assert.equal(validateAutomation(ok({ link: "" }), []), null);
  });
  test("DM+link at most 1000 chars (boundary)", () => {
    const link = "https://a.example/x"; // 19 chars + newline
    const dm = "d".repeat(1000 - link.length - 1);
    assert.equal(validateAutomation(ok({ dm, link }), []), null);
    assert.match(validateAutomation(ok({ dm: dm + "d", link }), []), /1000/);
    assert.equal(validateAutomation(ok({ dm: "d".repeat(1000) }), []), null);
    assert.match(validateAutomation(ok({ dm: "d".repeat(1001) }), []), /1000/);
  });
  test("ack at most 300, name at most 80", () => {
    assert.equal(validateAutomation(ok({ ack: "a".repeat(300) }), []), null);
    assert.match(validateAutomation(ok({ ack: "a".repeat(301) }), []), /300/);
    assert.equal(validateAutomation(ok({ name: "n".repeat(80) }), []), null);
    assert.ok(validateAutomation(ok({ name: "n".repeat(81) }), []));
  });

  const other = (o = {}) => mk({ id: "a_2", name: "Other One", keyword: "DIWALI", media_ids: ["A"], ...o });
  test("clash with enabled automation on overlapping post -> names it", () => {
    const e = validateAutomation(ok({ id: "a_new" }), [other()]);
    assert.match(e, /DIWALI/);
    assert.match(e, /Other One/);
  });
  test("alias clash is rejected too (both directions)", () => {
    assert.match(validateAutomation(ok({ id: "n", keyword: "ZZZ", aliases: ["DIWALI"] }), [other()]), /DIWALI/);
    assert.match(validateAutomation(ok({ id: "n", keyword: "DIWALI" }), [other({ keyword: "QQ", aliases: ["diwali"] })]), /DIWALI/);
  });
  test("case-insensitive clash", () => {
    assert.ok(validateAutomation(ok({ id: "n", keyword: "diwali" }), [other()]));
  });
  test("no clash when posts do not overlap", () => {
    assert.equal(validateAutomation(ok({ id: "n", media_ids: ["B"] }), [other()]), null);
  });
  test("all_posts overlaps with any posts", () => {
    assert.ok(validateAutomation(ok({ id: "n", all_posts: true, media_ids: [] }), [other()]));
    assert.ok(validateAutomation(ok({ id: "n", media_ids: ["Z"] }), [other({ all_posts: true, media_ids: [] })]));
  });
  test("no clash if the other is disabled", () => {
    assert.equal(validateAutomation(ok({ id: "n" }), [other({ enabled: false })]), null);
  });
  test("no clash when this one is disabled", () => {
    assert.equal(validateAutomation(ok({ id: "n", enabled: false }), [other()]), null);
  });
  test("editing itself is not a clash", () => {
    assert.equal(validateAutomation(ok({ id: "a_2" }), [other()]), null);
  });
});

// =====================================================================
describe("per-post routing (end to end)", () => {
  test("same keyword on different posts sends different DMs by media id", async () => {
    await putV2([
      mk({ id: "a_A", name: "For A", media_ids: ["A"], dm: "dm for A", link: "https://a.example/a", ack: "" }),
      mk({ id: "a_B", name: "For B", media_ids: ["B"], dm: "dm for B", link: "https://b.example/b", ack: "" }),
    ]);
    await webhook({ id: "C1", text: "DIWALI", media: "A" });
    await webhook({ id: "C2", text: "diwali pls", media: "B" });
    assert.equal(g.dms.length, 2);
    const by = Object.fromEntries(g.dms.map((d) => [d.body.recipient.comment_id, d.body.message.text]));
    assert.equal(by.C1, "dm for A\nhttps://a.example/a");
    assert.equal(by.C2, "dm for B\nhttps://b.example/b");
    const rec = env.LEDGER._storage._m;
    assert.equal(rec.get("c:C1").item.automationId, "a_A");
    assert.equal(rec.get("c:C2").item.automationId, "a_B");
  });

  test("comment on a post with no automation is skipped", async () => {
    await putV2([mk({ media_ids: ["A"] })]);
    await webhook({ id: "C1", text: "DIWALI", media: "OTHER" });
    assert.equal(g.dms.length, 0);
  });

  test("all_posts fires on any post except exclude_media_ids", async () => {
    await putV2([mk({ all_posts: true, media_ids: [] })], { exclude_media_ids: ["X"] });
    await webhook({ id: "C1", text: "DIWALI", media: "ANY" });
    await webhook({ id: "C2", text: "DIWALI", media: "X" });
    assert.deepEqual(g.dms.map((d) => d.body.recipient.comment_id), ["C1"]);
  });

  test("disabled automation never fires (webhook and poll)", async () => {
    await putV2([mk({ enabled: false })]);
    await webhook({ id: "C1", text: "DIWALI", media: "A" });
    g.comments.A = [row("P1", "DIWALI", isoAgo(H))];
    await poll(env, { full: true, backfill: true });
    assert.equal(g.dms.length, 0);
  });

  test("disabled automation does not shadow an enabled one with same keyword", async () => {
    await putV2([mk({ id: "a_off", enabled: false, dm: "off" }), mk({ id: "a_on", dm: "on" })]);
    await webhook({ id: "C1", text: "DIWALI", media: "A" });
    assert.deepEqual(dmTexts(), ["on"]);
  });

  test("before_allow: polled comment older than allowed_at is skipped, backfill sends it", async () => {
    await putV2([mk({ media_ids: ["A"], allowed_at: { A: isoAgo(H) } })]);
    g.comments.A = [row("OLD", "DIWALI", isoAgo(3 * H)), row("NEW", "DIWALI", isoAgo(10 * 60_000))];
    await poll(env, {});
    assert.deepEqual(g.dms.map((d) => d.body.recipient.comment_id), ["NEW"]);
    await poll(env, { full: true, backfill: true });
    assert.deepEqual(g.dms.map((d) => d.body.recipient.comment_id).sort(), ["NEW", "OLD"]);
  });

  test("before_allow is per post: another post's stamp doesn't affect this one", async () => {
    await putV2([mk({ media_ids: ["A", "B"], allowed_at: { A: isoAgo(H) } })]); // B has no stamp
    g.comments.A = [row("OA", "DIWALI", isoAgo(3 * H))];
    g.comments.B = [row("OB", "DIWALI", isoAgo(3 * H))];
    await poll(env, {});
    assert.deepEqual(g.dms.map((d) => d.body.recipient.comment_id), ["OB"]);
  });

  test("webhook comment (no timestamp) fires even with a fresh allowed_at", async () => {
    await putV2([mk({ media_ids: ["A"], allowed_at: { A: new Date(Date.now() + 1000).toISOString() } })]);
    await webhook({ id: "W", text: "DIWALI", media: "A" });
    assert.equal(g.dms.length, 1);
  });

  test("all_posts automation: comments older than all_posts_since wait for backfill", async () => {
    await putV2([mk({ all_posts: true, media_ids: [], all_posts_since: isoAgo(H) })]);
    g.media = [{ id: "A" }];
    g.comments.A = [row("OLD", "DIWALI", isoAgo(3 * H))];
    await poll(env, {});
    assert.equal(g.dms.length, 0);
    await poll(env, { backfill: true });
    assert.equal(g.dms.length, 1);
  });

  test("all_posts poll honours exclude_media_ids", async () => {
    await putV2([mk({ all_posts: true, media_ids: [] })], { exclude_media_ids: ["X"] });
    g.media = [{ id: "X" }, { id: "Y" }];
    g.comments.X = [row("CX", "DIWALI", isoAgo(H))];
    g.comments.Y = [row("CY", "DIWALI", isoAgo(H))];
    await poll(env, { full: true });
    assert.deepEqual(g.dms.map((d) => d.body.recipient.comment_id), ["CY"]);
  });

  test("self comments are never answered", async () => {
    await putV2([mk()]);
    await webhook({ id: "S", text: "DIWALI", media: "A", fromId: IG_ID, username: "x" });
    assert.equal(g.dms.length, 0);
  });
});

// =====================================================================
describe("auth", () => {
  test("no credentials -> 401", async () => {
    const r = await req("GET", "/api/automations", { auth: "none" });
    assert.equal(r.status, 401);
    assert.ok(r.json.error);
  });
  test("login wrong key -> 401, no cookie", async () => {
    const r = await req("POST", "/api/login", { auth: "none", body: { key: "nope" } });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get("set-cookie"), null);
    assert.ok(r.json.error);
  });
  test("login missing key / bad JSON -> 401", async () => {
    assert.equal((await req("POST", "/api/login", { auth: "none", body: {} })).status, 401);
    const bad = await api(new Request(ORIGIN + "/api/login", { method: "POST", body: "{not json" }), env, new URL(ORIGIN + "/api/login"));
    assert.equal(bad.status, 401);
  });
  test("login with no ADMIN_KEY configured is refused", async () => {
    env.ADMIN_KEY = undefined;
    const r = await req("POST", "/api/login", { auth: "none", body: { key: "" } });
    assert.equal(r.status, 401);
    const r2 = await req("GET", "/api/automations", { auth: { authorization: "Bearer undefined" } });
    assert.equal(r2.status, 401);
  });
  test("login right key -> 200, cookie flags", async () => {
    const r = await req("POST", "/api/login", { auth: "none", body: { key: "adm" } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    const sc = r.headers.get("set-cookie");
    assert.match(sc, /^sid=\d+\.[0-9a-f]{64};/);
    assert.match(sc, /HttpOnly/);
    assert.match(sc, /Secure/);
    assert.match(sc, /SameSite=Strict/);
    assert.match(sc, /Path=\//);
    assert.match(sc, new RegExp(`Max-Age=${30 * 86400}`));
  });
  test("session cookie authorizes GET", async () => {
    const r = await req("GET", "/api/automations", { auth: "cookie" });
    assert.equal(r.status, 200);
  });
  test("tampered signature -> 401", async () => {
    const s = await sid();
    const bad = s.slice(0, -1) + (s.at(-1) === "0" ? "1" : "0");
    const r = await req("GET", "/api/automations", { auth: { cookie: `sid=${bad}` } });
    assert.equal(r.status, 401);
  });
  test("tampered expiry (extended, old sig) -> 401", async () => {
    const [exp, sig] = (await sid()).split(".");
    const r = await req("GET", "/api/automations", { auth: { cookie: `sid=${Number(exp) + 99999}.${sig}` } });
    assert.equal(r.status, 401);
  });
  test("correctly signed but expired cookie -> 401", async () => {
    const exp = Date.now() - 1000;
    const c = `${exp}.${await hmac("adm", `sid:${exp}`)}`;
    assert.equal((await req("GET", "/api/automations", { auth: { cookie: `sid=${c}` } })).status, 401);
    const fresh = Date.now() + 60_000; // sanity: same construction, unexpired, is accepted
    const ok = `${fresh}.${await hmac("adm", `sid:${fresh}`)}`;
    assert.equal((await req("GET", "/api/automations", { auth: { cookie: `sid=${ok}` } })).status, 200);
  });
  test("cookie signed with a different key -> 401", async () => {
    const exp = Date.now() + 60_000;
    const c = `${exp}.${await hmac("other", `sid:${exp}`)}`;
    assert.equal((await req("GET", "/api/automations", { auth: { cookie: `sid=${c}` } })).status, 401);
  });
  test("garbage cookies -> 401", async () => {
    for (const c of ["sid=", "sid=abc", "sid=.", "foo=bar", "sid=1.2.3"])
      assert.equal((await req("GET", "/api/automations", { auth: { cookie: c } })).status, 401, c);
  });
  test("cookie is found among other cookies", async () => {
    const s = await sid();
    const r = await req("GET", "/api/automations", { auth: { cookie: `a=b; sid=${s}; c=d` } });
    assert.equal(r.status, 200);
  });
  test("Bearer ADMIN_KEY works; wrong bearer 401", async () => {
    assert.equal((await req("GET", "/api/automations", { auth: "bearer" })).status, 200);
    assert.equal((await req("GET", "/api/automations", { auth: { authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await req("GET", "/api/automations", { auth: { authorization: "adm" } })).status, 401);
  });
  test("cookie-authed mutations need X-Requested-With: 403 without, OK with", async () => {
    const body = { keyword: "NEW", dm: "hello", media_ids: ["A"] };
    const n0 = (await getConfig(env)).automations.length;
    const no = await req("POST", "/api/automations", { auth: "cookie", csrf: false, body });
    assert.equal(no.status, 403);
    assert.ok(no.json.error);
    assert.equal((await req("PUT", "/api/automations/a_nope", { auth: "cookie", csrf: false, body: {} })).status, 403);
    assert.equal((await req("DELETE", "/api/automations/a_nope", { auth: "cookie", csrf: false })).status, 403);
    assert.equal((await req("PUT", "/api/settings", { auth: "cookie", csrf: false, body: { dry_run: true } })).status, 403);
    assert.equal((await req("POST", "/api/try", { auth: "cookie", csrf: false, body: { text: "x" } })).status, 403);
    assert.equal((await getConfig(env)).automations.length, n0, "403 must not have changed anything");
    const wrong = await req("POST", "/api/automations", { auth: "cookie", csrf: false, headers: { "x-requested-with": "nope" }, body });
    assert.equal(wrong.status, 403);
    const yes = await req("POST", "/api/automations", { auth: "cookie", body });
    assert.equal(yes.status, 200);
  });
  test("cookie-authed GET needs no header", async () => {
    const r = await req("GET", "/api/overview", { auth: "cookie", csrf: false });
    assert.equal(r.status, 200);
  });
  test("bearer-authed mutations need no header", async () => {
    const r = await req("POST", "/api/automations", { body: { keyword: "BEAR", dm: "x" } });
    assert.equal(r.status, 200);
    assert.equal((await req("DELETE", `/api/automations/${r.json.automation.id}`)).status, 200);
  });
  test("logout clears the cookie", async () => {
    const r = await req("POST", "/api/logout", { auth: "cookie" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    const sc = r.headers.get("set-cookie");
    assert.match(sc, /^sid=;/);
    assert.match(sc, /Max-Age=0/);
  });
  test("unknown route (authed) -> 404 {error}", async () => {
    const r = await req("GET", "/api/nope");
    assert.equal(r.status, 404);
    assert.ok(r.json.error);
  });
});

// =====================================================================
describe("automations CRUD", () => {
  beforeEach(async () => { await putV2([]); });

  test("create: server assigns id, uppercases keyword, timestamps, stats zeros", async () => {
    const before = Date.now();
    const r = await req("POST", "/api/automations", { body: { keyword: " promo ", dm: " hi there ", link: "https://a.example/p", ack: "sent", media_ids: ["A", "B"], aliases: ["deal", "deal"] } });
    assert.equal(r.status, 200);
    const a = r.json.automation;
    assert.match(a.id, /^a_[0-9a-f]{10}$/);
    assert.equal(a.keyword, "PROMO");
    assert.equal(a.name.toUpperCase(), "PROMO", "name defaults to keyword");
    assert.equal(a.dm, "hi there");
    assert.deepEqual(a.aliases, ["DEAL"]);
    assert.equal(a.enabled, true);
    assert.equal(a.match, "fuzzy");
    assert.equal(a.all_posts, false);
    assert.deepEqual(a.media_ids, ["A", "B"]);
    assert.ok(Date.parse(a.created_at) >= before - 1000 && Date.parse(a.created_at) <= Date.now() + 1000);
    assert.equal(a.updated_at, a.created_at);
    assert.deepEqual(a.stats, { sent: 0, failed: 0, pending: 0, last_sent_at: null });
    assert.ok(!("allowed_at" in a));
    const list = await req("GET", "/api/automations");
    assert.equal(list.json.automations.length, 1);
    assert.equal(list.json.automations[0].id, a.id);
  });

  test("create ignores client-supplied id/stats/timestamps", async () => {
    const r = await req("POST", "/api/automations", { body: { id: "a_mine", keyword: "K", dm: "d", stats: { sent: 9 }, created_at: "2000-01-01T00:00:00Z", updated_at: "2000-01-01T00:00:00Z" } });
    const a = r.json.automation;
    assert.notEqual(a.id, "a_mine");
    assert.equal(a.stats.sent, 0);
    assert.ok(a.created_at.startsWith("20") && !a.created_at.startsWith("2000"));
  });

  test("create stamps allowed_at for initial posts (verified via config)", async () => {
    const r = await req("POST", "/api/automations", { body: { keyword: "K", dm: "d", media_ids: ["A"] } });
    const cfg = await getConfig(env);
    assert.ok(cfg.automations[0].allowed_at.A);
    assert.equal(cfg.automations[0].id, r.json.automation.id);
  });

  test("create validation errors -> 400 {error}", async () => {
    const cases = [
      [{ dm: "x" }, /keyword/i],
      [{ keyword: "K" }, /DM/],
      [{ keyword: "K", dm: "x", link: "nope" }, /http/],
      [{ keyword: "K", dm: "x".repeat(1001) }, /1000/],
      [{ keyword: "K", dm: "x", ack: "a".repeat(301) }, /300/],
    ];
    for (const [body, re] of cases) {
      const r = await req("POST", "/api/automations", { body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.json.error, re);
    }
    assert.equal((await req("GET", "/api/automations")).json.automations.length, 0);
  });

  test("create with unparseable body -> 400", async () => {
    const res = await api(new Request(ORIGIN + "/api/automations", { method: "POST", headers: { authorization: "Bearer adm" }, body: "{oops" }), env, new URL(ORIGIN + "/api/automations"));
    assert.equal(res.status, 400);
  });

  test("create clash -> 400 naming the other automation; non-overlapping OK", async () => {
    await req("POST", "/api/automations", { body: { name: "First", keyword: "GO", dm: "1", media_ids: ["A"] } });
    const bad = await req("POST", "/api/automations", { body: { keyword: "go", dm: "2", media_ids: ["A", "B"] } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /GO/);
    assert.match(bad.json.error, /First/);
    const ok = await req("POST", "/api/automations", { body: { keyword: "GO", dm: "2", media_ids: ["B"] } });
    assert.equal(ok.status, 200);
  });

  test("update: partial fields; unknown/readonly fields ignored", async () => {
    const c = (await req("POST", "/api/automations", { body: { name: "Orig", keyword: "AAA", dm: "d1", link: "https://a.example", media_ids: ["A"] } })).json.automation;
    await new Promise((r) => setTimeout(r, 5));
    const r = await req("PUT", `/api/automations/${c.id}`, { body: { dm: "d2", id: "a_hack", stats: { sent: 99 }, created_at: "1999-01-01T00:00:00Z", updated_at: "1999-01-01T00:00:00Z", allowed_at: { Z: "x" }, all_posts_since: "x", bogus: 1 } });
    assert.equal(r.status, 200);
    const a = r.json.automation;
    assert.equal(a.id, c.id);
    assert.equal(a.dm, "d2");
    assert.equal(a.name, "Orig");
    assert.equal(a.keyword, "AAA");
    assert.equal(a.link, "https://a.example");
    assert.deepEqual(a.media_ids, ["A"]);
    assert.equal(a.stats.sent, 0);
    assert.equal(a.created_at, c.created_at);
    assert.ok(Date.parse(a.updated_at) > Date.parse(c.updated_at));
    assert.ok(!("bogus" in a));
    const cfg = await getConfig(env);
    assert.deepEqual(Object.keys(cfg.automations[0].allowed_at), ["A"], "client allowed_at ignored");
  });

  test("update can clear link/ack/aliases and toggle enabled/match/all_posts", async () => {
    const c = (await req("POST", "/api/automations", { body: { keyword: "AAA", dm: "d", link: "https://a.example", ack: "yo", aliases: ["B"], media_ids: ["A"] } })).json.automation;
    const r = (await req("PUT", `/api/automations/${c.id}`, { body: { link: "", ack: "", aliases: [], enabled: false, match: "exact", all_posts: true } })).json.automation;
    assert.equal(r.link, "");
    assert.equal(r.ack, "");
    assert.deepEqual(r.aliases, []);
    assert.equal(r.enabled, false);
    assert.equal(r.match, "exact");
    assert.equal(r.all_posts, true);
    const cfg = await getConfig(env);
    assert.ok(cfg.automations[0].all_posts_since);
  });

  test("update adding a post stamps only that post", async () => {
    const c = (await req("POST", "/api/automations", { body: { keyword: "AAA", dm: "d", media_ids: ["A"] } })).json.automation;
    const stampA = (await getConfig(env)).automations[0].allowed_at.A;
    await new Promise((r) => setTimeout(r, 5));
    await req("PUT", `/api/automations/${c.id}`, { body: { media_ids: ["A", "B"] } });
    let cfg = await getConfig(env);
    assert.equal(cfg.automations[0].allowed_at.A, stampA);
    assert.ok(Date.parse(cfg.automations[0].allowed_at.B) > Date.parse(stampA));
    await req("PUT", `/api/automations/${c.id}`, { body: { media_ids: ["B"] } });
    cfg = await getConfig(env);
    assert.deepEqual(Object.keys(cfg.automations[0].allowed_at), ["B"]);
  });

  test("update validation: clash 400, editing itself fine, re-enable checks clash", async () => {
    const a1 = (await req("POST", "/api/automations", { body: { name: "One", keyword: "AAA", dm: "d", media_ids: ["A"] } })).json.automation;
    const a2 = (await req("POST", "/api/automations", { body: { name: "Two", keyword: "BBB", dm: "d", media_ids: ["A"] } })).json.automation;
    const self = await req("PUT", `/api/automations/${a1.id}`, { body: { keyword: "AAA", dm: "again" } });
    assert.equal(self.status, 200);
    const clash = await req("PUT", `/api/automations/${a2.id}`, { body: { keyword: "AAA" } });
    assert.equal(clash.status, 400);
    assert.match(clash.json.error, /One/);
    await req("PUT", `/api/automations/${a1.id}`, { body: { enabled: false } });
    assert.equal((await req("PUT", `/api/automations/${a2.id}`, { body: { keyword: "AAA" } })).status, 200);
    const re = await req("PUT", `/api/automations/${a1.id}`, { body: { enabled: true } });
    assert.equal(re.status, 400);
    assert.match(re.json.error, /Two/);
  });

  test("update validation: blanking keyword/dm rejected", async () => {
    const a = (await req("POST", "/api/automations", { body: { keyword: "AAA", dm: "d" } })).json.automation;
    assert.equal((await req("PUT", `/api/automations/${a.id}`, { body: { keyword: "" } })).status, 400);
    assert.equal((await req("PUT", `/api/automations/${a.id}`, { body: { dm: "  " } })).status, 400);
  });

  test("delete removes it; deleting again / unknown -> 404", async () => {
    const a = (await req("POST", "/api/automations", { body: { keyword: "AAA", dm: "d" } })).json.automation;
    const r = await req("DELETE", `/api/automations/${a.id}`);
    assert.deepEqual(r.json, { ok: true });
    assert.equal((await req("GET", "/api/automations")).json.automations.length, 0);
    assert.equal((await req("DELETE", `/api/automations/${a.id}`)).status, 404);
  });

  test("404 on unknown id for PUT/DELETE/waiting/send-waiting", async () => {
    for (const [m, p, body] of [
      ["PUT", "/api/automations/a_nope", {}], ["DELETE", "/api/automations/a_nope"],
      ["GET", "/api/automations/a_nope/waiting"], ["POST", "/api/automations/a_nope/send-waiting", {}],
    ]) {
      const r = await req(m, p, { body });
      assert.equal(r.status, 404, `${m} ${p}`);
      assert.ok(r.json.error);
    }
  });

  test("reorder changes order; omitted ids go last in original order", async () => {
    const ids = [];
    for (const k of ["AAA", "BBB", "CCC", "DDD"]) ids.push((await req("POST", "/api/automations", { body: { keyword: k, dm: "d" } })).json.automation.id);
    const r = await req("POST", "/api/automations/reorder", { body: { ids: [ids[2], ids[0]] } });
    assert.deepEqual(r.json, { ok: true });
    const got = (await req("GET", "/api/automations")).json.automations.map((a) => a.id);
    assert.deepEqual(got, [ids[2], ids[0], ids[1], ids[3]]);
    await req("POST", "/api/automations/reorder", { body: { ids: [...ids].reverse() } });
    assert.deepEqual((await req("GET", "/api/automations")).json.automations.map((a) => a.id), [...ids].reverse());
  });

  test("reorder keeps allowed_at / per-post stamps intact", async () => {
    const a = (await req("POST", "/api/automations", { body: { keyword: "AAA", dm: "d", media_ids: ["A"] } })).json.automation;
    const b = (await req("POST", "/api/automations", { body: { keyword: "BBB", dm: "d", media_ids: ["A"] } })).json.automation;
    const before = (await getConfig(env)).automations.map((x) => x.allowed_at);
    await req("POST", "/api/automations/reorder", { body: { ids: [b.id, a.id] } });
    const cfg = await getConfig(env);
    assert.deepEqual(cfg.automations.map((x) => x.id), [b.id, a.id]);
    assert.deepEqual(cfg.automations.map((x) => x.allowed_at), [before[1], before[0]]);
  });

  test("reorder changes matching priority (earlier automation wins ties)", async () => {
    await putV2([
      mk({ id: "a_x", name: "X", keyword: "FOO", aliases: [], dm: "x", media_ids: ["A"] }),
      mk({ id: "a_y", name: "Y", keyword: "BAR", aliases: [], dm: "y", media_ids: ["A"] }),
    ]);
    // a text hitting both keywords: first in order wins
    let r = await req("POST", "/api/try", { body: { text: "foo bar" } });
    assert.equal(r.json.match.automation_id, "a_x");
    await req("POST", "/api/automations/reorder", { body: { ids: ["a_y", "a_x"] } });
    r = await req("POST", "/api/try", { body: { text: "foo bar" } });
    assert.equal(r.json.match.automation_id, "a_y");
  });
});

// =====================================================================
describe("stats", () => {
  test("sent / last_sent_at land on the right automation", async () => {
    await putV2([
      mk({ id: "a_A", name: "A", keyword: "ONE", media_ids: ["A"] }),
      mk({ id: "a_B", name: "B", keyword: "TWO", media_ids: ["A"] }),
    ]);
    const t0 = Date.now();
    await webhook({ id: "C1", text: "one", media: "A" });
    await webhook({ id: "C2", text: "one", media: "A", fromId: "556" });
    const r = await req("GET", "/api/automations");
    const [a, b] = r.json.automations;
    assert.equal(a.stats.sent, 2);
    assert.equal(a.stats.failed, 0);
    assert.equal(a.stats.pending, 0);
    assert.ok(Date.parse(a.stats.last_sent_at) >= t0 - 1000);
    assert.equal(b.stats.sent, 0);
    assert.equal(b.stats.last_sent_at, null);
  });

  test("failed and pending counted separately", async () => {
    await putV2([mk({ id: "a_A", keyword: "ONE", media_ids: ["A"] })]);
    g.failNext("dm", { status: 400, body: { error: { message: "bad", code: 100 } } });
    await webhook({ id: "F1", text: "one", media: "A" });
    // pending: enqueue but over budget
    await ingest(extractComments(changesPayload(commentValue({ id: "P1", text: "one", media: "A" }))), env, { budget: { sends: 0 } });
    const a = (await req("GET", "/api/automations")).json.automations[0];
    assert.equal(a.stats.failed, 1);
    assert.equal(a.stats.pending, 1);
    assert.equal(a.stats.sent, 0);
    assert.equal(a.stats.last_sent_at, null);
  });

  test("legacy keyword-only ledger records count toward the migrated automation (and only it)", async () => {
    await putConfig(env, { scope: { mode: "allowlist", media_ids: ["M1"] } });
    const call = ledger(env);
    const now = Date.now();
    await call("enqueue", { now, items: [
      { commentId: "L1", keyword: "DIWALI", text: "diwali", fromId: "1", mediaId: "M1", source: "webhook" },
      { commentId: "L2", keyword: "DIWALI", text: "diwali", fromId: "2", mediaId: "M1", source: "webhook" },
    ] });
    await sweepPending(env);
    await webhook({ id: "N1", text: "diwali", media: "M1" }); // new-style record
    const list = (await req("GET", "/api/automations")).json.automations;
    const d = list.find((a) => a.id === "a_diwali");
    assert.equal(d.stats.sent, 3, "2 legacy + 1 new");
    assert.ok(d.stats.last_sent_at);
    assert.equal(list.find((a) => a.id === "a_eye").stats.sent, 0);
  });

  test("legacy records do NOT count toward a user-created automation with the same keyword", async () => {
    await putV2([mk({ id: "a_zzz9", keyword: "DIWALI" })]);
    const call = ledger(env);
    await call("enqueue", { now: Date.now(), items: [{ commentId: "L1", keyword: "DIWALI", text: "diwali", fromId: "1", mediaId: "A", source: "webhook" }] });
    // processOne finds it by keyword since there's no automationId, so it is sent...
    await sweepPending(env);
    assert.equal(g.dms.length, 1);
    const a = (await req("GET", "/api/automations")).json.automations[0];
    // ...documenting current behaviour: stats key mismatch means it isn't counted anywhere.
    assert.equal(a.stats.sent, 0);
  });
});

// =====================================================================
describe("waiting / send-waiting", () => {
  const setup = async (more = {}) => {
    await putV2([
      mk({ id: "a_A", name: "Alpha", keyword: "DIWALI", media_ids: ["A"], allowed_at: { A: isoAgo(2 * H) }, dm: "alpha dm" }),
      mk({ id: "a_B", name: "Beta", keyword: "EYE", media_ids: ["B"], allowed_at: { B: isoAgo(2 * H) }, dm: "beta dm" }),
    ], more);
    g.comments.A = [
      row("W_NEW", "DIWALI", isoAgo(30 * 60_000)),                     // after allowed_at: auto-fires on poll
      row("W_OLD1", "diwali pls", isoAgo(5 * H), { id: "601", username: "u1" }),
      row("W_OLD2", "DIWALI!!", isoAgo(4 * H), { id: "602", username: "u2" }),
      row("W_NOMATCH", "nice reel", isoAgo(4 * H), { id: "603", username: "u3" }),
      row("W_ANCIENT", "diwali", isoAgo(9 * D), { id: "604", username: "u4" }),   // outside 7 days
      row("W_SELF", "diwali", isoAgo(4 * H), { id: IG_ID, username: "testuser" }),
    ];
    g.comments.B = [row("B_OLD", "eye", isoAgo(5 * H), { id: "700", username: "ub" })];
    g.comments.C = [row("C_OLD", "diwali", isoAgo(5 * H), { id: "800", username: "uc" })]; // not on any automation
  };

  test("GET waiting: only matching, older, on this automation's posts; sends nothing", async () => {
    await setup();
    await poll(env, {}); // the live poll answers W_NEW only
    assert.deepEqual(g.dms.map((d) => d.body.recipient.comment_id), ["W_NEW"]);
    const posts0 = g.posts.length;
    const r = await req("GET", "/api/automations/a_A/waiting");
    assert.equal(r.status, 200);
    const ids = r.json.comments.map((c) => c.comment_id).sort();
    assert.deepEqual(ids, ["W_OLD1", "W_OLD2"], "answered W_NEW, non-matching, ancient, self, other posts must be excluded");
    assert.deepEqual(Object.keys(r.json.comments[0]).sort(), ["comment_id", "media_id", "text", "timestamp", "user"]);
    const c1 = r.json.comments.find((c) => c.comment_id === "W_OLD1");
    assert.equal(c1.user, "u1");
    assert.equal(c1.text, "diwali pls");
    assert.equal(c1.media_id, "A");
    assert.ok(c1.timestamp);
    assert.equal(g.posts.length, posts0, "no POSTs (messages/replies) made by GET waiting");
    assert.equal(g.dms.length, 1);
  });

  test("GET waiting does not enqueue anything in the ledger and is repeatable", async () => {
    await setup();
    const size0 = env.LEDGER._storage._m.size;
    const a = await req("GET", "/api/automations/a_A/waiting");
    const b = await req("GET", "/api/automations/a_A/waiting");
    assert.deepEqual(a.json, b.json);
    assert.equal(env.LEDGER._storage._m.size, size0);
    assert.equal(g.posts.length, 0);
  });

  test("GET waiting scoped to the other automation", async () => {
    await setup();
    const r = await req("GET", "/api/automations/a_B/waiting");
    assert.deepEqual(r.json.comments.map((c) => c.comment_id), ["B_OLD"]);
  });

  test("GET waiting works while dry_run is on (it only previews)", async () => {
    await setup({ dry_run: true });
    const r = await req("GET", "/api/automations/a_A/waiting");
    assert.equal(r.status, 200);
    assert.ok(r.json.comments.some((c) => c.comment_id === "W_OLD1"));
    assert.equal(g.posts.length, 0);
  });

  test("GET waiting excludes a disabled automation's comments", async () => {
    await setup();
    await req("PUT", "/api/automations/a_A", { body: { enabled: false } });
    const r = await req("GET", "/api/automations/a_A/waiting");
    assert.deepEqual(r.json.comments, []);
  });

  test("POST send-waiting sends all waiting, returns counts", async () => {
    await setup();
    await poll(env, {});
    const r = await req("POST", "/api/automations/a_A/send-waiting", { body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.json.sent, 2);
    assert.equal(r.json.queued, 0);
    assert.equal(r.json.failed, 0);
    assert.deepEqual(r.json.results.map((x) => x.comment_id).sort(), ["W_OLD1", "W_OLD2"]);
    assert.ok(r.json.results.every((x) => x.result === "done" || x.result === "done_noack"));
    const sentTo = g.dms.map((d) => d.body.recipient.comment_id).sort();
    assert.deepEqual(sentTo, ["W_NEW", "W_OLD1", "W_OLD2"]);
    assert.ok(g.dms.every((d) => d.body.message.text === "alpha dm"));
    // now nothing is waiting any more
    assert.deepEqual((await req("GET", "/api/automations/a_A/waiting")).json.comments, []);
  });

  test("POST send-waiting respects comment_ids filter", async () => {
    await setup();
    await poll(env, {});
    const r = await req("POST", "/api/automations/a_A/send-waiting", { body: { comment_ids: ["W_OLD2"] } });
    assert.equal(r.json.sent, 1);
    assert.deepEqual(r.json.results.map((x) => x.comment_id), ["W_OLD2"]);
    assert.deepEqual(g.dms.map((d) => d.body.recipient.comment_id).sort(), ["W_NEW", "W_OLD2"]);
    const still = await req("GET", "/api/automations/a_A/waiting");
    assert.deepEqual(still.json.comments.map((c) => c.comment_id), ["W_OLD1"]);
  });

  test("POST send-waiting with no body at all sends all", async () => {
    await setup();
    await poll(env, {});
    const res = await api(new Request(ORIGIN + "/api/automations/a_A/send-waiting", { method: "POST", headers: { authorization: "Bearer adm" } }), env, new URL(ORIGIN + "/api/automations/a_A/send-waiting"));
    assert.equal((await res.json()).sent, 2);
  });

  test("POST send-waiting does not touch other automations' comments", async () => {
    await setup();
    await req("POST", "/api/automations/a_A/send-waiting", { body: {} });
    assert.ok(!g.dms.some((d) => d.body.recipient.comment_id === "B_OLD"));
  });

  test("POST send-waiting counts queued when over the per-run budget", async () => {
    env.MAX_SENDS_PER_RUN = "1";
    await setup();
    await poll(env, { budget: { sends: 99 } });
    const r = await req("POST", "/api/automations/a_A/send-waiting", { body: {} });
    assert.equal(r.json.sent, 1);
    assert.equal(r.json.queued, 1);
  });

  test("POST send-waiting counts failures", async () => {
    await setup();
    await poll(env, {});
    g.failNext("dm", { status: 400, body: { error: { message: "nope", code: 100 } } });
    const r = await req("POST", "/api/automations/a_A/send-waiting", { body: {} });
    assert.equal(r.json.failed, 1);
    assert.equal(r.json.sent, 1);
    assert.ok(r.json.results.find((x) => x.result === "failed").note);
  });

  test("POST send-waiting with dry_run on -> 409 and nothing sent", async () => {
    await setup({ dry_run: true });
    const r = await req("POST", "/api/automations/a_A/send-waiting", { body: {} });
    assert.equal(r.status, 409);
    assert.ok(r.json.error);
    assert.equal(g.posts.length, 0);
  });
});

// =====================================================================
describe("GET /api/posts", () => {
  test("maps fields: thumbnails, trial, automation_ids, next cursor", async () => {
    await putV2([
      mk({ id: "a_A", keyword: "ONE", media_ids: ["V1"] }),
      mk({ id: "a_all", keyword: "TWO", all_posts: true, media_ids: [] }),
      mk({ id: "a_off", keyword: "THREE", enabled: false, media_ids: ["V1"] }),
    ], { exclude_media_ids: ["EX"] });
    extra.media = {
      data: [
        { id: "V1", caption: "vid", media_type: "VIDEO", media_product_type: "REELS", thumbnail_url: "https://t/v1.jpg", media_url: "https://m/v1.mp4", permalink: "https://ig/reel/1", timestamp: "2026-11-09T02:14:35+0000", comments_count: 4, is_shared_to_feed: true },
        { id: "I1", media_type: "IMAGE", media_product_type: "FEED", media_url: "https://m/i1.jpg", permalink: "https://ig/p/1", timestamp: "t", comments_count: 0 },
        { id: "C1", media_type: "CAROUSEL_ALBUM", media_product_type: "FEED", media_url: "https://m/c1.jpg", permalink: "p", timestamp: "t" },
        { id: "T1", media_type: "VIDEO", media_product_type: "REELS", media_url: "https://m/t.mp4", is_shared_to_feed: false, permalink: "p", timestamp: "t" },
        { id: "EX", media_type: "IMAGE", media_product_type: "FEED", media_url: "u", permalink: "p", timestamp: "t" },
      ],
      paging: { cursors: { after: "CUR2" }, next: "https://graph/next" },
    };
    const r = await req("GET", "/api/posts?limit=10&after=CUR1");
    assert.equal(r.status, 200);
    assert.equal(extra.mediaQuery.limit, "10");
    assert.equal(extra.mediaQuery.after, "CUR1");
    assert.ok(extra.mediaQuery.fields.includes("thumbnail_url"));
    const p = Object.fromEntries(r.json.posts.map((x) => [x.id, x]));
    assert.equal(r.json.next, "CUR2");
    assert.equal(p.V1.thumbnail, "https://t/v1.jpg");
    assert.equal(p.V1.caption, "vid");
    assert.equal(p.V1.product_type, "REELS");
    assert.equal(p.V1.media_type, "VIDEO");
    assert.equal(p.V1.comments_count, 4);
    assert.equal(p.V1.trial, false);
    assert.equal(p.V1.permalink, "https://ig/reel/1");
    assert.deepEqual(p.V1.automation_ids.sort(), ["a_A", "a_all"]);
    assert.equal(p.I1.thumbnail, "https://m/i1.jpg");
    assert.equal(p.I1.caption, "");
    assert.equal(p.I1.comments_count, 0);
    assert.deepEqual(p.I1.automation_ids, ["a_all"]);
    assert.equal(p.C1.thumbnail, "https://m/c1.jpg");
    assert.equal(p.T1.thumbnail, null, "video without thumbnail_url: don't use media_url");
    assert.equal(p.T1.trial, true);
    assert.equal(p.I1.trial, false);
    assert.deepEqual(p.EX.automation_ids, [], "excluded post runs no automations");
  });

  test("no next page -> next null; limit clamped to 50; default 24", async () => {
    await putV2([]);
    extra.media = { data: [], paging: { cursors: { after: "X" } } };
    let r = await req("GET", "/api/posts");
    assert.equal(r.json.next, null);
    assert.deepEqual(r.json.posts, []);
    assert.equal(extra.mediaQuery.limit, "24");
    await req("GET", "/api/posts?limit=999");
    assert.equal(extra.mediaQuery.limit, "50");
    assert.equal(extra.mediaQuery.after, undefined);
  });

  test("falls back to helpers' media route (no paging) fine", async () => {
    await putV2([]);
    g.media = [{ id: "Z", media_type: "IMAGE", media_url: "u" }];
    const r = await req("GET", "/api/posts");
    assert.equal(r.json.posts[0].id, "Z");
    assert.equal(r.json.next, null);
  });

  test("Graph error -> 502 {error}; missing IG_ID -> 409", async () => {
    await putV2([]);
    g.failNext("media", { status: 400, body: { error: { message: "oauth broke", code: 190 } } });
    const r = await req("GET", "/api/posts");
    assert.equal(r.status, 502);
    assert.match(r.json.error, /oauth broke/);
    env.IG_ID = undefined;
    assert.equal((await req("GET", "/api/posts")).status, 409);
  });
});

// =====================================================================
describe("POST /api/try", () => {
  beforeEach(async () => {
    await putV2([
      mk({ id: "a_A", name: "Alpha", keyword: "DIWALI", media_ids: ["A"] }),
      mk({ id: "a_B", name: "Beta", keyword: "DIWALI", media_ids: ["B"], dm: "b" }),
      mk({ id: "a_X", name: "Exact one", keyword: "ORBIT", match: "exact", media_ids: ["A"] }),
      mk({ id: "a_off", name: "Off", keyword: "SLEEP", enabled: false, media_ids: ["A"] }),
    ]);
  });
  test("matches by automation, fuzzy typo", async () => {
    const r = await req("POST", "/api/try", { body: { text: "diwalii pls" } });
    assert.deepEqual(r.json.match, { automation_id: "a_A", name: "Alpha", keyword: "DIWALI", mode: "fuzzy" });
  });
  test("media_id scopes to automations running on that post", async () => {
    assert.equal((await req("POST", "/api/try", { body: { text: "diwali", media_id: "B" } })).json.match.automation_id, "a_B");
    assert.equal((await req("POST", "/api/try", { body: { text: "diwali", media_id: "A" } })).json.match.automation_id, "a_A");
    assert.equal((await req("POST", "/api/try", { body: { text: "diwali", media_id: "ZZZ" } })).json.match, null);
  });
  test("null when nothing matches / empty text / disabled automation", async () => {
    assert.deepEqual((await req("POST", "/api/try", { body: { text: "hello world" } })).json, { match: null });
    assert.deepEqual((await req("POST", "/api/try", { body: { text: "" } })).json, { match: null });
    assert.deepEqual((await req("POST", "/api/try", { body: {} })).json, { match: null });
    assert.deepEqual((await req("POST", "/api/try", { body: { text: "sleep" } })).json, { match: null });
  });
  test("exact mode: typo doesn't match, mode reported", async () => {
    assert.equal((await req("POST", "/api/try", { body: { text: "orbitt" } })).json.match, null);
    assert.equal((await req("POST", "/api/try", { body: { text: "orbit" } })).json.match.mode, "exact");
  });
  test("try respects exclude_media_ids", async () => {
    await putV2([mk({ id: "a_A", media_ids: ["A"] })], { exclude_media_ids: ["A"] });
    assert.equal((await req("POST", "/api/try", { body: { text: "diwali", media_id: "A" } })).json.match, null);
  });
  test("try sends nothing", async () => {
    await req("POST", "/api/try", { body: { text: "diwali" } });
    assert.equal(g.posts.length, 0);
  });
});

// =====================================================================
describe("GET /api/activity", () => {
  test("newest first, with automation_name; limit applies", async () => {
    await putV2([mk({ id: "a_A", name: "Alpha", keyword: "ONE" }), mk({ id: "a_B", name: "Beta", keyword: "TWO" })]);
    await webhook({ id: "C1", text: "one", media: "A", username: "first" });
    await new Promise((r) => setTimeout(r, 5));
    await webhook({ id: "C2", text: "two", media: "A", username: "second", fromId: "556" });
    await new Promise((r) => setTimeout(r, 5));
    await webhook({ id: "C3", text: "one", media: "A", username: "third", fromId: "557" });
    const r = await req("GET", "/api/activity");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.items.map((i) => i.comment_id), ["C3", "C2", "C1"]);
    const c2 = r.json.items[1];
    assert.equal(c2.automation_id, "a_B");
    assert.equal(c2.automation_name, "Beta");
    assert.equal(c2.keyword, "TWO");
    assert.equal(c2.user, "second");
    assert.equal(c2.text, "two");
    assert.equal(c2.media_id, "A");
    assert.equal(c2.source, "webhook");
    assert.equal(c2.stage, "done");
    assert.equal(c2.attempts, 1);
    assert.equal(c2.note, null);
    assert.ok(!Number.isNaN(Date.parse(c2.updated_at)));
    assert.deepEqual((await req("GET", "/api/activity?limit=2")).json.items.map((i) => i.comment_id), ["C3", "C2"]);
  });

  test("renamed automation shows its current name", async () => {
    await putV2([mk({ id: "a_A", name: "Old", keyword: "ONE" })]);
    await webhook({ id: "C1", text: "one", media: "A" });
    await req("PUT", "/api/automations/a_A", { body: { name: "Shiny" } });
    assert.equal((await req("GET", "/api/activity")).json.items[0].automation_name, "Shiny");
  });

  test("legacy records (keyword only) get automation_name/id via keyword", async () => {
    await putConfig(env);
    const call = ledger(env);
    await call("enqueue", { now: Date.now(), items: [{ commentId: "L1", keyword: "EYE", text: "eye", fromId: "1", fromUsername: "old", mediaId: "M1", source: "poll" }] });
    const it = (await req("GET", "/api/activity")).json.items[0];
    assert.equal(it.automation_id, "a_eye");
    assert.equal(it.automation_name, "Eye");
    assert.equal(it.stage, "new");
    assert.equal(it.source, "poll");
  });

  test("legacy record with a keyword that no longer exists falls back to keyword; deleted automation keeps stored name", async () => {
    await putV2([mk({ id: "a_A", name: "Alpha", keyword: "ONE" })]);
    const call = ledger(env);
    await call("enqueue", { now: Date.now(), items: [
      { commentId: "L1", keyword: "GONE", text: "gone", fromId: "1", mediaId: "A", source: "poll" },
      { commentId: "L2", keyword: "ONE", automationId: "a_dead", automationName: "Dead one", text: "one", fromId: "2", mediaId: "A", source: "poll" },
    ] });
    const items = (await req("GET", "/api/activity")).json.items;
    const l1 = items.find((i) => i.comment_id === "L1");
    const l2 = items.find((i) => i.comment_id === "L2");
    assert.equal(l1.automation_id, null);
    assert.equal(l1.automation_name, "GONE");
    assert.equal(l2.automation_id, "a_dead");
    assert.equal(l2.automation_name, "Dead one");
  });

  test("failed item carries note", async () => {
    await putV2([mk({ id: "a_A", keyword: "ONE" })]);
    g.failNext("dm", { status: 400, body: { error: { message: "blocked", code: 100 } } });
    await webhook({ id: "F1", text: "one", media: "A" });
    const it = (await req("GET", "/api/activity")).json.items[0];
    assert.equal(it.stage, "failed");
    assert.match(it.note, /blocked/);
  });
});

// =====================================================================
describe("GET /api/overview", () => {
  test("everything green -> ok true, account populated, totals numeric", async () => {
    await putV2([mk({ id: "a_A", keyword: "ONE" }), mk({ id: "a_B", keyword: "TWO", enabled: false })], { exclude_media_ids: ["E"] });
    await webhook({ id: "C1", text: "one", media: "A" });
    const r = await req("GET", "/api/overview");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.health, { ok: true, token: true, account: true, account_error: null, webhook_callback: true, webhook_comments: true, account_subscribed: true });
    assert.deepEqual(r.json.account, { id: IG_ID, username: "testuser", name: "Test User", picture: "https://pic/x.jpg", followers: 42 });
    const t = r.json.totals;
    assert.equal(t.automations, 2);
    assert.equal(t.active, 1);
    assert.equal(t.sent_24h, 1);
    assert.equal(t.sent_total, 1);
    assert.equal(t.failed, 0);
    assert.equal(t.pending, 0);
    for (const k of ["automations", "active", "sent_24h", "sent_total", "failed", "pending"]) assert.equal(typeof t[k], "number", k);
    assert.equal(r.json.settings.dry_run, false);
    assert.deepEqual(r.json.settings.exclude_media_ids, ["E"]);
  });

  test("totals count failures and pending", async () => {
    await putV2([mk({ id: "a_A", keyword: "ONE" })]);
    g.failNext("dm", { status: 400, body: { error: { message: "x" } } });
    await webhook({ id: "F", text: "one", media: "A" });
    await ingest(extractComments(changesPayload(commentValue({ id: "P", text: "one", media: "A", fromId: "9" }))), env, { budget: { sends: 0 } });
    const t = (await req("GET", "/api/overview")).json.totals;
    assert.equal(t.failed, 1);
    assert.equal(t.pending, 1);
    assert.equal(t.sent_total, 0);
  });

  test("token missing -> account null, health.account false, ok false", async () => {
    env = makeEnv({ APP_ID: "999", IG_TOKEN: undefined });
    _resetCaches();
    const r = await req("GET", "/api/overview", { auth: "bearer" });
    assert.equal(r.status, 200);
    assert.equal(r.json.account, null);
    assert.equal(r.json.health.token, false);
    assert.equal(r.json.health.account, false);
    assert.equal(r.json.health.account_subscribed, false);
    assert.equal(r.json.health.ok, false);
    assert.ok(r.json.health.account_error);
  });

  test("KV token counts as a token", async () => {
    env = makeEnv({ APP_ID: "999", IG_TOKEN: undefined });
    await env.KV.put("token", JSON.stringify({ access_token: "kvtok" }));
    _resetCaches();
    const r = await req("GET", "/api/overview");
    assert.equal(r.json.health.token, true);
    assert.equal(r.json.health.ok, true);
  });

  test("account error from Graph is surfaced", async () => {
    extra.account = { error: { message: "Invalid OAuth token", code: 190 } };
    const orig = globalThis.fetch;
    globalThis.fetch = async (i, init) => {
      const u = new URL(typeof i === "string" ? i : i.url ?? String(i));
      if (u.pathname === `/v27.0/${IG_ID}`) return new Response(JSON.stringify(extra.account), { status: 400 });
      return orig(i, init);
    };
    const r = await req("GET", "/api/overview");
    assert.equal(r.json.account, null);
    assert.equal(r.json.health.account, false);
    assert.match(r.json.health.account_error, /Invalid OAuth/);
    assert.equal(r.json.health.ok, false);
  });

  test("webhook not pointing at this Worker / no comments field / account not subscribed", async () => {
    extra.subscriptions = { data: [{ object: "instagram", active: true, callback_url: "https://other/webhook", fields: [{ name: "messages" }] }] };
    extra.subscribedApps = { data: [{ app_id: "123", subscribed_fields: ["comments"] }] };
    const h = (await req("GET", "/api/overview")).json.health;
    assert.equal(h.webhook_callback, false);
    assert.equal(h.webhook_comments, false);
    assert.equal(h.account_subscribed, false);
    assert.equal(h.ok, false);
    extra.subscribedApps = { data: [{ app_id: "999", subscribed_fields: ["messages"] }] };
    assert.equal((await req("GET", "/api/overview")).json.health.account_subscribed, false);
  });

  test("overview works with no APP_ID/APP_SECRET (webhook checks false, no crash)", async () => {
    env = makeEnv({ APP_SECRET: undefined });
    _resetCaches();
    const r = await req("GET", "/api/overview");
    assert.equal(r.status, 200);
    assert.equal(r.json.health.webhook_callback, false);
    assert.equal(r.json.health.ok, false);
  });
});

// =====================================================================
describe("PUT /api/settings and other tools", () => {
  test("toggles dry_run and persists; dry_run blocks sends", async () => {
    await putV2([mk({ id: "a_A", keyword: "ONE" })]);
    let r = await req("PUT", "/api/settings", { body: { dry_run: true } });
    assert.equal(r.status, 200);
    assert.equal(r.json.settings.dry_run, true);
    assert.equal(JSON.parse(await env.KV.get("config")).dry_run, true);
    assert.equal((await req("GET", "/api/overview")).json.settings.dry_run, true);
    await webhook({ id: "C1", text: "one", media: "A" });
    assert.equal(g.dms.length, 0, "preview mode sends nothing");
    r = await req("PUT", "/api/settings", { body: { dry_run: false } });
    assert.equal(r.json.settings.dry_run, false);
    assert.equal(JSON.parse(await env.KV.get("config")).dry_run, false);
    await webhook({ id: "C2", text: "one", media: "A" });
    assert.equal(g.dms.length, 1);
  });

  test("dry_run only true for literal true; other values -> false; empty body keeps state", async () => {
    await putV2([mk()], { dry_run: true });
    assert.equal((await req("PUT", "/api/settings", { body: {} })).json.settings.dry_run, true);
    assert.equal((await req("PUT", "/api/settings", { body: { dry_run: "yes" } })).json.settings.dry_run, false);
  });

  test("settings update keeps automations (and their allowed_at) intact", async () => {
    await putV2([mk({ allowed_at: { A: "2026-02-02T00:00:00.000Z" } })]);
    await req("PUT", "/api/settings", { body: { dry_run: true } });
    const cfg = await getConfig(env);
    assert.equal(cfg.automations.length, 1);
    assert.deepEqual(cfg.automations[0].allowed_at, { A: "2026-02-02T00:00:00.000Z" });
  });

  test("exclude_media_ids settable and sanitised", async () => {
    await putV2([mk()]);
    const r = await req("PUT", "/api/settings", { body: { exclude_media_ids: ["X1", "X1", "bad id!", 5] } });
    assert.deepEqual(r.json.settings.exclude_media_ids, ["X1", "5"]);
    assert.deepEqual((await getConfig(env)).exclude_media_ids, ["X1", "5"]);
  });

  test("settings: non-array exclude_media_ids doesn't crash", async () => {
    await putV2([mk()]);
    const r = await req("PUT", "/api/settings", { body: { exclude_media_ids: "oops" } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.settings.exclude_media_ids, []);
  });

  test("POST /api/reconnect returns an OAuth link (and saves state); 409 without config", async () => {
    env.LOGIN_CONFIG_ID = "cfg1";
    const r = await req("POST", "/api/reconnect");
    assert.equal(r.status, 200);
    const u = new URL(r.json.link);
    assert.equal(u.host, "www.facebook.com");
    assert.equal(u.searchParams.get("client_id"), "999");
    assert.equal(u.searchParams.get("config_id"), "cfg1");
    assert.equal(u.searchParams.get("redirect_uri"), `${ORIGIN}/auth/callback`);
    assert.ok(env.KV._m.has(`oauth_state:${u.searchParams.get("state")}`));
    delete env.LOGIN_CONFIG_ID;
    assert.equal((await req("POST", "/api/reconnect")).status, 409);
  });
});

// =====================================================================
describe("contract spot checks (docs/API.md)", () => {
  test("every error response is {error: string}", async () => {
    await putV2([]);
    const rs = [
      await req("GET", "/api/automations", { auth: "none" }),
      await req("POST", "/api/login", { auth: "none", body: { key: "x" } }),
      await req("POST", "/api/automations", { body: {} }),
      await req("PUT", "/api/automations/zzz", { body: {} }),
      await req("GET", "/api/whatever"),
    ];
    for (const r of rs) {
      assert.ok(r.status >= 400);
      assert.equal(typeof r.json.error, "string");
    }
  });
  test("responses are no-store JSON", async () => {
    const r = await req("GET", "/api/automations");
    assert.match(r.headers.get("content-type"), /application\/json/);
    assert.equal(r.headers.get("cache-control"), "no-store");
  });
  test("Automation shape has exactly the documented fields", async () => {
    await putV2([]);
    const a = (await req("POST", "/api/automations", { body: { keyword: "K", dm: "d" } })).json.automation;
    assert.deepEqual(Object.keys(a).sort(), ["ack", "aliases", "all_posts", "created_at", "dm", "enabled", "follow_gate", "gate_button", "gate_text", "id", "keyword", "like", "link", "match", "media_ids", "name", "opener", "opener_button", "stats", "updated_at"]);
  });
  test("Activity item has exactly the documented fields", async () => {
    await putV2([mk({ keyword: "ONE" })]);
    await webhook({ id: "C1", text: "one", media: "A" });
    const it = (await req("GET", "/api/activity")).json.items[0];
    assert.deepEqual(Object.keys(it).sort(), ["attempts", "automation_id", "automation_name", "comment_id", "keyword", "media_id", "note", "source", "stage", "text", "updated_at", "user"]);
  });
  test("Post shape has exactly the documented fields", async () => {
    await putV2([]);
    g.media = [{ id: "Z", media_type: "IMAGE", media_url: "u", media_product_type: "FEED", permalink: "p", timestamp: "t" }];
    const p = (await req("GET", "/api/posts")).json.posts[0];
    assert.deepEqual(Object.keys(p).sort(), ["automation_ids", "caption", "comments_count", "id", "media_type", "permalink", "product_type", "thumbnail", "timestamp", "trial"]);
  });
  test("PUT /api/settings returns documented settings (dry_run, exclude_media_ids)", async () => {
    const r = await req("PUT", "/api/settings", { body: { dry_run: true } });
    assert.deepEqual(Object.keys(r.json.settings).sort(), ["dry_run", "exclude_media_ids"]);
  });
});

describe("home-screen install", () => {
  test("manifest, icons and head tags are served", async () => {
    const worker = (await import("../src/index.js")).default;
    const env = makeEnv(); const ctx = makeCtx();
    const m = await worker.fetch(new Request("https://x/app/manifest.webmanifest"), env, ctx);
    assert.equal(m.headers.get("content-type"), "application/manifest+json");
    const man = await m.json();
    assert.equal(man.start_url, "/app"); assert.equal(man.display, "standalone");
    for (const p of ["/app/icons/apple-touch-icon.png", "/app/icons/icon-192.png", "/app/icons/icon-512.png"]) {
      const r = await worker.fetch(new Request("https://x" + p), env, ctx);
      assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "image/png");
      const b = new Uint8Array(await r.arrayBuffer()); assert.deepEqual([...b.slice(1, 4)], [80, 78, 71]); // "PNG"
    }
    assert.equal((await worker.fetch(new Request("https://x/app/icons/nope.png"), env, ctx)).status, 404);
    const html = await (await worker.fetch(new Request("https://x/app"), env, ctx)).text();
    assert.match(html, /rel="manifest"/); assert.match(html, /apple-touch-icon/);
    const csp = (await worker.fetch(new Request("https://x/app"), env, ctx)).headers.get("content-security-policy");
    assert.match(csp, /manifest-src 'self'/);
  });
});
