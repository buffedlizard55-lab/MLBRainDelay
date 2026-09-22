#!/usr/bin/env node
/* ============================================================================
 * tools/news-test.mjs — offline tests for tools/news-scan.mjs
 * Runs with no network: parses a captured MLB RSS structure (fixture) and a
 * synthetic ESPN-style feed, and asserts the scanner only flags headlines that
 * actually contain the documented delay/weather vocabulary — never anything
 * else, and never invents a field the feed didn't publish.
 *   node tools/news-test.mjs
 * ==========================================================================*/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  parseRss, parseReddit, classifyItem, decodeEntities, stripCdata, stripTags, pubDateToEpoch,
  DELAY_WORDS, WEATHER_WORDS, FEEDS, SOCIAL_FEEDS, fetchFeed,
} from './news-scan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (name) => JSON.parse(readFileSync(path.join(here, 'fixtures', name), 'utf8'));

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n${err.stack || err}`); process.exitCode = 1; }
}

console.log('news-scan.mjs — XML/RSS parsing');
await test('parseRss reads channel title/link and every item field verbatim', () => {
  const r = parseRss(fx('mlb-rss-sample.json').xml);
  assert.equal(r.title, 'MLB News');
  assert.equal(r.link, 'https://www.mlb.com');
  assert.equal(r.items.length, 4);
  const first = r.items[0];
  assert.equal(first.title, "Holliday (wrist) unlikely to play again for O's in final week");
  assert.equal(first.link, 'https://www.mlb.com/news/jackson-holliday-left-wrist-injury-update');
  assert.equal(first.pubDate, 'Mon, 21 Sep 2026 20:49:36 GMT');
  assert.equal(first.author, 'MLB.com');
  assert.equal(first.guid, '1790023776');
  assert.equal(first.description, 'Holliday out with a wrist injury for the Orioles.');
});
await test('parseRss handles CDATA wrapped titles and missing items', () => {
  const r = parseRss('<rss><channel><title><![CDATA[Dodgers News]]></title><link>https://www.mlb.com/dodgers</link></channel></rss>');
  assert.equal(r.title, 'Dodgers News');
  assert.equal(r.items.length, 0);
  assert.deepEqual(parseRss(''), { title: null, link: null, items: [] });
  assert.deepEqual(parseRss(null), { title: null, link: null, items: [] });
});
await test('parseRss drops items without a title (nothing can be reviewed from them)', () => {
  const r = parseRss('<rss><channel><title>T</title><item><description>no title</description></item><item><title>real</title></item></channel></rss>');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].title, 'real');
});
await test('entity decoding and tag stripping', () => {
  assert.equal(decodeEntities('O&#39;s &amp; Co &lt;b&gt;'), "O's & Co <b>");
  assert.equal(stripCdata('<![CDATA[ hello ]]>'), ' hello ');
  assert.equal(stripTags('  <b>hi</b> there   '), 'hi there');
});
await test('pubDateToEpoch interprets RSS dates and passes through ISO-date fallback', () => {
  // EST is five hours behind GMT; the source offset must be preserved.
  assert.equal(pubDateToEpoch('Mon, 21 Sep 2026 20:49:36 EST') - pubDateToEpoch('Mon, 21 Sep 2026 20:49:36 GMT'), 5 * 3600000);
  const iso = Date.parse('2026-09-21T20:49:36Z');
  assert.equal(pubDateToEpoch('2026-09-21T20:49:36Z'), iso, 'ISO date falls through to Date.parse');
  assert.equal(pubDateToEpoch('not a date'), null);
  assert.equal(pubDateToEpoch(null), null);
});

console.log('news-scan.mjs — keyword classification (verbatim, no inference)');
await test('a delay headline is flagged with the delay words that matched', () => {
  const c = classifyItem({ title: 'O\'s rained out in Baltimore; makeup set for October', description: '' });
  assert.equal(c.flagged, true);
  assert.ok(c.delay.includes('postpon') === false, 'no false matches');
  assert.ok(c.delay.includes('rainout') === false);
  assert.ok(c.delay.includes('makeup'));
  assert.ok(c.weather.includes('rain'));
});
await test('a weather-only headline is flagged and keeps the delay list empty', () => {
  const c = classifyItem({ title: 'Thunderstorms expected this evening', description: 'Lightning possible' });
  assert.equal(c.flagged, true);
  assert.equal(c.delay.length, 0);
  assert.ok(c.weather.includes('thunder'));
  assert.ok(c.weather.includes('lightning'));
});
await test('a plain news item is NOT flagged', () => {
  assert.equal(classifyItem({ title: 'Holliday (wrist) unlikely to play again' }).flagged, false);
  assert.equal(classifyItem({ title: "Tigers' home ballpark renamed to Fifth Third Park" }).flagged, false);
});
await test('every flag comes from the documented word lists — the fixture items match exactly', () => {
  const items = fx('mlb-rss-sample.json').rss.items.map((i) => ({ title: i.title, description: i.description }));
  const classified = items.map(classifyItem);
  assert.deepEqual(classified.slice(0, 2).map((c) => c.flagged), [false, false], 'the two captured (non-synthetic) items must not flag');
  const rainOut = classified[2];
  const plain = classified[3];
  assert.equal(rainOut.flagged, true, 'the synthetic rain-out item flags');
  // Title + description both count: "postponement" and "makeup" match the
  // delay list; "rain" matches the weather list.
  assert.deepEqual(rainOut.delay, ['postpon', 'makeup']);
  assert.deepEqual(rainOut.weather, ['rain']);
  assert.equal(plain.flagged, false, 'the synthetic regular item does not flag');
});
await test('word lists are lowercased at match time so capitalisation never matters', () => {
  assert.equal(classifyItem({ title: 'DELAYED: Postponement of tonight\u2019s game' }).flagged, true);
  const delayed = classifyItem({ title: 'Delayed: Rain' });
  assert.equal(delayed.delay.includes('delay'), true);
  assert.equal(delayed.weather.includes('rain'), true);
});

console.log('news-scan.mjs — feed configuration');
await test('FEEDS covers the league feed, ESPN and all 30 club feeds with https URLs', () => {
  assert.ok(FEEDS.length >= 39, `Expected at least 39 feeds (league+wire+clubs), got ${FEEDS.length}`);
  assert.ok(FEEDS.some((f) => f.url === 'https://www.mlb.com/feeds/news/rss.xml'));
  assert.ok(FEEDS.some((f) => f.url === 'https://www.espn.com/espn/rss/mlb/news'));
  const slugs = new Set(FEEDS.map((f) => f.url.match(/mlb\.com\/([a-z]+)\/feeds\/news\/rss\.xml/)).filter(Boolean).map((m) => m[1]));
  assert.equal(slugs.size, 30, 'one feed per club');
  assert.ok(FEEDS.every((f) => f.url.startsWith('https://')));
  // The word lists are the documented, transparent vocabulary; assert a few
  // representative members rather than an order-sensitive snapshot.
  assert.deepEqual(DELAY_WORDS.filter((w) => ['delay', 'delayed', 'postpon', 'tarp', 'inclement', 'resume'].includes(w)), ['delay', 'delayed', 'postpon', 'tarp', 'resume', 'inclement']);
  assert.ok(WEATHER_WORDS.includes('rain') && WEATHER_WORDS.includes('thunder') && WEATHER_WORDS.includes('lightning'));
  assert.equal(WEATHER_WORDS.includes('weathers'), false, 'stem word list uses "weather" (matches "weathers" via substring)');
});

await test('malformed numeric entities do not crash the scanner', () => {
  assert.equal(decodeEntities('&#99999999;'), '&#99999999;');
});
await test('word starts avoid training and window false positives', () => {
  assert.equal(classifyItem({title: 'Spring training window opens'}).flagged, false);
});
await test('timestamps without explicit timezone are unknown', () => {
  assert.equal(pubDateToEpoch('2026-09-21T18:00:00'), null);
});
await test('HTTP 200 HTML is a feed failure, not an empty healthy feed', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ok: true, status: 200, text: async () => '<html>Access denied</html>'});
    const result = await fetchFeed(FEEDS[0]);
    assert.equal(result.ok, false);
    assert.match(result.error, /Unexpected feed format/);
    globalThis.fetch = async () => ({ok: true, status: 200, text: async () => '<rss><channel><title>Empty</title></channel></rss>'});
    assert.equal((await fetchFeed(FEEDS[0])).ok, true);
  } finally { globalThis.fetch = previous; }
});

console.log('news-scan.mjs — social (Reddit) parsing');
const redditFx = fx('reddit-baseball-sample.json');
await test('parseReddit reads children verbatim into the shared item shape', () => {
  const r = parseReddit(redditFx);
  // The title-less post (abc004) is dropped; the other four are kept.
  assert.equal(r.items.length, 4);
  const first = r.items[0];
  assert.equal(first.title, 'Fenway rain delay: tarp down, game suspended');
  assert.equal(first.link, 'https://www.reddit.com/r/baseball/comments/abc001/fenway_rain_delay_tarp_down_game_suspended/');
  assert.equal(first.pubDate, new Date(1789970000 * 1000).toISOString());
  assert.equal(first.author, 'testfan');
  assert.equal(first.guid, 'abc001');
  assert.ok(first.description.toLowerCase().includes('tarp'));
});
await test('parseReddit drops posts without a title (nothing reviewable)', () => {
  const r = parseReddit(redditFx);
  assert.equal(r.items.some((i) => i.guid === 'abc004'), false);
});
await test('parseReddit links via the subreddit permalink, not an external url', () => {
  const r = parseReddit(redditFx);
  const linked = r.items.find((i) => i.guid === 'abc005');
  assert.ok(linked.link.startsWith('https://www.reddit.com/'));
  assert.equal(linked.link.includes('example.com'), false);
});
await test('parseReddit tolerates missing / malformed payloads', () => {
  assert.deepEqual(parseReddit(null), { title: null, link: null, items: [] });
  assert.deepEqual(parseReddit({}), { title: null, link: null, items: [] });
  assert.deepEqual(parseReddit({ data: { children: [] } }), { title: null, link: null, items: [] });
});
await test('parseReddit accepts absolute reddit.com permalinks, rejects others', () => {
  const one = (d) => parseReddit({ data: { children: [{ kind: 't3', data: d }] } }).items;
  assert.equal(one({ title: 't', permalink: '/r/baseball/comments/x/', created_utc: 1789970000 }).length, 1);
  assert.equal(one({ title: 't', permalink: 'https://www.reddit.com/r/baseball/comments/x/', created_utc: 1789970000 }).length, 1);
  assert.equal(one({ title: 't', permalink: 'https://example.com/stealth/', created_utc: 1789970000 }).length, 0, 'non-reddit absolute permalink dropped');
  assert.equal(one({ title: 't', url: 'https://example.com/outbound', created_utc: 1789970000 }).length, 0, 'no permalink → not reviewable, outbound url never used');
});
await test('classifyItem flags the synthetic rain-delay thread and not the hot take', () => {
  const items = fx('reddit-baseball-sample.json').data.children
    .filter((c) => c.data.title)
    .map((c) => ({ title: c.data.title, description: c.data.selftext }));
  const fenway = classifyItem(items[0]);
  assert.equal(fenway.flagged, true);
  assert.ok(fenway.delay.includes('tarp'));
  assert.ok(fenway.delay.includes('suspend'));
  assert.ok(fenway.weather.includes('rain'));
  const hotTake = classifyItem(items[2]);
  assert.equal(hotTake.flagged, false);
});
await test('fetchFeed treats a Reddit 403 as an explicit per-feed failure, not success', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => 'blocked' });
    const result = await fetchFeed(SOCIAL_FEEDS[0]);
    assert.equal(result.ok, false);
    assert.equal(result.category, 'community');
    assert.match(result.error, /403/);
  } finally { globalThis.fetch = previous; }
});
await test('fetchFeed parses a Reddit JSON listing end-to-end', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(redditFx) });
    const result = await fetchFeed(SOCIAL_FEEDS[0]);
    assert.equal(result.ok, true);
    assert.equal(result.items, 4);
    assert.ok(result.flagged.length >= 2, 'at least the two weather threads flag');
    assert.ok(result.flagged.every((f) => f.link.startsWith('https://www.reddit.com/')));
    assert.ok(result.flagged.every((f) => f.matched && (f.matched.delay.length || f.matched.weather.length)));
  } finally { globalThis.fetch = previous; }
});
await test('SOCIAL_FEEDS are community-categorised, keyless, https', () => {
  assert.ok(SOCIAL_FEEDS.length >= 1);
  assert.ok(SOCIAL_FEEDS.every((f) => f.url.startsWith('https://')));
  assert.ok(SOCIAL_FEEDS.every((f) => f.category === 'community'));
  assert.ok(SOCIAL_FEEDS.some((f) => f.source === 'reddit' && /reddit\.com\/r\/baseball/.test(f.url)));
});
await test('run() merges RSS and social results into one snapshot', async () => {
  const { run } = await import('./news-scan.mjs');
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('reddit')) return { ok: true, status: 200, text: async () => JSON.stringify(redditFx) };
      return { ok: true, status: 200, text: async () => '<rss><channel><title>T</title><item><title>rained out</title><link>https://www.mlb.com/news/x</link><pubDate>Mon, 21 Sep 2026 20:00:00 GMT</pubDate></item></channel></rss>' };
    };
    const report = await run({ concurrency: 5 });
    assert.equal(report.feedsScanned, report.rssFeeds + report.socialFeeds);
    assert.ok(report.feeds.some((f) => f.category === 'community'));
    assert.ok(report.flagged.some((f) => f.category === 'community' && f.feedUrl.includes('reddit.com')));
  } finally { globalThis.fetch = previous; }
});

console.log(`\n${passed} passed${process.exitCode ? ' — FAILURES above' : ''}`);
