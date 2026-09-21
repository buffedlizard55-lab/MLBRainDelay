#!/usr/bin/env node
/* ============================================================================
 * tools/weather-test.mjs — offline tests for assets/js/weather.js
 * Normalisers run against captured NWS / ECCC payload shapes; the provider
 * chain runs against a stubbed fetch (no network).
 *   node tools/weather-test.mjs
 * ==========================================================================*/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (name) => JSON.parse(readFileSync(path.join(here, 'fixtures', name), 'utf8'));

/* --- stub the browser fetch BEFORE loading api.js/weather.js ------------ */
const routes = new Map(); // url -> { status, json } | (url) => …
const calls = [];
globalThis.fetch = async (url, opts) => {
  calls.push({ url, headers: (opts && opts.headers) || {} });
  let r = routes.get(url);
  if (typeof r === 'function') r = r(url);
  if (!r) {
    for (const [k, v] of routes) if (k.endsWith('*') && url.startsWith(k.slice(0, -1))) { r = typeof v === 'function' ? v(url) : v; break; }
  }
  if (!r) return { ok: false, status: 599, json: async () => ({ error: `unrouted ${url}` }) };
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json };
};
globalThis.AbortController = globalThis.AbortController || class { constructor() { this.signal = { aborted: false, addEventListener() {}, removeEventListener() {} }; } abort() {} };

const MLB = require('../assets/js/api.js');
globalThis.MLB = MLB;
const Weather = require('../assets/js/weather.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n${err.stack || err}`); process.exitCode = 1; }
}

console.log('weather.js — NWS normalisation');
const hourly = Weather.normalizeNwsHourly(fx('nws-hourly-sample.json'));
await test('hourly periods keep start/end, PoP, text, wind and °F', () => {
  assert.equal(hourly.periods.length, 7);
  const p = hourly.periods[2];
  assert.equal(p.pop, 62);
  assert.equal(p.tempF, 70);
  assert.equal(p.tempC, 21);
  assert.equal(p.text, 'Showers And Thunderstorms Likely');
  assert.equal(p.wind, '15 mph');
  assert.equal(p.windDir, 'SW');
  assert.equal(p.flags.thunder, true);
  assert.equal(p.flags.rain, true);
  assert.equal(new Date(p.start).toISOString(), '2026-09-21T00:00:00.000Z');
  assert.equal(hourly.updateTime, '2026-09-20T20:31:00+00:00');
});
await test('alerts: severe warning classified severe; beach hazards ignored; Test/Exercise dropped', () => {
  const raw = fx('nws-alerts-sample.json');
  const alerts = Weather.normalizeNwsAlerts(raw);
  assert.equal(alerts.length, 2);
  const sev = alerts.find((a) => /Severe Thunderstorm/.test(a.event));
  assert.equal(sev.kind.severe, true);
  assert.equal(sev.kind.weather, true);
  assert.equal(sev.kind.ignored, false);
  assert.equal(sev.kind.level, 'severe');
  assert.equal(sev.url, 'https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.example1');
  assert.equal(sev.sender, 'NWS Chicago IL');
  const beach = alerts.find((a) => /Beach/.test(a.event));
  assert.equal(beach.kind.ignored, true);
  raw.features[0].properties.status = 'Test';
  assert.equal(Weather.normalizeNwsAlerts(raw).length, 1);
});
await test('classifyAlertEvent levels', () => {
  assert.equal(Weather.classifyAlertEvent('Tornado Warning').level, 'severe');
  assert.equal(Weather.classifyAlertEvent('Tornado Watch').level, 'watch');
  assert.equal(Weather.classifyAlertEvent('Flood Advisory').level, 'advisory');
  assert.equal(Weather.classifyAlertEvent('Excessive Heat Warning').level, 'warning');
  assert.equal(Weather.classifyAlertEvent('Excessive Heat Warning').weather, true);
  assert.equal(Weather.classifyAlertEvent('Rip Current Statement').ignored, true);
  assert.equal(Weather.classifyAlertEvent('Small Craft Advisory').ignored, true);
  assert.equal(Weather.classifyAlertEvent('Air Quality Alert').weather, true);
  assert.equal(Weather.classifyAlertEvent('Red Flag Warning').weather, true);
});
await test('isInvalidPoint recognises the NWS 404 problem document', () => {
  const err = new Error('HTTP 404'); err.status = 404; err.body = fx('nws-points-invalid.json');
  assert.equal(Weather.isInvalidPoint(err), true);
  const other = new Error('HTTP 500'); other.status = 500;
  assert.equal(Weather.isInvalidPoint(other), false);
});

