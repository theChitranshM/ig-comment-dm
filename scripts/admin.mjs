#!/usr/bin/env node
// npm run admin -- <command>   ·   day-to-day control of your deployed Worker.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  ROOT, WRANGLER_TOML, bold, dim, cyan, green, red, yellow, ok, bad, warn, die,
  confirm, tomlVar, setTomlVar, deploy, wrangler, api, openUrl, closePrompts,
  putSecret,
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
function splitTo(args) {
  const i = args.indexOf("--to");
  return i === -1 ? { refs: args, target: null } : { refs: args.slice(0, i), target: args[i + 1] };
}
function pickAutomation(cfg, target, verb) {
  const list = cfg.automations ?? [];
  if (!list.length) die("No automations yet. Create one in the dashboard (/app) first.");
  if (!target) {
    if (list.length === 1) return list[0];
    die(`You have ${list.length} automations. Say which: npm run admin -- ${verb} 3 --to ${list[0].keyword}\n  (${list.map((a) => a.keyword).join(", ")})`);
  }
  const t = target.toUpperCase();
  return list.find((a) => a.id === target || a.keyword === t || a.name.toUpperCase() === t) ?? die(`No automation matches "${target}".`);
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
    const autos = r.config?.automations ?? [];
    for (const a of autos) console.log(`  ${a.enabled ? green("●") : dim("○")} ${a.name} ${dim(`(${a.keyword}) · ${a.posts === "all" ? "all posts" : `${a.posts} post(s)`}`)}`);
    if (r.config?.dry_run) warn("Preview mode is on: nothing is being sent.");
    if (!autos.some((a) => a.enabled && (a.posts === "all" || a.posts > 0))) warn("No automation is running on any post yet. Open the dashboard (/app) or: npm run admin -- allow 1");
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
    const allowed = new Set(cfg.automations.filter((a) => a.enabled).flatMap((a) => a.media_ids));
    console.log("");
    r.data.data.forEach((m, i) => {
      const tag = allowed.has(m.id) ? green(" [on]") : "";
      const trial = m.media_product_type === "REELS" && m.is_shared_to_feed === false ? dim(" trial?") : "";
      console.log(`  ${dim(String(i + 1).padStart(3))} ${m.id} ${dim(m.timestamp.slice(0, 10))} 💬${String(m.comments_count ?? 0).padEnd(3)}${tag}${trial} ${short(m.caption, 55)}`);
    });
    console.log(dim("\n  Turn one on: npm run admin -- allow 3     ('trial?' = reel not shared to feed)"));
  },

  // allow <post…> [--to <keyword|automation id>] · needed when you have more than one automation
  async allow(args) {
    const { refs, target } = splitTo(args);
    needRefs(refs, "allow");
    const cfg = await getConfig();
    const a = pickAutomation(cfg, target, "allow");
    for (const ref of refs) {
      const id = await resolveMedia(ref);
      if (!a.media_ids.includes(id)) {
        a.media_ids.push(id);
        a.allowed_at[id] = new Date().toISOString(); // only comments from now on fire automatically
      }
      ok(`"${a.name}" is on for ${id}`);
    }
    await putConfig(cfg);
    console.log(dim("  New comments fire from now on. Older ones wait for you: npm run admin -- preview, then backfill."));
  },

  async disallow(args) {
    const { refs, target } = splitTo(args);
    needRefs(refs, "disallow");
    const cfg = await getConfig();
    const pool = target ? [pickAutomation(cfg, target, "disallow")] : cfg.automations;
    for (const ref of refs) {
      const id = await resolveMedia(ref);
      for (const a of pool) {
        a.media_ids = a.media_ids.filter((x) => x !== id);
        delete a.allowed_at?.[id];
      }
      ok(`Off: ${id}${target ? ` for "${pool[0].name}"` : " (all automations)"}`);
    }
    await putConfig(cfg);
  },

  async skip([commentId]) {
    if (!commentId) die("Usage: npm run admin -- skip <comment_id>");
    const cfg = await getConfig();
    cfg.skip_comment_ids = [...new Set([...(cfg.skip_comment_ids ?? []), commentId])];
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
    const r = matchRule(text, (cfg.automations ?? []).filter((a) => a.enabled !== false));
    console.log(r ? `  ${green("✓")} "${text}" → ${bold(r.name)} ${dim(`(${r.keyword}, ${r.match ?? "fuzzy"})`)}` : `  ${red("✗")} "${text}" matches no rule`);
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

  // alerts webhook URL → push alerts to a Discord/Slack incoming webhook
  // alerts off          → stop webhook alerts
  // alerts test         → send a test alert
  async alerts([sub, value]) {
    if (sub === "webhook") {
      if (!/^https:\/\/\S+$/.test(value ?? "")) die("Usage: npm run admin -- alerts webhook https://discord.com/api/webhooks/…");
      putSecret("ALERT_WEBHOOK_URL", value);
      ok("Webhook alerts on");
      await new Promise((r) => setTimeout(r, 12000)); // let the new secret reach the Worker
    } else if (sub === "off") {
      const r = wrangler(["secret", "delete", "ALERT_WEBHOOK_URL"], { input: "y\n" });
      return r.code === 0 ? ok("Webhook alerts off. The dashboard banner still shows problems.") : die(r.out);
    } else if (sub !== "test") {
      console.log(`\n  The dashboard always shows a banner when Instagram access breaks.\n  For a push too, add a Discord or Slack incoming webhook:\n    ${bold("npm run admin -- alerts webhook <url>")}\n`);
      return;
    }
    const r = await api("POST", "/api/alerts/test");
    if (r.error) die(r.error);
    r.sent ? ok("Test alert sent.") : bad(`The webhook didn't accept it (${r.channels?.map((c) => c.status).join(", ")}).`);
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
  ${bold("allow")} <n|id>… [--to KW]  turn an automation on for these posts (n from \`posts\`); new comments only
  ${bold("disallow")} <n|id>…      turn it off
  ${bold("skip")} <comment_id>     never act on one comment
  ${bold("preview")}               who would get a DM right now (sends nothing)
  ${bold("backfill")}              preview, confirm, then send to waiting comments (7-day window)
  ${bold("try")} "<comment>"       which rule would this comment trigger?

  ${bold("config pull")} | ${bold("push")}   edit rules locally in config.local.json, push live
  ${bold("status")}                recent sends and retries
  ${bold("alerts")} webhook <url>|off|test  Discord/Slack alert when access breaks or DMs fail
  ${bold("logs")}                  live Worker logs
`;

if (!cmd || !commands[cmd]) {
  console.log(help);
  process.exit(cmd ? 1 : 0);
}
await commands[cmd](args);
closePrompts();
