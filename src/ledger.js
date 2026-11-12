// Durable Object: the single, serialized ledger of every comment we act on.
// Why a DO and not KV: KV has no compare-and-set, so "check then claim" in KV can
// race (two deliveries both see "absent"). A DO runs one request at a time and its
// storage get→put sits behind an input gate, so begin() is a true atomic claim.
// (Also keeps per-comment writes off KV's 1,000-writes/day free cap.)
//
// Record: { item, stage: new|dm_sent|done|done_noack|failed, attempts, leaseUntil, created, updated, note }

const OPS = new Set(["enqueue", "begin", "advance", "release", "pending", "get", "status", "prune", "stats", "activity", "lookup", "once"]);
const SENT = new Set(["dm_sent", "done", "done_noack"]);
const TERMINAL = new Set(["done", "done_noack", "failed"]);
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
    if (stage === "dm_sent" || ((stage === "done" || stage === "done_noack") && !rec.sentAt)) rec.sentAt = now;
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

  // Which of these comment ids do we already know, and at what stage?
  async lookup({ ids = [] }) {
    const stages = {};
    for (const id of ids.slice(0, 500)) {
      const rec = await this.storage.get(this.key(id));
      if (rec) stages[id] = rec.stage;
    }
    return { stages };
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

  // Per-automation counters for the dashboard. Old records without automationId are keyed by keyword.
  async stats({ now }) {
    const by = {};
    const totals = { sent: 0, sent_24h: 0, failed: 0, pending: 0 };
    for (const [, rec] of await this.storage.list({ prefix: "c:" })) {
      const key = rec.item.automationId ?? `kw:${rec.item.keyword}`;
      const b = (by[key] ??= { sent: 0, failed: 0, pending: 0, last_sent_at: null });
      if (SENT.has(rec.stage)) {
        b.sent++; totals.sent++;
        const at = rec.sentAt ?? rec.updated;
        if (now - at < 86_400_000) totals.sent_24h++;
        if (!b.last_sent_at || at > b.last_sent_at) b.last_sent_at = at;
      } else if (rec.stage === "failed") { b.failed++; totals.failed++; }
      else { b.pending++; totals.pending++; }
    }
    return { by, totals };
  }

  async activity({ limit = 50 }) {
    const rows = [];
    for (const [, rec] of await this.storage.list({ prefix: "c:" })) rows.push(rec);
    rows.sort((a, b) => b.updated - a.updated);
    return {
      items: rows.slice(0, Math.min(Number(limit) || 50, 200)).map((r) => ({
        comment_id: r.item.commentId, automation_id: r.item.automationId ?? null, automation_name: r.item.automationName ?? null,
        keyword: r.item.keyword, user: r.item.fromUsername, text: r.item.text, media_id: r.item.mediaId, source: r.item.source,
        stage: r.stage, attempts: r.attempts, note: r.note ?? null, updated_at: new Date(r.updated).toISOString(),
      })),
    };
  }

  // First time this key is seen? Used to act once per button tap (Meta retries webhooks).
  async once({ key, now }) {
    const k = `p:${key}`;
    if (await this.storage.get(k)) return { first: false };
    await this.storage.put(k, { created: now });
    return { first: true };
  }

  async prune({ now }) {
    let removed = 0;
    for (const [k, rec] of await this.storage.list({ prefix: "p:" })) {
      if (now - rec.created > KEEP_MS) { await this.storage.delete(k); removed++; }
    }
    for (const [k, rec] of await this.storage.list({ prefix: "c:" })) {
      if (now - rec.created > KEEP_MS) { await this.storage.delete(k); removed++; }
    }
    return { removed };
  }
}
