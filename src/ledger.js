// Durable Object: the single, serialized ledger of every comment we act on.
// Why a DO and not KV: KV has no compare-and-set, so "check then claim" in KV can
// race (two deliveries both see "absent"). A DO runs one request at a time and its
// storage get→put sits behind an input gate, so begin() is a true atomic claim.
// (Also keeps per-comment writes off KV's 1,000-writes/day free cap.)
//
// Record: { item, stage: new|dm_sent|done|done_noack|failed, attempts, leaseUntil, created, updated, note }

const OPS = new Set(["enqueue", "begin", "advance", "release", "pending", "get", "status", "prune"]);
const TERMINAL =new Set(["done", "done_noack", "failed"]);
const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 5;
const KEEP_MS = 30 * 86_400_000;

export class Ledger {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(request) {
    const a = await request.json();
    if (!OPS.has(a.op)) return new Response("bad op", { status: 400 });
    return Response.json(await this[a.op](a));
  }

  key(id) { return `c:${id}`; }

  async enqueue({ items, now }) {
    let added = 0;
    for (const item of items) {
      const k = this.key(item.commentId);
      if (await this.storage.get(k)) continue; // already known → never re-queued
      await this.storage.put(k, { item, stage: "new", attempts: 0, leaseUntil: 0, created: now, updated: now });
      added++;
    }
    return { added };
  }

  async begin({ id, now }) {
    const k = this.key(id);
    const rec = await this.storage.get(k);
    if (!rec) return { go: false, stage: "unknown" };
    if (TERMINAL.has(rec.stage)) return { go: false, stage: rec.stage };
    if (rec.leaseUntil > now) return { go: false, stage: "inflight" };
    rec.leaseUntil = now + LEASE_MS;
    rec.attempts += 1;
    rec.updated = now;
    await this.storage.put(k, rec);
    return { go: true, stage: rec.stage, item: rec.item };
  }

  async advance({ id, stage, note, now }) {
    const k = this.key(id);
    const rec = await this.storage.get(k);
    if (!rec) return { ok: false };
    rec.stage = stage;
    rec.updated = now;
    if (note) rec.note = note;
    if (TERMINAL.has(stage)) rec.leaseUntil = 0;
    await this.storage.put(k, rec);
    return { ok: true, stage };
  }

  async release({ id, error, now }) {
    const k = this.key(id);
    const rec = await this.storage.get(k);
    if (!rec) return { ok: false };
    rec.leaseUntil = 0;
    rec.updated = now;
    rec.note = error;
    if (rec.attempts >= MAX_ATTEMPTS) rec.stage = "failed";
    await this.storage.put(k, rec);
    return { ok: true, stage: rec.stage };
  }

  async pending({ now }) {
    const ids = [];
    for (const [k, rec] of await this.storage.list({ prefix: "c:" })) {
      if (!TERMINAL.has(rec.stage) && rec.leaseUntil <= now) ids.push(k.slice(2));
    }
    return { ids };
  }

  async get({ id }) {
    return (await this.storage.get(this.key(id))) ?? null;
  }

  async status({ now }) {
    const counts = {};
    const recent = [];
    for (const [, rec] of await this.storage.list({ prefix: "c:" })) {
      counts[rec.stage] = (counts[rec.stage] ?? 0) + 1;
      if (now - rec.updated < 86_400_000) recent.push({ id: rec.item.commentId, user: rec.item.fromUsername, kw: rec.item.keyword, src: rec.item.source, stage: rec.stage, attempts: rec.attempts, note: rec.note });
    }
    return { counts, recent };
  }

  async prune({ now }) {
    let removed = 0;
    for (const [k, rec] of await this.storage.list({ prefix: "c:" })) {
      if (now - rec.created > KEEP_MS) { await this.storage.delete(k); removed++; }
    }
    return { removed };
  }
}
