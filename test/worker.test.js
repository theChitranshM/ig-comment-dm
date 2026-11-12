import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { matchRule } from "../src/core.js";
import {
  IG_ID, makeEnv, makeCtx, putConfig, installGraph, webhookReq, sign,
  commentValue, changesPayload, _resetCaches, isoAgo, H, D,
} from "./helpers.js";

const realLog = console.log;
let env, ctx, g;
const DIWALI_DM = "here's the code 🪔 build your own\nhttps://github.com/theChitranshM/hands-on-fire";
const stageOf = (id) => env.LEDGER._storage._m.get(`c:${id}`)?.stage;

beforeEach(async () => {
  console.log = () => {};
  env = makeEnv();
  ctx = makeCtx();
  g = installGraph();
  _resetCaches();
  await putConfig(env);
});
afterEach(() => { g.restore(); console.log = realLog; });

const hook = async (payload, opts) => {
  const res = await worker.fetch(await webhookReq(payload, opts), env, ctx);
  await ctx.flush();
  return res;
};
const cron = async (c) => { await worker.scheduled({ cron: c }, env, ctx); await ctx.flush(); };
const DAILY = "17 10 * * *";
const pollRow = (id, text, ts = isoAgo(H), from = { id: "555", username: "someuser" }) => ({ id, text, timestamp: ts, from });

describe("AT1 DIWALI webhook", () => {
  test("AT1: one DM then one ack, correct bodies/auth, 200", async () => {
    const res = await hook(changesPayload(commentValue({ id: "C1", text: "DIWALI" })));
    assert.equal(res.status, 200);
    assert.equal(g.dms.length, 1);
    assert.equal(g.replies.length, 1);
    assert.deepEqual(g.dms[0].body, { recipient: { comment_id: "C1" }, message: { text: DIWALI_DM } });
    assert.equal(g.dms[0].auth, "Bearer tok");
    assert.equal(g.replies[0].path, "/v27.0/C1/replies");
    assert.deepEqual(g.replies[0].body, { message: "sent 🪔 check your dms" });
    assert.equal(g.replies[0].auth, "Bearer tok");
    assert.ok(g.calls.indexOf(g.dms[0]) < g.calls.indexOf(g.replies[0]), "DM before ack");
    assert.equal(g.posts.length, 2);
    assert.equal(stageOf("C1"), "done");
  });
});

describe("AT2 trial reel via polling", () => {
  test("AT2: poll finds TRIAL1 comment, fires once, second run is a no-op", async () => {
    g.comments.TRIAL1 = [pollRow("T1", "DIWALI")];
    await cron("*/5 * * * *");
    assert.equal(g.dms.length, 1);
    assert.equal(g.replies.length, 1);
    assert.equal(g.dms[0].body.recipient.comment_id, "T1");
    assert.equal(g.replies[0].path, "/v27.0/T1/replies");
    const cq = g.byKind("comments").find((c) => c.target === "TRIAL1");
    assert.ok(cq, "polled TRIAL1/comments");
    assert.ok(cq.query.fields.split(",").includes("from"), cq.query.fields);
    await cron("*/5 * * * *");
    assert.equal(g.dms.length, 1);
    assert.equal(g.replies.length, 1);
  });
});

describe("AT3 dedupe", () => {
  test("AT3: identical signed webhook x3 sequential -> one DM, one ack", async () => {
    const p = changesPayload(commentValue({ id: "C3" }));
    for (let i = 0; i < 3; i++) assert.equal((await hook(p)).status, 200);
    assert.equal(g.dms.length, 1);
    assert.equal(g.replies.length, 1);
  });
  test("AT3: identical signed webhook x3 concurrent -> one DM, one ack", async () => {
    const p = changesPayload(commentValue({ id: "C3" }));
    const rs = await Promise.all([0, 1, 2].map(async () => worker.fetch(await webhookReq(p), env, ctx)));
    await ctx.flush();
    rs.forEach((r) => assert.equal(r.status, 200));
    assert.equal(g.dms.length, 1);
    assert.equal(g.replies.length, 1);
  });
  test("AT3: webhook then poll returning same comment -> still one", async () => {
    await hook(changesPayload(commentValue({ id: "C4", media: "M1" })));
    g.comments.M1 = [pollRow("C4", "DIWALI")];
    await cron("*/5 * * * *");
    assert.equal(g.dms.length, 1);
    assert.equal(g.replies.length, 1);
  });
  test("AT3: poll first then webhook -> still one", async () => {
    g.comments.M1 = [pollRow("C5", "DIWALI")];
    await cron("*/5 * * * *");
    await hook(changesPayload(commentValue({ id: "C5" })));
    assert.equal(g.dms.length, 1);
  });
});

