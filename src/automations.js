// Automations: the v2 config model ("keyword → DM" scoped to posts), plus migration from v1 rules.
//
// v2 config (KV key "config"):
//   { version: 2, automations: [Automation], exclude_media_ids: [], skip_comment_ids: [], dry_run: false }
// Automation:
//   { id, name, enabled, keyword, aliases[], match, dm, link, ack,
//     all_posts, all_posts_since, media_ids[], allowed_at: { [media_id]: iso }, created_at, updated_at }
//   allowed_at records when each post was added — comments older than that only go out via backfill.

const str = (v) => (typeof v === "string" ? v.trim() : "");
const uniq = (a) => [...new Set(a)];
const ids = (v) => uniq((Array.isArray(v) ? v : []).map(String).filter((x) => /^[\w-]{1,64}$/.test(x)));

export const newId = () => `a_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;

export function normalizeAutomation(a, fallbackTime = new Date(0).toISOString()) {
  return {
    id: str(a.id) || newId(),
    name: str(a.name) || str(a.keyword).toUpperCase() || "Untitled",
    enabled: a.enabled !== false,
    keyword: str(a.keyword).toUpperCase(),
    aliases: uniq((Array.isArray(a.aliases) ? a.aliases : []).map((x) => str(x).toUpperCase()).filter(Boolean)),
    match: a.match === "exact" ? "exact" : "fuzzy",
    dm: str(a.dm),
    link: str(a.link),
    ack: str(a.ack),
    all_posts: a.all_posts === true,
    all_posts_since: a.all_posts === true ? a.all_posts_since || a.created_at || fallbackTime : null,
    media_ids: ids(a.media_ids),
    allowed_at: a.allowed_at && typeof a.allowed_at === "object" ? { ...a.allowed_at } : {},
    created_at: a.created_at || fallbackTime,
    updated_at: a.updated_at || a.created_at || fallbackTime,
  };
}

// Accepts v2 as-is or migrates v1 ({ rules, scope }) so existing installs keep working untouched.
export function normalizeConfig(raw) {
  raw ??= {};
  if (Array.isArray(raw.automations)) {
    return {
      version: 2,
      automations: raw.automations.map((a) => normalizeAutomation(a)),
      exclude_media_ids: ids(raw.exclude_media_ids),
      skip_comment_ids: uniq((raw.skip_comment_ids ?? []).map(String)),
      dry_run: raw.dry_run === true,
    };
  }
  const scope = raw.scope ?? {};
  const all = scope.mode === "all";
  return {
    version: 2,
    automations: (raw.rules ?? []).map((r) =>
      normalizeAutomation({
        ...r,
        id: `a_${str(r.keyword).toLowerCase().replace(/[^a-z0-9]+/g, "") || "rule"}`,
        name: r.name ?? str(r.keyword).charAt(0) + str(r.keyword).slice(1).toLowerCase(),
        all_posts: all,
        media_ids: all ? [] : scope.media_ids ?? [],
        allowed_at: scope.allowed_at ?? {},
      }),
    ),
    exclude_media_ids: ids(scope.exclude_media_ids),
    skip_comment_ids: uniq((scope.skip_comment_ids ?? []).map(String)),
    dry_run: raw.dry_run === true,
  };
}

export const runsOn = (a, mediaId, config) =>
  a.enabled !== false &&
  !config.exclude_media_ids.includes(String(mediaId)) &&
  (a.all_posts || a.media_ids.includes(String(mediaId)));

// When did this automation start covering this post? Older comments need an explicit backfill.
export const coveredSince = (a, mediaId) => a.allowed_at[String(mediaId)] ?? (a.all_posts ? a.all_posts_since : null);

const triggers = (a) => [a.keyword, ...a.aliases].map((k) => k.toUpperCase());
const overlaps = (a, b) => a.all_posts || b.all_posts || a.media_ids.some((m) => b.media_ids.includes(m));

// Returns an error string, or null when valid. `others` = the rest of the automations.
export function validateAutomation(a, others) {
  if (!a.keyword) return "Add a keyword.";
  if (a.keyword.length > 60) return "Keep the keyword under 60 characters.";
  if (!a.dm) return "Write the DM people will receive.";
  if (a.link && !/^https?:\/\/[^\s]+\.[^\s]+$/i.test(a.link)) return "The link must start with http:// or https://.";
  if ((a.link ? `${a.dm}\n${a.link}` : a.dm).length > 1000) return "The DM (including the link) must be 1000 characters or fewer.";
  if (a.ack.length > 300) return "Keep the public reply to 300 characters or fewer.";
  if (a.name.length > 80) return "Keep the name under 80 characters.";
  if (a.enabled) {
    const mine = triggers(a);
    for (const o of others) {
      if (o.id === a.id || o.enabled === false || !overlaps(a, o)) continue;
      const clash = mine.find((k) => triggers(o).includes(k));
      if (clash) return `"${clash}" is already used by "${o.name}" on the same posts.`;
    }
  }
  return null;
}

// Apply an edit, stamping allowed_at for newly added posts (so old comments don't auto-fire).
export function applyEdit(current, patch, now = new Date().toISOString()) {
  const switchingToAll = patch.all_posts === true && !current?.all_posts;
  const next = normalizeAutomation({
    ...current, ...patch, id: current?.id,
    all_posts_since: switchingToAll ? now : current?.all_posts_since,
    created_at: current?.created_at ?? now, updated_at: now,
  });
  const before = new Set(current?.media_ids ?? []);
  for (const m of next.media_ids) if (!before.has(m)) next.allowed_at[m] ??= now; // only newly added posts
  for (const m of Object.keys(next.allowed_at)) if (!next.media_ids.includes(m)) delete next.allowed_at[m];
  return next;
}
