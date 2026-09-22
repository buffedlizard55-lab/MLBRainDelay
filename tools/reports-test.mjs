import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Match must load before Reports so prepare() can annotate when a slate is given.
const Match = require('../assets/js/match.js');
globalThis.Match = Match;
const Reports = require('../assets/js/reports.js');
const now = Date.parse('2026-09-21T22:00:00Z');
const item = {title: 'Synthetic rain delay', link: 'https://www.mlb.com/news/test', feedUrl: 'https://www.mlb.com/feeds/news/rss.xml', pubDate: 'Mon, 21 Sep 2026 16:00:00 EST'};
const report = { generatedAt: new Date(now).toISOString(), flagged: [item, item], feeds: [{ok: true}] };
assert.equal(Reports.prepare(report, now).items.length, 1);
assert.equal(Reports.prepare(report, now).items[0].epoch, Date.parse('2026-09-21T21:00:00Z'));
for (const url of ['javascript:alert(1)', 'http://www.mlb.com', 'https://www.mlb.com.evil.test', 'https://evil.test/mlb.com', 'https://user@www.mlb.com']) assert.equal(Reports.safeUrl(url), null);
assert.equal(Reports.prepare({...report, flagged: [{...item, link: 'javascript:alert(1)'}]}, now).items.length, 0);
// Reddit post links from the social scanner are canonical www.reddit.com
// permalinks — allow the exact host, reject lookalikes and other platforms.
assert.equal(Reports.safeUrl('https://www.reddit.com/r/baseball/comments/abc001/fenway_rain_delay/'), 'https://www.reddit.com/r/baseball/comments/abc001/fenway_rain_delay/');
for (const url of ['https://reddit.com.evil.test/r/baseball', 'https://www.reddit.com.evil.test/x', 'https://old.reddit.com/r/baseball/comments/x/', 'https://twitter.com/MLB']) assert.equal(Reports.safeUrl(url), null);
assert.equal(Reports.CATEGORY_LABEL.community, 'Community — NOT official');
assert.match(Reports.prepare(report, now + 3600000).warnings.join(), /stale/);
assert.match(Reports.prepare(report, now - 3600000).warnings.join(), /future/);
assert.match(Reports.prepare({...report, feeds: [{ok:false}]}, now).warnings.join(), /incomplete/);
assert.throws(() => Reports.prepare({}), /Invalid/);
assert.equal(Reports.prepare({...report, flagged: []}, now).items.length, 0);

// Deterministic game linking when a slate is provided.
const slate = [{
  gamePk: 900001, _listingDate: '2026-09-20', officialDate: '2026-09-20', doubleHeader: 'N', gameNumber: 1,
  teams: {
    away: { team: { id: 147, name: 'New York Yankees', abbreviation: 'NYY', teamName: 'Yankees' } },
    home: { team: { id: 110, name: 'Baltimore Orioles', abbreviation: 'BAL', teamName: 'Orioles' } },
  },
}];
const linked = {
  title: 'Yankees-Orioles delayed; restart at 9:05 p.m. ET',
  link: 'https://www.mlb.com/news/nyy-bal-delay',
  feedUrl: 'https://www.mlb.com/feeds/news/rss.xml',
  pubDate: 'Mon, 21 Sep 2026 16:00:00 EST',
};
const prepared = Reports.prepare({ generatedAt: new Date(now).toISOString(), flagged: [linked], feeds: [{ ok: true }] }, now, slate);
assert.equal(prepared.items[0].match.status, 'matched');
assert.equal(prepared.items[0].match.games[0].gamePk, 900001);
assert.equal(prepared.items[0].announcedTimes.length, 1);
assert.equal(prepared.items[0].announcedTimes[0].hour24, 21);
assert.match(prepared.warnings.join(), /Deterministic linker/);

// Without a slate the items still render and carry no match block.
const bare = Reports.prepare({ generatedAt: new Date(now).toISOString(), flagged: [linked], feeds: [{ ok: true }] }, now);
assert.equal(bare.items[0].match, undefined);

console.log('Report model: deduplication, timezone, URL safety, stale/future/failed/empty/invalid snapshot, game-link annotation checks passed');
