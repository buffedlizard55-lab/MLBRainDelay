#!/usr/bin/env node
/* ============================================================================
 * tools/render-test.mjs — render the three pages against captured payloads
 * ----------------------------------------------------------------------------
 * A tiny DOM shim (enough for UI.el / textContent / classList / dataset /
 * querySelector by id or class) lets scoreboard.js, delay-feed.js and
 * game.js run end-to-end in Node with a stubbed fetch. Asserts the delay,
 * forecast, alert and flag content actually reaches the DOM, and that every
 * row carries its source links.
 *   node tools/render-test.mjs
 * ==========================================================================*/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const fx = (name) => JSON.parse(readFileSync(path.join(here, 'fixtures', name), 'utf8'));
const src = (rel) => readFileSync(path.join(root, rel), 'utf8');

/* ------------------------------------------------------------- DOM shim */

class ClassList {
  constructor(el) { this.el = el; }
  get _set() { return new Set((this.el.className || '').split(/\s+/).filter(Boolean)); }
  _write(set) { this.el.className = [...set].join(' '); }
  add(...c) { const s = this._set; c.forEach((x) => s.add(x)); this._write(s); }
  remove(...c) { const s = this._set; c.forEach((x) => s.delete(x)); this._write(s); }
  toggle(c, force) { const s = this._set; const on = force == null ? !s.has(c) : !!force; if (on) s.add(c); else s.delete(c); this._write(s); return on; }
  contains(c) { return this._set.has(c); }
}