describe("AT4 self comments", () => {
  test("AT4: from.id === IG_ID", async () => {
    await hook(changesPayload(commentValue({ id: "S1", fromId: IG_ID, username: "x" })));
    assert.equal(g.posts.length, 0);
  });
  test("AT4: from.id === entry.id (entry differs from IG_ID)", async () => {
    await hook(changesPayload(commentValue({ id: "S2", fromId: "999", username: "x" }), "999"));
    assert.equal(g.posts.length, 0);
  });
  test("AT4: username match case-insensitive, different id", async () => {
    await hook(changesPayload(commentValue({ id: "S3", fromId: "123", username: "TestUser" })));
    assert.equal(g.posts.length, 0);
  });
  test("AT4: self via polling is skipped too", async () => {
    g.comments.M1 = [pollRow("S4", "DIWALI", isoAgo(H), { id: IG_ID, username: "testuser" })];
    await cron("*/5 * * * *");
    assert.equal(g.posts.length, 0);
  });
});

describe("AT5 keyword matching", () => {
  const fires = async (text, id) => {
    g.calls.length = 0;
    await hook(changesPayload(commentValue({ id, text })));
    return g.dms[0]?.body.message.text;
  };
  test("AT5: omg DIWALI pls 🙏 fires", async () => assert.equal(await fires("omg DIWALI pls 🙏", "K1"), DIWALI_DM));
  test("AT5: happy diwali!! fires", async () => assert.equal(await fires("happy diwali!!", "K2"), DIWALI_DM));
  test("AT5: #diwali fires", async () => assert.equal(await fires("#diwali", "K3"), DIWALI_DM));
  test("AT5: misspelled / stretched / accented diwali fires (fuzzy default)", async () => {
    for (const [i, t] of ["diwalli", "divali", "Diwaliii 🪔", "dīwālī", "di wali", "D I W A L I"].entries()) {
      _resetCaches();
      assert.ok(await fires(t, `F${i}`), t);
    }
  });
  test("AT5: eye -> ThirdEye", async () => {
    const t = await fires("eye", "K5");
    assert.match(t, /theChitranshM\/ThirdEye$/);
    assert.equal(g.replies[0].body.message, "sent 👁️ check your dms");
  });
  test("AT5: the orb -> FortuneOrb", async () => assert.match(await fires("the orb", "K6"), /theChitranshM\/FortuneOrb$/));
});

describe("AT6 daily sweep / 7-day window", () => {
  test("AT6: missed comment (1h old) found by daily sweep, fires once; no refire; 8d old ignored", async () => {
    g.comments.M1 = [pollRow("D1", "DIWALI", isoAgo(H)), pollRow("OLD", "DIWALI", isoAgo(8 * D))];
    await cron(DAILY);
    assert.equal(g.dms.length, 1);
    assert.equal(g.dms[0].body.recipient.comment_id, "D1");
    assert.equal(g.replies.length, 1);
    assert.equal(stageOf("OLD"), undefined);
    await cron(DAILY);
    assert.equal(g.dms.length, 1);
    assert.equal(g.replies.length, 1);
  });
  test("AT6: daily full sweep in mode=all lists /media and polls them", async () => {
    await putConfig(env, { scope: { mode: "all", media_ids: [] } });
    g.media = [{ id: "MX" }];
    g.comments.MX = [pollRow("D2", "diwali")];
    await cron(DAILY);
    assert.equal(g.byKind("media")[0].query.limit, "8");
    assert.equal(g.dms.length, 1);
  });
});

