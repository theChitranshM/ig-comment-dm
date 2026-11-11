#!/usr/bin/env node
// Guided setup: Cloudflare login → KV → wrangler.toml → secrets → deploy → what to paste into Meta.
// Safe to re-run: it reuses your KV namespace, keys and answers, and only fills what's missing.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  ROOT, WRANGLER_TOML, bold, dim, cyan, yellow, ok, bad, warn, step, die,
  ask, askSecret, confirm, readSecrets, writeSecrets, tomlVar, setTomlVar,
  wrangler, deploy, putSecret, copy, closePrompts,
} from "./lib.mjs";

const TOTAL = 7;
const [major] = process.versions.node.split(".").map(Number);
if (major < 22) die(`Node.js 22 or newer is required (you have ${process.versions.node}). Get it at https://nodejs.org`);

console.log(`\n${bold("ig-comment-dm setup")} ${dim("— Instagram comment → DM, on your own free Cloudflare Worker")}`);
console.log(dim("Have your Meta app open first (docs/SETUP.md, Part A): you'll need its App ID, App secret"));
console.log(dim("and Unified-login Configuration ID. What you type goes only to Cloudflare and files on this machine.\n"));

// 1 — Cloudflare
step(1, TOTAL, "Cloudflare account");
let who = wrangler(["whoami"]);
if (/not authenticated/i.test(who.out)) {
  console.log("  A browser window will open — approve Wrangler's access to your Cloudflare account.");
  const r = wrangler(["login"], { inherit: true });
  if (r.code !== 0) die("Cloudflare login didn't complete. Re-run `npm run setup`.");
  who = wrangler(["whoami"]);
}
if (/not authenticated/i.test(who.out)) die("Still not logged in to Cloudflare.");
ok("Logged in to Cloudflare");

// 2 — Your details
step(2, TOTAL, "Your details");
const exists = existsSync(WRANGLER_TOML);
let toml = exists ? readFileSync(WRANGLER_TOML, "utf8") : readFileSync(join(ROOT, "wrangler.example.toml"), "utf8");
const cur = (k) => {
  const v = tomlVar(toml, k);
  return v && !v.startsWith("<") ? v : "";
};
const name = await ask("Worker name", /^name\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? "ig-comment-dm");
const owner = await ask("Your name (shown on the privacy page)", cur("OWNER_NAME"));
const igUser = (await ask("Your Instagram username (without @)", cur("IG_USERNAME"))).replace(/^@/, "");
console.log(dim("\n  From your Meta app (docs/SETUP.md, Part A):"));
const appId = await ask("Meta App ID (App settings → Basic)", cur("APP_ID"));
const configId = await ask("Configuration ID (Use cases → Customize → API setup with Unified login)", cur("LOGIN_CONFIG_ID"));
if (!/^\d+$/.test(appId)) die("App ID should be digits only.");
if (!/^\d+$/.test(configId)) die("Configuration ID should be digits only.");

// 3 — KV namespace
step(3, TOTAL, "Storage (Workers KV)");
let kvId = /^id\s*=\s*"([0-9a-f]{32})"/m.exec(toml)?.[1];
if (kvId) ok(`Reusing KV namespace ${dim(kvId)}`);
else {
  const r = wrangler(["kv", "namespace", "create", `${name}-kv`]);
  kvId = /"?id"?\s*[=:]\s*"([0-9a-f]{32})"/.exec(r.out)?.[1];
  if (!kvId) die(`Couldn't create the KV namespace:\n${r.out}`);
  ok(`Created KV namespace ${dim(kvId)}`);
}

// 4 — wrangler.toml
step(4, TOTAL, "Writing wrangler.toml (git-ignored)");
toml = toml.replace(/^name\s*=\s*"[^"]*"/m, `name = "${name}"`).replace(/^id\s*=\s*"[^"]*"/m, `id = "${kvId}"`);
for (const [k, v] of Object.entries({ OWNER_NAME: owner, IG_USERNAME: igUser, APP_ID: appId, LOGIN_CONFIG_ID: configId })) toml = setTomlVar(toml, k, v);
writeFileSync(WRANGLER_TOML, toml);
ok("wrangler.toml written");

