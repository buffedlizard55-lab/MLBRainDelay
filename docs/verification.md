# Verification Report — every claim on the site vs. its official source

**Date:** 2026-09-21 · **Sources:** `https://statsapi.mlb.com` (the public, CORS-open API
behind MLB.com Gameday), `https://api.weather.gov` (US National Weather Service),
`https://api.weather.gc.ca` (Environment and Climate Change Canada GeoMet),
`https://www.mlb.com` (club pages). Every row below was checked against a **live
response** captured on the date shown, not against documentation or memory. The payloads
that drive the offline tests are in `tools/fixtures/`, each with a `_source` URL and a
`_verified` date; values that were synthesised to exercise a rule (not observed live) are
labelled *synthetic* in the fixture and here.

A ✅ means the site reads the field exactly as the source publishes it. A ⚠️ means the
site relies on an assumption that could not be exercised end-to-end from the build
environment and is therefore surfaced as a flag or a footnote in the UI.

---

## 1. Game status, delays, postponements — MLB StatsAPI

| Claim on the site | Verified | Evidence (live URL → value) |
|---|---|---|
| `status.statusCode` is a two-letter code: game state letter + reason letter | ✅ | `GET /api/v1/gameStatus` — `PR` = "Delayed Start: Rain", `IR` = "Delayed: Rain", `IZ` = "Delayed: About to Resume", `DI` = "Postponed" (reason Inclement Weather), `DR`, `CR`, `OR` = "Completed Early: Rain", `UR`/`TR` suspended, `PW` Warmup, `IH` Instant Replay, `MA` Manager Challenge, `FT` "Final: Tied", `QR` "Forfeit: Rule". **All 210 rows** of the live registry (fetched 2026-09-21 with `?fields=statusCode,codedGameState,detailedState,abstractGameState`) are transcribed verbatim into `tools/fixtures/game-status-registry.json`; the test suite classifies every row and fails if any of them is mis-classified or flagged spuriously. |
| Forfeit codes (`Q*` / `R*`) use a **different** second-letter table from the weather one: K Delay, X Appear, Q Lineup, J Ejection, I Ineligible, N Refusal, V Unplayable, **R Rule**, O none | ✅ | Same registry. Encoded separately in `Delays.FORFEIT_REASON_BY_CODE` (found in Pass 2 — the Pass 1 fixture had guessed `QR` = "Forfeit: Rain"). |
| Some second letters are game-state **qualifiers**, not reasons: `IZ`/`UZ` About to Resume, `IT` Tiebreaker, `IH` Review, `FT`/`OT` Tied, `FW`/`OW` Tied (won in tiebreaker), `PW` Warmup — MLB puts these words in `reason` too | ✅ | Same registry. `Delays.parseStatus` never reports them as a delay reason and does not raise `reason-missing` for them; they are returned as `qualifier` and printed by `Delays.statusLabel`. |
| Reason letters R Rain, S Snow, G Wet Grounds, V Venue, F Fog, C Cold, D Air Quality, B Wind, I Inclement Weather, P Power, Y Ceremony, L Lightning, E Emergency, 9 COVID-19, A Tragedy, M Mercy, O none | ✅ | Same registry (`reason` field for each code). Encoded in `Delays.REASON_BY_CODE`; an unknown letter is flagged `unknown-reason-code`, never guessed. |
| The live schedule sends `detailedState`, `statusCode` **and** `reason` separately | ✅ | `schedule?sportId=1&gamePk=823062` → `status:{abstractGameState:"Final",codedGameState:"D",detailedState:"Postponed",statusCode:"DI",reason:"Inclement Weather"}`. |
| Precedence: `status.reason` → `"X: <reason>"` suffix → code letter; a disagreement is flagged `reason-conflict` | ✅ tested | `tools/delays-test.mjs` "reason falls back…", "conflicting words vs letters…". |
| Official delay length = `gameInfo.delayDurationMinutes` | ✅ | `game/824546/feed/live` → `gameData.gameInfo.delayDurationMinutes: 230`; `schedule?date=2026-09-20&hydrate=gameInfo` → 824381 `delayDurationMinutes: 125`, 822686 (2026-09-02) `86`. Absent on games without a delay (822922, 824139). |
| First-pitch offset = `gameInfo.firstPitch − gameDate` | ✅ | 824546: `gameDate 2026-09-20T18:10:00Z`, `firstPitch 2026-09-20T22:00:00Z` → +230 min = the official minutes. 824381: 17:40Z → 19:45Z = +125 = official. |
| Delay start/end and inning come from play-by-play `game_advisory` events | ✅ | `game/824546/playByPlay` first play: `{type:"action",details:{eventType:"game_advisory",description:"Status Change - Delayed Start: Rain"},startTime:"2026-09-20T17:26:12Z",endTime:"2026-09-20T21:38:05Z"}` then `"Status Change - Warmup"` (21:38:05Z) and `"Status Change - In Progress"` (21:59:58Z). `game/822686/playByPlay` top 4th: `"Status Change - Delayed: Inclement Weather"` 17:56:10Z→19:18:12Z, `"Status Change - Delayed: About to Resume"` →19:19:37Z, `"Status Change - In Progress"` 19:20:54Z. `eventTypes` registry lists `game_advisory`. |
| Advisories can sit inside a play whose `about.startTime` is *later* than the events, so events are sorted by their own `startTime` | ✅ | 822686 play `about.startTime 19:21:13Z` contains the 17:56:10Z advisory. Tested: "mid-game advisories are ordered by their own startTime". |
| Non-weather advisories exist and are shown but flagged `non-weather` | ✅ | 822686: `"Injury Delay."` 17:48:59Z→17:51:38Z (no `Status Change -` prefix). |
| Box score `info[]` carries `Weather`, `Wind`, `First pitch`, `T` with `(h:mm delay)` | ✅ | `game/824546/boxscore?fields=info,label,value` → `Weather: "65 degrees, Rain."`, `Wind: "10 mph, L To R."`, `First pitch: "5:00 PM."`, `T: "2:50 (3:50 delay)."`, `Att: "21,354."`, `Venue: "Rate Field."` (verbatim in `tools/fixtures/boxscore-824546-info.json`). 3:50 = 230 min = `delayDurationMinutes` ✓ cross-check. |
| Postponed games carry `rescheduleDate` / `rescheduleGameDate`; the makeup entry (same `gamePk`) carries `rescheduledFrom` / `rescheduledFromDate` / `description` | ✅ | `schedule?sportId=1&gamePk=823062` → date `2026-05-05`: `status DI`, `officialDate 2026-07-07`, `rescheduleDate 2026-07-07T18:15:00Z`; date `2026-07-07`: `rescheduledFrom 2026-05-05T17:45:00Z`, `doubleHeader "S"`, `description "Makeup of 5/5ppd"`. Also 824362 (5/5 → 5/7). |
| `officialDate` of a postponed game is the **makeup** date, so the listing day must come from `dates[].date` | ✅ | Same response; handled via `_listingDate`; a shift without reschedule fields is flagged `official-date-shift`. |
| MLB first-pitch weather line: `weather:{condition,temp,wind}`; `{}` before the game; `Dome` / `Roof Closed` at covered parks | ✅ | `schedule?date=2026-09-20&hydrate=weather` → 824546 `{condition:"Rain",temp:"65",wind:"10 mph, L To R"}`, 822922 `{condition:"Dome"…}` (Tropicana), 824139 `{condition:"Roof Closed"…}` (Daikin Park); 823570 `Drizzle`; 2026-09-21 pre-game entries `weather:{}`. |
| Roof type per venue: `venue.fieldInfo.roofType ∈ Open / Dome / Retractable` | ✅ | `venues?sportId=1&season=2026&hydrate=fieldInfo,location,timezone` — Tropicana 12 Dome; Rogers 14, Chase 15, AmFam 32, T-Mobile 680, Daikin 2392, Globe Life 5325, loanDepot 4169 Retractable; all others Open. |
| Venue coordinates & time zone: `venue.location.defaultCoordinates{latitude,longitude}`, `venue.timeZone.id` | ✅ | Same endpoint, e.g. Rate Field 4 → `41.83, -87.634167`, `America/Chicago`. **Venues 5340, 3049, 401, 3832/3833 have no coordinates** → the site shows `no-coordinates` instead of guessing. |
| Start-time-TBD games (`status.startTimeTBD:true`) are shown as "TBD", never as the placeholder clock time | ✅ tested | `tools/render-test.mjs` scoreboard case (game 900003). Placeholder time is only shown labelled as such. |
| Game-status sweep uses `schedule?…&fields=*` (light) every 5 s while games are not final | ✅ | Same cadence class as the reference site's replay feed; the 429 self-throttle in `api.js` is retained. |

