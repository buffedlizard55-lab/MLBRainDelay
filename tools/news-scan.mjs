#!/usr/bin/env node
/* ============================================================================
 * tools/news-scan.mjs — official news-RSS scan for weather delays
 * ----------------------------------------------------------------------------
 * A keyless, server-side scanner over the OFFICIAL, machine-readable news
 * feeds of MLB.com (one league feed + one feed per club), the major
 * independent MLB news outlets, and the r/baseball community feed (Reddit's
 * keyless public JSON — the only named social platform with one). It is
 * designed to run on a schedule (GitHub Actions) or locally — never inside
 * the browser, because most of these hosts do not send CORS headers for a
 * browser page to read them. X/Twitter, Facebook, Instagram, Threads and
 * Bluesky have no keyless public read path and are not consumed (see the
 * per-platform status notes by FEEDS below).
 *
 * What it does — nothing more, nothing less:
 *   1. GET each configured RSS feed (RSS 2.0 XML).
 *   2. Parse only the machine-readable fields the feed publishes:
 *      channel <title>/<link>, item <title>, <link>, <pubDate>,
 *      <author> (or <dc:creator>), <description>, <guid>.
 *   3. Flag an item for review when its title or description matches one of the
 *      transparent keyword groups below (delay vocabulary / weather
 *      vocabulary). The groups that matched are recorded with the item.
 *   4. Emit a JSON report where every entry carries its feed URL, the exact
 *      published title, the article link and the publication timestamp —
 *      nothing is paraphrased, nothing is predicted, nothing is inferred
 *      beyond "this headline contains these words".
 *
 * It NEVER asserts that a delay happened. It only lists headlines that mention
 * delay/weather vocabulary, with a link, so a human can open the official
 * article. Feed status is reported per feed, so a failing feed is visible,
 * never silently skipped.
 *
 * Configured sources: MLB league + 30 club RSS feeds, 7 independent news
 * outlets (ESPN, CBS, Yahoo, SI, The Athletic, NBC Sports), plus one social
 * source (Reddit r/baseball JSON) categorised as community. X/Twitter,
 * Facebook and Instagram have no keyless public read API and are therefore
 * not consumed (verified 2026-09-22); they are linked for manual review on
 * the site. Availability is measured per request, not guaranteed by
 * configuration.
 *
 * Usage:
 *   node tools/news-scan.mjs            # scan and print JSON to stdout
 *   node tools/news-scan.mjs --out docs/news-report.json
 *
 * Offline tests (no network): node tools/news-test.mjs
 * ==========================================================================*/
'use strict';

/* ------------------------------------------------------------------ feeds */

const SLUGS = [
  'angels', 'astros', 'athletics', 'bluejays', 'braves', 'brewers', 'cardinals',
  'cubs', 'dbacks', 'dodgers', 'giants', 'guardians', 'mariners', 'marlins',
  'mets', 'nationals', 'orioles', 'padres', 'phillies', 'pirates', 'rangers',
  'rays', 'reds', 'redsox', 'rockies', 'royals', 'tigers', 'twins', 'whitesox',
  'yankees',
];

/*
 * RSS feeds scanned for delay / weather mentions. Everything here is a
 * PUBLIC, KEYLESS, machine-readable news feed — no API credentials, no
 * login walls. A feed failure is surfaced in the published snapshot and
 * counted against coverage; feeds are NEVER silently skipped.
 *
 * Categories:
 *   official   — MLB.com property (league or club); these are the publisher
 *                of record for an official delay / postponement announcement.
 *   wire       — Independent news wire / major outlet. Provides reporting
 *                context but is NOT an official club/league statement.
 *   community  — Fan / community discussion (Reddit). NOT official evidence;
 *                surfaced so a human can open the thread and decide.
 *
 * Platform access status (re-verified 2026-09-22):
 *   Reddit — has a public, keyless JSON API (www.reddit.com/r/{sub}/new.json).
 *     Anonymous requests from datacenter / CI egress returned HTTP 403 on
 *     2026-09-22, so the social scan attempts it every run and reports the
 *     result per feed; if the network ever allows it, data flows with no
 *     further change. It is never silently skipped.
 *   X/Twitter — no keyless public read API (public RSS deprecated 2013,
 *     anonymous web reads locked down 2023); requires authorized credentials.
 *   Facebook / Instagram — no keyless public API for page/post streams;
 *     Graph API requires a page access token.
 *   Threads / Bluesky — authenticated API access required.
 *   These platforms can only be consumed via authorized credentials
 *     (see docs/implementation-review.md).
 */
