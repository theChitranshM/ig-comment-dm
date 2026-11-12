import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { watch, notify } from "../src/alerts.js";
import { makeEnv, putConfig, installGraph, _resetCaches } from "./helpers.js";

const BLOCKED = { status: 400, body: { error: { message: "API access blocked.", code: 200 } } };
const realLog = console.log;
let env, g, pushes, graphFetch;

beforeEach(async () => {
  console.log = () => {};
  _resetCaches();
  env = makeEnv({ ALERT_WEBHOOK_URL: "https://hooks.example/abc" });
  await putConfig(env);
  g = installGraph();
  graphFetch = globalThis.fetch;
  pushes = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(typeof input === "string" ? input : input.url);
    if (url.startsWith("https://hooks.example/")) {
      const content = JSON.parse(init.body).content;
      const [first, ...rest] = content.split("\n");
      pushes.push({ url, title: first.replace(/\*\*/g, ""), body: rest.join("\n"), content });
      return new Response("ok");
    }
    return graphFetch(input, init);
  };
});
afterEach(() => { g.restore(); console.log = realLog; });

describe("alerts", () => {
  test("no channel configured → does nothing, makes no calls", async () => {
    delete env.ALERT_WEBHOOK_URL;
    const r = await watch(env);
    assert.match(r.skipped, /no alert channel/);
    assert.equal(g.calls.length, 0);
  });

  test("healthy → no alert, and no KV write after the baseline", async () => {
    await watch(env);
    const writes = env.KV._writes ?? null;
    await watch(env);
    assert.equal(pushes.length, 0);
    if (writes != null) assert.equal(env.KV._writes, writes);
  });

  test("one failed check stays quiet; two in a row fire one 'down' alert", async () => {
    g.failNext("accounts", BLOCKED);
    await watch(env);
    assert.equal(pushes.length, 0);
    g.failNext("accounts", BLOCKED, BLOCKED, BLOCKED);
    await watch(env);
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].title, "Instagram access is down");
    assert.match(pushes[0].body, /API access blocked/);
    await watch(env); // still down → no repeat
    assert.equal(pushes.length, 1);
  });

  test("recovery sends one 'back' alert", async () => {
    g.failNext("accounts", BLOCKED, BLOCKED);
    await watch(env);
    await watch(env);
    await watch(env); // healthy again
    assert.deepEqual(pushes.map((p) => p.title), ["Instagram access is down", "Instagram access is back"]);
    await watch(env);
    assert.equal(pushes.length, 2);
  });

  test("a single blip between healthy checks never alerts", async () => {
    await watch(env);
    g.failNext("accounts", BLOCKED);
    await watch(env);
    await watch(env);
    assert.equal(pushes.length, 0);
  });

  test("new failed DMs alert once with the count; history at first run is the baseline", async () => {
    const call = async (op, args = {}) => (await env.LEDGER.get(env.LEDGER.idFromName("ledger")).fetch("https://ledger/", { method: "POST", body: JSON.stringify({ op, now: Date.now(), ...args }) })).json();
    const fail = async (id) => {
      await call("enqueue", { items: [{ commentId: id, keyword: "DIWALI", automationId: "a_diwali" }] });
      await call("advance", { id, stage: "failed", note: "dm: refused" });
    };
    await fail("OLD");
    await watch(env); // baseline includes OLD → no alert
    assert.equal(pushes.length, 0);
    await fail("N1");
    await fail("N2");
    await watch(env);
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].title, "2 DMs failed to send");
    assert.doesNotMatch(pushes[0].body, /someuser|N1|N2/); // no usernames or ids in notifications
    await watch(env);
    assert.equal(pushes.length, 1);
  });

  test("notify posts Discord/Slack-compatible JSON that links to the dashboard", async () => {
    await env.KV.put("origin", "https://x.workers.dev");
    const sent = await notify(env, { title: "Test alert", message: "hi" });
    assert.deepEqual(sent.map((s) => s.ok), [true]);
    assert.match(pushes[0].content, /^\*\*Test alert\*\*\nhi\nhttps:\/\/x\.workers\.dev\/app$/);
  });
});