console.log('weather.js — ECCC normalisation');
await test('bilingual leaves → en; hourly lop → pop; current conditions; text forecasts; url', () => {
  const feat = fx('eccc-toronto-sample.json').features[0];
  const n = Weather.normalizeEccc(feat);
  assert.equal(n.station, 'Toronto Island');
  assert.equal(n.region, 'City of Toronto');
  assert.equal(n.url, 'https://weather.gc.ca/en/location/index.html?coords=43.63,-79.39');
  assert.equal(n.periods.length, 3);
  assert.equal(n.periods[1].pop, 40);
  assert.equal(n.periods[1].text, 'Chance of showers');
  assert.equal(n.periods[1].tempC, 15);
  assert.equal(n.periods[1].tempF, 59);
  assert.equal(n.periods[1].wind, '12 mph');
  assert.equal(n.periods[1].windDir, 'NE');
  assert.equal(n.current.condition, 'Clear');
  assert.equal(n.current.tempC, 17.6);
  assert.equal(n.current.station, 'Toronto City Centre Airport');
  assert.equal(n.textForecasts[0].period, 'Tonight');
  assert.match(n.textForecasts[0].text, /A few clouds/);
  assert.deepEqual(n.alerts, []);
  assert.equal(n.hourlyIssued, '2026-09-20T15:30:00Z');
});
await test('ECCC warnings[] (schema-named fields) → normalized alerts with weather.gc.ca link', () => {
  // Field names per the collection queryables schema (no populated live
  // example was captured; see docs/verification.md §7).
  const base = fx('eccc-toronto-sample.json').features[0];
  const feat = JSON.parse(JSON.stringify(base));
  feat.properties.warnings = [{
    description: { en: 'SEVERE THUNDERSTORM WATCH IN EFFECT', fr: 'VEILLE D\u2019ORAGES VIOLENTS EN VIGUEUR' },
    type: { en: 'watch', fr: 'veille' },
    priority: { en: 'high', fr: 'haute' },
    alertColourLevel: { en: 'yellow', fr: 'jaune' },
    eventIssue: { en: '2026-09-21T18:05:00Z', fr: '2026-09-21T18:05:00Z' },
    expiryTime: { en: '2026-09-22T02:00:00Z', fr: '2026-09-22T02:00:00Z' },
    url: { en: 'https://weather.gc.ca/warnings/report_e.html?on41', fr: 'https://meteo.gc.ca/warnings/report_f.html?on41' },
  }];
  const n = Weather.normalizeEccc(feat);
  assert.equal(n.alerts.length, 1);
  const a = n.alerts[0];
  assert.equal(a.event, 'SEVERE THUNDERSTORM WATCH IN EFFECT');
  assert.equal(a.url, 'https://weather.gc.ca/warnings/report_e.html?on41');
  assert.equal(a.onset, '2026-09-21T18:05:00Z');
  assert.equal(a.expires, '2026-09-22T02:00:00Z');
  assert.equal(a.provider, 'eccc');
  assert.equal(a.kind.level, 'watch');
  assert.equal(a.kind.weather, true);
  // A warning with only a url falls back to the city page, never throws.
  feat.properties.warnings = [{ url: null }];
  const n2 = Weather.normalizeEccc(feat);
  assert.equal(n2.alerts[0].event, 'Weather warning');
  assert.equal(n2.alerts[0].url, 'https://weather.gc.ca/en/location/index.html?coords=43.63,-79.39');
});
await test('nearestFeature picks the closest point', () => {
  const json = { features: [
    { geometry: { coordinates: [-79.39, 43.63] }, id: 'a' },
    { geometry: { coordinates: [-79.10, 43.90] }, id: 'b' },
  ] };
  assert.equal(Weather.nearestFeature(json, 43.64155, -79.38915).id, 'a');
  assert.equal(Weather.nearestFeature({ features: [] }, 1, 1), null);
});

