#!/usr/bin/env node
/* ============================================================================
 * tools/delays-test.mjs — offline tests for assets/js/delays.js
 * Runs with no network: every input is a fixture captured from a live,
 * verified StatsAPI response (see tools/fixtures/*.json `_source`).
 *   node tools/delays-test.mjs
 * ==========================================================================*/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (name) => JSON.parse(readFileSync(path.join(here, 'fixtures', name), 'utf8'));

const Delays = require('../assets/js/delays.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n${err.stack || err}`); process.exitCode = 1; }
}

console.log('delays.js — status registry classification');
const registry = fx('game-status-registry.json').statuses;
test('every one of the 210 registry rows classifies to the kind its family implies, with no spurious flags', () => {
  assert.equal(registry.length, 210);
  const expectKind = (s) => {
    const d = s.detailedState;
    if (/^Delayed Start/.test(d)) return 'delayed-start';
    if (/^Delayed: About to Resume/.test(d)) return 'about-to-resume';
    if (/^Delayed/.test(d)) return 'delayed';
    if (/^Postponed/.test(d)) return 'postponed';
    if (/^Suspended: About to Resume/.test(d)) return 'suspended-about-to-resume';
    if (/^Suspended/.test(d)) return 'suspended';
    if (/^Cancelled/.test(d)) return 'cancelled';
    if (/^Completed Early/.test(d)) return 'completed-early';
    if (/^Forfeit/.test(d)) return 'forfeit';
    if (/challenge|review|Instant Replay/i.test(d)) return 'review';
    if (/^(Final|Game Over)/.test(d)) return 'final';
    if (d === 'Warmup') return 'warmup';
    if (d === 'In Progress') return 'live';
    if (d === 'Pre-Game') return 'pregame';
    if (/^Scheduled/.test(d)) return 'scheduled';
    return 'unknown';
  };
  registry.forEach((s) => {
    const p = Delays.parseStatus(s);
    assert.equal(p.kind, expectKind(s), `${s.statusCode} "${s.detailedState}" → ${p.kind}`);
    // The registry's own reason must round-trip (or be a qualifier we ignore).
    const qualifier = ['About to Resume', 'Tiebreaker', 'Review', 'Tied', 'Tied (won in tiebreaker)'].includes(s.reason);
    if (s.reason && !qualifier && p.disruption) assert.equal(p.reason, s.reason, `${s.statusCode} reason`);
    // Registry rows are self-consistent: only the reason-less "*O" codes may be flagged, and only reason-missing.
    const allowed = p.flags.filter((f) => !(f.code === 'reason-missing' && !s.reason));
    assert.deepEqual(allowed, [], `${s.statusCode} "${s.detailedState}" flagged ${JSON.stringify(p.flags)}`);
  });
  // Both letters of the same code must agree in both directions.
  assert.equal(Delays.parseStatus({ statusCode: 'QR', codedGameState: 'Q', detailedState: 'Forfeit: Rule', reason: 'Rule' }).reason, 'Rule');
  assert.equal(Delays.parseStatus({ statusCode: 'QR', codedGameState: 'Q', detailedState: 'Forfeit' }).reason, 'Rule', 'forfeit letter table, not the weather table');
  assert.equal(Delays.parseStatus({ statusCode: 'T9', codedGameState: 'T', detailedState: 'Scheduled: COVID-19', reason: 'COVID-19', abstractGameState: 'Preview' }).kind, 'scheduled');
});
test('statusLabel: reason appended only when not already in the state text; qualifiers shown; regex-safe', () => {
  assert.equal(Delays.statusLabel(Delays.parseStatus(registry.find((s) => s.statusCode === 'PR'))), 'Delayed Start: Rain');
  assert.equal(Delays.statusLabel(Delays.parseStatus({ statusCode: 'IR', codedGameState: 'I', detailedState: 'Delayed', reason: 'Rain' })), 'Delayed: Rain');
  assert.equal(Delays.statusLabel(Delays.parseStatus(registry.find((s) => s.statusCode === 'IT'))), 'Delayed: Tiebreaker', 'MLB state text already carries the qualifier');
  assert.equal(Delays.statusLabel(Delays.parseStatus({ statusCode: 'IT', codedGameState: 'I', detailedState: 'Delayed', reason: 'Tiebreaker' })), 'Delayed (Tiebreaker)');
  assert.equal(Delays.statusLabel(Delays.parseStatus(registry.find((s) => s.statusCode === 'IZ'))), 'Delayed: About to Resume');
  assert.equal(Delays.statusLabel(Delays.parseStatus(registry.find((s) => s.statusCode === 'FT'))), 'Final: Tied');
  // A reason containing regex metacharacters must not throw or mis-match.
  const weird = Delays.parseStatus({ statusCode: 'DI', codedGameState: 'D', detailedState: 'Postponed', reason: 'Rain (field unplayable) [see note]' });
  assert.equal(Delays.statusLabel(weird), 'Postponed: Rain (field unplayable) [see note]');
  assert.equal(Delays.statusLabel(null), '');
});
test('delayed-start codes (P?)', () => {
  const p = Delays.parseStatus(registry.find((s) => s.statusCode === 'PR'));
  assert.equal(p.kind, 'delayed-start');
  assert.equal(p.reason, 'Rain');
  assert.equal(p.reasonSource, 'status.reason');
  assert.equal(p.isWeather, true);
  assert.equal(p.active, true);
  assert.equal(Delays.parseStatus(registry.find((s) => s.statusCode === 'PO')).kind, 'delayed-start');
  assert.equal(Delays.parseStatus(registry.find((s) => s.statusCode === 'PW')).kind, 'warmup');
  assert.equal(Delays.parseStatus(registry.find((s) => s.statusCode === 'P')).kind, 'pregame');
});
test('in-game delay codes (I?) incl. About to Resume and non-weather Power', () => {
  assert.equal(Delays.parseStatus(registry.find((s) => s.statusCode === 'IR')).kind, 'delayed');
  assert.equal(Delays.parseStatus(registry.find((s) => s.statusCode === 'II')).reason, 'Inclement Weather');
  const power = Delays.parseStatus(registry.find((s) => s.statusCode === 'IP'));
  assert.equal(power.kind, 'delayed');
  assert.equal(power.isWeather, false);
  assert.equal(power.reasonClass, 'other');
  const atr = Delays.parseStatus(registry.find((s) => s.statusCode === 'IZ'));
  assert.equal(atr.kind, 'about-to-resume');
  assert.equal(atr.active, true);
  assert.equal(atr.flags.length, 0, 'About to Resume must not be flagged reason-missing');
  assert.equal(Delays.parseStatus(registry.find((s) => s.statusCode === 'IH')).kind, 'review');
  assert.equal(Delays.parseStatus(registry.find((s) => s.statusCode === 'MA')).kind, 'review');
  assert.equal(Delays.parseStatus(registry.find((s) => s.statusCode === 'I')).kind, 'live');
});
test('postponed / cancelled / completed early / suspended / forfeit', () => {
  const di = Delays.parseStatus({ abstractGameState: 'Final', codedGameState: 'D', detailedState: 'Postponed', statusCode: 'DI', reason: 'Inclement Weather' });
  assert.equal(di.kind, 'postponed');
  assert.equal(di.reason, 'Inclement Weather');
  assert.equal(di.active, false);
  assert.equal(di.disruption, true);
  assert.equal(di.flags.length, 0);
  assert.equal(Delays.parseStatus(registry.find((s) => s.statusCode === 'DA')).isWeather, false);
  assert.equal(Delays.parseStatus(registry.find((s) => s.statusCode === 'DD')).reasonClass, 'weather-adjacent');
  assert.equal(Delays.parseStatus(registry.find((s) => s.statusCode === 'CR')).kind, 'cancelled');
  assert.equal(Delays.parseStatus(registry.find((s) => s.statusCode === 'OR')).kind, 'completed-early');
  assert.equal(Delays.parseStatus(registry.find((s) => s.statusCode === 'FR')).kind, 'completed-early');
  assert.equal(Delays.parseStatus(registry.find((s) => s.statusCode === 'FT')).kind, 'final');
  assert.equal(Delays.parseStatus(registry.find((s) => s.statusCode === 'F')).kind, 'final');
  assert.equal(Delays.parseStatus(registry.find((s) => s.statusCode === 'O')).kind, 'final');
  const ur = Delays.parseStatus(registry.find((s) => s.statusCode === 'UR'));
  assert.equal(ur.kind, 'suspended');
  assert.equal(ur.active, true);
  assert.equal(Delays.parseStatus(registry.find((s) => s.statusCode === 'UZ')).kind, 'suspended-about-to-resume');
  assert.equal(Delays.parseStatus(registry.find((s) => s.statusCode === 'QR')).kind, 'forfeit');
  assert.equal(Delays.parseStatus(registry.find((s) => s.statusCode === 'QR')).reason, 'Rule');
  assert.equal(Delays.parseStatus(registry.find((s) => s.statusCode === 'IT')).kind, 'delayed');
  assert.equal(Delays.parseStatus(registry.find((s) => s.statusCode === 'IT')).reason, null, 'Tiebreaker is a qualifier, not a delay reason');
});
test('reason falls back to the detailedState suffix, then to the code letter', () => {
  const suffix = Delays.parseStatus({ detailedState: 'Delayed: Lightning' });
  assert.equal(suffix.reason, 'Lightning');
  assert.equal(suffix.reasonSource, 'detailedState');
  const letter = Delays.parseStatus({ codedGameState: 'I', statusCode: 'IS', detailedState: 'Delayed' });
  assert.equal(letter.reason, 'Snow');
  assert.equal(letter.reasonSource, 'statusCode');
  const none = Delays.parseStatus({ codedGameState: 'I', statusCode: 'IO', detailedState: 'Delayed' });
  assert.equal(none.reason, null);
  assert.ok(none.flags.some((f) => f.code === 'reason-missing'));
});
test('conflicting words vs letters are flagged, never silently resolved', () => {
  const p = Delays.parseStatus({ codedGameState: 'I', statusCode: 'IR', detailedState: 'Delayed: Fog', reason: 'Fog' });
  assert.equal(p.reason, 'Fog');
  assert.ok(p.flags.some((f) => f.code === 'reason-conflict'));
  const q = Delays.parseStatus({ codedGameState: 'I', statusCode: 'IQ', detailedState: 'Delayed: Rain' });
  assert.ok(q.flags.some((f) => f.code === 'unknown-reason-code'));
});

