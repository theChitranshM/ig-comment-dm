#!/usr/bin/env node
// Dev-only mock of the /api contract in docs/API.md, serving src/app/app.html.
//   node scripts/ui-mock.mjs        ->  http://localhost:8788/app
// Login key: dev.  Query flags on /app (sticky until changed):
//   ?health=bad | webhook | ok     reconnect banner / webhook warning / healthy
//   ?dry=1 | 0                     preview mode banner
//   ?empty=1                       no automations (empty state)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const PORT = Number(process.env.PORT || 8788);
const APP = fileURLToPath(new URL('../src/app/app.html', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const MIN = 60e3, HR = 36e5, DAY = 864e5;

// ---------- data ----------
const ACCOUNT = {
  id: '17841400123456789', username: 'maya.builds', name: 'Chitransh', followers: 5415,
  picture: 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#2b2622"/><circle cx="32" cy="25" r="11" fill="#d9a77c"/><path d="M10 64c2-16 12-22 22-22s20 6 22 22z" fill="#d9a77c"/><path d="M20 22c0-9 6-13 13-13s11 5 11 11c-4-5-9-6-14-5s-8 3-10 7z" fill="#17120e"/></svg>`),
};

const CAPTIONS = [
  'built a comment-to-dm tool in a weekend. cloudflare worker, free tier, zero subscriptions. comment DIWALI for the repo',
  'my desk at 2am during diwali week. one lamp, one terminal, one bug that is definitely not mine',
  'trial reel: the stack behind this whole account (spoiler, it is mostly bash)',
  'i trained a tiny model to read my git history like a horoscope. comment EYE and i will send the notebook',
  'what a webhook retry looks like at 3am. exactly-once is a lie unless you make it true',
  'the fortune orb is a regex and a prayer. comment ORB',
  'shipping on a friday. do not try this at home',
  'day 12 of building in public from vancouver. rain, coffee, a failing test',
  'how i parse 400 comments a minute on a free tier. durable objects did the heavy lifting',
  'sunday reset: delete the todo list, keep the tea',
  'the fastest way to learn a codebase is to break it on purpose',
  'a quick tour of my terminal setup after three years of tweaking nothing',
  'my first week as a cs student vs my last semester. same tabs, fewer tears',
  'sleep schedule: undefined. nan:nan am',
  'skytrain commute, a laptop on my knees, and one stubborn css bug',
  'why my side projects have good readmes and bad names',
];
const TYPES = [['VIDEO', 'REELS'], ['VIDEO', 'REELS'], ['VIDEO', 'REELS'], ['VIDEO', 'REELS'], ['IMAGE', 'FEED'], ['VIDEO', 'REELS'], ['CAROUSEL_ALBUM', 'FEED'], ['VIDEO', 'REELS']];
const HUES = [[18, 345], [32, 12], [210, 250], [160, 190], [48, 20], [275, 320], [8, 40], [190, 220]];
const thumb = (i) => {
  const [a, b] = HUES[i % HUES.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${a} 55% 42%)"/><stop offset="1" stop-color="hsl(${b} 60% 22%)"/></linearGradient></defs><rect width="240" height="300" fill="url(#g)"/><g fill="none" stroke="rgba(255,255,255,.35)" stroke-width="2"><circle cx="120" cy="140" r="${34 + (i % 4) * 8}"/><path d="M0 ${220 + (i % 3) * 15}q60-40 120 0t120 0"/></g><text x="16" y="282" font-family="monospace" font-size="14" fill="rgba(255,255,255,.7)">#${String(i + 1).padStart(2, '0')}</text></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
};
const POSTS = CAPTIONS.map((caption, i) => {
  const [media_type, product_type] = TYPES[i % TYPES.length];
  const id = String(18190357408417000 + i * 1371);
  return {
    id, caption, media_type, product_type, thumbnail: i === 12 ? null : thumb(i),
    permalink: `https://www.instagram.com/${product_type === 'REELS' ? 'reel' : 'p'}/Cx${id.slice(-6)}/`,
    timestamp: new Date(now - (i * 1.4 + 0.2) * DAY).toISOString().replace('Z', '+0000'),
    comments_count: [214, 38, 9, 86, 12, 61, 3, 27, 140, 6, 19, 44, 8, 2, 31, 17][i],
    trial: i === 2,
  };
});
const P = (i) => POSTS[i].id;

let automations, settings, activity, pool, healthMode = 'ok';
const uid = () => 'a_' + randomBytes(4).toString('hex').slice(0, 6);

function seed() {
  automations = [
    { id: 'a_diwali', name: 'Diwali code', enabled: true, keyword: 'DIWALI', aliases: ['DEEPAWALI'], match: 'fuzzy',
      dm: "here's the code 🪔 the whole worker, readme included. fork it, break it, make it yours.",
      link: 'https://github.com/theChitranshM/ig-comment-dm', ack: 'sent 🪔 check your dms', like: true, all_posts: false,
      media_ids: [P(0), P(1), P(8)], created_at: iso(9 * DAY), updated_at: iso(2 * DAY) },
    { id: 'a_eye', name: 'Third Eye', enabled: true, keyword: 'EYE', aliases: [], match: 'exact',
      dm: 'the notebook that reads your git history like a horoscope. it is weirdly accurate.',
      link: 'https://github.com/theChitranshM/third-eye', ack: 'check your dms 👁️', like: true, all_posts: false,
      media_ids: [P(3), P(10)], created_at: iso(6 * DAY), updated_at: iso(3 * DAY) },
    { id: 'a_orb', name: 'Fortune Orb', enabled: false, keyword: 'ORB', aliases: ['FORTUNE'], match: 'fuzzy',
      dm: 'your fortune is attached. results may vary, regex is not a prophet.',
      link: 'https://fortune-orb.example.dev', ack: '', all_posts: true,
      media_ids: [], created_at: iso(4 * DAY), updated_at: iso(1 * DAY) },
  ];
  settings = { dry_run: false, exclude_media_ids: [P(6)] };
  const U = ['mira.codes', 'kiran.codes', 'mayabuilds', 'aarav_dev_', 'tanvi.shh', 'rohan_k_97', 'the.pixel.nomad', 'nikhil.exe', 'zoya_writes_code', 'dev.with.dhruv', 'priyaa.bytes', 'jas.in.yvr'];
  const row = (i, a, text, stage, ageMs, src = 'webhook', media = 0, note = null, attempts = 1) => ({
    comment_id: String(1808000000000000 + i * 7919), automation_id: a.id, automation_name: a.name, keyword: a.keyword,
    user: U[i % U.length], text, media_id: P(media), source: src, stage, attempts, note, updated_at: iso(ageMs),
  });
  const [d, e, o] = automations;
  activity = [
    row(0, d, 'diwali pls 🙏', 'new', 20e3),
    row(1, e, 'EYE', 'dm_sent', 3 * MIN, 'webhook', 3),
    row(2, d, 'diwalli!!', 'done', 9 * MIN),
    row(3, d, 'DIWALIIII send the repo', 'done', 22 * MIN),
    row(4, e, 'eye eye eye', 'done_noack', 41 * MIN, 'poll', 10),
    row(5, d, 'd i w a l i', 'done', 1.2 * HR),
    row(6, d, 'deepawali code please', 'failed', 2 * HR, 'webhook', 1, 'Instagram error 551: this person is unavailable (cannot receive messages from this account)', 3),
    row(7, o, 'orb 🔮', 'done', 3.5 * HR, 'webhook', 5),
    row(8, d, 'Diwali', 'done', 5 * HR, 'poll', 8),
    row(9, e, 'eye pls', 'done', 8 * HR, 'webhook', 3),
    row(10, d, 'diwalii i need this', 'done', 11 * HR),
    row(11, d, 'diwali code?', 'failed', 14 * HR, 'poll', 0, 'The 24h messaging window for this user has closed', 2),
    row(0, o, 'FORTUNE', 'done', 20 * HR, 'webhook', 5),
    row(3, d, 'diwali', 'done', 26 * HR, 'webhook', 0),
    row(5, e, 'eye', 'done', 30 * HR, 'poll', 10),
    row(8, d, 'diwaly pls pls', 'done', 2.2 * DAY, 'webhook', 8),
    row(2, d, 'DIWALI', 'done', 2.6 * DAY),
    row(7, o, 'orb', 'done_noack', 3 * DAY, 'webhook', 5),
  ];
  const C = (i, user, text, media, ago) => ({
    comment_id: String(1809000000000000 + i * 4243), user, text, media_id: P(media), timestamp: iso(ago).replace('Z', '+0000'), answered: false,
  });
  pool = [
    C(0, 'tanvi.shh', 'EYE', 3, 5 * HR), C(1, 'rohan_k_97', 'eye pls 🙏', 3, 1.4 * DAY),
    C(2, 'nikhil.exe', 'eye!!', 10, 2.5 * DAY),
    C(3, 'zoya_writes_code', 'diwali', 4, 3 * HR), C(4, 'dev.with.dhruv', 'diwalli code pls', 4, 1.1 * DAY),
    C(5, 'priyaa.bytes', 'DIWALI send it', 5, 2 * DAY), C(6, 'jas.in.yvr', 'deepawali', 5, 4.5 * DAY),
    C(7, 'aarav_dev_', 'd i w a l i', 7, 6 * DAY),
  ];
}
seed();

// ---------- matching ----------
const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const squash = (w) => w.replace(/(.)\1+/g, '$1');
function lev(a, b) {
  const m = a.length, n = b.length; if (Math.abs(m - n) > 1) return 2;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
function tokens(text) {
  const t = fold(text).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const out = [...t]; let run = '';
  for (const w of t) { if (w.length === 1) run += w; else { if (run.length > 1) out.push(run); run = ''; } }
  if (run.length > 1) out.push(run);
  return out;
}
function matches(a, text) {
  const words = tokens(text);
  for (const kw of [a.keyword, ...(a.aliases || [])].map(fold)) {
    for (const w of words) {
      if (w === kw) return true;
      if (a.match === 'fuzzy') {
        const s = squash(w), k = squash(kw);
        if (s === k || (k.length >= 4 && lev(s, k) <= 1)) return true;
      }
    }
  }
  return false;
}
const runsOn = (a, mid) => (a.all_posts ? !settings.exclude_media_ids.includes(mid) : a.media_ids.includes(mid));

function withStats(a) {
  const mine = activity.filter((x) => x.automation_id === a.id);
  const sent = mine.filter((x) => ['done', 'done_noack', 'dm_sent'].includes(x.stage));
  return { ...a, stats: {
    sent: sent.length + (a.id === 'a_diwali' ? 118 : a.id === 'a_eye' ? 41 : 7), failed: mine.filter((x) => x.stage === 'failed').length,
    pending: mine.filter((x) => ['new', 'dm_sent'].includes(x.stage)).length,
    last_sent_at: sent.length ? sent.map((x) => x.updated_at).sort().at(-1) : null } };
}

// ---------- http ----------
const sessions = new Set();
const json = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve) => {
  let s = ''; req.on('data', (c) => (s += c));
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve(null); } });
});
const cookieOf = (req) => /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '')?.[1];

