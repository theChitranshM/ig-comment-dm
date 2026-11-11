#!/usr/bin/env node
// npm run admin -- <command>   ·   day-to-day control of your deployed Worker.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  ROOT, WRANGLER_TOML, bold, dim, cyan, green, red, yellow, ok, bad, warn, die,
  confirm, tomlVar, setTomlVar, deploy, wrangler, api, openUrl, closePrompts,
} from "./lib.mjs";

const [cmd, ...args] = process.argv.slice(2);
const LOCAL_CONFIG = join(ROOT, "config.local.json");
const mark = (b) => (b ? green("✓") : red("✗"));
const short = (s, n = 60) => (s ?? "").replace(/\s+/g, " ").slice(0, n);

async function getConfig() { return api("GET", "/admin/config"); }
async function putConfig(cfg) {
  const r = await api("PUT", "/admin/config", cfg);
  if (!r.ok) die(`Config rejected: ${r.error ?? JSON.stringify(r)}`);
}

// Resolve a post number from `posts` ("3" or "#3") or a full media id (long digits).
let mediaCache;
async function resolveMedia(ref) {
  const n = /^#?(\d{1,3})$/.exec(ref ?? "")?.[1];
  if (!n) {
    if (/^\d{10,}$/.test(ref ?? "")) return ref;
    die(`"${ref}" isn't a post number or media id. See: npm run admin -- posts`);
  }
  mediaCache ??= await api("GET", "/admin/media?limit=50");
  if (!mediaCache.ok) die(`Couldn't list your posts: ${mediaCache.error}`);
  const m = mediaCache.data.data[Number(n) - 1];
  if (!m) die(`There's no post ${n}.`);
  return m.id;
}
const needRefs = (refs, verb) => {
  if (!refs.length) die(`Usage: npm run admin -- ${verb} <post number or media id> …   (numbers from: npm run admin -- posts)`);
};

function printPreview(r) {
  const rows = (r.results ?? []).filter((x) => x.result === "dry_run");
  console.log(`\n  Scanned ${r.media} post(s), ${r.comments} comment(s).`);
  if (!rows.length) return console.log(`  ${dim("Nothing would be sent.")}`), rows;
  console.log(`  ${bold(`${rows.length} would get a DM + public reply:`)}`);
  for (const x of rows) console.log(`   • @${x.user} ${dim(`on ${x.mediaId}`)}: "${short(x.text, 50)}"`);
  console.log(`\n  ${dim("DM:")} ${rows[0].dm.replace(/\n/g, " ⏎ ")}\n  ${dim("Public reply:")} ${rows[0].ack ?? dim("(none)")}`);
  return rows;
}