describe("GET /webhook handshake", () => {
  const get = (qs) => worker.fetch(new Request("https://x/webhook" + qs), env, ctx);
  test("correct token echoes challenge", async () => {
    const r = await get("?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=abc123");
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "abc123");
  });
  test("wrong token -> 403", async () => assert.equal((await get("?hub.mode=subscribe&hub.verify_token=no&hub.challenge=x")).status, 403));
  test("missing token -> 403", async () => assert.equal((await get("?hub.mode=subscribe&hub.challenge=x")).status, 403));
  test("empty VERIFY_TOKEN env never matches", async () => {
    env.VERIFY_TOKEN = "";
    assert.equal((await get("?hub.mode=subscribe&hub.verify_token=&hub.challenge=x")).status, 403);
  });
});

describe("signature", () => {
  const p = () => changesPayload(commentValue({ id: "G1" }));
  test("valid APP_SECRET -> 200", async () => { assert.equal((await hook(p())).status, 200); assert.equal(g.dms.length, 1); });
  test("valid IG_APP_SECRET -> 200", async () => { assert.equal((await hook(p(), { secret: "igsecret" })).status, 200); assert.equal(g.dms.length, 1); });
  test("wrong secret -> 401", async () => { assert.equal((await hook(p(), { secret: "nope" })).status, 401); assert.equal(g.calls.length, 0); });
  test("missing header -> 401", async () => { assert.equal((await hook(p(), { header: null })).status, 401); assert.equal(g.calls.length, 0); });
  test("malformed header -> 401", async () => { assert.equal((await hook(p(), { header: "sha256=zz" })).status, 401); assert.equal(g.calls.length, 0); });
  test("tampered body -> 401", async () => {
    const body = JSON.stringify(p());
    const sig = await sign(body, "appsecret");
    const res = await worker.fetch(new Request("https://x/webhook", { method: "POST", headers: { "x-hub-signature-256": sig }, body: body.replace("DIWALI", "DIWALI ") }), env, ctx);
    await ctx.flush();
    assert.equal(res.status, 401);
    assert.equal(g.calls.length, 0);
  });
  test("signed non-JSON body -> 400", async () => {
    assert.equal((await hook(null, { rawBody: "not json" })).status, 400);
  });
});

describe("payload shapes", () => {
  test("changes[] shape", async () => { await hook(changesPayload(commentValue({ id: "P1" }))); assert.equal(g.dms.length, 1); });
  test("flat entry.{field,value} shape", async () => {
    await hook({ object: "instagram", entry: [{ id: IG_ID, field: "comments", value: commentValue({ id: "P2" }) }] });
    assert.equal(g.dms.length, 1);
    assert.equal(g.dms[0].body.recipient.comment_id, "P2");
  });
  test("value.comment_id instead of value.id", async () => {
    const v = commentValue({ id: "P3" }); delete v.id; v.comment_id = "P3";
    await hook(changesPayload(v));
    assert.equal(g.dms[0].body.recipient.comment_id, "P3");
  });
  test("non-comments field ignored", async () => {
    await hook({ object: "instagram", entry: [{ id: IG_ID, changes: [{ field: "mentions", value: commentValue({ id: "P4" }) }] }] });
    assert.equal(g.calls.length, 0);
  });
  test("multiple entries/changes in one payload", async () => {
    await hook({ object: "instagram", entry: [
      { id: IG_ID, changes: [{ field: "comments", value: commentValue({ id: "P5" }) }, { field: "comments", value: commentValue({ id: "P6" }) }] },
      { id: IG_ID, changes: [{ field: "comments", value: commentValue({ id: "P7" }) }] },
    ] });
    assert.equal(g.dms.length, 3);
  });
});