function validate(a, id) {
  if (!String(a.keyword || '').trim()) return 'Keyword is required.';
  if (!String(a.dm || '').trim()) return 'Message is required.';
  if (a.link && !/^https?:\/\/\S+$/i.test(a.link)) return 'Link must start with http:// or https://';
  if ((a.dm + (a.link ? '\n' + a.link : '')).length > 1000) return 'The DM, including the link, can be at most 1000 characters.';
  if ((a.ack || '').length > 300) return 'Public reply can be at most 300 characters.';
  if (a.enabled) {
    const mine = [a.keyword, ...a.aliases].map((x) => x.toUpperCase());
    for (const o of automations) {
      if (o.id === id || !o.enabled) continue;
      const theirs = [o.keyword, ...o.aliases].map((x) => x.toUpperCase());
      const hit = mine.find((x) => theirs.includes(x));
      const overlap = a.all_posts || o.all_posts || a.media_ids.some((m) => o.media_ids.includes(m));
      if (hit && overlap) return `"${hit}" is already used by "${o.name}" on an overlapping post.`;
    }
  }
  return null;
}
const clean = (b, base = {}) => {
  const a = { ...base };
  for (const k of ['name', 'dm', 'link', 'ack', 'opener', 'opener_button', 'gate_text', 'gate_button']) if (k in b) a[k] = String(b[k] ?? '').trim();
  if ('like' in b) a.like = b.like === true;
  if ('follow_gate' in b) a.follow_gate = b.follow_gate === true;
  if ('keyword' in b) a.keyword = String(b.keyword ?? '').trim().toUpperCase();
  if ('aliases' in b) a.aliases = (b.aliases || []).map((x) => String(x).trim().toUpperCase()).filter(Boolean);
  if ('match' in b) a.match = b.match === 'exact' ? 'exact' : 'fuzzy';
  for (const k of ['enabled', 'all_posts']) if (k in b) a[k] = !!b[k];
  if ('media_ids' in b) a.media_ids = (b.media_ids || []).map(String);
  return a;
};