console.log('delays.js — schedule inspection');
const sched = fx('schedule-2026-09-20.json').dates[0].games;
sched.forEach((g) => { g._listingDate = '2026-09-20'; });
const byPk = new Map(sched.map((g) => [g.gamePk, g]));
test('824546 (delayed start 230 min) → hadDelay with official minutes and +230 first-pitch offset', () => {
  const ins = Delays.inspectGame(byPk.get(824546));
  assert.equal(ins.hadDelay, true);
  assert.equal(ins.active, false);
  assert.equal(ins.disrupted, false);
  assert.equal(ins.official.delayMinutes, 230);
  assert.equal(ins.official.startDelayMinutes, 230);
  assert.equal(ins.status.kind, 'final');
  assert.equal(ins.flags.length, 0);
});
test('824381 (125-minute delay = first pitch − scheduled start)', () => {
  const ins = Delays.inspectGame(byPk.get(824381));
  assert.equal(ins.official.delayMinutes, 125);
  assert.equal(ins.official.startDelayMinutes, 125);
});
test('games without delayDurationMinutes are not delays', () => {
  assert.equal(Delays.inspectGame(byPk.get(822922)).hadDelay, false);
  assert.equal(Delays.inspectGame(byPk.get(824139)).hadDelay, false);
});
test('postponed original-date entry: reschedule fields + officialDate shift handled', () => {
  const data = fx('schedule-823062-postponed.json');
  const orig = data.dates[0].games[0];
  orig._listingDate = data.dates[0].date;
  const ins = Delays.inspectGame(orig);
  assert.equal(ins.status.kind, 'postponed');
  assert.equal(ins.status.reason, 'Inclement Weather');
  assert.equal(ins.reschedule.toDate, '2026-07-07');
  assert.equal(ins.reschedule.toIso, '2026-07-07T18:15:00Z');
  assert.equal(ins.listingMismatch, true, 'officialDate 2026-07-07 ≠ listing date 2026-05-05');
  assert.ok(!ins.flags.some((f) => f.code === 'official-date-shift'), 'shift explained by reschedule fields → no flag');
  const makeup = data.dates[1].games[0];
  makeup._listingDate = data.dates[1].date;
  const ins2 = Delays.inspectGame(makeup);
  assert.equal(ins2.status.kind, 'final');
  assert.equal(ins2.makeupOf.fromDate, '2026-05-05');
  assert.equal(ins2.makeupOf.description, 'Makeup of 5/5ppd');
  assert.equal(ins2.hadDelay, false);
});
test('officialDate shift WITHOUT reschedule fields is flagged', () => {
  const ins = Delays.inspectGame({ gamePk: 1, _listingDate: '2026-05-05', officialDate: '2026-05-06', status: { abstractGameState: 'Preview', codedGameState: 'S', detailedState: 'Scheduled', statusCode: 'S' } });
  assert.ok(ins.flags.some((f) => f.code === 'official-date-shift'));
});
test('live "Delayed: Rain" game is active and weather', () => {
  const ins = Delays.inspectGame({ gamePk: 2, gameDate: '2026-09-21T23:10:00Z', status: { abstractGameState: 'Live', codedGameState: 'I', detailedState: 'Delayed: Rain', statusCode: 'IR', reason: 'Rain' }, gameInfo: { firstPitch: '2026-09-21T23:11:00Z' } });
  assert.equal(ins.active, true);
  assert.equal(ins.hadDelay, true);
  assert.equal(ins.status.isWeather, true);
  assert.ok(!ins.flags.some((f) => f.code === 'non-weather'));
});
test('non-weather delays are flagged non-weather (still shown)', () => {
  const ins = Delays.inspectGame({ gamePk: 3, gameDate: '2026-09-21T23:10:00Z', status: { abstractGameState: 'Live', codedGameState: 'I', detailedState: 'Delayed: Power', statusCode: 'IP', reason: 'Power' } });
  assert.ok(ins.flags.some((f) => f.code === 'non-weather'));
  assert.equal(ins.hadDelay, true);
});