describe("failure handling", () => {
  test("DM permanent 400 -> no ack, stage failed, never retried", async () => {
    g.failNext("dm", { status: 400, body: { error: { message: "bad", code: 100 } } });
    await hook(changesPayload(commentValue({ id: "F1" })));
    assert.equal(g.dms.length, 1);
    assert.equal(g.replies.length, 0);
    assert.equal(stageOf("F1"), "failed");
    await cron("*/5 * * * *");
    assert.equal(g.dms.length, 1);
  });
  test("DM transient 500 -> no ack; sweep retries -> success, one ack", async () => {
    g.failNext("dm", { status: 500, body: { error: { message: "oops" } } });
    await hook(changesPayload(commentValue({ id: "F2" })));
    assert.equal(g.replies.length, 0);
    assert.equal(stageOf("F2"), "new");
    await cron("*/5 * * * *");
    assert.equal(g.dms.length, 2);
    assert.equal(g.replies.length, 1);
    assert.equal(stageOf("F2"), "done");
  });
  test("DM network throw is transient", async () => {
    g.failNext("dm", "throw");
    await hook(changesPayload(commentValue({ id: "F2b" })));
    assert.equal(stageOf("F2b"), "new");
    await cron("*/5 * * * *");
    assert.equal(stageOf("F2b"), "done");
  });
  test("DM ok + ack transient fail -> retry sends ONLY the ack", async () => {
    g.failNext("reply", { status: 500, body: { error: { message: "oops" } } });
    await hook(changesPayload(commentValue({ id: "F3" })));
    assert.equal(g.dms.length, 1);
    assert.equal(g.replies.length, 1);
    assert.equal(stageOf("F3"), "dm_sent");
    await cron("*/5 * * * *");
    assert.equal(g.dms.length, 1, "no second DM");
    assert.equal(g.replies.length, 2);
    assert.equal(stageOf("F3"), "done");
  });
  test("ack permanent failure -> done_noack, no retry", async () => {
    g.failNext("reply", { status: 400, body: { error: { message: "nope", code: 100 } } });
    await hook(changesPayload(commentValue({ id: "F4" })));
    assert.equal(stageOf("F4"), "done_noack");
    await cron("*/5 * * * *");
    assert.equal(g.dms.length, 1);
    assert.equal(g.replies.length, 1);
  });
  test("Graph error code 4 (rate limit) on 400 is transient", async () => {
    g.failNext("dm", { status: 400, body: { error: { message: "rate", code: 4 } } });
    await hook(changesPayload(commentValue({ id: "F5" })));
    assert.equal(stageOf("F5"), "new");
  });
  test("gives up after 5 attempts -> failed", async () => {
    for (let i = 0; i < 6; i++) g.failNext("dm", { status: 500, body: {} });
    await hook(changesPayload(commentValue({ id: "F6" })));
    for (let i = 0; i < 6; i++) await cron("*/5 * * * *");
    assert.equal(stageOf("F6"), "failed");
    assert.equal(g.dms.length, 5);
  });
});

describe("scope and dry run", () => {
  test("media not in allowlist -> nothing", async () => {
    await hook(changesPayload(commentValue({ id: "A1", media: "OTHER" })));
    assert.equal(g.calls.length, 0);
  });
  test("excluded media in mode=all -> nothing", async () => {
    await putConfig(env, { scope: { mode: "all", media_ids: [], exclude_media_ids: ["BAD"] } });
    await hook(changesPayload(commentValue({ id: "A2", media: "BAD" })));
    await hook(changesPayload(commentValue({ id: "A3", media: "GOOD" })));
    assert.deepEqual(g.dms.map((d) => d.body.recipient.comment_id), ["A3"]);
  });
  test("dry_run -> no Graph POSTs", async () => {
    await putConfig(env, { dry_run: true });
    await hook(changesPayload(commentValue({ id: "A4" })));
    assert.equal(g.posts.length, 0);
    assert.equal(stageOf("A4"), undefined); // preview leaves no ledger trace
  });
  test("dry_run preview, then real run still sends exactly once", async () => {
    await putConfig(env, { dry_run: true });
    await hook(changesPayload(commentValue({ id: "A6" })));
    assert.equal(g.posts.length, 0);
    await putConfig(env, { dry_run: false });
    await hook(changesPayload(commentValue({ id: "A6" })));
    assert.equal(g.dms.length, 1);
    assert.equal(g.replies.length, 1);
  });
  test("disabled rule does not fire", async () => {
    const cfg = await putConfig(env);
    cfg.rules[0].enabled = false;
    await env.KV.put("config", JSON.stringify(cfg)); _resetCaches();
    await hook(changesPayload(commentValue({ id: "A5" })));
    assert.equal(g.dms.length, 0);
  });
});