const FEEDS = [
  /* Official MLB league feed */
  { name: 'MLB.com — league news', url: 'https://www.mlb.com/feeds/news/rss.xml', category: 'official' },
  /* Official MLB transaction / transaction-adjacent feeds */
  { name: 'MLB.com — transactions', url: 'https://www.mlb.com/feeds/transactions/rss.xml', category: 'official' },
  /* Independent / wire-service reporting (context, not official statements) */
  { name: 'ESPN — MLB news', url: 'https://www.espn.com/espn/rss/mlb/news', category: 'wire' },
  { name: 'ESPN — Top MLB', url: 'https://www.espn.com/espn/rss/mlb/index', category: 'wire' },
  { name: 'CBS Sports — MLB', url: 'https://www.cbssports.com/rss/headlines/mlb/', category: 'wire' },
  { name: 'Yahoo! Sports — MLB', url: 'https://sports.yahoo.com/mlb/rss/', category: 'wire' },
  { name: 'Sports Illustrated — MLB', url: 'https://www.si.com/rss/si-baseball.rss', category: 'wire' },
  { name: 'The Athletic (feedburner mirror)', url: 'https://feeds.theathletic.com/baseball', category: 'wire' },
  { name: 'NBC Sports — Hardball Talk', url: 'https://mlb.nbcsports.com/feed/', category: 'wire' },
  /* Club feeds — official publisher-of-record per team */
  ...SLUGS.map((slug) => ({ name: `MLB.com — ${slug} news (official)`, url: `https://www.mlb.com/${slug}/feeds/news/rss.xml`, category: 'official' })),
];

/*
 * Social / community sources scanned server-side. Reddit is the only one of
 * the platforms named in the project goals with a public, keyless JSON API,
 * so it is attempted on every scan. The request is a plain GET of the public
 * listing endpoint — no credentials, no scraping of protected endpoints.
 *
 *   url:      r/baseball /new.json — the newest posts, up to `limit`
 *   shape:    { kind, data: { children: [ { kind: "t3", data: { id,
 *              title, permalink, author, created_utc, selftext, num_comments,
 *              upvote_ratio, ... } } ] } }
 *   access:   anonymous reads are frequently answered HTTP 403 from datacenter
 *             / CI egress (observed 2026-09-22). A 403 is reported as a
 *             per-feed failure in the snapshot — never silently skipped,
 *             never retried into a hammer loop.
 *
 * These are COMMUNITY sources: fan discussion, not official club or league
 * statements, and never treated as evidence that a delay happened.
 */
const SOCIAL_FEEDS = [
  { name: 'Reddit — r/baseball (community, NOT official)', url: 'https://www.reddit.com/r/baseball/new.json?limit=100&raw_json=1', category: 'community', source: 'reddit' },
];

/* ------------------------------------------------------------- vocabulary */

/* Transparent keyword groups. A hit is "flagged for review", nothing more. */
const DELAY_WORDS = ['delay', 'delayed', 'postpon', 'suspend', 'suspended', 'tarp', 'rainout', 'rain out', 'makeup', 'make-up', 'resume', 'resum', 'inclement', 'wet grounds', 'first pitch'];
const WEATHER_WORDS = ['rain', 'shower', 'storm', 'thunder', 'lightning', 'tornado', 'flood', 'hail', 'wind', 'fog', 'snow', 'drizzle', 'sleet', 'freez', 'wintry', 'blizzard', 'tropical', 'hurricane', 'weather', 'precipit'];

/* ------------------------------------------------------------- XML utils */

/* Decode the common XML/HTML entities; leave anything else untouched. */
function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
  return String(s)
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, key) => {
      if (named[key] != null) return named[key];
      if (key[0] === '#') {
        const code = key[1] === 'x' || key[1] === 'X'
          ? parseInt(key.slice(2), 16)
          : parseInt(key.slice(1), 10);
        if (Number.isInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) return String.fromCodePoint(code);
      }
      return m;
    });
}

function stripCdata(s) {
  return String(s).replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '');
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/* Extract the text of the first occurrence of an XML tag inside `block`. */
function firstTag(block, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = re.exec(block);
  return m ? stripCdata(m[1]).trim() : null;
}

/**
 * Parse an RSS 2.0 document into { title, link, items[] }. Conservative:
 * unknown shapes simply yield empty fields — never an invented value.
 */