console.log('delays.js — play-by-play advisories');
test('824546: three status changes in the first play, sorted, with a 252-min delayed-start segment', () => {
  const adv = Delays.extractAdvisories(fx('pbp-824546-delayed-start.json'));
  assert.equal(adv.length, 3);
  assert.deepEqual(adv.map((a) => a.kind), ['delayed-start', 'warmup', 'live']);
  assert.equal(adv[0].reason, 'Rain');
  assert.equal(adv[0].isStatusChange, true);
  const game = byPk.get(824546);
  const tl = Delays.buildTimeline(adv, game);
  assert.equal(tl.length, 1);
  assert.equal(tl[0].kind, 'delayed-start');
  assert.equal(tl[0].reason, 'Rain');
  assert.equal(tl[0].open, false);
  assert.equal(tl[0].startTime, '2026-09-20T17:26:12Z');
  assert.equal(tl[0].endTime, '2026-09-20T21:38:05Z');
  assert.equal(tl[0].minutes, 252);
  assert.equal(tl[0].resumedKind, 'warmup');
});
test('822686: mid-game advisories are ordered by their own startTime, not play order', () => {
  const pbp = fx('pbp-822686-midgame.json');
  const adv = Delays.extractAdvisories(pbp);
  assert.deepEqual(adv.map((a) => a.description), [
    'Injury Delay.',
    'Status Change - Delayed: Inclement Weather',
    'Status Change - Delayed: About to Resume',
    'Status Change - In Progress',
  ]);
  assert.equal(adv[0].isStatusChange, false);
  assert.equal(adv[0].kind, 'delayed');
  assert.equal(adv[0].reason, 'Injury');
  assert.equal(adv[0].reasonClass, 'other');
  // Mound visit / pitching change are NOT advisories.
  assert.ok(!adv.some((a) => /Mound|Pitching/.test(a.description)));
  const tl = Delays.buildTimeline(adv, { status: { abstractGameState: 'Final' } });
  assert.equal(tl.length, 2);
  const injury = tl[0];
  assert.equal(injury.freeText, true);
  assert.equal(injury.minutes, 3);
  const rain = tl[1];
  assert.equal(rain.kind, 'delayed');
  assert.equal(rain.reason, 'Inclement Weather');
  assert.equal(rain.inning, 4);
  assert.equal(rain.halfInning, 'top');
  assert.equal(rain.startTime, '2026-09-02T17:56:10Z');
  assert.equal(rain.endTime, '2026-09-02T19:20:54Z', 'closes on the "In Progress" advisory, not "About to Resume"');
  assert.equal(rain.minutes, 85);
  assert.equal(rain.events.length, 3);
  assert.equal(rain.open, false);
});
test('an open delay on a live game stays open; on a final game it closes on the event endTime', () => {
  const pbp = { allPlays: [{ about: { inning: 5, halfInning: 'bottom', atBatIndex: 40, startTime: '2026-09-21T01:00:00Z' }, playEvents: [
    { type: 'action', isPitch: false, details: { eventType: 'game_advisory', description: 'Status Change - Delayed: Rain' }, startTime: '2026-09-21T01:05:00Z', endTime: '2026-09-21T01:50:00Z' },
  ] }] };
  const adv = Delays.extractAdvisories(pbp);
  const live = Delays.buildTimeline(adv, { status: { abstractGameState: 'Live' } });
  assert.equal(live[0].open, true);
  assert.equal(live[0].minutes, null);
  const fin = Delays.buildTimeline(adv, { status: { abstractGameState: 'Final' } });
  assert.equal(fin[0].open, false);
  assert.equal(fin[0].minutes, 45);
  assert.equal(fin[0].closedByEventEnd, true);
});
test('empty / malformed play-by-play yields no advisories, no throw', () => {
  assert.deepEqual(Delays.extractAdvisories(null), []);
  assert.deepEqual(Delays.extractAdvisories({}), []);
  assert.deepEqual(Delays.extractAdvisories({ allPlays: [{}] }), []);
  assert.deepEqual(Delays.buildTimeline([], null), []);
});