describe("matching modes (unit)", () => {
  const R = [
    { keyword: "DIWALI", dm: "d" },
    { keyword: "EYE", dm: "e" },
    { keyword: "ORB", dm: "o" },
    { keyword: "GUIDE", dm: "g", match: "exact" },
  ];
  const m = (t) => matchRule(t, R)?.keyword ?? null;
  test("short keywords get no typo tolerance", () => {
    for (const t of ["bye", "aye", "orbs", "pick a or b", "by e"]) assert.equal(m(t), null, t);
    for (const t of ["eyeee", "the orb", "orbbb"]) assert.ok(m(t), t);
  });
  test("exact mode: no fuzz, still case-insensitive and standalone", () => {
    assert.equal(m("GuIdE pls"), "GUIDE");
    for (const t of ["guides", "guid", "misguided"]) assert.equal(m(t), null, t);
  });
  test("unrelated words don't fuzzy-match", () => {
    for (const t of ["i love the wall", "dear wally", "we all", "diwan"]) assert.equal(m(t), null, t);
  });
});

describe("safe switch-on + send budget", () => {
  test("comments older than allowed_at are skipped by polls, answered by backfill", async () => {
    const cfg = await putConfig(env);
    cfg.scope.allowed_at = { M1: new Date().toISOString() };
    await env.KV.put("config", JSON.stringify(cfg)); _resetCaches();
    g.comments.M1 = [{ ...pollRow("OLD1", "DIWALI"), timestamp: isoAgo(3600_000) }];
    await cron("*/5 * * * *");
    assert.equal(g.dms.length, 0);
    const r = await worker.fetch(new Request("https://x/admin/poll?full=1&backfill=1", { method: "POST", headers: { authorization: "Bearer adm" } }), env, ctx);
    await ctx.flush();
    assert.equal(r.status, 200);
    assert.equal(g.dms.length, 1);
  });
  test("over-budget sends stay queued and go out on the next sweep, once each", async () => {
    await putConfig(env);
    env.MAX_SENDS_PER_RUN = "2";
    g.comments.M1 = ["B1", "B2", "B3", "B4", "B5"].map((id) => pollRow(id, "DIWALI"));
    await cron("*/5 * * * *");
    assert.equal(g.dms.length, 2);
    await cron("*/5 * * * *");
    assert.equal(g.dms.length, 4);
    await cron("*/5 * * * *");
    await cron("*/5 * * * *");
    assert.equal(g.dms.length, 5);
    assert.equal(new Set(g.dms.map((d) => d.body.recipient.comment_id)).size, 5);
  });
});

describe("already handled elsewhere", () => {
  test("skip_comment_ids are never acted on", async () => {
    const cfg = await putConfig(env);
    cfg.scope.skip_comment_ids = ["S1"];
    await env.KV.put("config", JSON.stringify(cfg)); _resetCaches();
    await hook(changesPayload(commentValue({ id: "S1" })));
    assert.equal(g.posts.length, 0);
  });
  test("poll skips a keyword comment that already has a reply from the account", async () => {
    await putConfig(env);
    g.comments.M1 = [
      { ...pollRow("H1", "Diwali"), replies: { data: [{ username: "testuser" }] } },
      pollRow("H2", "Diwali"),
    ];
    await cron("*/5 * * * *");
    assert.equal(g.dms.length, 1);
    assert.equal(g.dms[0].body.recipient.comment_id, "H2");
  });
});