console.log('weather.js — Open-Meteo normalisation');
await test('unixtime hourly arrays → periods with WMO text', () => {
  const n = Weather.normalizeOpenMeteo({ hourly: { time: [1789980000, 1789983600], temperature_2m: [20.1, 19.4], precipitation_probability: [10, 70], precipitation: [0, 1.2], weather_code: [2, 95], wind_speed_10m: [12, 20] } });
  assert.equal(n.periods.length, 2);
  assert.equal(n.periods[1].pop, 70);
  assert.equal(n.periods[1].text, 'Thunderstorm');
  assert.equal(n.periods[1].flags.thunder, true);
  assert.equal(n.periods[0].tempF, 68);
  assert.equal(n.periods[1].wind, '12 mph');
});

console.log('weather.js — game window, roof and risk assessment');
const sched = fx('schedule-2026-09-20.json').dates[0].games;
const byPk = new Map(sched.map((g) => [g.gamePk, g]));
await test('windowFor: −1h before first pitch; final games end at first pitch + duration + delay', () => {
  const g = byPk.get(824546); // firstPitch 22:00Z, duration 170, delay 230
  const w = Weather.windowFor(g);
  assert.equal(new Date(w.start).toISOString(), '2026-09-20T21:00:00.000Z');
  assert.equal(new Date(w.firstPitch).toISOString(), '2026-09-20T22:00:00.000Z');
  assert.equal(new Date(w.end).toISOString(), '2026-09-21T04:40:00.000Z');
  const pre = Weather.windowFor({ gameDate: '2026-09-21T23:10:00Z', status: { abstractGameState: 'Preview' } });
  assert.equal(new Date(pre.start).toISOString(), '2026-09-21T22:10:00.000Z');
  assert.equal(new Date(pre.end).toISOString(), '2026-09-22T03:10:00.000Z');
  assert.equal(Weather.windowFor({}), null);
});
await test('roofInfo: Open / Dome / Retractable+"Roof Closed" / Retractable unknown', () => {
  assert.equal(Weather.roofInfo(byPk.get(824546)).covered, false);
  const dome = Weather.roofInfo(byPk.get(822922));
  assert.equal(dome.isDome, true); assert.equal(dome.covered, true);
  const closed = Weather.roofInfo(byPk.get(824139));
  assert.equal(closed.roofType, 'Retractable'); assert.equal(closed.closedNow, true); assert.equal(closed.covered, true);
  const unknown = Weather.roofInfo({ venue: { fieldInfo: { roofType: 'Retractable' } }, weather: {} });
  assert.equal(unknown.covered, false); assert.equal(unknown.closedNow, null);
  assert.match(unknown.label, /not yet reported/);
  const open = Weather.roofInfo({ venue: { fieldInfo: { roofType: 'Retractable' } }, weather: { condition: 'Roof Open' } });
  assert.equal(open.closedNow, false);
});
await test('assess: 7:10 PM CDT game against the synthetic 62% thunderstorm evening → HIGH', () => {
  const win = Weather.windowFor({ gameDate: '2026-09-21T00:10:00Z', status: { abstractGameState: 'Preview' } }); // 7:10 PM CDT
  const r = Weather.assess(hourly, [], win, { covered: false });
  assert.equal(r.level, 'high');
  assert.equal(r.maxPop, 62);
  assert.equal(r.thunder, true);
  assert.equal(r.worst.text, 'Showers And Thunderstorms Likely');
  assert.equal(r.windowPeriods.length, 6, 'window 18:10–23:10 CDT overlaps 6 hourly periods');
  assert.match(r.reasons[0], /62%/);
});
await test('assess: a later window sees only the dry tail → NONE / LOW', () => {
  const win = Weather.windowFor({ gameDate: '2026-09-21T03:30:00Z', status: { abstractGameState: 'Preview' } }); // 10:30 PM CDT
  const r = Weather.assess(hourly, [], win, { covered: false });
  assert.equal(r.maxPop, 20, 'window starts 9:30 PM → includes the 9 PM period at 20%');
  assert.equal(r.level, 'low');
});
await test('assess: thunder mention with sub-30% PoP → MODERATE; watch/advisory lifts NONE → MODERATE; severe warning → HIGH', () => {
  const fc = { periods: [{ start: 1000, end: 4600000, pop: 15, text: 'Isolated Thunderstorms', flags: Weather.textFlags('Isolated Thunderstorms') }] };
  const win = { start: 0, end: 5000000, firstPitch: 1000 };
  assert.equal(Weather.assess(fc, [], win, { covered: false }).level, 'moderate');
  const dry = { periods: [{ start: 1000, end: 4600000, pop: 3, text: 'Sunny', flags: Weather.textFlags('Sunny') }] };
  assert.equal(Weather.assess(dry, [], win, { covered: false }).level, 'none');
  const watch = [{ event: 'Severe Thunderstorm Watch', kind: Weather.classifyAlertEvent('Severe Thunderstorm Watch') }];
  assert.equal(Weather.assess(dry, watch, win, { covered: false }).level, 'moderate');
  const warn = [{ event: 'Tornado Warning', kind: Weather.classifyAlertEvent('Tornado Warning') }];
  assert.equal(Weather.assess(dry, warn, win, { covered: false }).level, 'high');
  const beach = [{ event: 'Beach Hazards Statement', kind: Weather.classifyAlertEvent('Beach Hazards Statement') }];
  assert.equal(Weather.assess(dry, beach, win, { covered: false }).level, 'none', 'ignored products never raise the level');
});
await test('assess: covered parks → COVERED even with a wet forecast; no forecast → UNKNOWN', () => {
  const win = { start: 0, end: 5000000, firstPitch: 1000 };
  const wet = { periods: [{ start: 1000, end: 4600000, pop: 90, text: 'Rain', flags: Weather.textFlags('Rain') }] };
  assert.equal(Weather.assess(wet, [], win, { covered: true, isDome: true }).level, 'covered');
  assert.equal(Weather.assess(null, [], win, { covered: false }).level, 'unknown');
  assert.equal(Weather.assess({ periods: [] }, [], win, { covered: false }).level, 'unknown');
  assert.equal(Weather.assess(null, [{ event: 'Tornado Warning', kind: Weather.classifyAlertEvent('Tornado Warning') }], win, { covered: false }).level, 'high');
});
await test('RISK_RULES text matches the thresholds in assess()', () => {
  assert.match(Weather.RISK_RULES[0], /60%/); assert.match(Weather.RISK_RULES[0], /40%/);
  assert.match(Weather.RISK_RULES[1], /30–59%/);
  assert.match(Weather.RISK_RULES[2], /10–29%/);
  assert.equal(Weather.RISK_RULES.length, 6);
});