console.log('delays.js — box score + cross-checks');
test('box score info parses Weather / Wind / T (delay) / Att exactly as printed', () => {
  const box = Delays.parseBoxscoreInfo(fx('boxscore-824546-info.json').info);
  assert.equal(box.weather, '65 degrees, Rain');
  assert.equal(box.wind, '10 mph, L To R');
  assert.equal(box.firstPitch, '5:00 PM');
  assert.equal(box.timeOfGame, '2:50');
  assert.equal(box.delayNote, '3:50 delay');
  assert.equal(box.delayMinutes, 230);
  assert.equal(box.attendance, '21,354');
  assert.equal(box.venue, 'Rate Field');
});
test('a T line without a delay parses cleanly', () => {
  const box = Delays.parseBoxscoreInfo([{ label: 'T', value: '2:41.' }]);
  assert.equal(box.timeOfGame, '2:41');
  assert.equal(box.delayMinutes, null);
  assert.equal(box.delayNote, null);
});
test('crossCheck: 824546 — schedule 230, advisories 252 start segment but official start delay 230 → consistent (start part uses first pitch − scheduled)', () => {
  const game = byPk.get(824546);
  const ins = Delays.inspectGame(game);
  const tl = Delays.buildTimeline(Delays.extractAdvisories(fx('pbp-824546-delayed-start.json')), game);
  const box = Delays.parseBoxscoreInfo(fx('boxscore-824546-info.json').info);
  const flags = Delays.crossCheck(ins, tl, box);
  assert.deepEqual(flags, []);
});
test('crossCheck: box score delay disagreeing with gameInfo is flagged', () => {
  const ins = Delays.inspectGame(byPk.get(824546));
  const flags = Delays.crossCheck(ins, null, { delayMinutes: 200, delayNote: '3:20 delay' });
  assert.ok(flags.some((f) => f.code === 'boxscore-mismatch'));
});
test('crossCheck: official minutes but no advisory (final) is flagged; advisory but no minutes is flagged', () => {
  const ins = Delays.inspectGame(byPk.get(824381));
  assert.ok(Delays.crossCheck(ins, [], null).some((f) => f.code === 'minutes-without-advisory'));
  const g2 = { ...byPk.get(822922), gameInfo: { firstPitch: '2026-09-20T17:41:00Z', gameDurationMinutes: 150 } };
  const ins2 = Delays.inspectGame(g2);
  const seg = [{ kind: 'delayed', minutes: 40, open: false, events: [] }];
  assert.ok(Delays.crossCheck(ins2, seg, null).some((f) => f.code === 'advisory-without-minutes'));
});
test('crossCheck: mid-game segment sum far from official minutes is flagged', () => {
  const g = { gamePk: 9, gameDate: '2026-09-02T17:05:00Z', status: { abstractGameState: 'Final', codedGameState: 'F', detailedState: 'Final', statusCode: 'F' }, gameInfo: { firstPitch: '2026-09-02T17:06:00Z', delayDurationMinutes: 86, gameDurationMinutes: 180 } };
  const ins = Delays.inspectGame(g);
  const tlOk = Delays.buildTimeline(Delays.extractAdvisories(fx('pbp-822686-midgame.json')), g);
  assert.deepEqual(Delays.crossCheck(ins, tlOk, null), [], '85 derived vs 86 official is within tolerance');
  const tlBad = [{ kind: 'delayed', minutes: 30, open: false, events: [] }];
  assert.ok(Delays.crossCheck(ins, tlBad, null).some((f) => f.code === 'duration-mismatch'));
});
test('weatherConsistencyFlags: MLB "Rain" vs dry official forecast is flagged; matching is silent', () => {
  const g = byPk.get(824546);
  assert.ok(Delays.weatherConsistencyFlags(g, { level: 'none', maxPop: 5 }).some((f) => f.code === 'mlb-wet-forecast-dry'));
  assert.deepEqual(Delays.weatherConsistencyFlags(g, { level: 'high', maxPop: 80 }), []);
  assert.deepEqual(Delays.weatherConsistencyFlags(byPk.get(822922), { level: 'high', maxPop: 90 }), [], 'covered parks are skipped by the caller; dome string is not "wet"');
  assert.deepEqual(Delays.weatherConsistencyFlags(g, { level: 'covered', maxPop: 0 }), []);
});

