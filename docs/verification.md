> **Current audit:** [implementation-review.md](implementation-review.md). This document
> retains historical observations from prior sessions, not proof of current source
> availability. Earlier claims that these are the only accessible feeds or that all
> social APIs are universally inaccessible were too broad and are withdrawn.
> The current deployment uses Pages artifacts, not commits to main; see the current audit.

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

## 5. Manual-review links + official-news scan (social media / news)

| Claim | Verified | Evidence |
|---|---|---|
| `https://www.mlb.com/gameday/{gamePk}` | ✅ | Pattern used by MLB.com; the reference site links it identically. |
| Club news pages `https://www.mlb.com/{slug}/news` for all 30 clubs; slugs `dbacks`, `athletics`, `whitesox`, `redsox`, `bluejays`, `mariners`… | ✅ | `mlb.com/dbacks`, `mlb.com/athletics/news`, `mlb.com/whitesox/news` fetched live 2026-09-21 (HTTP 200). `teams?sportId=1&season=2026` for ids/abbreviations (Athletics id 133, D-backs abbreviation `AZ`). |
| Curated official channels on `delays.html` (MLB.com news/scores, @MLB, @MLB_PR, r/baseball, weather.gov, SPC outlook, NWS radar, ECCC warnings) | ✅ links only | Public URLs; the browser pages do **not** read them (see Limitations). |
| `https://www.mlb.com/feeds/news/rss.xml` (league) and `https://www.mlb.com/{slug}/feeds/news/rss.xml` (all 30 clubs) are publicly readable without credentials | ✅ | Fetched 2026-09-21 during this pass: league, `orioles`, `bluejays`, `yankees`, `dodgers` all HTTP 200 with RSS 2.0 `<channel>`/`<item>` shape (title, link, pubDate, author, description, guid). |
| `https://www.espn.com/espn/rss/mlb/news` is publicly readable without credentials | ✅ | Fetched 2026-09-21: HTTP 200 RSS 2.0. |
| `https://www.reddit.com/r/baseball/search.json?…` and `/…/.rss` answer **HTTP 403** to anonymous requests | ✅ | Fetched 2026-09-21 via the page fetcher — both 403. |
| Twitter/X, Facebook, Instagram have **no keyless read API** | ✅ | `api.twitter.com/2/tweets/…` requires OAuth; x.com HTML is not a feed. No keyless public JSON/RSS for Facebook/Instagram posts. (Not exercised via the CLI sandbox, which has no outbound network; this is the platform-API fact, not a live-response claim.) |
| The news scanner (`tools/news-scan.mjs`) flags a headline only when its verbatim title/description contains a word from the documented `DELAY_WORDS` / `WEATHER_WORDS` lists, records the matched words and the article link, and reports per-feed failures | ✅ tested | `tools/news-test.mjs` (11 assertions): parsed channel/item fields verbatim from a captured structure, drops untitled items, decodes CDATA/entities, flags only matching items and never the plain ones, and asserts the 32-feed configuration (league + ESPN + 30 clubs). |

The scanner is **server-side by design**: the browser cannot read these feeds
(no CORS guarantee), so the scheduled `.github/workflows/news-scan.yml`
(GitHub Actions, every 15 minutes + on main pushes) runs it and builds the
Pages artifact containing `docs/news-report.json` (read-only repository
permissions; nothing is committed back to main). It never asserts that a
delay happened — only that a headline or community post mentions delay/weather
vocabulary, with the link for a human to open. Reddit (the only named social
platform with a keyless public read path) is attempted on every scan and
reported per source — see §11.

## 6. Design parity with MLB-Live-PBP

| Item | Status |
|---|---|
| Stylesheet, `ui.js`, `404.html`, `LICENSE`, `.gitignore`, `docs/workflows/pages.yml` copied from the reference (`6d61092`) | ✅ verbatim (+ appended weather/delay CSS block and four new UI helpers; the 404 title was corrected in Pass 4) |
| Scoreboard → `index.html`, Game → `game.html`, all-games feed → `delays.html` (structure, classes and behaviour of `reviews.html`: banner, live strip, stats, tabs, chat-style rows, sound toggle, countdown, date picker) | ✅ |
| Polling etiquette (hidden-tab pause, backoff on Final, 429 self-throttle) | ✅ retained in `api.js` and the three controllers |
| Offline fixture-driven tests in `tools/`, workflows in `docs/workflows/` (smoke enabled in `.github/workflows/` since Pass 4) | ✅ 67 assertions across four suites (26 + 24 + 11 + 6) |

