#!/usr/bin/env node
/* ==========================================================================
 * tools/match-test.mjs — offline tests for assets/js/match.js
 * Deterministic headline ↔ game linking and restart-time extraction.
 * Never asserts a match or a time the rules did not explicitly produce.
 *   node tools/match-test.mjs
 * ==========================================================================*/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const Match = require('../assets/js/match.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (name) => JSON.parse(readFileSync(path.join(here, 'fixtures', name), 'utf8'));

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n${err.stack || err}`); process.exitCode = 1; }
}

const schedule = fx('schedule-2026-09-20.json');
const baseGames = schedule.dates[0].games.map((g) => ({ ...g, _listingDate: '2026-09-20' }));

// Synthetic additions used only for matching edge cases.
const liveDelayed = {
  gamePk: 900001, gameDate: '2026-09-20T23:10:00Z', officialDate: '2026-09-20', _listingDate: '2026-09-20',
  status: { detailedState: 'Delayed: Rain' },
  teams: {
    away: { team: { id: 147, name: 'New York Yankees', abbreviation: 'NYY', teamName: 'Yankees' } },
    home: { team: { id: 110, name: 'Baltimore Orioles', abbreviation: 'BAL', teamName: 'Orioles' } },
  },
  doubleHeader: 'N', gameNumber: 1,
};
const dh1 = {
  gamePk: 900010, gameDate: '2026-09-20T17:05:00Z', officialDate: '2026-09-20', _listingDate: '2026-09-20',
  teams: {
    away: { team: { id: 147, name: 'New York Yankees', abbreviation: 'NYY', teamName: 'Yankees' } },
    home: { team: { id: 110, name: 'Baltimore Orioles', abbreviation: 'BAL', teamName: 'Orioles' } },
  },
  doubleHeader: 'Y', gameNumber: 1,
};
const dh2 = {
  gamePk: 900011, gameDate: '2026-09-20T23:05:00Z', officialDate: '2026-09-20', _listingDate: '2026-09-20',
  teams: {
    away: { team: { id: 147, name: 'New York Yankees', abbreviation: 'NYY', teamName: 'Yankees' } },
    home: { team: { id: 110, name: 'Baltimore Orioles', abbreviation: 'BAL', teamName: 'Orioles' } },
  },
  doubleHeader: 'Y', gameNumber: 2,
};
const slate = [...baseGames, liveDelayed];
const slateDh = [...baseGames, dh1, dh2];

console.log('match.js — team detection');
test('finds official abbreviations and nicknames; refuses bare ambiguous tokens', () => {
  const idx = Match.buildAliasIndex(slate);
  const a = Match.findTeams("Yankees' rain delay at Camden Yards", idx);
  assert.deepEqual(a.ids, [147]);
  const b = Match.findTeams('NYY @ BAL delayed by rain', idx);
  assert.ok(b.ids.includes(147) && b.ids.includes(110));
  const c = Match.findTeams("O's rained out in Baltimore", idx);
  assert.deepEqual(c.ids, [110]);
  // bare "sox" is ambiguous and must not hit
  const d = Match.findTeams('sox postpone tonight', idx);
  assert.deepEqual(d.ids, []);
  const e = Match.findTeams('White Sox rain delay at Rate Field', idx);
  assert.deepEqual(e.ids, [145]);
  const f = Match.findTeams('Red Sox postponed in Boston', idx);
  assert.deepEqual(f.ids, [111]);
});

console.log('match.js — game matching');
test('single unique team on the slate matches that game', () => {
  // On the 2026-09-20 fixture, CWS (145) plays DET at Rate Field (824546).
  const r = Match.matchItem({ title: 'White Sox rain delay stretches past two hours' }, slate);
  assert.equal(r.status, 'matched');
  assert.equal(r.games.length, 1);
  assert.equal(r.games[0].gamePk, 824546);
  assert.equal(r.games[0].reason, 'single-team-unique');
  assert.ok(r.evidence.some((e) => /white sox/i.test(e)));
});

test('two opponent teams match the shared game', () => {
  const r = Match.matchItem({ title: 'Yankees-Orioles delayed by thunderstorms in Baltimore' }, slate);
  assert.equal(r.status, 'matched');
  assert.equal(r.games[0].gamePk, 900001);
  assert.equal(r.games[0].reason, 'both-teams');
});

test('two teams that are not opponents abstain', () => {
  const r = Match.matchItem({ title: 'Yankees and Dodgers both facing rain threats' }, slate);
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.abstainReason, 'two-teams-not-opponents');
  assert.equal(r.games.length, 0);
});

test('three or more teams abstain', () => {
  const r = Match.matchItem({ title: 'Yankees, Orioles and Red Sox all delayed' }, slate);
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.abstainReason, 'three-or-more-teams');
});

test('team not on the slate is unmatched', () => {
  // No Padres game on this slate.
  const r = Match.matchItem({ title: 'Padres rain delay in San Diego' }, slate);
  assert.equal(r.status, 'unmatched');
  assert.equal(r.abstainReason, 'team-not-on-slate');
});

test('no team mention stays unmatched (never invents a link)', () => {
  const r = Match.matchItem({ title: 'Thunderstorms sweep the East Coast tonight' }, slate);
  assert.equal(r.status, 'unmatched');
  assert.equal(r.abstainReason, 'no-team-mention');
});

test('doubleheader without a game-number cue abstains', () => {
  const r = Match.matchItem({ title: 'Yankees-Orioles rain delay' }, slateDh);
  assert.equal(r.status, 'ambiguous');
  assert.ok(['doubleheader-without-game-number', 'multiple-games-no-game-number'].includes(r.abstainReason), r.abstainReason);
});

test('doubleheader with an explicit game-number cue matches that game', () => {
  const r1 = Match.matchItem({ title: 'Yankees-Orioles game 1 delayed by rain' }, slateDh);
  assert.equal(r1.status, 'matched', r1.abstainReason);
  assert.equal(r1.games[0].gamePk, 900010);
  const r2 = Match.matchItem({ title: 'Yankees at Orioles nightcap postponed' }, slateDh);
  assert.equal(r2.status, 'matched', r2.abstainReason);
  assert.equal(r2.games[0].gamePk, 900011);
});

test('date cue that disagrees with the slate abstains', () => {
  const r = Match.matchItem({ title: 'White Sox rain delay on September 1, 2026' }, slate, { refYear: 2026 });
  assert.equal(r.status, 'unmatched');
  assert.equal(r.abstainReason, 'date-disagreement');
});

test('date cue that agrees still matches', () => {
  const r = Match.matchItem({ title: 'White Sox rain delay on September 20' }, slate, { refYear: 2026 });
  assert.equal(r.status, 'matched');
  assert.equal(r.games[0].gamePk, 824546);
});

test('empty slate or empty text never throws and never matches', () => {
  assert.equal(Match.matchItem({ title: 'Yankees delayed' }, []).status, 'unmatched');
  assert.equal(Match.matchItem({ title: '' }, slate).status, 'unmatched');
  assert.equal(Match.matchItem(null, slate).status, 'unmatched');
});

console.log('match.js — restart-time extraction');
test('explicit restart / first-pitch announcements are extracted with evidence', () => {
  const a = Match.extractAnnouncedTimes('The Yankees and Orioles will restart at 8:35 p.m. ET');
  assert.equal(a.length, 1);
  assert.equal(a[0].hour, 8);
  assert.equal(a[0].minute, 35);
  assert.equal(a[0].ampm, 'pm');
  assert.equal(a[0].zone, 'ET');
  assert.equal(a[0].hour24, 20);
  assert.equal(a[0].kind, 'restart');
  assert.match(a[0].evidence, /restart at 8:35 p\.m\. ET/i);

  const b = Match.extractAnnouncedTimes('Club announces first pitch now set for 7:10pm');
  assert.equal(b.length, 1);
  assert.equal(b[0].hour24, 19);
  assert.equal(b[0].minute, 10);
  assert.equal(b[0].kind, 'first-pitch');

  const c = Match.extractAnnouncedTimes('Targeting an 8:30 restart after the storm passes');
  assert.equal(c.length, 1);
  assert.equal(c[0].hour, 8);
  assert.equal(c[0].minute, 30);
  assert.equal(c[0].kind, 'restart');
});

test('speculative phrasing is rejected (no invented hard time)', () => {
  assert.equal(Match.extractAnnouncedTimes('Hoping to restart around 8:30 p.m.').length, 0);
  assert.equal(Match.extractAnnouncedTimes('Could resume at 9:00 ET if the rain stops').length, 0);
  assert.equal(Match.extractAnnouncedTimes('Maybe first pitch at 8:15').length, 0);
  assert.equal(Match.extractAnnouncedTimes('Rain should clear by 8:00 p.m.').length, 0, 'forecast clearing is not an announcement');
});

test('12-hour clock without am/pm keeps hour24 null (no invention)', () => {
  const a = Match.extractAnnouncedTimes('Restart at 8:35 ET');
  // "8:35 ET" without am/pm: hour is 8, hour24 stays null.
  if (a.length) {
    assert.equal(a[0].hour, 8);
    assert.equal(a[0].minute, 35);
    assert.equal(a[0].hour24, null);
  }
  // Fully specified 24h-style with minutes and no am/pm is accepted as hour24.
  const b = Match.extractAnnouncedTimes('Play will resume at 20:15 local');
  assert.ok(b.length >= 1);
  assert.equal(b[0].hour24, 20);
  assert.equal(b[0].minute, 15);
});

test('duplicate announcements de-duplicate; empty input is empty', () => {
  const a = Match.extractAnnouncedTimes('Restart at 8:35 p.m. ET. Officials confirm restart at 8:35 p.m. ET.');
  assert.equal(a.length, 1);
  assert.deepEqual(Match.extractAnnouncedTimes(''), []);
  assert.deepEqual(Match.extractAnnouncedTimes(null), []);
});

console.log('match.js — annotate pipeline');
test('annotate attaches match + announcedTimes without mutating the input', () => {
  const items = [
    { title: 'Yankees-Orioles delayed; restart at 9:05 p.m. ET', link: 'https://www.mlb.com/news/x' },
    { title: 'Thunderstorms overnight across the Midwest', link: 'https://www.mlb.com/news/y' },
  ];
  const frozen = JSON.stringify(items);
  const out = Match.annotate(items, slate);
  assert.equal(JSON.stringify(items), frozen, 'input not mutated');
  assert.equal(out[0].match.status, 'matched');
  assert.equal(out[0].match.games[0].gamePk, 900001);
  assert.equal(out[0].announcedTimes.length, 1);
  assert.equal(out[0].announcedTimes[0].hour24, 21);
  assert.equal(out[1].match.status, 'unmatched');
  assert.equal(out[1].announcedTimes.length, 0);
});

test('game-number and date cue helpers', () => {
  assert.equal(Match.gameNumberCue('Game 2 postponed'), 2);
  assert.equal(Match.gameNumberCue('the nightcap is delayed'), 2);
  assert.equal(Match.gameNumberCue('opener washed out'), 1);
  assert.equal(Match.gameNumberCue('no number here'), null);
  assert.equal(Match.dateCue('on 2026-09-20 the tarp came out'), '2026-09-20');
  assert.equal(Match.dateCue('September 20 rainout', 2026), '2026-09-20');
  assert.equal(Match.dateCue('no date'), null);
});

console.log(`\n${passed} passed${process.exitCode ? ' — FAILURES above' : ''}`);