const commands = {
  async check() {
    const r = await api("GET", "/admin/check");
    console.log(`\n${bold("Connection")}`);
    console.log(`  ${mark(r.token?.source && r.token.source !== "missing")} Token: ${r.token?.kind}, ${r.token?.source}${r.token?.expires === "never" ? ", never expires" : ""}`);
    console.log(`  ${mark(r.account?.ok)} Account: ${r.account?.ok ? `@${r.account.data.username} (${r.account.data.id})` : r.account?.error}`);
    const need = ["instagram_basic", "instagram_manage_comments", "instagram_manage_messages"];
    const perms = Array.isArray(r.permissions) ? r.permissions : [];
    console.log(`  ${mark(need.every((p) => perms.includes(p)))} Permissions: ${Array.isArray(r.permissions) ? need.map((p) => (perms.includes(p) ? p : red(p))).join(", ") : r.permissions}`);
    console.log(`\n${bold("Webhooks")}`);
    console.log(`  ${mark(r.app_webhook?.callback_ok && r.app_webhook?.active)} App callback points at this Worker`);
    console.log(`  ${mark(r.app_webhook?.comments_field)} App subscribed to the "comments" field`);
    console.log(`  ${mark(r.account_subscribed)} Your account subscribed to the app`);
    console.log(`\n${bold("Config")}`);
    console.log(`  Keywords: ${r.config?.rules?.join(", ")} · mode: ${r.config?.mode} · posts allowed: ${r.config?.posts}${r.config?.dry_run ? yellow(" · DRY RUN") : ""}`);
    if (r.config?.mode !== "all" && !r.config?.posts) warn("No posts allowed yet, so nothing will fire. Add one: npm run admin -- allow 1");
    if (!r.app_webhook?.comments_field || !r.account_subscribed) warn("Fix webhooks with: npm run admin -- subscribe");
  },

  async connect() {
    const r = await api("POST", "/admin/connect-link");
    if (!r.link) die(r.error ?? JSON.stringify(r));
    console.log(`\n  Opening Meta's login. ${bold("Select your Instagram account")} when asked which assets to share.`);
    console.log(`  ${dim("Link (valid 15 min):")} ${cyan(r.link)}\n`);
    openUrl(r.link);
  },

  async "set-ig-id"([id]) {
    if (!/^\d+$/.test(id ?? "")) die("Usage: npm run admin -- set-ig-id <numeric id>  (Business Settings → Accounts → Instagram accounts)");
    const r = await api("GET", `/admin/account?id=${id}`);
    if (!r.ok) die(`The connected token can't reach ${id}: ${r.error}. Run \`npm run admin -- connect\` and select that account.`);
    ok(`Found @${r.data.username}`);
    let toml = readFileSync(WRANGLER_TOML, "utf8");
    toml = setTomlVar(toml, "IG_ID", id);
    if (!tomlVar(toml, "IG_USERNAME") || tomlVar(toml, "IG_USERNAME").startsWith("<")) toml = setTomlVar(toml, "IG_USERNAME", r.data.username);
    writeFileSync(WRANGLER_TOML, toml);
    const d = deploy();
    if (!d.ok) die(`Saved to wrangler.toml but redeploy failed:\n${d.out}`);
    ok("IG_ID saved and Worker redeployed. Next: npm run admin -- subscribe");
  },

  async subscribe() {
    const r = await api("POST", "/admin/subscribe");
    if (r.error) die(r.error);
    console.log(`  ${mark(r.account?.ok)} Account → app (comments)${r.account?.ok ? "" : `: ${r.account?.error}`}`);
    console.log(`  ${mark(r.app?.success)} App → webhook (comments field)${r.app?.success ? "" : `: ${r.app?.error?.message ?? JSON.stringify(r.app)}`}`);
  },

  async posts([n = "20"]) {
    const r = await api("GET", `/admin/media?limit=${n}`);
    if (!r.ok) die(r.error);
    const cfg = await getConfig();
    const allowed = new Set(cfg.scope?.media_ids ?? []);
    console.log("");
    r.data.data.forEach((m, i) => {
      const tag = allowed.has(m.id) ? green(" [on]") : "";
      const trial = m.media_product_type === "REELS" && m.is_shared_to_feed === false ? dim(" trial?") : "";
      console.log(`  ${dim(String(i + 1).padStart(3))} ${m.id} ${dim(m.timestamp.slice(0, 10))} 💬${String(m.comments_count ?? 0).padEnd(3)}${tag}${trial} ${short(m.caption, 55)}`);
    });
    console.log(dim("\n  Turn one on: npm run admin -- allow 3     ('trial?' = reel not shared to feed)"));
  },

  async allow(refs) {
    needRefs(refs, "allow");
    const cfg = await getConfig();
    cfg.scope.media_ids ??= [];
    cfg.scope.allowed_at ??= {};
    for (const ref of refs) {
      const id = await resolveMedia(ref);
      if (!cfg.scope.media_ids.includes(id)) {
        cfg.scope.media_ids.push(id);
        cfg.scope.allowed_at[id] = new Date().toISOString(); // only comments from now on fire automatically
      }
      ok(`On: ${id}`);
    }
    await putConfig(cfg);
    console.log(dim("  New comments fire from now on. Older ones wait for you: npm run admin -- preview, then backfill."));
  },

  async disallow(refs) {
    needRefs(refs, "disallow");
    const cfg = await getConfig();
    for (const ref of refs) {
      const id = await resolveMedia(ref);
      cfg.scope.media_ids = (cfg.scope.media_ids ?? []).filter((x) => x !== id);
      if (cfg.scope.allowed_at) delete cfg.scope.allowed_at[id];
      ok(`Off: ${id}`);
    }
    await putConfig(cfg);
  },

  async skip([commentId]) {
    if (!commentId) die("Usage: npm run admin -- skip <comment_id>");
    const cfg = await getConfig();
    cfg.scope.skip_comment_ids = [...new Set([...(cfg.scope.skip_comment_ids ?? []), commentId])];
    await putConfig(cfg);
    ok(`Will never act on comment ${commentId}`);
  },

  async preview() {
    printPreview(await api("POST", "/admin/poll?full=1&backfill=1&dry=1"));
  },

  async backfill() {
    const rows = printPreview(await api("POST", "/admin/poll?full=1&backfill=1&dry=1"));
    if (!rows.length) return;
    if (!(await confirm(`\n  Send to these ${rows.length} now?`))) return console.log("  Nothing sent.");
    let results = (await api("POST", "/admin/poll?full=1&backfill=1")).results ?? [];
    // Each Worker call sends a few at a time (free-plan limits); keep draining the queue.
    for (let i = 0; i < 40 && results.some((x) => x.result === "queued"); i++) {
      const done = results.filter((x) => x.result !== "queued");
      results = [...done, ...(await api("POST", "/admin/sweep"))];
    }
    for (const x of results) console.log(`  ${mark(x.result === "done")} ${x.id} ${x.result}${x.note || x.error ? dim(` (${x.note ?? x.error})`) : ""}`);
  },

  async try([...words]) {
    const text = words.join(" ");
    if (!text) die('Usage: npm run admin -- try "diwalii pls 🙏"');
    const { matchRule } = await import("../src/core.js");
    const cfg = await getConfig();
    const r = matchRule(text, cfg.rules);
    console.log(r ? `  ${green("✓")} "${text}" → ${bold(r.keyword)} ${dim(`(${r.match ?? "fuzzy"})`)}` : `  ${red("✗")} "${text}" matches no rule`);
  },

  async status() {
    const r = await api("GET", "/admin/status");
    console.log(`\n  Ledger: ${JSON.stringify(r.ledger.counts)}`);
    for (const x of r.ledger.recent ?? []) console.log(`   • @${x.user} ${x.kw} via ${x.src} → ${x.stage}${x.note ? dim(` (${x.note})`) : ""}`);
    if (!r.ledger.recent?.length) console.log(dim("   (no activity in the last 24h)"));
  },

  async config([sub, file = LOCAL_CONFIG]) {
    if (sub === "pull") {
      writeFileSync(file, JSON.stringify(await getConfig(), null, 2) + "\n");
      return ok(`Saved live config to ${file} — edit it, then: npm run admin -- config push`);
    }
    if (sub === "push") {
      if (!existsSync(file)) die(`${file} not found. Start with: npm run admin -- config pull`);
      await putConfig(JSON.parse(readFileSync(file, "utf8")));
      return ok("Live config updated (no redeploy needed)");
    }
    die("Usage: npm run admin -- config pull|push [file]");
  },

  async logs() {
    wrangler(["tail", "--format", "pretty"], { inherit: true });
  },
};

const help = `
${bold("npm run admin -- <command>")}

  ${bold("check")}                 is everything wired up? (token, account, permissions, webhooks)
  ${bold("connect")}               log in with Instagram (Unified login) and save the token
  ${bold("set-ig-id")} <id>        save your Instagram account ID and redeploy
  ${bold("subscribe")}             subscribe your account + app to comment webhooks

  ${bold("posts")} [n]             list recent posts, numbered (1 = newest)
  ${bold("allow")} <n|id>…         turn the tool on for these posts (n from \`posts\`); new comments only
  ${bold("disallow")} <n|id>…      turn it off
  ${bold("skip")} <comment_id>     never act on one comment
  ${bold("preview")}               who would get a DM right now (sends nothing)
  ${bold("backfill")}              preview, confirm, then send to waiting comments (7-day window)
  ${bold("try")} "<comment>"       which rule would this comment trigger?

  ${bold("config pull")} | ${bold("push")}   edit rules locally in config.local.json, push live
  ${bold("status")}                recent sends and retries
  ${bold("logs")}                  live Worker logs
`;

if (!cmd || !commands[cmd]) {
  console.log(help);
  process.exit(cmd ? 1 : 0);
}
await commands[cmd](args);
closePrompts();