console.log('weather.js — provider chain (stubbed fetch)');
const rate = byPk.get(824546).venue;
const pointUrl = Weather.nwsPointUrl(41.83, -87.634167);
routes.set(pointUrl, { status: 200, json: fx('nws-points-rate-field.json') });
routes.set('https://api.weather.gov/gridpoints/LOT/76,71/forecast/hourly', { status: 200, json: fx('nws-hourly-sample.json') });
routes.set(Weather.nwsAlertsUrl(41.83, -87.634167), { status: 200, json: fx('nws-alerts-sample.json') });

await test('US venue → NWS point → hourly + alerts; URLs rounded to 4 decimals; no custom headers', async () => {
  const wx = await Weather.forVenue(rate);
  assert.equal(wx.ok, true);
  assert.equal(wx.provider, 'nws');
  assert.equal(pointUrl, 'https://api.weather.gov/points/41.83,-87.6342');
  assert.equal(wx.point.gridId, 'LOT');
  assert.equal(wx.forecast.periods.length, 7);
  assert.equal(wx.alerts.length, 2);
  assert.ok(wx.sourceUrls.includes(pointUrl));
  assert.ok(wx.links.some((l) => /forecast\.weather\.gov\/MapClick/.test(l.url)));
  assert.ok(wx.links.some((l) => /radar\.weather\.gov\/station\/klot/.test(l.url)));
  const hdrs = calls.map((c) => Object.keys(c.headers).map((k) => k.toLowerCase())).flat();
  assert.ok(!hdrs.includes('user-agent'), 'never send User-Agent from the browser');
  assert.ok(calls.every((c) => !/[?&](t|_|cb)=/.test(c.url)), 'no cache-busting params (NWS answers 400)');
});
await test('second call for the same venue is served from cache (no new requests)', async () => {
  const before = calls.length;
  const wx = await Weather.forVenue(rate);
  assert.equal(wx.ok, true);
  assert.equal(calls.length, before);
});
await test('stale value + recent refresh failure → value served WITH the stale flag on every call', async () => {
  const point = fx('nws-points-rate-field.json').properties;
  const key = `nws:hourly:${point.forecastHourly}`;
  const hourlyUrl = point.forecastHourly;
  const good = routes.get(hourlyUrl);
  const entry = Weather._cache.get(key);
  assert.ok(entry && entry.value, 'precondition: hourly forecast is cached');
  entry.at = Date.now() - 16 * 60 * 1000; // push the value past its 15-min TTL
  routes.set(hourlyUrl, { status: 503, json: {} });
  try {
    const first = await Weather.forVenue(rate); // the call whose refresh fails
    assert.equal(first.ok, true, 'stale forecast still served');
    assert.equal(first.forecast.stale, true);
    assert.ok(first.issues.some((i) => i.code === 'stale'));
    const second = await Weather.forVenue(rate); // cached-error path
    assert.equal(second.ok, true);
    assert.equal(second.forecast.stale, true, 'stale flag survives the cached-error path');
    assert.ok(second.issues.some((i) => i.code === 'stale'));
  } finally {
    const e = Weather._cache.get(key);
    if (e) { e.at = Date.now(); e.error = undefined; e.errorAt = 0; }
    routes.set(hourlyUrl, good);
  }
});
await test('forGame composes roof + window + risk for a real schedule game', async () => {
  const g = { ...byPk.get(824546), gameDate: '2026-09-21T00:10:00Z', gameInfo: {}, status: { abstractGameState: 'Preview' } };
  const wx = await Weather.forGame(g);
  assert.equal(wx.risk.level, 'high');
  assert.equal(wx.roof.roofType, 'Open');
  assert.ok(wx.window);
  assert.equal(Weather.summaryText(wx.risk, 'America/Chicago').startsWith('62% · Showers And Thunderstorms Likely'), true);
});