describe("unified login (system-user token)", () => {
  test("all Graph calls go to graph.facebook.com", async () => {
    await hook(changesPayload(commentValue({ id: "U1" })));
    assert.equal(g.dms.length, 1);
    for (const c of g.posts) assert.equal(c.host, "graph.facebook.com");
  });
  test("webhook with value.comment_id (Unified/FLB shape) fires once", async () => {
    const v = commentValue({ id: "U2" }); v.comment_id = v.id; delete v.id;
    await hook(changesPayload(v));
    assert.equal(g.dms.length, 1);
    assert.equal(g.dms[0].body.recipient.comment_id, "U2");
  });
  test("daily cron health-checks the token and never calls refresh", async () => {
    await cron(DAILY);
    assert.equal(g.byKind("accounts").length, 1);
    assert.equal(g.byKind("refresh").length, 0);
  });
});

describe("token refresh (ig_login route only)", () => {
  beforeEach(() => { env.TOKEN_KIND = "ig_login"; });
  test("10 days left -> refresh called, new token + expires_at stored", async () => {
    const before = Date.now();
    await env.KV.put("token", JSON.stringify({ access_token: "oldtok", expires_at: Date.now() + 10 * D }));
    await cron(DAILY);
    const r = g.byKind("refresh");
    assert.equal(r.length, 1);
    assert.equal(r[0].query.access_token, "oldtok");
    assert.equal(r[0].query.grant_type, "ig_refresh_token");
    const t = await env.KV.get("token", "json");
    assert.equal(t.access_token, "newtok");
    assert.ok(Math.abs(t.expires_at - (before + 5184000_000)) < 60_000);
  });
  test("40 days left -> no refresh", async () => {
    await env.KV.put("token", JSON.stringify({ access_token: "oldtok", expires_at: Date.now() + 40 * D }));
    await cron(DAILY);
    assert.equal(g.byKind("refresh").length, 0);
  });
  test("5-minute cron never refreshes", async () => {
    await env.KV.put("token", JSON.stringify({ access_token: "oldtok", expires_at: Date.now() + 1 * D }));
    await cron("*/5 * * * *");
    assert.equal(g.byKind("refresh").length, 0);
  });
  test("KV token is used as Bearer once present", async () => {
    await env.KV.put("token", JSON.stringify({ access_token: "kvtok", expires_at: Date.now() + 40 * D }));
    await hook(changesPayload(commentValue({ id: "T9" })));
    assert.equal(g.dms[0].auth, "Bearer kvtok");
  });
});

describe("admin", () => {
  test("status without bearer -> 401", async () => {
    const r = await worker.fetch(new Request("https://x/admin/status"), env, ctx);
    assert.equal(r.status, 401);
  });
  test("status with wrong bearer -> 401", async () => {
    const r = await worker.fetch(new Request("https://x/admin/status", { headers: { authorization: "Bearer no" } }), env, ctx);
    assert.equal(r.status, 401);
  });
  test("status with bearer -> 200", async () => {
    const r = await worker.fetch(new Request("https://x/admin/status", { headers: { authorization: "Bearer adm" } }), env, ctx);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.ledger && j.config);
  });
  test("admin unauthenticated when ADMIN_KEY unset", async () => {
    env.ADMIN_KEY = undefined;
    const r = await worker.fetch(new Request("https://x/admin/status", { headers: { authorization: "Bearer undefined" } }), env, ctx);
    assert.equal(r.status, 401);
  });
  test("PUT /admin/config validates and applies", async () => {
    const bad = await worker.fetch(new Request("https://x/admin/config", { method: "PUT", headers: { authorization: "Bearer adm" }, body: "{}" }), env, ctx);
    assert.equal(bad.status, 400);
  });
});