### Verified sample games used throughout

| gamePk | Game | Verified facts |
|---|---|---|
| 824546 | DET @ CWS, 2026-09-20, Rate Field | Delayed Start: Rain; official 230 min; advisories 17:26:12Z → 21:38:05Z (Warmup) → 21:59:58Z (In Progress); first pitch 22:00Z; box score T 2:50 (3:50 delay), Weather 65 degrees, Rain; Att 21,354 |
| 824381 | ATH @ CLE, 2026-09-20, Progressive Field | official 125 min; gameDate 17:40Z, first pitch 19:45Z; CLE 1-0; MLB.com game story: "two-hour, five-minute rain delay" |
| 822686 | ATL @ WSH, 2026-09-02, Nationals Park | official 86 min; top-4th "Delayed: Inclement Weather" 17:56:10Z → resumed 19:20:54Z (85 min derived, within tolerance); earlier "Injury Delay." 3 min |
| 823062 | MIL @ STL, 2026-05-05 → 2026-07-07 | Postponed (DI, Inclement Weather); makeup listed with `rescheduledFrom` and "Makeup of 5/5ppd" |
| 822922 / 824139 | BOS @ TB (Tropicana, Dome) / ATL @ HOU (Daikin, Roof Closed) | covered-park handling |

## 2. Weather — US National Weather Service (`api.weather.gov`)