// 5 — keys
step(5, TOTAL, "Keys");
const secrets = readSecrets();
secrets.VERIFY_TOKEN ||= randomBytes(24).toString("hex");
secrets.ADMIN_KEY ||= randomBytes(32).toString("hex");
writeSecrets(secrets);
ok(`Webhook verify token + admin key saved to ${bold(".secrets.local")} ${dim("(git-ignored, readable only by you)")}`);

// 6 — deploy + secrets
step(6, TOTAL, "Deploying to Cloudflare");
const d = deploy();
if (!d.ok) {
  if (/workers\.dev subdomain/i.test(d.out)) {
    bad("Your Cloudflare account has no workers.dev subdomain yet.");
    console.log(`  Pick one (it becomes part of your webhook URL) in the Cloudflare dashboard:\n  ${cyan("https://dash.cloudflare.com/?to=/:account/workers/onboarding")}\n  then re-run ${bold("npm run setup")}.`);
    process.exit(1);
  }
  die(`Deploy failed:\n${d.out}`);
}
secrets.WORKER = d.url ?? secrets.WORKER;
if (!secrets.WORKER) die("Deployed, but couldn't read the workers.dev URL from Wrangler's output.");
writeSecrets(secrets);
ok(`Live at ${bold(secrets.WORKER)}`);

putSecret("VERIFY_TOKEN", secrets.VERIFY_TOKEN);
putSecret("ADMIN_KEY", secrets.ADMIN_KEY);
ok("VERIFY_TOKEN and ADMIN_KEY set on the Worker");
const listed = wrangler(["secret", "list"]).out;
if (/"APP_SECRET"/.test(listed) && !(await confirm("APP_SECRET is already set. Replace it?"))) ok("Keeping existing APP_SECRET");
else {
  const appSecret = await askSecret("Meta App secret (App settings → Basic → Show)");
  if (!/^[0-9a-f]{32}$/i.test(appSecret)) warn("That doesn't look like a 32-character Meta app secret — setting it anyway.");
  putSecret("APP_SECRET", appSecret);
  ok("APP_SECRET set on the Worker");
}

// 7 — what to paste into Meta
step(7, TOTAL, "Paste these into your Meta app (docs/SETUP.md, Part C)");
const W = secrets.WORKER;
const rows = [
  ["Valid OAuth redirect URI", `${W}/auth/callback`, "Use cases → Customize → API setup with Unified login → Redirect URL"],
  ["Webhook callback URL", `${W}/webhook`, "same page → Configure webhooks"],
  ["Webhook verify token", secrets.VERIFY_TOKEN, "same page → Configure webhooks"],
  ["Privacy policy URL", `${W}/privacy`, "App settings → Basic"],
  ["Data deletion URL", `${W}/data-deletion`, "App settings → Basic → Data deletion instructions URL"],
];
for (const [label, value, where] of rows) console.log(`\n  ${bold(label)}  ${dim(where)}\n  ${cyan(value)}`);
if (copy(secrets.VERIFY_TOKEN)) console.log(dim("\n  (verify token copied to your clipboard)"));

console.log(`\n${bold("Next:")}`);
console.log(`  1. Paste the values above into Meta and click ${bold("Verify and save")} on the webhook.`);
console.log(`  2. ${bold("npm run admin -- connect")}   ${dim("log in with Instagram and pick your account")}`);
console.log(`  3. ${bold("npm run admin -- set-ig-id <id>")}   ${dim("your Instagram account ID (Business Settings → Instagram accounts)")}`);
console.log(`  4. ${bold("npm run admin -- subscribe")} then ${bold("npm run admin -- check")}`);
console.log(`  5. Open your dashboard: ${cyan(`${W}/app`)}  ${dim("log in with ADMIN_KEY from .secrets.local")}`);
console.log(dim("\n  Full walkthrough: docs/SETUP.md\n"));
closePrompts();
