// Follow to unlock: the comment DM carries a button instead of the link. Tapping it opens a
// conversation, which lets us ask Instagram whether that person follows the account
// (is_user_follow_business). Followers get the link; everyone else gets a "follow first"
// message with an "I'm following" button that checks again.
//
// Webhook field: messaging_postbacks (npm run admin -- subscribe). Only postbacks are read;
// message text is never parsed, stored or logged.
import { graph, ledger, log, getConfig, dmText } from "./core.js";

export const GATE_DEFAULTS = {
  opener: "tap below and i'll send it over 👇",
  opener_button: "Send me the link",
  gate_text: "nearly there ✨ the link is just for my followers. follow me, then tap the button below.",
  gate_button: "I'm following",
};
const NOT_YET = "i can't see the follow yet 👀 it can take a few seconds. follow me, then tap again.";
const PREFIX = "unlock:";

const pick = (rule, k) => rule[k] || GATE_DEFAULTS[k];
const payloadFor = (rule, step) => `${PREFIX}${rule.id}:${step}`;
const buttonMessage = (text, title, payload) => ({
  attachment: { type: "template", payload: { template_type: "button", text, buttons: [{ type: "postback", title, payload }] } },
});

// The private reply sent for a matched comment when the gate is on.
export const openerMessage = (rule) => buttonMessage(pick(rule, "opener"), pick(rule, "opener_button"), payloadFor(rule, 1));

// Postback taps from webhook payloads: [{ mid, senderId, payload }]. Echoes and other events are ignored.
export function extractPostbacks(payload, igId) {
  const out = [];
  for (const entry of payload?.entry ?? []) {
    for (const m of entry?.messaging ?? []) {
      const p = m?.postback?.payload ?? m?.message?.quick_reply?.payload;
      const senderId = m?.sender?.id && String(m.sender.id);
      if (typeof p !== "string" || !p.startsWith(PREFIX) || !/^\d{1,32}$/.test(senderId ?? "") || senderId === String(igId) || m?.message?.is_echo) continue;
      out.push({ mid: String(m.postback?.mid ?? m.message?.mid ?? `${senderId}:${m.timestamp}`), senderId, payload: p });
    }
  }
  return out;
}

const send = (env, igsid, message) => graph(env, "POST", `${env.IG_ID}/messages`, { body: { recipient: { id: igsid }, message } });

export async function handlePostback(env, { mid, senderId, payload }) {
  const [id, step] = payload.slice(PREFIX.length).split(":");
  const call = ledger(env);
  const { first } = await call("once", { key: `pb:${mid}` }); // Meta retries webhooks; act once per tap
  if (!first) return { result: "dedupe" };
  // A person hammering the button can't make us spam Instagram: 6 taps a minute each.
  if (!(await call("hit", { key: `tap:${senderId}`, limit: 6, windowMs: 60_000 })).ok) {
    log("tap_throttled", { automation: id });
    return { result: "throttled" };
  }
  const config = await getConfig(env);
  const rule = config.automations.find((a) => a.id === id);
  if (!rule || rule.enabled === false) return { result: "inactive" };
  if (config.dry_run) { log("unlock_preview", { automation: id }); return { result: "dry_run" }; }

  const who = await graph(env, "GET", senderId, { query: { fields: "is_user_follow_business" } });
  // If Instagram won't say, let them through rather than leave them stuck.
  const follows = who.ok ? who.data?.is_user_follow_business !== false : true;
  if (!who.ok) log("follow_check_failed", { automation: id, error: who.error });

  if (follows) {
    const r = await send(env, senderId, { text: dmText(rule) });
    log(r.ok ? "unlocked" : "unlock_failed", { automation: id, error: r.ok ? undefined : r.error });
    return { result: r.ok ? "unlocked" : "failed" };
  }
  const text = step === "1" ? pick(rule, "gate_text") : NOT_YET;
  const r = await send(env, senderId, buttonMessage(text, pick(rule, "gate_button"), payloadFor(rule, 2)));
  log(r.ok ? "gate_sent" : "gate_failed", { automation: id, step, error: r.ok ? undefined : r.error });
  return { result: r.ok ? "gated" : "failed" };
}