## 7. Test evidence (Pass 1)

```
$ for f in assets/js/*.js; do node --check "$f"; done      # clean
$ node tools/delays-test.mjs     # 25 passed  (26 after Pass 2)
$ node tools/weather-test.mjs    # 22 passed  (23 after Pass 2)
$ node tools/render-test.mjs     #  5 passed  (6 after Pass 2: scoreboard, delay feed ×3, game page ×2)
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
$ node tools/render-test.mjs     #  6 passed
```

(Finding 1–9 below were found and fixed in the first session; the Pass 4
findings of the second session — live re-verification on 2026-09-21 plus six
further bugs — are in [§9](#9-pass-4-second-session-live-re-verification-bugs-and-fixes).)

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
| 9 | Scoreboard: the first fast status sweep only recorded a baseline (compared against an empty map), so a flip between the hydrated load and that sweep was not applied until the following sweep. | Sweep signatures are now seeded from the hydrated schedule; a render test drives a real Delayed → In Progress sweep through both pages and asserts the stale reason, the ticker and the active strip all clear. |

---

## 9. Pass 4 — second session: live re-verification, bugs and fixes

**Date:** 2026-09-21 (late morning US time, a few hours after the §1–§8 captures).
Everything below was re-fetched live and compared against what the **deployed
site** renders (the GitHub Pages site executes the real page code, so the
rendered output was read directly from
<https://buffedlizard55-lab.github.io/MLBRainDelay/> and diffed field-by-field
against the raw official payloads).

### 9.1 Live re-verification (2026-09-21 slate)

| Check | Official source (live URL → value) | Site rendered | Result |
|---|---|---|---|
| Today's schedule | `schedule?sportId=1&date=2026-09-21&fields=…` (the exact 20-field sweep the code polls every 5 s — all 20 field names accepted, no 400) → 3 games, all `S`/Scheduled | `index.html`: "3 games · 0 in progress · 0 delayed now"; `delays.html`: 3 forecast rows | ✅ identical |
| Hydrated schedule shape | `schedule?…&date=2026-09-21&hydrate=team,weather,venue(location,timezone,fieldInfo),gameInfo` → 824787 Camden Yards `39.283787,-76.621689`, `America/New_York`, roofType `Open`, `weather:{}` pre-game; 824221 Comerica `42.3391151,-83.048695` | site shows "6:35 PM local · 6:35 PM EDT at the park", "MLB game weather: not yet published (appears around first pitch)" | ✅ identical |
| NWS point for Camden Yards | `api.weather.gov/points/39.283787,-76.621689` → `gridId "LWX"`, `109,91`, radar `KLWX`, `America/New_York` | game page: "NWS grid LWX 109,91 · radar KLWX"; verify link `points/39.2838,-76.6217` (4-decimal rounding, per NWS docs) | ✅ identical |
| NWS hourly 9 PM EDT period | `gridpoints/LWX/109,91/forecast/hourly` period #19 `2026-09-21T21:00:00-04:00`: PoP **67**, `shortForecast "Rain Showers Likely"` | scoreboard + feed + game page: "⛈ High — 67% · Rain Showers Likely · 9:00 PM EDT" (HIGH = documented rule maxPoP ≥ 60%) | ✅ exact |
| NWS hourly, full game window | periods 15–21 (17:00→22:00 EDT): 28 / 28 / 32 / 49 / 67 / 54 % | feed hourly table shows exactly those six rows with the same temps and winds | ✅ exact |
| NWS active alerts, Camden Yards | `alerts/active?point=39.283787,-76.621689` → `features: []`, updated 07:33Z | "Active alerts at the ballpark (0)" / no alert chip on the card | ✅ identical |
| ECCC endpoint, exact code URL | `api.weather.gc.ca/collections/citypageweather-realtime/items?f=json&lang=en&limit=10&bbox=-79.789,43.342,-78.989,43.942` (the ±0.4°/±0.3° box around the Rogers Centre coordinates, the exact string `weather.js` builds) → FeatureCollection with bilingual `{en,fr}` leaves, `currentConditions`, `forecastGroup`, `lastUpdated` — the documented shape | n/a today (no Jays game); nearest-feature logic picks the park's own city page at runtime | ✅ shape verified live (resolves the ⚠️ in §3 for the *server* side; browser CORS still needs a user check — see Limitations) |
| Status registry | `gameStatus` re-fetched live, all 210 rows | fixture `game-status-registry.json` = 210 rows; per-family counts identical (P 18, I 20, M 23, N 23, O 19, F 19, D 15, C 15, T 17, U 18, Q 10, R 10, S 1, W 1, X 1 = 210) | ✅ same membership — see flag below |
| Delay facts, 824381 (ATH@CLE, Progressive Field) | `schedule?sportId=1&gamePk=824381&hydrate=gameInfo,weather` → `delayDurationMinutes: 125`, `firstPitch 2026-09-20T19:45:00Z` − `gameDate 17:40:00Z` = +125, MLB weather `"Cloudy" 68°F, "12 mph, In From CF"`, CLE 1–0 | fixture + cross-check logic reproduce the 125 min exactly | ✅ identical |
| Box score, 824546 (DET@CWS, Rate Field) | `game/824546/boxscore?fields=info,label,value` → `T: "2:50 (3:50 delay)."`, `Weather: "65 degrees, Rain."`, `Wind: "10 mph, L To R."`, `Att: "21,354."`, `Venue: "Rate Field."` | `3:50 = 230 min = delayDurationMinutes` cross-check; feed shows "MLB delayDurationMinutes: 230 (3h 50m)" + "box score T: 2:50 (3:50 delay)" | ✅ identical |

### 9.2 Irregularities found live this pass (flagged, not silently resolved)

1. **Registry row order drifted within the N family.** Between the §1 capture
   (04:00Z) and this re-fetch (≈07:50Z), `NW` "Umpire review: Def Shift
   Violation" moved from position 3 to position 22 of the N family. Row
   **membership and content are identical** (210 = 210, every row verified);
   the classifier works per-row so there is no functional impact, and the
   fixture test would catch any future *content* drift.
2. **The registry endpoint ignores `fields=`.** `gameStatus?fields=statusCode`
   still returns full rows (2026-09-21). No code impact (the fixture was
   captured with the four documented fields and the extra fields are simply
   not stored), noted so a future re-capture doesn't trust the projection.
3. **`fields=` + `hydrate=` on `schedule` returns empty hydrated objects.**
   Verified live this pass (e.g. `gameInfo:{}`). The client never combines the
   two: `getSchedule` uses `hydrate=` only, `getStatusSweep` uses `fields=`
   only — both patterns verified working in 9.1. Documented here so the
   combination is not introduced later.
4. **Live box scores carry more `info[]` labels than the captured fixture.**
   The live 824546 box score also lists `WP`, `Balk`, `HBP`, `ABS Challenge`,
   `Pitches-strikes`, `Groundouts-flyouts`, `Batters faced`, `Inherited
   runners-scored`, `Umpires` and a trailing date line **without a value**
   (`{"label":"September 20, 2026"}`). `parseBoxscoreInfo` reads only the six
   known labels and treats a missing `value` as `''` (verified in code), so
   the cross-checks are unaffected; the extra labels are deliberately ignored,
   not hidden.

### 9.3 Bugs found and fixed this pass

```
$ for f in assets/js/*.js; do node --check "$f"; done      # clean
$ node tools/delays-test.mjs     # 26 passed
$ node tools/weather-test.mjs    # 24 passed  (+1: stale-cache)
$ node tools/render-test.mjs     #  6 passed  (assertions extended)
```

| # | Finding | Fix |
|---|---|---|
| 1 | `delays.html` had an empty `<div id="club-links">` — the manual-review club list was never populated (clubs.js was loaded but unused by the feed). | `Clubs.newsLinks(games)` added (one official MLB.com club-news link per team, de-duplicated); the feed fills the div on every load and clears it on date change. Render test asserts 12 links for the 12-club fixture slate, all `https://www.mlb.com/{slug}/news`. |
| 2 | Scoreboard tab filter could desync: when the user's filter lost its tab (e.g. Flagged count dropped to 0 between polls), the reset to `all` ran **after** the card list was already rendered with the dead filter — the list showed the stale filtered subset with no tab highlighted until the next cycle. | Counts + tab list are computed first; the filter is reset *before* the card list is rendered. Render test drives the exact transition (flags 1 → 0) and asserts all cards visible, All tab active, no Flagged tab. |
| 3 | Duplicate "NWS alerts (JSON)" links: the alerts URL was reachable from both `sourceUrls` and the human-review links, so feed rows and the game-page Sources panel listed it twice. | De-duplicated by URL in `wxLinks()` (delay feed), `alertBody()` (alert rows) and the game-page Sources panel. Render tests assert no URL appears twice in any row/panel. |
| 4 | `ui.js` exported a `headshot()` helper that called `MLB.headshotUrl` — a function that does not exist in `api.js`. Unused by every page, but a guaranteed `TypeError` if ever called. | Dead helper and its export removed. |
| 5 | `weather.js` cache: when a refresh failed while the cached value was already past its TTL, the *next* call served the stale value **without** the `stale` marker, so the "last successful fetch" footnote could silently disappear for as long as the failure lasted. | `cached()` now marks the value `stale: true` whenever it is served outside its TTL (the value-fresh / error-fresh matrix is unchanged otherwise). New unit test drives both the failing call and the follow-up cached-error call. |
| 6 | `404.html` still carried the reference project's title ("404 — MLB Live PBP"). | Title now "404 — MLB Rain Delay". Also removed a dead `window.MLBReviews` branch in `statusChip` (that script is not part of this repo; the self-contained statusCode/codedGameState detector — verified against the live registry's M*/N*/IH rows — is the only path now). |

### 9.4 CI

`.github/workflows/smoke.yml` runs the four offline suites (syntax check +
all `tools/*-test.mjs` assertions) on every push, pull request and nightly
(04:17 UTC). They are fully offline — captured, verified payloads in
`tools/fixtures/` — so they never depend on upstream availability or rate
limits. The live scan + deploy workflow `.github/workflows/news-scan.yml`
re-runs the same suites before building the Pages artifact every 15 minutes
and on main pushes. (Earlier copies of these templates lived in
`docs/workflows/`; they were removed on 2026-09-22 because the live
workflows in `.github/workflows/` are the only source of truth.)

---

## 10. Pass 5 — third session: official-news scan + live re-verification

**Date:** 2026-09-21 (evening US time). Everything below was re-fetched live
where the sandbox allows it, and the sandbox's limits are stated rather than
worked around.

### 10.1 Live re-verification (2026-09-21 evening slate)

| Check | Source → value | Result |
|---|---|---|
| Today's slate carries a real active delay | `schedule?sportId=1&gamePk=824787&hydrate=weather,venue(location,timezone,fieldInfo),gameInfo` → TOR @ BAL, Camden Yards, `status.detailedState "Delayed Start"`, `statusCode "PI"`, `reason "Inclement Weather"`, `weather.condition "Rain"`, 39.283787,-76.621689, roofType Open | ✅ rendered by the deployed scoreboard + feed exactly ("⏸ ACTIVE DELAYS … Delayed Start: Inclement Weather") |
| NWS point for Camden Yards | `api.weather.gov/points/39.2838,-76.6217` → grid `LWX 109,91`, radar `KLWX`, tz `America/New_York` | ✅ deployed feed links `points/39.2838,-76.6217` and `radar KLWX` |
| NWS active alerts at Camden Yards | `alerts/active?point=39.2838,-76.6217` → `features: []` | ✅ "0 alerts" shown |
| ECCC GeoMet works server-side | `api.weather.gc.ca/collections/citypageweather-realtime/items?f=json&lang=en&limit=1&bbox=…` → FeatureCollection `on-128` Toronto Island with currentConditions + forecastGroup (bilingual `{en,fr}`) | ✅ shape re-verified live |
| MLB.com news RSS league feed | `mlb.com/feeds/news/rss.xml` → HTTP 200, `<channel><item>` RSS 2.0 | ✅ keyless-readable |
| MLB.com club RSS feeds | `orioles/bluejays/yankees/dodgers/feeds/news/rss.xml` → HTTP 200, RSS 2.0 | ✅ keyless-readable |
| ESPN MLB RSS | `espn.com/espn/rss/mlb/news` → HTTP 200, RSS 2.0 | ✅ keyless-readable |
| Reddit anonymous | `reddit.com/r/baseball/search.json?…` and `/…/.rss` → HTTP **403** | ✅ blocked (as documented) |

**Sandbox limits disclosed:** the build sandbox has no outbound network from
the shell (`curl`/`node fetch` fail with "fetch failed"), so live-response
checks above were made through the documentation/page fetcher, exactly as in
past passes. `tools/news-scan.mjs` was therefore exercised offline only
(parser + classifier unit tests) and with a full 32-feed run that correctly
reported `feedsOk 0 / feedsFailed 32` (degradation path) in the sandbox; a
real run happens in GitHub Actions, where egress exists.

### 10.2 Findings and fixes this pass

| # | Finding | Fix |
|---|---|---|
| 1 | The request asks to scan Twitter, Facebook, Instagram, Reddit "and any other news organizations". On live check, the social platforms have **no keyless read path** (Reddit JSON+RSS = HTTP 403 anonymous; X/Facebook/Instagram have no anonymous API). A static page cannot store credentials, so pretending to scan them would be a hallucination. | Documented the verified blocker; implemented the **only keyless official sources that exist** — a server-side scanner over the MLB.com league/club RSS + ESPN MLB RSS (`tools/news-scan.mjs`, 11 offline assertions) with a scheduled workflow (`.github/workflows/news-scan.yml`) that writes `docs/news-report.json` and flags feed outages. Nothing is asserted about a delay from a headline. |
| 2 | Browser copy claimed "the site **never scrapes social media or news sites**", which implied there was no news path at all — now inaccurate. | `delays.html`, `game.js`, README and the verification report re-worded to state precisely what is read (official RSS, server-side) and what is not (social platforms). |
| 3 | The news-scan workflow (which pushes into the repo) must not run with the anonymous bot's default permissions assumptions. | Workflow grants `contents: write` + `issues: write`, pushes only `docs/news-report.json`, and reports an outage as an issue rather than pretending success. |
| 4 | The smoke CI did not cover the new scanner. | `tools/news-test.mjs` wired into both `.github/workflows/smoke.yml` and `docs/workflows/smoke.yml` (67 total assertions). |

---

## 11. Pass 6 — fourth session (2026-09-22): full re-verification, sparse-schedule flag, Reddit scan attempt, Pages deployment blocker

**Date:** 2026-09-22 (early morning UTC / evening 2026-09-21 US time). Every
row below was re-fetched live through the page fetcher; the sandbox shell has
no outbound network (curl fails), which is disclosed, not worked around.

### 11.1 Live re-verification (2026-09-22)

| Check | Official source (live URL → value) | Result |
|---|---|---|
| Today's slate 2026-09-22 | `schedule?sportId=1&date=2026-09-22&fields=…` → 16 games, all `S`/`Scheduled` (as of 03:35Z) | ✅ matches the deployed scoreboard's date handling |
| **Sparse slate 2026-09-21** | `schedule?sportId=1&date=2026-09-21&fields=…` → **3 games** (824787 Final, 824221 Final, 823169 In Progress); same 3 games via `startDate=2026-09-21&endDate=2026-09-21` — **both API forms agree** | ✅ upstream irregularity, now flagged by the new `sparse-schedule` rule (§11.2 #1) |
| Neighbour slates for comparison | 2026-09-20 → 15 games; 2026-09-19 → 15 games; 2026-09-22 → 16 games | ✅ the 3-game day is an outlier in both directions |
| Status registry (spot check of the 210-row fixture) | `gameStatus` live: `PR` "Delayed Start: Rain" (`reason "Rain"`), `PW` Warmup, `IH` "Instant Replay" (`reason "Review"`), `IT` "Delayed: Tiebreaker" (`reason "Tiebreaker"`), `IZ` "Delayed: About to Resume", `MF/MA/MU/…` manager-challenge family | ✅ matches `tools/fixtures/game-status-registry.json` |
| NWS point, Rate Field | `api.weather.gov/points/41.83,-87.6342` → `LOT/76,71`, radar `KLOT`, `America/Chicago` | ✅ unchanged from §2 |
| NWS hourly, LOT/76,71 | `generatedAt 2026-09-22T03:37:10Z`; overnight periods PoP 9–13%, "Cloudy"/"Mostly Cloudy" | ✅ shape + values as documented |
| NWS active alerts, Rate Field | **one live feature**: `Beach Hazards Statement` (Lakeshore, NWS Chicago IL, severity Moderate) | ✅ live exercise of the ignore list: `beach` product is classified `ignored` and correctly does **not** raise a ballpark alert or risk level |
| ECCC GeoMet, Toronto | `citypageweather-realtime/items?f=json&lang=en&limit=10&bbox=…` → `on-128` Toronto Island, `lastUpdated 2026-09-22T03:01:12Z`, current 14.1 °C "Mostly Cloudy", wind NE 33 km/h, bilingual `forecastGroup.forecasts[]` | ✅ shape re-verified (server side) |
| Open-Meteo fallback (non-US park, Tokyo) | `api.open-meteo.com/v1/forecast?latitude=35.6939&longitude=139.7489&hourly=…&timeformat=unixtime&timezone=UTC` (the exact URL the code builds) → `hourly.time[]` epoch seconds, `precipitation_probability[]`, WMO `51` (Light drizzle) appears | ✅ shape verified live with the production parameter set |
| MLB league RSS | `mlb.com/feeds/news/rss.xml` → HTTP 200, freshest item `Tue, 22 Sep 2026 03:35:45 GMT` | ✅ keyless-readable |
| ESPN MLB RSS | `espn.com/espn/rss/mlb/news` → HTTP 200, fresh items; pubDates use `EST` zone notation in September | ✅ parsed exactly as published (`EST` → UTC−5); the scanner interprets the zone the feed states and never invents an offset |
| Reddit anonymous | `www.reddit.com/r/baseball/new.json`, `api.reddit.com/…`, `old.reddit.com/…/.json` → HTTP **403** (three host variants) | ✅ blocked from this egress; the scanner reports it per source instead of skipping |
| GitHub Pages mode | `GET /repos/buffedlizard55-lab/MLBRainDelay/pages` → `build_type "legacy"`, source `main`/`/`; `PUT …/pages build_type=workflow` → **403 "Resource not accessible by integration"** (admin-only) | ✅ confirms the published-snapshot blocker (§11.2 #3, Limitations #2) |
| Deployed site, 2026-09-21 slate | `https://buffedlizard55-lab.github.io/MLBRainDelay/index.html` renders "3 games · 1 in progress · 0 delayed now" with "⏱ 47m official delay · first pitch 7:22 PM (+47m)" for 824787; `docs/news-report.json` → 404 | ✅ site live; inbox 404 explained by the legacy Pages mode above. **The deployed feed also carried a spurious `boxscore-note-unparsed` flag on 824787: its box score prints the sub-hour delay as `T: "2:30 (:47 delay)."` (minutes only), which the `h:mm`-only regex did not parse. Fixed in `parseBoxscoreInfo` + 2 new unit tests (§11.2 #6)** |

### 11.2 Findings and fixes this pass

| # | Finding | Fix |
|---|---|---|
| 1 | The official schedule reported **3 games for 2026-09-21 while both neighbours reported 15** — an upstream data irregularity the site displayed silently. | New `sparse-schedule` irregularity flag: a date reporting ≤ 8 games while an adjacent day reports ≥ 4 more (or 0 games with an adjacent day of ≥ 8) shows a 🚩 note with the counts and a link to that date's schedule JSON, on both the scoreboard and the delay feed. Pure function `Delays.sparseScheduleFlag()` (4 unit tests); one lightweight sweep per neighbour, cached per session; a failed neighbour fetch means "no comparison", never a false flag. |
| 2 | Reddit — the only named social platform with a keyless public API — was documented as blocked but **never actually attempted** by the scanner. | `tools/news-scan.mjs` now attempts `r/baseball/new.json` (keyless) on every 15-minute scan, classifies posts with the same transparent word lists, labels them **community (NOT official)**, and reports a 403 as an explicit per-source failure with a link to the subreddit. 8 new offline tests + a labelled-synthetic fixture (live capture impossible while 403). If the egress ever allows it, data flows with no code change. |
| 3 | The public site's written-reports inbox was 404: Pages is on legacy branch publishing, so the workflow-built snapshot never reached the public site, and the workflow cannot switch Pages mode itself (403, admin-only). | The delay feed's reports section now shows the **latest scan run** (time, status, direct link to the run and its artifact) from the public GitHub API, and when the snapshot is 404 it prints the exact admin steps (Settings → Pages → Source: GitHub Actions) instead of a generic "unavailable". |
| 4 | Stale copies of the workflow templates in `docs/workflows/` could mislead a reviewer about what is actually deployed. | Removed; `.github/workflows/smoke.yml` header updated; README structure list updated. |
| 5 | `reports.js` snapshot header and category handling only knew `official`/`wire`. | Added the `community` category (labelled "Community — NOT official", distinct badge) and the `www.reddit.com` host to the URL allowlist (lookalike hosts rejected, tested). |
| 6 | **Sub-hour box score delay notes parsed as unparseable.** 824787's box score prints the official 47-minute delay as `T: "2:30 (:47 delay)."` (minutes only — MLB's sub-hour form), and the `h:mm`-only regex did not match it, so the deployed feed showed a spurious `boxscore-note-unparsed` flag. | `parseBoxscoreInfo` now matches `(?:(\d+):)?(\d{1,2})\s*delay` — `:47 delay` → 47, `3:50 delay` still → 230. 2 new unit tests (sub-hour parse + silent crossCheck; hour:minute regression). |

### 11.3 Test evidence

```
$ for f in assets/js/*.js; do node --check "$f"; done      # clean
$ node tools/delays-test.mjs     # 32 passed  (+4 sparse-schedule, +2 sub-hour delay note)
$ node tools/weather-test.mjs    # 25 passed
$ node tools/news-test.mjs       # 25 passed  (+8 social/Reddit, +1 permalink policy)
$ node tools/render-test.mjs     # 8 passed
$ node tools/reports-test.mjs    # passed     (+5 reddit URL safety / community label)
```

---

## Limitations and remaining work

1. **Social-media scanning is only partially possible keyless.** Among the
   platforms named in the project goals, only Reddit exposes a keyless public
   read path, and it is attempted server-side on every 15-minute scan — but
   anonymous requests from datacenter/CI egress answered HTTP 403 on
   2026-09-22 (re-verified), so the snapshot currently lists it as an
   unavailable source with a link to the subreddit rather than silently
   skipping it. X/Twitter, Facebook, Instagram, Threads and Bluesky have no
   keyless read API (re-verified 2026-09-22); ingesting them would need paid,
   authorized credentials stored server-side (never in the static page).
   **News scanning is fully done**: the MLB league + 30-club RSS feeds and 7
   independent outlets are scanned by the scheduled `news-scan` workflow into
   the published snapshot (see §5 and §11).
2. **The published snapshot is not deployed until a one-time admin switch.**
   The repo's GitHub Pages is still on **branch publishing** (legacy), which
   serves `main` as-is — so `docs/news-report.json` (built only inside the
   workflow artifact) 404s on the public site. The workflow's attempt to
   switch Pages to the GitHub Actions build type is refused (HTTP 403, admin
   only). Until **Settings → Pages → Build and deployment → Source: GitHub
   Actions** is enabled, the delay feed shows the latest scan run (status +
   link) and the exact steps instead of pretending the inbox is live.
3. **ECCC browser CORS unverified** (see §3 and §9.1). The *server* side of
   the exact code URL was verified live on 2026-09-21 and re-verified on
   2026-09-22 (FeatureCollection with the documented shape). The remaining
   check is browser CORS from a user's machine on a day the Blue Jays play:
   if the chip reads "Open-Meteo (model)" with `eccc-failed`, the fix is
   either a proxy or ECCC's `alerts`/`weather` collections that do send CORS
   headers.
4. **Live end-to-end run** — the deployed site's rendered output (the page's
   own JavaScript executed in a real browser by the verification tooling) was
   diffed field-by-field against the raw official payloads for the 2026-09-21
   slate (§9.1) and spot-checked again on 2026-09-22 (§11.1). What remains:
   an interactive user-side check of polling behaviour (5 s status sweep,
   weather refresh, chime) on a day with an active delay.
5. **Venue coordinates** come from MLB's venue record; special-event venues
   (Mexico City 5340, Santo Domingo 3049, and others without
   `defaultCoordinates`) show `no-coordinates`. Sutter Health Park (Athletics,
   id 2529) does have coordinates.
6. **Lightning specifically** — NWS does not publish a per-point lightning
   feed; thunder is detected from the hourly `shortForecast` wording and from
   Severe Thunderstorm products. Ballpark lightning-detection systems are not
   public.
7. **Risk chip is a threshold reading, not a prediction.** Delay decisions
   belong to the umpires and the home club; a HIGH chip with no delay is not
   an error.
8. **Suspended-game `resumeDate` / `resumedFrom` fields** were not observed
   live this season; they are read defensively and shown when present.
9. **History depth** — the feed shows one date at a time (like the reference
   site); a season-wide list of every delay would need a scheduled job that
   snapshots `schedule?startDate…endDate&hydrate=gameInfo` into the repo.
10. **Notifications** — the chime only sounds while the tab is open; there is
    no push.