| Claim on the site | Verified | Evidence |
|---|---|---|
| `points/{lat},{lon}` → forecast office, grid, hourly URL, radar station | ✅ | `points/41.83,-87.6342` → `gridId "LOT"`, `gridX 76`, `gridY 71`, `forecastHourly ".../gridpoints/LOT/76,71/forecast/hourly"`, `radarStation "KLOT"`, `timeZone "America/Chicago"`. |
| Coordinates must be rounded to ≤ 4 decimals | ✅ | NWS API docs; more precision returns a 301 that browsers do not always follow. Tested: URL is `points/41.83,-87.6342`. |
| Non-US points return **404 `InvalidPoint`**, which triggers the Canada fallback (not a retry) | ✅ | `points/43.6416,-79.3892` (Rogers Centre) → `{"type":"https://api.weather.gov/problems/InvalidPoint","status":404}` (`tools/fixtures/nws-points-invalid.json`). |
| Hourly forecast shape: `properties.periods[{startTime,endTime,temperature,temperatureUnit,probabilityOfPrecipitation.value,windSpeed,windDirection,shortForecast}]`, `updateTime` | ✅ shape | `gridpoints/LOT/76,71/forecast/hourly` (2026-09-20). **The values in `nws-hourly-sample.json` are synthetic** (a 62 % "Showers And Thunderstorms Likely" hour at 7 PM CDT) so the HIGH rule can be tested deterministically. |
| Active alerts: `alerts/active?point={lat},{lon}` → `features[{id,properties{event,severity,urgency,certainty,onset,ends,expires,senderName,headline,description,instruction,status,messageType}}]` | ✅ shape | `alerts/active?point=41.83,-87.6342` (empty on 2026-09-20) and `alerts/active?area=FL` (2026-09-20, two Flood Warnings) for the populated shape. **The two alerts in `nws-alerts-sample.json` are synthetic.** |
| The browsable alert URL is the feature `id` / `properties["@id"]` (`https://api.weather.gov/alerts/urn:oid:…`); `properties.id` is the bare URN | ✅ | `alerts/active?area=FL`: `"id":"https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.affd…001.1"`, `"properties":{"@id":"https://…","id":"urn:oid:2.49…"}`. Fixed in `weather.js` during Pass 1 testing. |
| `status: "Test"` / `"Exercise"` alerts are dropped | ✅ tested | CAP status semantics; `weather-test.mjs`. |
| Alert classification: Tornado / Severe Thunderstorm / Flash Flood **Warning** = severe; other Warnings = warning; Watches; Advisories/Statements; marine, beach, rip-current, small-craft products ignored | ✅ tested | `Weather.classifyAlertEvent`; the ignored list only removes products that cannot affect a ballpark. Unknown event names default to *weather-relevant, advisory level* so nothing is silently discarded. |
| No custom `User-Agent` from the browser; no cache-busting query params | ✅ | NWS API FAQ: custom headers trigger a CORS preflight the API does not answer; unknown query parameters return **400** (confirmed live: `alerts/active?limit=1` → `400 Bad Request, "Query parameter \"limit\" is not recognized"`). Tested: no `user-agent` header, no `?t=` params. |
| Caching: `/points` 24 h, hourly 15 min, alerts 2 min, ≤ 6 concurrent | ✅ tested | `weather-test.mjs` "second call … served from cache". |
| Human-readable links: `forecast.weather.gov/MapClick.php?lat=…&lon=…`, `radar.weather.gov/station/{klot}`, NWS office page | ✅ | Public NWS URL patterns; rendered under every weather row. |