describe("like the comment", () => {
  const withLike = async () => {
    const cfg = JSON.parse(await env.KV.get("config"));
    cfg.rules[0].like = true; // v1 rules migrate with their fields intact
    await env.KV.put("config", JSON.stringify(cfg));
    _resetCaches();
  };
  const likes = () => g.byKind("like");

  test("off by default: no like call", async () => {
    await hook(changesPayload(commentValue({ id: "L0" })));
    assert.equal(g.dms.length, 1);
    assert.equal(likes().length, 0);
  });
  test("on: likes after the DM, before the public reply", async () => {
    await withLike();
    await hook(changesPayload(commentValue({ id: "L1" })));
    assert.equal(likes().length, 1);
    assert.deepEqual(likes()[0].body, { comment_id: "L1" });
    assert.equal(likes()[0].auth, "Bearer tok");
    assert.ok(g.calls.indexOf(g.dms[0]) < g.calls.indexOf(likes()[0]), "DM before like");
    assert.ok(g.calls.indexOf(likes()[0]) < g.calls.indexOf(g.replies[0]), "like before reply");
    assert.equal(stageOf("L1"), "done");
  });
  test("failed DM → no like", async () => {
    await withLike();
    g.failNext("dm", { status: 400, body: { error: { message: "bad", code: 100 } } });
    await hook(changesPayload(commentValue({ id: "L2" })));
    assert.equal(likes().length, 0);
  });
  test("failed like (e.g. missing permission) never blocks the reply or retries", async () => {
    await withLike();
    g.failNext("like", { status: 403, body: { error: { message: "(#10) needs instagram_manage_engagement", code: 10 } } });
    await hook(changesPayload(commentValue({ id: "L3" })));
    assert.equal(g.replies.length, 1);
    assert.equal(stageOf("L3"), "done");
    await cron("*/5 * * * *");
    assert.equal(likes().length, 1);
    assert.equal(g.dms.length, 1);
  });
  test("ack retry does not like twice", async () => {
    await withLike();
    g.failNext("reply", { status: 500, body: { error: { message: "oops" } } });
    await hook(changesPayload(commentValue({ id: "L4" })));
    await cron("*/5 * * * *");
    assert.equal(g.replies.length, 2);
    assert.equal(likes().length, 1);
    assert.equal(stageOf("L4"), "done");
  });
});