function parseRss(xml) {
  const out = { title: null, link: null, items: [] };
  if (typeof xml !== 'string' || !xml) return out;

  const channel = /<channel\b[^>]*>([\s\S]*?)<\/channel>/i.exec(xml);
  const body = channel ? channel[1] : xml;
  out.title = firstTag(body, 'title');
  out.link = firstTag(body, 'link');

  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(body)) !== null) {
    const block = m[1];
    const title = firstTag(block, 'title');
    if (!title) continue; // a feed entry without a title cannot be reviewed
    out.items.push({
      title,
      link: firstTag(block, 'link'),
      pubDate: firstTag(block, 'pubDate'),
      author: firstTag(block, 'author') || firstTag(block, 'dc:creator'),
      description: firstTag(block, 'description'),
      guid: firstTag(block, 'guid'),
    });
  }
  return out;
}

/**
 * Parse a Reddit `/r/{sub}/new.json` listing into the same item shape
 * parseRss emits: { title, link, pubDate, author, description, guid }.
 *
 * Verified shape (public API docs + listing response structure):
 *   { data: { children: [ { kind: "t3", data: {
 *       id, title, permalink, author, created_utc (epoch seconds),
 *       selftext, num_comments, ... } } ] } }
 *
 * Only fields the API publishes are read; a missing field yields null,
 * never an invented value. Titles/links are taken verbatim (the
 * `raw_json=1` parameter disables HTML-entity escaping, and the values
 * pass through decodeEntities() anyway, which is a no-op on clean text).
 * `pubDate` is the ISO string of created_utc — an explicit UTC instant.
 *
 * Keyword matching covers the full title plus the first 500 characters of
 * the post body — long threads are truncated for the snapshot, so a delay
 * mention buried deep in a very long selftext is not indexed (the thread
 * link is still what a reviewer opens; nothing is paraphrased).
 */