## 3. Weather — Environment and Climate Change Canada (Rogers Centre)

| Claim on the site | Verified | Evidence |
|---|---|---|
| `citypageweather-realtime/items?f=json&limit=1&lang=en&bbox=lon1,lat1,lon2,lat2` returns the Toronto city page | ✅ | Live 2026-09-20 → `features[0].id "on-128"`, `properties.name.en "Toronto"`, `currentConditions.station.value "Toronto City Centre Airport"`, `hourlyForecastGroup.hourlyForecasts[]` with `lop.value.en` (= chance of precipitation %), `temperature.value.en` (°C), `wind.speed.value.en` (km/h), `warnings: []`, `url.en "https://weather.gc.ca/en/location/index.html?coords=43.63,-79.39"`. Every leaf is bilingual `{en, fr}`; the key is `hourlyForecasts` (plural). |
| Hourly timestamps are UTC without an offset (`2026-09-20T16:00:00`) | ✅ | Same response; parsed as UTC. |
| ECCC labels the collection **experimental** | ✅ | Collection metadata, 2026-09-20. |
| The endpoint answers browser CORS requests | ⚠️ **not exercised** | Could not be tested from the build sandbox (no browser, outbound TLS blocked). If the browser blocks it, Rogers Centre falls to Open-Meteo and the row is flagged `eccc-failed` + `non-government-source`. **First thing to check in the deployed site.** |
| `warnings[]` item shape | ✅ schema / ⚠️ no populated sample | Field names taken from the collection's published queryables schema (`/collections/citypageweather-realtime/queryables`, read 2026-09-21): `warnings[].description`, `.type`, `.priority`, `.alertColourLevel`, `.eventIssue`, `.expiryTime`, `.url` — all bilingual `{en, fr}`. No populated item was captured live (Toronto, Tulita and Chéticamp all had `warnings: []` on 2026-09-21), so the normaliser is unit-tested against a synthetic item built from those names and falls back to the city-page URL if a field is absent. |