async function api(req, res, url) {
  const path = url.pathname, method = req.method;
  await sleep(150 + Math.random() * 250);
  if (path === '/api/login' && method === 'POST') {
    const b = await readBody(req);
    if (req.headers['x-requested-with'] !== 'ig-comment-dm') return json(res, 403, { error: 'Missing X-Requested-With header.' });
    if (b?.key !== 'dev') return json(res, 401, { error: 'Wrong admin key.' });
    const sid = randomBytes(16).toString('hex'); sessions.add(sid);
    return json(res, 200, { ok: true }, { 'set-cookie': `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` });
  }
  const authed = sessions.has(cookieOf(req)) || req.headers.authorization === 'Bearer dev';
  if (!authed) return json(res, 401, { error: 'Not logged in.' });
  const viaCookie = sessions.has(cookieOf(req));
  if (method !== 'GET' && viaCookie && req.headers['x-requested-with'] !== 'ig-comment-dm')
    return json(res, 403, { error: 'Missing X-Requested-With header.' });
  const body = method === 'GET' ? {} : await readBody(req);
  if (body === null) return json(res, 400, { error: 'Invalid JSON.' });

  if (path === '/api/logout' && method === 'POST') {
    sessions.delete(cookieOf(req));
    return json(res, 200, { ok: true }, { 'set-cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (path === '/api/overview' && method === 'GET') {
    const health = { ok: true, token: true, account: true, account_error: null, webhook_callback: true, webhook_comments: true, account_subscribed: true };
    if (healthMode === 'bad') Object.assign(health, { ok: false, account: false, account_error: 'Error validating access token: the session has been invalidated.', account_subscribed: false });
    if (healthMode === 'webhook') Object.assign(health, { ok: false, webhook_comments: false });
    const sentStages = ['done', 'done_noack', 'dm_sent'];
    return json(res, 200, {
      account: ACCOUNT, health,
      totals: {
        automations: automations.length, active: automations.filter((a) => a.enabled).length,
        sent_24h: activity.filter((x) => sentStages.includes(x.stage) && now - Date.parse(x.updated_at) < DAY).length,
        sent_total: automations.reduce((n, a) => n + withStats(a).stats.sent, 0),
        failed: activity.filter((x) => x.stage === 'failed').length,
        pending: activity.filter((x) => ['new', 'dm_sent'].includes(x.stage)).length,
      },
      settings,
      alerts: { webhook: false },
    });
  }
  if (path === '/api/automations' && method === 'GET') return json(res, 200, { automations: automations.map(withStats) });
  if (path === '/api/automations' && method === 'POST') {
    const a = clean(body, { name: '', enabled: true, aliases: [], match: 'fuzzy', link: '', ack: '', all_posts: false, media_ids: [] });
    if (!a.name) a.name = a.keyword ? a.keyword[0] + a.keyword.slice(1).toLowerCase() : '';
    const err = validate(a, null); if (err) return json(res, 400, { error: err });
    a.id = uid(); a.created_at = a.updated_at = new Date().toISOString();
    automations.push(a); return json(res, 200, { automation: withStats(a) });
  }
  if (path === '/api/automations/reorder' && method === 'POST') {
    const ids = body.ids || [];
    if (ids.length !== automations.length || !ids.every((i) => automations.some((a) => a.id === i))) return json(res, 400, { error: 'ids must list every automation exactly once.' });
    automations = ids.map((i) => automations.find((a) => a.id === i)); return json(res, 200, { ok: true });
  }
  let m = /^\/api\/automations\/([\w-]+)(?:\/(waiting|send-waiting))?$/.exec(path);
  if (m) {
    const a = automations.find((x) => x.id === m[1]);
    if (!a) return json(res, 404, { error: 'Automation not found.' });
    const waiting = () => pool.filter((c) => !c.answered && runsOn(a, c.media_id) && matches(a, c.text));
    if (!m[2] && method === 'PUT') {
      const next = clean(body, a); const err = validate(next, a.id); if (err) return json(res, 400, { error: err });
      Object.assign(a, next, { updated_at: new Date().toISOString() }); return json(res, 200, { automation: withStats(a) });
    }
    if (!m[2] && method === 'DELETE') { automations = automations.filter((x) => x !== a); return json(res, 200, { ok: true }); }
    if (m[2] === 'waiting' && method === 'GET') {
      if (!a.enabled) return json(res, 200, { comments: [] });
      return json(res, 200, { comments: waiting().map(({ answered, ...c }) => c) });
    }
    if (m[2] === 'send-waiting' && method === 'POST') {
      const w = waiting(); const want = Array.isArray(body.comment_ids) ? w.filter((c) => body.comment_ids.includes(c.comment_id)) : w;
      const results = want.map((c, i) => {
        c.answered = true; const sent = i < 2;
        activity.unshift({ comment_id: c.comment_id, automation_id: a.id, automation_name: a.name, keyword: a.keyword, user: c.user, text: c.text,
          media_id: c.media_id, source: 'poll', stage: sent ? 'done' : 'new', attempts: 1, note: null, updated_at: new Date().toISOString() });
        return { comment_id: c.comment_id, result: sent ? 'sent' : 'queued', note: null };
      });
      return json(res, 200, { sent: results.filter((r) => r.result === 'sent').length, queued: results.filter((r) => r.result === 'queued').length, failed: 0, results });
    }
  }
  if (path === '/api/posts' && method === 'GET') {
    const limit = Math.min(Number(url.searchParams.get("limit")) || 24, 12);
    const start = Number(url.searchParams.get('after')) || 0;
    const slice = POSTS.slice(start, start + limit).map((p) => ({ ...p, automation_ids: automations.filter((a) => a.enabled && runsOn(a, p.id)).map((a) => a.id) }));
    return json(res, 200, { posts: slice, next: start + limit < POSTS.length ? String(start + limit) : null });
  }
  if (path === '/api/try' && method === 'POST') {
    const text = String(body.text || '');
    const hit = automations.find((a) => a.enabled && (!body.media_id || runsOn(a, body.media_id)) && matches(a, text));
    return json(res, 200, { match: hit ? { automation_id: hit.id, name: hit.name, keyword: hit.keyword, mode: hit.match } : null });
  }
  if (path === '/api/activity' && method === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
    return json(res, 200, { items: [...activity].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, limit) });
  }
  if (path === '/api/alerts/test' && method === 'POST') return json(res, 200, { sent: 1, channels: [{ channel: 'ntfy', ok: true }] });
  if (path === '/api/reconnect' && method === 'POST') {
    healthMode = 'ok';
    return json(res, 200, { link: 'https://www.facebook.com/dialog/oauth?client_id=mock&redirect_uri=http%3A%2F%2Flocalhost%3A8788%2Fapp' });
  }
  if (path === '/api/settings' && method === 'PUT') {
    if ('dry_run' in body) settings.dry_run = !!body.dry_run;
    if (Array.isArray(body.exclude_media_ids)) settings.exclude_media_ids = body.exclude_media_ids.map(String);
    return json(res, 200, { settings });
  }
  return json(res, 404, { error: 'No such route.' });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/') { res.writeHead(302, { location: '/app' }); return res.end(); }
    if (url.pathname === '/app' || url.pathname === '/app/') {
      const h = url.searchParams.get('health'); if (h) healthMode = h;
      if (url.searchParams.has('dry')) settings.dry_run = url.searchParams.get('dry') === '1';
      if (url.searchParams.get('empty') === '1') automations = [];
      const html = await readFile(APP, 'utf8');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      });
      return res.end(html);
    }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    json(res, 404, { error: 'Not found.' });
  } catch (e) { console.error(e); json(res, 500, { error: 'Mock server error: ' + e.message }); }
}).listen(PORT, () => console.log(`ui-mock on http://localhost:${PORT}/app  (login key: dev)`));