describe("follow to unlock", () => {
  const gateOn = async (extra = {}) => {
    const cfg = JSON.parse(await env.KV.get("config"));
    Object.assign(cfg.rules[0], { follow_gate: true, ...extra });
    await env.KV.put("config", JSON.stringify(cfg));
    _resetCaches();
  };
  const tap = (payload, { mid = "PB1", sender = "777" } = {}) =>
    hook({ object: "instagram", entry: [{ id: IG_ID, time: 1, messaging: [{ sender: { id: sender }, recipient: { id: IG_ID }, timestamp: 1, postback: { mid, title: "x", payload } }] }] });
  const sends = () => g.dms.filter((d) => d.body.recipient.id);

  test("comment gets a button DM, not the link; ack still posts", async () => {
    await gateOn();
    await hook(changesPayload(commentValue({ id: "G1" })));
    const m = g.dms[0].body.message;
    assert.equal(m.attachment.payload.template_type, "button");
    assert.equal(m.attachment.payload.buttons[0].type, "postback");
    assert.equal(m.attachment.payload.buttons[0].payload, "unlock:a_diwali:1");
    assert.doesNotMatch(JSON.stringify(m), /hands-on-fire/);
    assert.equal(g.replies.length, 1);
    assert.equal(stageOf("G1"), "done");
  });
  test("custom opener text and button label are used", async () => {
    await gateOn({ opener: "click below to get the guide", opener_button: "Yes! I want it" });
    await hook(changesPayload(commentValue({ id: "G1b" })));
    const p = g.dms[0].body.message.attachment.payload;
    assert.equal(p.text, "click below to get the guide");
    assert.equal(p.buttons[0].title, "Yes! I want it");
  });
  test("button rejected → falls back to the plain link once", async () => {
    await gateOn();
    g.failNext("dm", { status: 400, body: { error: { message: "Invalid parameter", code: 100 } } });
    await hook(changesPayload(commentValue({ id: "G2" })));
    assert.equal(g.dms.length, 2);
    assert.deepEqual(g.dms[1].body.message, { text: DIWALI_DM });
    assert.equal(stageOf("G2"), "done");
  });
  test("follower taps → gets the link", async () => {
    await gateOn();
    g.follows["777"] = true;
    await tap("unlock:a_diwali:1");
    assert.equal(g.byKind("profile").length, 1);
    assert.equal(sends().length, 1);
    assert.deepEqual(sends()[0].body, { recipient: { id: "777" }, message: { text: DIWALI_DM } });
  });
  test("non-follower taps → follow-first message with an I'm following button; after following → link", async () => {
    await gateOn();
    await tap("unlock:a_diwali:1", { mid: "PB2" });
    const p = sends()[0].body.message.attachment.payload;
    assert.match(p.text, /follow/);
    assert.equal(p.buttons[0].payload, "unlock:a_diwali:2");
    await tap("unlock:a_diwali:2", { mid: "PB3" });
    assert.match(sends()[1].body.message.attachment.payload.text, /can't see the follow yet/);
    g.follows["777"] = true;
    await tap("unlock:a_diwali:2", { mid: "PB4" });
    assert.deepEqual(sends()[2].body.message, { text: DIWALI_DM });
  });
  test("a retried webhook for the same tap acts once", async () => {
    await gateOn();
    g.follows["777"] = true;
    await tap("unlock:a_diwali:1", { mid: "PB5" });
    await tap("unlock:a_diwali:1", { mid: "PB5" });
    assert.equal(sends().length, 1);
  });
  test("follow check unavailable → lets them through", async () => {
    await gateOn();
    g.failNext("profile", { status: 400, body: { error: { message: "nope", code: 100 } } });
    await tap("unlock:a_diwali:1", { mid: "PB6" });
    assert.deepEqual(sends()[0].body.message, { text: DIWALI_DM });
  });
  test("a person hammering the button is throttled (6 taps a minute)", async () => {
    await gateOn();
    for (let i = 0; i < 9; i++) await tap("unlock:a_diwali:2", { mid: "H" + i });
    assert.equal(sends().length, 6);
  });
  test("non-numeric sender ids are ignored", async () => {
    await gateOn();
    g.follows["777"] = true;
    await tap("unlock:a_diwali:1", { mid: "N1", sender: "../me" });
    assert.equal(sends().length, 0);
  });
  test("ignores own echoes, foreign payloads, paused automations and preview mode", async () => {
    await gateOn();
    g.follows["777"] = true;
    await tap("unlock:a_diwali:1", { mid: "E1", sender: IG_ID });
    await tap("something:else", { mid: "E2" });
    await tap("unlock:a_nope:1", { mid: "E3" });
    await gateOn({ enabled: false });
    await tap("unlock:a_diwali:1", { mid: "E4" });
    await gateOn({ enabled: true });
    const cfg = JSON.parse(await env.KV.get("config")); cfg.dry_run = true; await env.KV.put("config", JSON.stringify(cfg)); _resetCaches();
    await tap("unlock:a_diwali:1", { mid: "E5" });
    assert.equal(sends().length, 0);
  });
});

describe("like-only connection", () => {
  test("likes use the separate like token when connected; DMs keep the main token", async () => {
    await env.KV.put("like_token", JSON.stringify({ access_token: "liketok" }));
    const cfg = JSON.parse(await env.KV.get("config")); cfg.rules[0].like = true; await env.KV.put("config", JSON.stringify(cfg)); _resetCaches();
    await hook(changesPayload(commentValue({ id: "LT1" })));
    assert.equal(g.byKind("like")[0].auth, "Bearer liketok");
    assert.equal(g.dms[0].auth, "Bearer tok");
    assert.equal(g.replies[0].auth, "Bearer tok");
  });
  test("like-only OAuth callback stores like_token, never touches the main token", async () => {
    await env.KV.put("oauth_state:S1", "like");
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const u = String(input instanceof Request ? input.url : input);
      if (u.includes("/oauth/access_token")) return Response.json({ access_token: "newlike" });
      if (u.includes("/me/permissions")) return Response.json({ data: [{ permission: "instagram_manage_engagement", status: "granted" }] });
      return realFetch(input, init);
    };
    try {
      const res = await worker.fetch(new Request("https://x/auth/callback?state=S1&code=abc"), env, ctx);
      assert.equal(res.status, 200);
      assert.match(await res.text(), /Liking connected/);
    } finally { globalThis.fetch = realFetch; }
    assert.equal(JSON.parse(await env.KV.get("like_token")).access_token, "newlike");
    assert.notEqual(JSON.parse((await env.KV.get("token")) ?? "{}").access_token, "newlike");
  });
});