## 4. Weather — Open-Meteo (last resort only)

| Claim | Verified | Evidence |
|---|---|---|
| Used only when neither government service covers the point (e.g. London, Mexico City if coordinates exist) | ✅ tested | Provider chain test. Always flagged `non-government-source`, chip labelled "Open-Meteo (model)". |
| Hourly arrays `time (unixtime), precipitation_probability, weather_code, wind_speed_10m` | ✅ | Open-Meteo public schema; WMO code table used for the text. Not verified live from the sandbox — shape test only. |

## 5. Manual-review links (social media / news)

| Claim | Verified | Evidence |
|---|---|---|
| `https://www.mlb.com/gameday/{gamePk}` | ✅ | Pattern used by MLB.com; the reference site links it identically. |
| Club news pages `https://www.mlb.com/{slug}/news` for all 30 clubs; slugs `dbacks`, `athletics`, `whitesox`, `redsox`, `bluejays`, `mariners`… | ✅ | `mlb.com/dbacks`, `mlb.com/athletics/news`, `mlb.com/whitesox/news` fetched live 2026-09-21 (HTTP 200). `teams?sportId=1&season=2026` for ids/abbreviations (Athletics id 133, D-backs abbreviation `AZ`). |
| Curated official channels on `delays.html` (MLB.com news/scores, @MLB, @MLB_PR, r/baseball, weather.gov, SPC outlook, NWS radar, ECCC warnings) | ✅ links only | Public URLs; the site does **not** read them (see Limitations). |

## 6. Design parity with MLB-Live-PBP

| Item | Status |
|---|---|
| Stylesheet, `ui.js`, `404.html`, `LICENSE`, `.gitignore`, `docs/workflows/pages.yml` copied from the reference (`6d61092`) | ✅ verbatim (+ appended weather/delay CSS block and four new UI helpers) |
| Scoreboard → `index.html`, Game → `game.html`, all-games feed → `delays.html` (structure, classes and behaviour of `reviews.html`: banner, live strip, stats, tabs, chat-style rows, sound toggle, countdown, date picker) | ✅ |
| Polling etiquette (hidden-tab pause, backoff on Final, 429 self-throttle) | ✅ retained in `api.js` and the three controllers |
| Offline fixture-driven tests in `tools/`, optional workflows in `docs/workflows/` | ✅ 52 assertions across three suites |

## 7. Test evidence (Pass 1)

```
$ for f in assets/js/*.js; do node --check "$f"; done      # clean
$ node tools/delays-test.mjs     # 25 passed
$ node tools/weather-test.mjs    # 22 passed
$ node tools/render-test.mjs     #  5 passed (scoreboard, delay feed ×2, game page ×2)
```

Bugs found and fixed by the tests during Pass 1: (1) NWS alert links pointed at the bare
URN instead of the `https://api.weather.gov/alerts/…` URL; (2) a `mound_visit` event
with a loose `event` label could be mistaken for an advisory — `eventType` is now
authoritative; (3) TBD start times were rendered as a fake clock time on all three pages;
(4) `window.X` lookups broke when the scripts run outside a browser global (tests) —
replaced with `typeof X` guards.

## 8. Pass 2 — review findings (bugs, edge cases, wrong assumptions)

```
$ for f in assets/js/*.js; do node --check "$f"; done      # clean
$ node tools/delays-test.mjs     # 26 passed
$ node tools/weather-test.mjs    # 23 passed
$ node tools/render-test.mjs     #  5 passed
```

