// Shared helpers for scripts/setup.mjs and scripts/admin.mjs. Zero dependencies.
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SECRETS_FILE = join(ROOT, ".secrets.local");
export const WRANGLER_TOML = join(ROOT, "wrangler.toml");
export const WRANGLER_VERSION = "4.160.0"; // pinned: reproducible installs, cached after the first run
export const WRANGLER = ["--yes", `wrangler@${WRANGLER_VERSION}`];
const WIN = process.platform === "win32";

// ---------- terminal ----------
const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const bold = c(1), dim = c(2), green = c(32), red = c(31), yellow = c(33), cyan = c(36);
export const ok = (s) => console.log(`${green("✓")} ${s}`);
export const bad = (s) => console.log(`${red("✗")} ${s}`);
export const warn = (s) => console.log(`${yellow("!")} ${s}`);
export const step = (n, total, s) => console.log(`\n${cyan(`[${n}/${total}]`)} ${bold(s)}`);
export const die = (s) => { console.error(`\n${red("✗")} ${s}`); process.exit(1); };

// One shared reader for every prompt (separate readers can drop or misroute typed lines).
let rl, muted = false;
function reader() {
  if (!rl) {
    rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
    const write = rl._writeToOutput?.bind(rl);
    if (write) rl._writeToOutput = (s) => { if (!muted || /[:?]\s*$/.test(s) || s === "\r\n" || s === "\n") write(s); };
    rl.on("SIGINT", () => { process.stdout.write("\n"); process.exit(130); });
  }
  return rl;
}
export function closePrompts() { rl?.close(); rl = undefined; }
process.on("exit", closePrompts);

export function ask(question, def = "") {
  const hint = def ? dim(` (${def})`) : "";
  return new Promise((res) => reader().question(`  ${question}${hint}: `, (a) => res(a.trim() || def)));
}

// Hidden input for secrets: nothing typed is echoed.
export async function askSecret(question) {
  for (;;) {
    muted = true;
    const v = await new Promise((res) => reader().question(`  ${question} ${dim("(hidden)")}: `, (a) => res(a.trim())));
    muted = false;
    if (!process.stdin.isTTY) process.stdout.write("\n");
    if (v) return v;
    console.log(`  ${yellow("!")} Nothing entered, try again (Ctrl-C to quit).`);
  }
}

export async function confirm(question) {
  return /^y(es)?$/i.test(await ask(`${question} [y/N]`));
}

// ---------- files ----------
export function readSecrets() {
  if (!existsSync(SECRETS_FILE)) return {};
  return Object.fromEntries(
    readFileSync(SECRETS_FILE, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}
export function writeSecrets(obj) {
  writeFileSync(SECRETS_FILE, Object.entries(obj).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  chmodSync(SECRETS_FILE, 0o600);
}
export function tomlVar(toml, key) {
  return new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m").exec(toml)?.[1];
}
export function setTomlVar(toml, key, value) {
  const re = new RegExp(`^(${key}\\s*=\\s*)"[^"]*"`, "m");
  const safe = String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return re.test(toml) ? toml.replace(re, (_, lhs) => `${lhs}"${safe}"`) : toml;
}

// ---------- wrangler ----------
export function wrangler(args, { input, inherit = false } = {}) {
  const r = spawnSync(WIN ? "npx.cmd" : "npx", [...WRANGLER, ...args], {
    cwd: ROOT,
    shell: WIN,
    input,
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["pipe", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.replace(/\(node:\d+\) ExperimentalWarning[\s\S]*?created\)\n?/g, "");
  if (r.error) die(`Couldn't run Wrangler via npx: ${r.error.message}. Is Node.js on your PATH?`);
  if (/more than one account/i.test(out))
    die("Your Cloudflare login can see more than one account. Add `account_id = \"<id>\"` near the top of wrangler.toml (find it with `npx wrangler whoami`) and re-run.");
  return { code: r.status, out };
}

export function deploy() {
  const r = wrangler(["deploy"]);
  if (r.code !== 0) return { ok: false, out: r.out };
  const url = /https:\/\/[a-z0-9.-]+\.workers\.dev/i.exec(r.out)?.[0];
  return { ok: true, url, out: r.out };
}

// Retries: Cloudflare occasionally rejects a secret write right after a deploy.
export function putSecret(name, value) {
  let r;
  for (let attempt = 1; attempt <= 3; attempt++) {
    r = wrangler(["secret", "put", name], { input: value });
    if (r.code === 0 && /Success/i.test(r.out)) return true;
    if (attempt < 3) spawnSync(process.execPath, ["-e", "setTimeout(()=>{},3000)"]);
  }
  die(`Couldn't set ${name} on the Worker:\n${r.out.trim().split("\n").slice(-6).join("\n")}`);
}

export function openUrl(url) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : WIN ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {}); // no browser opener (headless/WSL): the link is printed anyway
    child.unref();
  } catch {}
}

export function copy(text) {
  const cmd = process.platform === "darwin" ? ["pbcopy"] : process.platform === "win32" ? ["clip"] : ["xclip", "-selection", "clipboard"];
  const r = spawnSync(cmd[0], cmd.slice(1), { input: text });
  return r.status === 0;
}

// ---------- admin API ----------
export async function api(method, path, body) {
  const s = readSecrets();
  if (!s.WORKER || !s.ADMIN_KEY) die("No deployment found (.secrets.local). Run `npm run setup` first.");
  let res;
  try {
    res = await fetch(s.WORKER + path, {
      method,
      headers: { authorization: `Bearer ${s.ADMIN_KEY}`, ...(body ? { "content-type": "application/json" } : {}), "user-agent": "ig-comment-dm-cli" },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    die(`Can't reach ${s.WORKER} (${e.cause?.code ?? e.message}). A brand-new workers.dev URL can take a few minutes to get HTTPS.`);
  }
  const text = await res.text();
  if (res.status === 401) die("Admin key rejected. Is ADMIN_KEY in .secrets.local the same one set on the Worker?");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const hint = /no access token/i.test(text) ? " Not connected yet: run `npm run admin -- connect`." : "";
    die(`Worker returned HTTP ${res.status}.${hint}\n${text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 200)}`);
  }
  if (res.status >= 500) {
    const hint = /no access token/i.test(data.error ?? "") ? " Not connected yet: run `npm run admin -- connect`." : "";
    die(`Worker error: ${data.error ?? res.status}.${hint}`);
  }
  return data;
}