const rogers = { id: 14, name: 'Rogers Centre', location: { city: 'Toronto', country: 'Canada', defaultCoordinates: { latitude: 43.64155, longitude: -79.38915 } }, timeZone: { id: 'America/Toronto' }, fieldInfo: { roofType: 'Retractable' } };
routes.set(Weather.nwsPointUrl(43.64155, -79.38915), { status: 404, json: fx('nws-points-invalid.json') });
routes.set(Weather.ecccItemsUrl(43.64155, -79.38915), { status: 200, json: fx('eccc-toronto-sample.json') });
await test('Rogers Centre → ECCC (country hint) with weather.gc.ca links; NWS never asked', async () => {
  const before = calls.length;
  const wx = await Weather.forVenue(rogers);
  assert.equal(wx.provider, 'eccc');
  assert.equal(wx.ok, true);
  assert.equal(wx.forecast.station, 'Toronto Island');
  assert.ok(wx.links[0].url.startsWith('https://weather.gc.ca/en/location/index.html'));
  assert.ok(!calls.slice(before).some((c) => /api\.weather\.gov/.test(c.url)));
  assert.ok(wx.issues.every((i) => i.code !== 'nws-no-coverage'), 'no fallback note when the country said Canada up front');
});
await test('unknown-country venue: NWS InvalidPoint → ECCC fallback, flagged as an issue', async () => {
  Weather._providerByVenue.clear();
  const v = { ...rogers, id: 9914, location: { ...rogers.location, country: undefined } };
  const wx = await Weather.forVenue(v);
  assert.equal(wx.provider, 'eccc');
  assert.ok(wx.issues.some((i) => i.code === 'nws-no-coverage'));
});
await test('transient NWS failure does NOT switch providers; reports nws-failed and keeps manual links', async () => {
  const v = { id: 77, name: 'Test Park', location: { defaultCoordinates: { latitude: 30.5, longitude: -90.5 } } };
  routes.set(Weather.nwsPointUrl(30.5, -90.5), { status: 503, json: {} });
  const wx = await Weather.forVenue(v);
  assert.equal(wx.ok, false);
  assert.equal(wx.provider, 'nws');
  assert.ok(wx.issues.some((i) => i.code === 'nws-failed'));
  assert.ok(wx.links.some((l) => /MapClick/.test(l.url)));
});
await test('no coordinates (Mexico City / Santo Domingo placeholders) → no-coordinates issue, nothing fetched', async () => {
  const before = calls.length;
  const wx = await Weather.forVenue({ id: 5340, name: 'Estadio Alfredo Harp Helu', location: { city: 'Mexico City' } });
  assert.equal(wx.ok, false);
  assert.ok(wx.issues.some((i) => i.code === 'no-coordinates'));
  assert.equal(calls.length, before);
});
await test('outside both government services → Open-Meteo, always flagged non-government', async () => {
  const v = { id: 5000, name: 'London Stadium', location: { country: 'United Kingdom', defaultCoordinates: { latitude: 51.5387, longitude: -0.0166 } } };
  routes.set(Weather.openMeteoUrl(51.5387, -0.0166), { status: 200, json: { hourly: { time: [1789980000], temperature_2m: [18], precipitation_probability: [55], precipitation: [0.4], weather_code: [61], wind_speed_10m: [10] } } });
  const wx = await Weather.forVenue(v);
  assert.equal(wx.provider, 'open-meteo');
  assert.ok(wx.issues.some((i) => i.code === 'non-government-source'));
  assert.ok(wx.links.every((l) => /open-meteo/.test(l.url)));
});

await test('missing, empty and out-of-range venue coordinates never become a forecast location', () => {
  const venue = (latitude, longitude) => ({location: {defaultCoordinates: {latitude, longitude}}});
  for (const v of [venue(null, -76), venue('', -76), venue(91, 10), venue(30, 181), venue(0, 0)]) {
    assert.equal(Weather.coordsOf(v), null);
  }
  assert.deepEqual(Weather.coordsOf(venue('39.28', '-76.62')), {lat:39.28, lon:-76.62});
});

console.log(`\n${passed} passed${process.exitCode ? ' — FAILURES above' : ''}`);