| # | Finding | Fix |
|---|---|---|
| 1 | Pass 1 status fixture had 32 hand-picked rows and **guessed** `QR` = "Forfeit: Rain". The live registry says "Forfeit: Rule" — forfeits use a different letter table. | Fetched all 210 live rows into the fixture; added `FORFEIT_REASON_BY_CODE`; the registry test now asserts every row's kind, reason round-trip and "no spurious flags". |
| 2 | `IZ` About to Resume, `IT` Tiebreaker, `IH` Review, `FT` Tied etc. carry qualifier words in `reason`; Pass 1 treated them as delay reasons and could raise `reason-missing`/`reason-conflict`. | `parseStatus` classifies by `detailedState` words first, ignores `NON_REASON_WORDS` as reasons, exposes them as `qualifier`. |
| 3 | The fast status sweep **merged** the fresh status into the old one (`Object.assign(g.status, fresh.status)`), so a `reason: "Rain"` survived the flip to `In Progress` (which has no `reason`) and the card kept saying "Rain". | Replace the status object instead of merging (scoreboard.js, delay-feed.js). |
| 4 | `scoreboard.js` built a `RegExp` from `status.reason` unescaped — a reason with `(`/`)` would throw and blank the ticker. | One shared, escaped, tested `Delays.statusLabel()` used by all pages. |
| 5 | `MLB.getJSON` always sent `Accept: application/json`; NWS content-negotiates and documents `application/geo+json`/`ld+json` — safest is to send no `Accept` for weather hosts. | `accept: null` now omits the header. |
| 6 | ECCC `warnings[]` was read with guessed field names. | Names taken from the published queryables schema (§3); unit test added. |
| 7 | A delayed-start segment's advisory span (posted → warmup) was printed like an official duration. It is not: MLB's official figure is first pitch − scheduled start (`gameInfo.delayDurationMinutes`), which the pages also show. | Timeline text now says "advisory posted 4h 12m before play resumed"; the official minutes remain the headline number. |
| 8 | README flag table missed `nws-hourly-failed`, `nws-alerts-failed`, `no-provider`, `stale`. | Added. |

---

## Limitations and remaining work

1. **No social-media / news scanning.** Twitter/X, Facebook and Instagram have no
   keyless read API; Reddit's JSON endpoints block anonymous browser requests; news
   sites have no structured, verifiable delay feed. A static GitHub Pages site has no
   server, no secrets and no place to run a scraper. What *can* be done next: a scheduled
   GitHub Action (server-side, with a stored token) that reads the official club and
   `@MLB_PR` accounts and MLB.com news RSS, writes a small JSON file into the repo, and
   the pages render it under a "Reported, not official" heading with the post URL as the
   source. Until then the pages link to those channels for manual review.
2. **ECCC browser CORS unverified** (see §3). Check `delays.html` for a Rogers Centre
   game; if the chip reads "Open-Meteo (model)" with `eccc-failed`, the fix is either a
   proxy or ECCC's `alerts`/`weather` collections that do send CORS headers.
3. **Live end-to-end run not performed from the build sandbox** — outbound TLS to
   `statsapi.mlb.com` / `api.weather.gov` was blocked there, so every verification above
   used the platform's page fetcher and the browser code was exercised only against
   captured payloads. The first live page load in a browser is the remaining check.
4. **Venue coordinates** come from MLB's venue record; special-event venues (Mexico
   City 5340, Santo Domingo 3049, and others without `defaultCoordinates`) show
   `no-coordinates`. Sutter Health Park (Athletics, id 2529) does have coordinates.
5. **Lightning specifically** — NWS does not publish a per-point lightning feed; thunder
   is detected from the hourly `shortForecast` wording and from Severe Thunderstorm
   products. Ballpark lightning-detection systems are not public.
6. **Risk chip is a threshold reading, not a prediction.** Delay decisions belong to the
   umpires and the home club; a HIGH chip with no delay is not an error.
7. **Suspended-game `resumeDate` / `resumedFrom` fields** were not observed live this
   season; they are read defensively and shown when present.
8. **History depth** — the feed shows one date at a time (like the reference site); a
   season-wide list of every delay would need a scheduled job that snapshots
   `schedule?startDate…endDate&hydrate=gameInfo` into the repo.
9. **Notifications** — the chime only sounds while the tab is open; there is no push.
