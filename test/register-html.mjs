// Lets Node tests import .html files as text, matching Wrangler's `Text` module rule.
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`
  import { readFile } from "node:fs/promises";
  export async function load(url, ctx, next) {
    if (url.endsWith(".html")) {
      const text = await readFile(new URL(url), "utf8");
      return { format: "module", shortCircuit: true, source: "export default " + JSON.stringify(text) + ";" };
    }
    return next(url, ctx);
  }
`));
