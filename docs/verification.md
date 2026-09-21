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
(no CORS guarantee) and the social platforms have no anonymous read path, so the
scheduled `.github/workflows/news-scan.yml` (GitHub Actions, every 6 h) runs it
and writes `docs/news-report.json`. It never asserts that a delay happened —
only that a headline mentions delay/weather vocabulary, with the link for a
human to open.

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

`docs/workflows/smoke.yml` was enabled in `.github/workflows/smoke.yml`: the
four offline suites (syntax check + 67 assertions) now run on every push,
pull request and nightly (04:17 UTC). They are fully offline — captured,
verified payloads in `tools/fixtures/` — so they never depend on upstream
availability or rate limits. The Pages workflow (`docs/workflows/pages.yml`)
remains optional: this repo is already published from `main` / `(root)` via
GitHub Pages settings, and enabling the Actions-based deploy at the same time
would double-deploy.

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

## Limitations and remaining work

1. **Social-media scanning is not possible keyless, and is not done.** Twitter/X,
   Facebook and Instagram have no keyless read API; Reddit's JSON/RSS endpoints answer
   HTTP 403 to anonymous requests (verified 2026-09-21). Reading them would need paid
   API credentials stored server-side. **Official-news scanning is done instead**:
   the publicly readable MLB.com league/club RSS and ESPN MLB RSS feeds are scanned by
   the scheduled `news-scan` workflow into `docs/news-report.json` (see §5). What remains
   impossible from a storeless static page: the social feeds themselves, and any "post
   text" that is not in a public RSS feed.
2. **ECCC browser CORS unverified** (see §3 and §9.1). The *server* side of the
2. **ECCC browser CORS unverified** (see §3 and §9.1). The *server* side of the
   exact code URL was verified live on 2026-09-21 (FeatureCollection with the
   documented shape). The remaining check is browser CORS from a user's machine
   on a day the Blue Jays play: if the chip reads "Open-Meteo (model)" with
   `eccc-failed`, the fix is either a proxy or ECCC's `alerts`/`weather`
   collections that do send CORS headers.
3. **Live end-to-end run** — partially closed on 2026-09-21 (§9.1): the
   deployed site's rendered output (the page's own JavaScript executed in a
   real browser by the verification tooling) was diffed field-by-field against
   the raw official payloads for the full 2026-09-21 slate (schedule, NWS
   point/hourly/alerts at Camden Yards, ECCC, box score, status registry).
   What remains: an interactive user-side check of polling behaviour (5 s
   status sweep, weather refresh, chime) on a day with an active delay, since
   today's slate had no in-progress game.
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