function parseReddit(json) {
  const out = { title: null, link: null, items: [] };
  const children = (json && json.data && Array.isArray(json.data.children)) ? json.data.children : [];
  children.forEach((child) => {
    const d = (child && child.data) || {};
    if (!d.title) return; // nothing reviewable without a title
    // Link only the thread itself: a relative subreddit permalink (the
    // documented shape) or an absolute reddit.com permalink. `d.url` is the
    // outbound target of link posts (external sites) and is never used.
    let link = null;
    if (typeof d.permalink === 'string') {
      if (d.permalink.startsWith('/')) link = `https://www.reddit.com${d.permalink}`;
      else if (/^https?:\/\/([a-z0-9-]+\.)*reddit\.com\//i.test(d.permalink)) link = d.permalink;
    }
    if (!link) return; // a post we cannot link to cannot be reviewed
    out.items.push({
      title: decodeEntities(String(d.title)),
      link,
      pubDate: Number.isFinite(d.created_utc) ? new Date(d.created_utc * 1000).toISOString() : null,
      author: d.author ? decodeEntities(String(d.author)) : null,
      description: d.selftext ? decodeEntities(String(d.selftext)).slice(0, 500) : null,
      guid: d.id || null,
    });
  });
  return out;
}

/* Interpret an RSS pubDate like "Mon, 21 Sep 2026 20:49:36 GMT" or
 * "Mon, 21 Sep 2026 16:55:14 EST" to a sortable UTC epoch. Returns null when
 * uninterpretable — the caller never invents a time. */
function pubDateToEpoch(pubDate) {
  if (!pubDate) return null;
  // Require an explicit zone. Never interpret a publisher's wall time as UTC.
  const text = String(pubDate).trim();
  if (!/(?:GMT|UTC|[ECMP][SD]T|[+-]\d{4}|Z|[+-]\d{2}:\d{2})$/i.test(text)) return null;
  const epoch = Date.parse(text);
  return Number.isFinite(epoch) ? epoch : null;
}

/* ----------------------------------------------- classification (verbatim) */

/**
 * Pure keyword match over an item's verbatim title + description. Returns
 * { flagged, delay: [], weather: [] } — the words that matched, so a reviewer
 * sees exactly why the item was surfaced.
 */
function classifyItem(item) {
  const text = `${item.title || ''} ${item.description || ''}`.toLowerCase();
  const lower = (list) => list.map((w) => w.toLowerCase());
  const matches = (w) => new RegExp(`\\b${w}${w === "wind" ? "(?:s|y)?\\b" : ""}`, "i").test(text);
  const delay = lower(DELAY_WORDS).filter(matches);
  const weather = lower(WEATHER_WORDS).filter(matches);
  return { flagged: delay.length > 0 || weather.length > 0, delay, weather };
}

/* ------------------------------------------------------------------- fetch */

const UA = 'MLBRainDelay-news-scan/1.0 (public MLB news RSS + Reddit community JSON; weather-delay fan project; contact: buffedlizard55-lab)';

async function fetchFeed({ name, url, category, source }, { timeout = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const headers = { 'User-Agent': UA };
    if (source === 'reddit') headers.Accept = 'application/json';
    else headers.Accept = 'application/rss+xml, application/xml, text/xml, */*';
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) {
      const errText = source === 'reddit' && res.status === 403
        ? 'HTTP 403 — Reddit blocks anonymous access from this network; the subreddit is linked for manual review'
        : `HTTP ${res.status}`;
      return { name, url, ok: false, category: category || 'unknown', source: source || 'rss', status: res.status, items: [], flagged: [], error: errText };
    }
    const body = await res.text();
    let parsed;
    if (source === 'reddit') {
      let json;
      try { json = JSON.parse(body); } catch (_) { throw new Error('Unexpected social feed format (expected JSON)'); }
      parsed = parseReddit(json);
    } else {
      if (!/<rss\b/i.test(body) || !/<channel\b/i.test(body) || !/<\/channel>/i.test(body)) {
        throw new Error('Unexpected feed format (expected RSS channel)');
      }
      parsed = parseRss(body);
    }
    const flagged = parsed.items
      .map((item) => {
        const c = classifyItem(item);
        return c.flagged ? { ...item, matched: { delay: c.delay, weather: c.weather } } : null;
      })
      .filter(Boolean);
    return { name, url, ok: true, category: category || 'unknown', source: source || 'rss', status: res.status, feedTitle: parsed.title, feedLink: parsed.link, items: parsed.items.length, flagged };
  } catch (err) {
    return { name, url, ok: false, category: category || 'unknown', source: source || 'rss', status: 0, items: [], flagged: [], error: (err && err.message) || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------------------------------------------------- run */

async function run({ feeds = null, socialFeeds = SOCIAL_FEEDS, concurrency = 3, out = null } = {}) {
  const allFeeds = feeds || [...FEEDS, ...socialFeeds];
  const results = [];
  const queue = allFeeds.slice();
  const workers = new Array(Math.min(concurrency, queue.length)).fill(0).map(async () => {
    while (queue.length) {
      const feed = queue.shift();
      results.push(await fetchFeed(feed));
    }
  });
  await Promise.all(workers);

  const report = {
    generatedAt: new Date().toISOString(),
    scanner: 'tools/news-scan.mjs',
    note: 'Headlines that mention delay/weather vocabulary, with their article link — for a human to review. Nothing here asserts that a delay happened. Entries categorised "community" are fan discussion, not official statements.',
    feedsScanned: results.length,
    rssFeeds: FEEDS.length,
    socialFeeds: socialFeeds.length,
    feedsOk: results.filter((r) => r.ok).length,
    feedsFailed: results.filter((r) => !r.ok).length,
    feeds: results,
    flagged: results
      .flatMap((r) => (r.flagged || []).map((f) => ({ feed: r.name, feedUrl: r.url, category: r.category, ...f })))
      .sort((a, b) => (pubDateToEpoch(b.pubDate) || 0) - (pubDateToEpoch(a.pubDate) || 0)),
  };

  const json = JSON.stringify(report, null, 2);
  if (out) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(out, `${json}\n`);
  }
  return report;
}

/* Exports for the offline tests (run() is only invoked from the CLI/main). */
export { parseRss, parseReddit, classifyItem, decodeEntities, stripCdata, stripTags, pubDateToEpoch, DELAY_WORDS, WEATHER_WORDS, FEEDS, SOCIAL_FEEDS, fetchFeed, run };

/* --------------------------------------------------------------- CLI/main */

/* Run the scan only when this file is the script node started (not when it is
 * imported by the tests). Comparing basenames keeps this robust across
 * relative vs absolute invocation paths on the two supported OSes. */
const path = await import('node:path');
const selfName = (() => {
  try { return path.fileURLToPath(import.meta.url); } catch (_) { return import.meta.url; }
})();
const argvName = String(process.argv[1] || '');
const invoked = selfName === argvName || path.basename(selfName) === path.basename(argvName);
if (invoked) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const out = outIdx !== -1 && args[outIdx + 1] ? args[outIdx + 1] : null;
  run({ out }).then((report) => {
    if (!out) console.log(JSON.stringify(report, null, 2));
    else console.log(`wrote ${out} — scanned ${report.feedsScanned} feeds, ${report.flagged.length} headlines flagged for review`);
  }).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