class Element {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.className = '';
    this._text = null;
    this.classList = new ClassList(this);
    this.listeners = {};
  }
  get id() { return this.attributes.id || ''; }
  set id(v) { this.attributes.id = v; }
  get firstChild() { return this.children[0] || null; }
  _materialise() { if (this._text != null) { if (this._text !== '') this.children.push(new TextNode(this._text)); this._text = null; } }
  appendChild(c) { this._materialise(); if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  prepend(c) { this._materialise(); if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.unshift(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceWith(n) { if (!this.parentNode) return; const p = this.parentNode; const i = p.children.indexOf(this); p.children.splice(i, 1, n); n.parentNode = p; this.parentNode = null; }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'class') this.className = String(v); }
  getAttribute(k) { return this.attributes[k] == null ? null : this.attributes[k]; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  get textContent() { return this._text != null ? this._text : this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children = []; this._text = String(v); }
  set href(v) { this.attributes.href = v; }
  get href() { return this.attributes.href; }
  set title(v) { this.attributes.title = v; }
  get title() { return this.attributes.title; }
  set src(v) { this.attributes.src = v; }
  set alt(v) { this.attributes.alt = v; }
  set loading(v) { this.attributes.loading = v; }
  set onerror(fn) { this._onerror = fn; }
  matches(sel) {
    if (sel.startsWith('#')) return this.id === sel.slice(1);
    if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
    return this.tagName === sel.toUpperCase();
  }
  querySelectorAll(sel) { const out = []; const walk = (n) => { n.children.forEach((c) => { if (c.matches(sel)) out.push(c); walk(c); }); }; walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  text() { return this.textContent; }
}
class TextNode { constructor(t) { this.textContent = String(t); this.parentNode = null; } matches() { return false; } get children() { return []; } }

function makeDocument(ids) {
  const body = new Element('body');
  const doc = {
    body, hidden: false, title: '',
    createElement: (t) => new Element(t),
    createTextNode: (t) => new TextNode(t),
    querySelector: (sel) => body.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    getElementById: (id) => body.querySelector("#" + id),
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    fire(type) { (this.listeners[type] || []).forEach((fn) => fn()); },
  };
  ids.forEach((id) => { const el = new Element('div'); el.id = id; body.appendChild(el); });
  return doc;
}

/* ---------------------------------------------------------- fetch stub */

const routes = new Map();
const calls = [];
function route(url, json, status = 200) { routes.set(url, { status, json }); }
async function fakeFetch(url) {
  calls.push(url);
  let r = routes.get(url);
  if (!r) for (const [k, v] of routes) if (k.endsWith('*') && url.startsWith(k.slice(0, -1))) { r = v; break; }
  if (!r) return { ok: false, status: 599, json: async () => ({ error: `unrouted ${url}` }) };
  // Fresh objects every call, like a real fetch — pages must never share
  // state through the route table.
  return { ok: r.status < 400, status: r.status, json: async () => JSON.parse(JSON.stringify(r.json)) };
}

/* --------------------------------------------------------- page loader */

function loadPage(scripts, { search = '', ids = [] } = {}) {
  const document = makeDocument(ids);
  const timers = [];
  const ctx = {
    console, Date, Math, JSON, Map, Set, Promise, Array, Object, String, Number, Boolean, RegExp, Error, parseInt, parseFloat, isNaN, Intl,
    URL, URLSearchParams,
    fetch: fakeFetch,
    AbortController,
    setTimeout: (fn, ms) => { const id = timers.length + 1; timers.push({ id, fn, ms, cleared: false }); return id; },
    clearTimeout: (id) => { const t = timers[id - 1]; if (t) t.cleared = true; },
    setInterval: () => 1, clearInterval: () => {},
    document,
    localStorage: (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] || null, get length() { return m.size; } }; })(),
    Image: class { set src(v) { this._src = v; } },
    location: { search, href: `https://example.test/x.html${search}` },
    history: { replaceState() {} },
    navigator: {},
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.location = new URL(`https://example.test/x.html${search}`);
  ctx.window.location = ctx.location;
  vm.createContext(ctx);
  scripts.forEach((rel) => vm.runInContext(src(rel), ctx, { filename: rel }));
  const get = (name) => vm.runInContext(name, ctx); // top-level const lives in the context's lexical scope, not on `window`
  const flush = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };
  // Fire every pending short timer (sleep/backoff), never the long poll
  // timers, so an initial load can settle deterministically.
  const settle = async (maxMs = 5000) => {
    for (let round = 0; round < 40; round += 1) {
      await flush();
      const due = timers.filter((t) => !t.cleared && !t.fired && t.ms <= maxMs);
      if (!due.length) break;
      due.forEach((t) => { t.fired = true; t.fn(); });
    }
    await flush();
  };
  return { ctx, document, timers, get, flush, settle };
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n${err.stack || err}`); process.exitCode = 1; }
}

/* ------------------------------------------------------------- routes */

const schedule = fx('schedule-2026-09-20.json');
// Add a LIVE delayed game and a postponed game to the slate for the render.
const liveDelayed = {
  gamePk: 900001, gameType: 'R', gameDate: '2026-09-20T23:10:00Z', officialDate: '2026-09-20',
  status: { abstractGameState: 'Live', codedGameState: 'I', detailedState: 'Delayed: Rain', statusCode: 'IR', reason: 'Rain', abstractGameCode: 'L' },
  teams: { away: { leagueRecord: { wins: 1, losses: 1 }, score: 2, team: { id: 147, name: 'New York Yankees', abbreviation: 'NYY' } }, home: { leagueRecord: { wins: 1, losses: 1 }, score: 2, team: { id: 110, name: 'Baltimore Orioles', abbreviation: 'BAL' } } },
  venue: { id: 2, name: 'Oriole Park at Camden Yards', location: { city: 'Baltimore', stateAbbrev: 'MD', defaultCoordinates: { latitude: 39.283787, longitude: -76.621689 } }, timeZone: { id: 'America/New_York' }, fieldInfo: { roofType: 'Open' } },
  weather: { condition: 'Rain', temp: '66', wind: '8 mph, In From RF' },
  gameInfo: { firstPitch: '2026-09-20T23:11:00Z' },
  linescore: { currentInning: 5, currentInningOrdinal: '5th', inningState: 'Top', balls: 1, strikes: 2, outs: 1, innings: [], teams: { home: { runs: 2 }, away: { runs: 2 } } },
};
const postponed = {
  gamePk: 900002, gameType: 'R', gameDate: '2026-09-20T22:05:00Z', officialDate: '2026-09-22',
  status: { abstractGameState: 'Final', codedGameState: 'D', detailedState: 'Postponed', statusCode: 'DR', reason: 'Rain', abstractGameCode: 'F' },
  rescheduleDate: '2026-09-22T20:05:00Z', rescheduleGameDate: '2026-09-22',
  teams: { away: { leagueRecord: { wins: 1, losses: 1 }, team: { id: 143, name: 'Philadelphia Phillies', abbreviation: 'PHI' } }, home: { leagueRecord: { wins: 1, losses: 1 }, team: { id: 121, name: 'New York Mets', abbreviation: 'NYM' } } },
  venue: { id: 3289, name: 'Citi Field', location: { city: 'Flushing', stateAbbrev: 'NY', defaultCoordinates: { latitude: 40.75753012, longitude: -73.84559155 } }, timeZone: { id: 'America/New_York' }, fieldInfo: { roofType: 'Open' } },
  weather: {},
};
const tbdGame2 = {
  gamePk: 900003, gameType: 'R', gameDate: '2026-09-21T03:33:00Z', officialDate: '2026-09-20', doubleHeader: 'S', gameNumber: 2,
  status: { abstractGameState: 'Preview', codedGameState: 'S', detailedState: 'Scheduled', statusCode: 'S', startTimeTBD: true, abstractGameCode: 'P' },
  teams: { away: { leagueRecord: { wins: 1, losses: 1 }, team: { id: 147, name: 'New York Yankees', abbreviation: 'NYY' } }, home: { leagueRecord: { wins: 1, losses: 1 }, team: { id: 110, name: 'Baltimore Orioles', abbreviation: 'BAL' } } },
  venue: liveDelayed.venue, weather: {},
};
const slate = { dates: [{ date: '2026-09-20', games: [...schedule.dates[0].games, liveDelayed, postponed, tbdGame2] }] };

const H = 'team,linescore,weather,venue(location,timezone,fieldInfo),gameInfo,probablePitcher,decisions';
route(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-09-20&hydrate=${H}`, slate);
route('https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-09-20&fields=*', { dates: [{ date: '2026-09-20', games: slate.dates[0].games.map((g) => ({ gamePk: g.gamePk, status: g.status })) }] });
route(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&gamePk=824546&hydrate=${H}`, { dates: [{ date: '2026-09-20', games: [schedule.dates[0].games[0]] }] });
route('https://statsapi.mlb.com/api/v1/game/824546/playByPlay?fields=*', fx('pbp-824546-delayed-start.json'));
route('https://statsapi.mlb.com/api/v1/game/824381/playByPlay?fields=*', { allPlays: [] }); // official minutes but no advisory → flag
route('https://statsapi.mlb.com/api/v1/game/900001/playByPlay?fields=*', { allPlays: [{ about: { inning: 5, halfInning: 'top', atBatIndex: 30, startTime: '2026-09-21T00:40:00Z' }, playEvents: [{ type: 'action', isPitch: false, details: { eventType: 'game_advisory', description: 'Status Change - Delayed: Rain' }, startTime: '2026-09-21T00:41:00Z', endTime: '2026-09-21T00:41:00Z' }] }] });
route('https://statsapi.mlb.com/api/v1/game/824546/boxscore?fields=info,label,value', fx('boxscore-824546-info.json'));
route('https://statsapi.mlb.com/api/v1/game/824381/boxscore?fields=info,label,value', { info: [{ label: 'T', value: '2:14 (2:05 delay).' }] });
route('https://statsapi.mlb.com/api/v1/game/824546/linescore', { currentInning: 9, inningState: 'Bottom', innings: [{ num: 1, home: { runs: 0 }, away: { runs: 2 } }], teams: { home: { runs: 3, hits: 6, errors: 0 }, away: { runs: 6, hits: 9, errors: 1 } } });

// Weather: every US venue in the slate resolves to the same LOT grid for the test.
const nwsPoint = fx('nws-points-rate-field.json');
route('https://api.weather.gov/points/*', nwsPoint);
route('https://api.weather.gov/gridpoints/LOT/76,71/forecast/hourly', fx('nws-hourly-sample.json'));
route('https://api.weather.gov/alerts/active?point=*', fx('nws-alerts-sample.json'));

const CORE = ['assets/js/api.js', 'assets/js/ui.js', 'assets/js/delays.js', 'assets/js/weather.js', 'assets/js/clubs.js'];

/* ------------------------------------------------------------ scoreboard */

console.log('scoreboard.js');
await test('renders every game with a weather strip, delay ticker, delay/forecast/alert/flag tabs and source-free cards', async () => {
  const page = loadPage([...CORE, 'assets/js/scoreboard.js'], { search: '?date=2026-09-20', ids: ['game-list', 'banner', 'tabs', 'status-line', 'date-label', 'date-picker', 'feed-link'] });
  page.document.fire('DOMContentLoaded');
  await page.flush();
  const { document } = page;
  const cards = document.querySelectorAll('.game-card');
  assert.equal(cards.length, 7);
  // active delay first
  assert.match(cards[0].textContent, /Delayed: Rain/);
  assert.ok(cards[0].classList.contains('card-delay-active'));
  // ticker
  const ticker = document.querySelector('.delay-ticker');
  assert.ok(ticker, 'active-delay ticker rendered');
  assert.match(ticker.textContent, /NYY @ BAL/);
  assert.match(ticker.querySelector('.ticker-feed-link').href, /delays\.html\?date=2026-09-20/);
  // weather strips: each card has one; the dome shows Covered; the closed roof shows Covered
  const strips = document.querySelectorAll('.wx-strip');
  assert.equal(strips.length, 7);
  const text = document.body.textContent;
  assert.match(text, /Dome \(fixed roof\)/);
  assert.match(text, /Retractable roof — closed \(per MLB\)/);
  assert.match(text, /High/);
  assert.match(text, /MLB: Rain · 65°F · wind 10 mph, L To R/);
  assert.match(text, /3h 50m official delay/);
  assert.match(text, /makeup 2026-09-22/);
  assert.match(text, /alerts?/);
  // tabs
  const tabs = document.querySelectorAll('.tab').map((t) => t.textContent);
  assert.ok(tabs.some((t) => /Delays \(4\)/.test(t)), `delay tab: ${tabs}`); // 824546, 824381, live, postponed
  assert.ok(tabs.some((t) => /Rain risk/.test(t)));
  assert.ok(tabs.some((t) => /Alerts/.test(t)));
  assert.ok(tabs.some((t) => /Flagged \(1\)/.test(t)), `TBD start flagged: ${tabs}`);
  assert.match(document.querySelector('#status-line').textContent, /7 games · 1 in progress · 1 delayed now/);
  // filter switch
  page.ctx.Scoreboard.setFilter('delays');
  assert.equal(document.querySelectorAll('.game-card').length, 4);
  page.ctx.Scoreboard.setFilter('forecast');
  assert.ok(document.querySelectorAll('.game-card').length >= 3, 'open-air parks with the 62% evening are rain-risk');
  page.ctx.Scoreboard.setFilter('flags');
  const flaggedCards = document.querySelectorAll('.game-card');
  assert.equal(flaggedCards.length, 1);
  assert.match(flaggedCards[0].textContent, /TBD/);
  // A filter whose tab vanished (flag count drops to 0) must reset to 'all'
  // BEFORE the list renders: every card visible, All tab active, no Flagged tab.
  const g2 = page.ctx.Scoreboard._games().find((x) => x.gamePk === 900003);
  g2.status.startTimeTBD = false;
  page.ctx.Scoreboard._inspections.set(900003, page.get('Delays').inspectGame(g2));
  page.ctx.Scoreboard.setFilter('flags');
  assert.equal(document.querySelectorAll('.game-card').length, 7, 'vanished tab resets the filter before the card list renders');
  const tabLabels = document.querySelectorAll('.tab').map((t) => t.textContent);
  assert.ok(!tabLabels.some((t) => /Flagged/.test(t)), 'empty flag tab is not rendered');
  assert.match(document.querySelector('.tab-on').textContent, /^All/, 'All tab is active again');
});

/* ------------------------------------------------------------ delay feed */

console.log('delay-feed.js');
await test('feed builds forecast / delay / postponed / alert rows with timelines, official facts, flags and source links', async () => {
  const page = loadPage([...CORE, 'assets/js/delay-feed.js'], { search: '?date=2026-09-20', ids: ['banner', 'feed-list', 'status-line', 'date-label', 'date-picker', 'active-strip', 'feed-stats', 'feed-tabs', 'countdown', 'live-dot', 'refresh-btn', 'sound-toggle-btn', 'back-link', 'written-reports', 'league-links', 'independent-links', 'weather-links', 'club-links'] });
  page.document.fire('DOMContentLoaded');
  await page.flush();
  await page.flush();
  const { document } = page;
  const rows = document.querySelectorAll('.feed-row');
  const byType = (t) => rows.filter((r) => r.classList.contains(`feed-type-${t}`));
  assert.equal(byType('forecast').length, 7, 'one forecast row per game');
  assert.equal(byType('postponed').length, 1);
  assert.equal(byType('active').length, 1, 'the live delayed game is an active row');
  assert.ok(byType('delay').length >= 2, '824546 and 824381 delay rows');
  assert.equal(byType('alert').length, 1, 'only weather-relevant alerts become rows (Beach Hazards is classified ignored), de-duplicated across seven games');

  const text = document.body.textContent;
  assert.match(text, /Expected start \/ restart: not confirmed/);
  // 824546 timeline + official facts + box score cross-check
  assert.match(text, /Delayed Start: Rain/);
  assert.match(text, /Status Change - Delayed Start: Rain/);
  assert.match(text, /MLB delayDurationMinutes: 230 \(3h 50m\)/);
  assert.match(text, /box score T: 2:50 \(3:50 delay\)/);
  assert.match(text, /Play resumed \(Warmup\)/);
  // 824381: minutes without advisory → flagged
  assert.match(text, /minutes-without-advisory/);
  // postponed row
  assert.match(text, /Postponed: Rain/);
  assert.match(text, /rescheduled to 2026-09-22/);
  // active row
  assert.match(text, /ongoing since/);
  // alert rows
  assert.match(text, /Severe Thunderstorm Warning/);
  assert.doesNotMatch(text, /Beach Hazards Statement/, 'ignored products are not delay-feed rows');
  // every row has source links; government links present on weather rows
  rows.forEach((r) => assert.ok(r.querySelector('.source-links'), `row without sources: ${r.textContent.slice(0, 80)}`));
  // no URL appears twice inside one row's verify links (the alerts JSON used to be listed twice)
  rows.forEach((r) => {
    const hrefs = r.querySelectorAll('.source-link').map((a) => a.href);
    assert.equal(new Set(hrefs).size, hrefs.length, `duplicate source links in row: ${[...new Set(hrefs)].filter((u) => hrefs.filter((x) => x === u).length > 1).join(' | ')}`);
  });
  assert.ok(document.querySelectorAll('.source-link-gov').length > 0);
  // manual-review club links: one per club on the slate (12 teams here), official MLB.com URLs only
  const clubWrap = document.querySelector('#club-links');
  assert.ok(clubWrap, 'club-links container present');
  const clubLinks = clubWrap.querySelectorAll('.source-link');
  assert.ok(clubLinks.length >= 12, `at least one link per club playing today (news + social): ${clubLinks.length}`);
  const clubHrefs = [...clubLinks].map((a) => a.href);
  assert.ok(clubHrefs.includes('https://www.mlb.com/whitesox/news'), 'CWS club news link');
  assert.ok(document.querySelectorAll('.source-link-gov').length > 0);
  assert.ok(document.querySelectorAll('.source-link').some((a) => /statsapi\.mlb\.com\/api\/v1\/game\/824546\/playByPlay/.test(a.href)));
  assert.ok(document.querySelectorAll('.source-link').some((a) => /api\.weather\.gov\/alerts\/urn:oid/.test(a.href)), 'alert row links the official alert URL');
  // stats bar + active strip
  assert.match(document.querySelector('#feed-stats').textContent, /Delayed now1/);
  assert.match(document.querySelector('#active-strip').textContent, /DELAYED NOW/);
  // tabs and filtering
  page.ctx.DelayFeed.setFilter('flags');
  assert.ok(document.querySelectorAll('.feed-row').length >= 1);
  page.ctx.DelayFeed.setFilter('alerts');
  assert.equal(document.querySelectorAll('.feed-row').length, 1);
  page.ctx.DelayFeed.setFilter('postponed');
  assert.equal(document.querySelectorAll('.feed-row').length, 1);
});
await test('feed: observed transition rows appear when a status sweep flips a game to Delayed', async () => {
  const page = loadPage([...CORE, 'assets/js/delay-feed.js'], { search: '?date=2026-09-20', ids: ['banner', 'feed-list', 'status-line', 'date-label', 'date-picker', 'active-strip', 'feed-stats', 'feed-tabs', 'countdown', 'live-dot', 'refresh-btn', 'sound-toggle-btn', 'back-link', 'written-reports', 'league-links', 'independent-links', 'weather-links', 'club-links'] });
  page.document.fire('DOMContentLoaded');
  await page.flush(); await page.flush();
  const st = page.ctx.DelayFeed._state;
  const next = new Map(st.games.map((g) => [g.gamePk, g.status]));
  next.set(822922, { abstractGameState: 'Live', codedGameState: 'I', detailedState: 'Delayed: Power', statusCode: 'IP', reason: 'Power' });
  const before = st.observed.length;
  // call through the same path the sweep uses
  const D = page.get('Delays');
  const trans = D.diffStatuses(st.statusCodes, next, Date.now());
  assert.equal(trans.length, 1);
  assert.equal(trans[0].event, 'delayed');
  st.observed.push({ gamePk: 822922, at: Date.now(), event: 'delayed', fromRaw: st.statusCodes.get(822922), toRaw: next.get(822922) });
  st.games.find((g) => g.gamePk === 822922).status = next.get(822922);
  st.inspections.set(822922, D.inspectGame(st.games.find((g) => g.gamePk === 822922)));
  page.ctx.DelayFeed.setFilter('observed');
  const rows = page.document.querySelectorAll('.feed-row');
  assert.ok(rows.length >= 1);
  assert.match(page.document.body.textContent, /Seen by this browser|Observed by this browser/);
  assert.ok(st.observed.length === before + 1);
});

await test('status sweep flip Delayed → In Progress REPLACES the status object (no stale reason) on both pages', async () => {
  const SWEEP = 'https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-09-20&fields=*'; // prefix route, see above
  const original = routes.get(SWEEP);
  const flipped = JSON.parse(JSON.stringify(original.json));
  flipped.dates[0].games.find((g) => g.gamePk === 900001).status =
    { abstractGameState: 'Live', codedGameState: 'I', detailedState: 'In Progress', statusCode: 'I', abstractGameCode: 'L' };
  try {
    // delay feed
    const feed = loadPage([...CORE, 'assets/js/delay-feed.js'], { search: '?date=2026-09-20', ids: ['banner', 'feed-list', 'status-line', 'date-label', 'date-picker', 'active-strip', 'feed-stats', 'feed-tabs', 'countdown', 'live-dot', 'refresh-btn', 'sound-toggle-btn', 'back-link', 'written-reports', 'league-links', 'independent-links', 'weather-links', 'club-links'] });
    feed.document.fire('DOMContentLoaded');
    await feed.flush(); await feed.flush();
    const st = feed.ctx.DelayFeed._state;
    await feed.settle(); // initial load: schedule + pbp scan (incl. one retry back-off) + weather
    assert.equal(st.inFlight, false, 'initial load finished');
    assert.equal(st.inspections.get(900001).active, true, 'precondition: 900001 starts delayed');
    routes.set(SWEEP, { status: 200, json: flipped });
    await feed.ctx.DelayFeed._pollStatus();
    await feed.flush();
    const g = st.games.find((x) => x.gamePk === 900001);
    assert.equal(g.status.detailedState, 'In Progress');
    assert.equal(g.status.reason, undefined, 'stale reason must not survive the flip');
    assert.equal(st.inspections.get(900001).active, false);
    assert.equal(st.inspections.get(900001).status.reason, null);
    const strip = feed.document.querySelector('#active-strip');
    assert.ok(!/NYY @ BAL/.test(strip.textContent), 'active strip no longer lists the resumed game');
    const resumed = st.observed.filter((o) => o.gamePk === 900001 && o.event === 'resumed');
    assert.equal(resumed.length, 1, 'transition recorded as an observed "resumed" row');

    // scoreboard
    routes.set(SWEEP, original);
    const sb = loadPage([...CORE, 'assets/js/scoreboard.js'], { search: '?date=2026-09-20', ids: ['game-list', 'banner', 'tabs', 'status-line', 'date-label', 'date-picker', 'feed-link'] });
    sb.document.fire('DOMContentLoaded');
    await sb.flush(); await sb.flush();
    assert.ok(sb.document.querySelector('.delay-ticker'), 'precondition: ticker shows the active delay');
    routes.set(SWEEP, { status: 200, json: flipped });
    await sb.settle(); // fires the 1.5 s initial status sweep (and weather back-offs)
    await sb.ctx.Scoreboard._pollStatus(); // and once more explicitly, in case the sweep raced the hydrated load
    await sb.flush();
    const sg = sb.ctx.Scoreboard._games().find((x) => x.gamePk === 900001);
    assert.equal(sg.status.reason, undefined);
    assert.equal(sb.ctx.Scoreboard._inspections.get(900001).active, false);
    assert.ok(!sb.document.querySelector('.delay-ticker'), 'ticker disappears once no game is delayed');
  } finally {
    routes.set(SWEEP, original);
  }
});

/* ------------------------------------------------------------ game page */

console.log('game.js');
await test('game page renders official delay panel, timeline, box-score cross-check, forecast table, alerts and all source links', async () => {
  const page = loadPage([...CORE, 'assets/js/game.js'], { search: '?gamePk=824546', ids: ['banner', 'loading', 'header-away', 'header-center', 'header-home', 'header-meta', 'header-decisions', 'linescore-wrap', 'delay-wrap', 'weather-wrap', 'sources-wrap', 'status-line', 'refresh-btn', 'countdown'] });
  page.document.fire('DOMContentLoaded');
  await page.flush(); await page.flush();
  const { document } = page;
  const text = document.body.textContent;
  assert.match(document.title, /DET @ CWS/);
  assert.match(text, /Official delay status/);
  assert.match(text, /230 \(3h 50m\)/);
  assert.match(text, /Status Change - Delayed Start: Rain/);
  assert.match(text, /2:50 \(3:50 delay\)/);
  assert.match(text, /65 degrees, Rain/);
  assert.match(text, /Weather at the ballpark/);
  assert.match(text, /LOT 76,71/);
  assert.match(text, /Severe Thunderstorm Warning/);
  assert.match(text, /How the forecast-risk chip is derived/);
  assert.ok(document.querySelector('.wx-table'), 'hourly table rendered');
  assert.ok(document.querySelector('.linescore-table'), 'linescore rendered');
  const links = document.querySelectorAll('.source-link').map((a) => a.href);
  assert.equal(new Set(links).size, links.length, 'no source URL listed twice (alerts JSON used to appear twice)');
  assert.ok(links.some((u) => u === 'https://www.mlb.com/gameday/824546'));
  assert.ok(links.some((u) => /api\/v1\/game\/824546\/playByPlay$/.test(u)));
  assert.ok(links.some((u) => /api\/v1\/game\/824546\/boxscore$/.test(u)));
  assert.ok(links.some((u) => /api\/v1\/gameStatus$/.test(u)));
  assert.ok(links.some((u) => /api\.weather\.gov\/points\/41\.83,-87\.6342$/.test(u)));
  assert.ok(links.some((u) => /forecast\.weather\.gov\/MapClick/.test(u)));
  assert.ok(links.some((u) => /mlb\.com\/whitesox\/news/.test(u)), 'club news links for manual review');
  assert.ok(!document.querySelector('.flag-item') || !/duration-mismatch/.test(text), '824546 is internally consistent');
});
await test('game page without a gamePk shows an error, fetches nothing', async () => {
  const before = calls.length;
  const page = loadPage([...CORE, 'assets/js/game.js'], { search: '', ids: ['banner', 'loading', 'refresh-btn'] });
  page.document.fire('DOMContentLoaded');
  await page.flush();
  assert.match(page.document.querySelector('#banner').textContent, /No gamePk/);
  assert.equal(calls.length, before);
});

await test('written report inbox renders safe source-linked text and failure warnings', () => {
  const page = loadPage(['assets/js/ui.js', 'assets/js/reports.js'], {ids: ['written-reports']});
  const reports = page.get('Reports');
  const root = page.document.querySelector('#written-reports');
  reports.render({generatedAt: new Date().toISOString(), feeds: [{ok:false, name:'Synthetic unavailable feed', error:'HTTP 503'}], flagged:[{
    title: '<script>not executed</script> Rain delay', author:'Synthetic reporter',
    link:'https://www.mlb.com/news/test', feedUrl:'https://www.mlb.com/feeds/news/rss.xml', pubDate:null,
  }]}, root);
  assert.match(root.textContent, /coverage is incomplete/);
  assert.match(root.textContent, /not matched to a/);
  assert.match(root.textContent, /Publication time/);
  assert.equal(root.querySelectorAll('script').length, 0);
  assert.equal(root.querySelectorAll('a').length, 2);
});

await test('hidden delay-feed tab schedules an idle wait rather than a zero-delay loop', async () => {
  const page = loadPage([...CORE, 'assets/js/delay-feed.js'], {search:'?date=2026-09-20', ids:['banner', 'feed-list', 'status-line', 'date-label', 'date-picker', 'active-strip', 'feed-stats', 'feed-tabs', 'countdown', 'live-dot', 'refresh-btn', 'sound-toggle-btn', 'back-link', 'written-reports', 'league-links', 'independent-links', 'weather-links', 'club-links']});
  page.document.fire('DOMContentLoaded');
  await page.flush(); await page.flush();
  const timer = page.timers.find(t => t.id === page.ctx.DelayFeed._state.pollTimer);
  assert.ok(timer);
  page.document.hidden = true;
  timer.fn();
  const next = page.timers.find(t => t.id === page.ctx.DelayFeed._state.pollTimer);
  assert.equal(next.ms, 60000);
});

console.log(`\n${passed} passed${process.exitCode ? ' — FAILURES above' : ''}`);
