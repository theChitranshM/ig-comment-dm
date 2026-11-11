// Default config: used until you create your own automations in the dashboard (/app).
// The live config lives in Workers KV (key "config"); older { rules, scope } configs are migrated on read.
//
// SAFETY: this example automation runs on no posts, so nothing fires until you pick some.
export default {
  version: 2,
  automations: [
    {
      id: "a_example",
      name: "Free guide",
      enabled: true,
      keyword: "GUIDE", // case-insensitive, must stand alone ("guide pls" ✓, "#guide" ✓, "misguided" ✗)
      aliases: [], // extra triggers for the same reply
      match: "fuzzy", // "fuzzy": also "guidee", "gude", "gùide" · "exact": spelling must match
      dm: "here's the guide 📘", // the private reply
      link: "https://example.com/guide", // added on its own line (optional)
      ack: "sent! check your dms 📩", // public reply, posted only after the DM succeeds (optional)
      all_posts: false, // true = every post (except exclude_media_ids)
      media_ids: [], // the posts it runs on
      allowed_at: {}, // when each post was added: older comments wait for an explicit backfill
    },
  ],
  exclude_media_ids: [], // posts no automation ever touches
  skip_comment_ids: [], // individual comments to never act on
  dry_run: false, // true = preview only, nothing is sent
};
