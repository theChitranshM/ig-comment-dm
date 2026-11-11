// Public HTML pages: privacy policy, data deletion, OAuth result.
// Owner details come from wrangler.toml vars, so the same code serves anyone's deployment.

export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function page(title, body, status = 200) {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${esc(title)}</title>` +
      `<body style="font:16px/1.55 system-ui,sans-serif;max-width:600px;margin:48px auto;padding:0 16px;color:#111">` +
      `<h2>${esc(title)}</h2>${body}</body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

const owner = (env) => ({
  name: esc(env.OWNER_NAME || "the account owner"),
  handle: esc(env.IG_USERNAME || ""),
  app: esc(env.APP_NAME || "ig-comment-dm"),
});

export function privacyPage(env) {
  const o = owner(env);
  const at = o.handle ? ` (@${o.handle})` : "";
  return page(`Privacy policy — ${o.app}`, `
    <p>${o.app} is a self-hosted tool run by ${o.name}${at} for their own Instagram account.</p>
    <p><b>What it reads:</b> comments on ${o.handle ? `@${o.handle}'s` : "the account's"} posts — comment text, comment id, and the commenter's id and username.</p>
    <p><b>What it does:</b> when a comment contains a keyword the account invited people to comment, it sends that commenter one private reply with the requested link and posts a short public reply.</p>
    <p><b>What it stores:</b> comment id, commenter id and username, matched keyword and send status — kept up to 30 days to prevent duplicate messages, then deleted. Nothing is sold, shared, or used for advertising.</p>
    <p><b>Deletion:</b> see <a href="/data-deletion">data deletion</a>.</p>`);
}

export function dataDeletionPage(env) {
  const o = owner(env);
  const contact = o.handle
    ? `DM <a href="https://instagram.com/${o.handle}">@${o.handle}</a> on Instagram with the word "delete" and your username`
    : `contact the account owner with the word "delete" and your username`;
  return page(`Data deletion — ${o.app}`, `
    <p>Records are deleted automatically 30 days after the comment.</p>
    <p>To have your data removed sooner, ${contact}. It is removed within 7 days.</p>`);
}
