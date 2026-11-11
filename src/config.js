// Default config, used only until you push your own with `npm run admin -- config push`.
// The live config lives in Workers KV (key "config"), so changing rules never needs a redeploy.
//
// SAFETY: scope.mode "allowlist" + an empty media_ids list means NOTHING fires.
// Add posts one at a time with `npm run admin -- allow <n>` (n from `npm run admin -- posts`).
export default {
  rules: [
    {
      keyword: "GUIDE", // case-insensitive, must stand alone ("guide pls" ✓, "#guide" ✓, "misguided" ✗)
      match: "fuzzy", // "fuzzy" (default): also "guidee", "gude", "gùide" · "exact": spelling must match
      aliases: [], // optional extra keywords for the same reply
      dm: "here's the guide 📘", // private reply text
      link: "https://example.com/guide", // appended on its own line (optional)
      ack: "sent! check your dms 📩", // public reply, posted only if the DM succeeds (optional)
    },
  ],
  scope: {
    mode: "allowlist", // "allowlist" = only media_ids · "all" = every post except exclude_media_ids
    media_ids: [],
    exclude_media_ids: [],
    skip_comment_ids: [], // individual comments to never act on
    allowed_at: {}, // set by `allow`: older comments on that post wait for an explicit backfill
  },
  dry_run: false, // true = log what would be sent, send nothing
};
