// Alerts: tell the owner when Instagram access breaks, comes back, or DMs start failing.
// The dashboard's health banner always shows problems. For a push, set the optional secret
//   ALERT_WEBHOOK_URL  a Discord or Slack incoming webhook (posts { content, text })
// (ntfy.sh's public server isn't reachable from Cloudflare Workers, so it isn't offered.)
// Notifications carry counts and reasons only, never commenters' usernames or comment text.
import { graph, ledger, log } from "./core.js";

const DOWN_AFTER = 2; // consecutive failed checks (5 min apart) before "down" fires, so one blip stays quiet

export const alertChannels = (env) => ({ webhook: Boolean(env.ALERT_WEBHOOK_URL) });

export async function notify(env, { title, message }) {
  const origin = await env.KV.get("origin").catch(() => null);
  const click = origin ? `${origin}/app` : undefined;
  const sent = [];
  if (env.ALERT_WEBHOOK_URL) {
    const text = `**${title}**\n${message}${click ? `\n${click}` : ""}`;
    const r = await fetch(env.ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text, text }),
    }).catch((e) => ({ ok: false, status: String(e) }));
    sent.push({ channel: "webhook", ok: r.ok, status: r.status });
  }
  log("alert", { title, sent });
  return sent;
}

// Runs every 5 minutes from the cron. One Graph call; KV is written only when state changes.
export async function watch(env) {
  if (!env.ALERT_WEBHOOK_URL) return { skipped: "no alert channel configured" };
  const prev = (await env.KV.get("alert_state", "json").catch(() => null)) ?? { down: false, fails: 0, failed: null };
  const next = { ...prev };
  const fired = [];

  const r = env.IG_ID
    ? await graph(env, "GET", String(env.IG_ID), { query: { fields: "id" } }).catch((e) => ({ ok: false, error: String(e) }))
    : { ok: false, error: "IG_ID is not set" };

  if (r.ok) {
    next.fails = 0;
    if (prev.down) {
      next.down = false;
      fired.push(await notify(env, {
        title: "Instagram access is back",
        message: "Comments are being answered again. Anything missed in the last 7 days on your active posts goes out within 5 minutes.",
      }));
    }
  } else {
    next.fails = (prev.fails ?? 0) + 1;
    if (!prev.down && next.fails >= DOWN_AFTER) {
      next.down = true;
      fired.push(await notify(env, {
        title: "Instagram access is down",
        message: `Comments aren't being answered. Meta says: ${r.error}. Open the dashboard for details; if it says to reconnect, use Settings → Reconnect Instagram.`,
      }));
    }
  }

  const { totals } = await ledger(env)("stats");
  if (next.failed == null) next.failed = totals.failed; // first run: baseline, don't alert on history
  else if (totals.failed > prev.failed) {
    const n = totals.failed - prev.failed;
    fired.push(await notify(env, {
      title: `${n} DM${n === 1 ? "" : "s"} failed to send`,
      message: "Instagram refused the message. Common reasons: someone else already replied to that comment, or the person restricts message requests. See Activity in the dashboard.",
    }));
    next.failed = totals.failed;
  } else if (totals.failed < prev.failed) next.failed = totals.failed; // old failures pruned

  if (JSON.stringify(next) !== JSON.stringify(prev)) await env.KV.put("alert_state", JSON.stringify(next));
  return { healthy: r.ok, state: next, fired: fired.length };
}