console.log('delays.js — observed transitions');
test('diffStatuses reports live→delayed, delayed→resumed, scheduled→postponed and ignores noise', () => {
  const prev = new Map([
    [1, { detailedState: 'In Progress', statusCode: 'I', codedGameState: 'I', abstractGameState: 'Live' }],
    [2, { detailedState: 'Delayed: Rain', statusCode: 'IR', codedGameState: 'I', reason: 'Rain', abstractGameState: 'Live' }],
    [3, { detailedState: 'Scheduled', statusCode: 'S', codedGameState: 'S', abstractGameState: 'Preview' }],
    [4, { detailedState: 'In Progress', statusCode: 'I', codedGameState: 'I', abstractGameState: 'Live' }],
    [5, { detailedState: 'Delayed: Rain', statusCode: 'IR', codedGameState: 'I', reason: 'Rain', abstractGameState: 'Live' }],
  ]);
  const next = new Map([
    [1, { detailedState: 'Delayed: Rain', statusCode: 'IR', codedGameState: 'I', reason: 'Rain', abstractGameState: 'Live' }],
    [2, { detailedState: 'In Progress', statusCode: 'I', codedGameState: 'I', abstractGameState: 'Live' }],
    [3, { detailedState: 'Postponed', statusCode: 'DR', codedGameState: 'D', reason: 'Rain', abstractGameState: 'Final' }],
    [4, { detailedState: 'Manager Challenge: Tag play', statusCode: 'MA', codedGameState: 'M', reason: 'Tag play', abstractGameState: 'Live' }],
    [5, { detailedState: 'Delayed: About to Resume', statusCode: 'IZ', codedGameState: 'I', abstractGameState: 'Live' }],
    [6, { detailedState: 'Delayed: Rain', statusCode: 'IR', codedGameState: 'I', reason: 'Rain', abstractGameState: 'Live' }],
  ]);
  const t = Delays.diffStatuses(prev, next, 1000);
  const byPk2 = new Map(t.map((x) => [x.gamePk, x.event]));
  assert.equal(byPk2.get(1), 'delayed');
  assert.equal(byPk2.get(2), 'resumed');
  assert.equal(byPk2.get(3), 'postponed');
  assert.equal(byPk2.has(4), false, 'review flips are not delay events');
  assert.equal(byPk2.get(5), 'about-to-resume');
  assert.equal(byPk2.has(6), false, 'a game first seen already delayed is not a transition');
  assert.ok(t.every((x) => x.at === 1000));
});

console.log(`\n${passed} passed${process.exitCode ? ' — FAILURES above' : ''}`);
