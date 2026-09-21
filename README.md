# 🌧 MLB Rain Delay — Live MLB Scoreboard with Weather & Delay Tracking

A zero-dependency, static web app — the same vanilla HTML/CSS/JS design as
[MLB-Live-PBP](https://github.com/buffedlizard55-lab/MLB-Live-PBP) — that pulls
**live MLB game data** from the public MLB StatsAPI and adds, for **every game on the
schedule**, the **official weather picture at the ballpark** and a **verified record of
every delay, postponement and suspension**: rain forecasts, thunderstorms and lightning,
active weather alerts, rain delays as they happen, how long they lasted, and when play
resumed.

**Live site:** <https://buffedlizard55-lab.github.io/MLBRainDelay/>

- **Scoreboard** (`index.html`) — every game for any date with live scores and inning,
  plus a weather strip on each card: forecast-risk chip (⛈ High / 🌧 Moderate / 🌦 Low /
  ☀ None / 🏟 Covered / ? Unknown), the worst hour in the game window, the number of
  active government weather alerts, MLB's own first-pitch weather line, roof status,
  and the official delay facts (`Delayed Start: Rain`, `3h 50m official delay`,
  `makeup 2026-09-22`, …). Games delayed **right now** rise to the top under an
  ⏸ ACTIVE DELAYS ticker. Filter tabs: Delays · Rain risk · Alerts · Flagged.
- **All-games Delay Feed** (`delays.html`, the analogue of the reference site's
  `reviews.html`) — a live, chat-style feed for the whole slate:
  - **DELAYED NOW** strip and a row for every game currently delayed or suspended, with
    the official reason and how long it has been going;
  - a **delay history row** for every game that had a delay, with MLB's official minutes,
    the play-by-play **status-change timeline** (`Delayed Start: Rain` at 12:26 PM →
    `Warmup` at 4:38 PM → `In Progress` at 4:59 PM, inning and half for mid-game
    delays), the box-score `T: 2:50 (3:50 delay)` line, and the first-pitch offset;
  - **postponed / cancelled** rows with the official reason and reschedule date;
  - a **forecast row per game** (hourly chances in the game window, thunder, wind, roof)
    and one row per **active weather alert** (Severe Thunderstorm Warning, Tornado
    Watch, Flood Advisory, …) mapped to the ballparks it covers;
  - **observed transitions** — when the page itself sees a game flip to Delayed, resume,
    or get postponed between two polls it logs the moment (clearly labelled as seen by
    this browser, never as an official timestamp) and plays an optional chime.

  The alert rows (DELAYED NOW / delay / postponed / observed) are produced **only from
  official status and advisory data** — a game that MLB has not officially delayed,
  postponed or suspended never appears as a delay row, whatever the forecast says.
  Weather forecasts are shown for **every** game, in the separate forecast-row category;
  a non-weather delay (power, injury) still appears — it genuinely delayed the game —
  but is flagged `(non-weather)`, never hidden.
- **Game view** (`game.html`) — one game: header, linescore, an **Official delay status**
  panel (MLB `delayDurationMinutes`, scheduled start vs. actual first pitch, status
  history, advisory timeline, box-score cross-check), a **Weather at the ballpark**
  panel (hourly table for the game window with the first-pitch row marked, active alert
  cards with headline/onset/expiry/instructions, the NWS grid or ECCC station used, the
  rules the risk chip follows, printed verbatim), and a **Sources** panel listing every
  URL the page read.

Every row and card carries **source links** — the exact StatsAPI JSON, the MLB.com
Gameday page, the NWS point / hourly forecast / alerts JSON (or the Environment Canada
city page for Toronto), and the human-readable `forecast.weather.gov` page — so any line
can be checked by hand in one click.

## Sources — what is official, what is derived, what is flagged

| Fact on the page | Source (read as-is) | Verified against |
|---|---|---|
| Game status, `Delayed: Rain`, `Postponed`, reason | StatsAPI `schedule` `status.detailedState / statusCode / reason` | `GET /api/v1/gameStatus` registry (all 210 codes captured verbatim in `tools/fixtures/game-status-registry.json`; every row is classified by the test suite) |
| Official delay minutes | `gameInfo.delayDurationMinutes` (schedule `hydrate=gameInfo`, live feed) | live feed 824546 (`230`), 824381 (`125`), 822686 (`86`) |
| First pitch vs. scheduled start | `gameInfo.firstPitch` − `gameDate` | 824546: 5:00 PM vs 12:10 PM local = +230 min = official minutes |
| Delay timeline (start → resume, inning) | `playByPlay` `playEvents[].details.eventType == "game_advisory"` with `startTime`/`endTime` | 824546 (delayed start), 822686 (top-4th delay, "About to Resume", resume) |
| Box score `T: 2:50 (3:50 delay)`, `Weather: 65 degrees, Rain.` | `boxscore` `info[]` labels `T`, `Weather`, `Wind` | 824546 |
| Postponement → makeup date | `rescheduleDate`, `rescheduleGameDate`, `rescheduledFrom`, `description` | 823062 MIL@STL 5/5 → 7/7 (`Makeup of 5/5ppd`) |
| MLB first-pitch weather line, roof | schedule `weather{condition,temp,wind}`, `venue.fieldInfo.roofType` | `Rain`, `Drizzle`, `Dome`, `Roof Closed` observed live |
| Hourly forecast (US parks) | NWS `api.weather.gov/points/{lat},{lon}` → `gridpoints/{wfo}/{x},{y}/forecast/hourly` | Rate Field → `LOT/76,71` |
| Active alerts (US parks) | NWS `alerts/active?point={lat},{lon}` | Live feature shape captured 2026-09-20 |
| Forecast & warnings, Rogers Centre | Environment Canada GeoMet `citypageweather-realtime` (`on-128`, Toronto) | Captured 2026-09-20; API is labelled *experimental* by ECCC |
| Forecast outside the US/Canada | Open-Meteo (model output, **not** a government source) | always flagged `non-government-source` |

**Derived, and labelled as such:** the forecast-risk level. The thresholds are data in
`assets/js/weather.js` (`RISK_RULES`) and printed on every game page:

- **HIGH** — max hourly precipitation chance in the game window ≥ 60 %, or thunderstorms
  in the window with chance ≥ 40 %, or an active Tornado / Severe Thunderstorm / Flash
  Flood **Warning** at the ballpark.
- **MODERATE** — max chance 30–59 %, or any thunderstorm mention, or an active weather
  **Watch / Advisory** (marine, beach and rip-current products are ignored).
- **LOW** — 10–29 % with no thunderstorms. **NONE** — below 10 %.
- **COVERED** — fixed dome, or retractable roof that MLB reports as `Roof Closed`.
- **UNKNOWN** — no forecast could be loaded (the reason is shown).

The game window is one hour before first pitch to four hours after (or the official game
duration plus delay minutes once the game is final). A risk level is a reading of the
official forecast, **not a prediction** of a delay.

**Nothing is invented.** If a field is absent it is shown as absent (`—`, `not yet`,
`No forecast`). The pages never guess a delay reason, never fill in a missing timestamp
with the observer's clock, and never fabricate a start time for a TBD game.

### Irregularity flags (🚩 for manual review)

Whenever two official sources disagree, or a shape is unexpected, the row gets a flag
with the code and a plain-language explanation — it is never resolved silently:

| Code | Meaning |
|---|---|
| `duration-mismatch` | play-by-play delay segments sum to something ≠ `delayDurationMinutes` (± 10 min) |
| `boxscore-mismatch` | box-score `(h:mm delay)` ≠ `delayDurationMinutes` |
| `minutes-without-advisory` / `advisory-without-minutes` | one MLB source records a delay, the other does not |
| `boxscore-only-delay` / `boxscore-note-unparsed` | a delay note exists only in the box score, or could not be parsed |
| `reason-conflict` / `unknown-reason-code` / `reason-missing` / `status-conflict` | status words, code letter and `reason` disagree or are incomplete |
| `official-date-shift` | `officialDate` ≠ listing date with no reschedule fields |
| `start-tbd` | start time is TBD — the forecast window uses MLB's placeholder time |
| `first-pitch-before-schedule` | first pitch recorded before the scheduled start |
| `non-weather` | delay/postponement reason is not weather (Power, Injury, Emergency …) — still shown |
| `multiple-schedule-entries` | one `gamePk` appears on more than one date (postponement + makeup) |
| `mlb-wet-forecast-dry` / `mlb-dry-forecast-wet` | MLB's first-pitch weather line contradicts the official forecast |
| `nws-no-coverage` / `nws-failed` / `no-coordinates` / `eccc-failed` / `non-government-source` / `no-provider` | which weather source answered, and why a fallback was used (or why none could) |
| `nws-hourly-failed` / `nws-alerts-failed` / `stale` | one NWS product failed while the other loaded, or the last good fetch is being shown after a failed refresh (`stale` is shown as a footnote, not counted as an irregularity) |
| `pbp-unavailable` / `boxscore-unavailable` | a cross-check source could not be fetched (retried next poll) |

### What this site does *not* do (by design, see [Limitations](#limitations))

It does **not** scan Twitter/X, Facebook, Instagram, Reddit or news sites. A keyless
static page cannot read those platforms (all require authenticated APIs or server-side
scraping, and none are verifiable sources on their own). Instead each game links to the
places where official announcements are made — the MLB.com Gameday page, both clubs'
official news pages, `@MLB` / `@MLB_PR`, the NWS forecast office and radar, the SPC
convective outlook and Environment Canada — under a **Manual review** heading, so a
human can check social chatter against the official record in one click.

## Project structure

```
index.html            Scoreboard (all games, weather strip + delay ticker)
delays.html           All-games Delay Feed (live delays, history, forecast, alerts, flags)
game.html             Single game (delay panel, weather panel, sources)
404.html              GitHub Pages fallback
assets/css/style.css  Reference stylesheet + weather/delay blocks
assets/js/api.js      StatsAPI client (retry, 429 self-throttle, cache, source-link helpers)
assets/js/weather.js  NWS → Environment Canada → Open-Meteo provider chain, alerts, risk rules
assets/js/delays.js   Status registry parsing, advisory timeline, box-score cross-checks, flags
assets/js/clubs.js    Official club news / site links for manual review
assets/js/scoreboard.js · delay-feed.js · game.js   Page controllers
assets/js/ui.js       DOM helpers, chips, logos
tools/fixtures/       Captured, verified API payloads (each has _source / _verified)
tools/*-test.mjs      Offline test suites (run in Node, no network)
docs/verification.md  Line-by-line verification log with the URLs used
docs/verification.html  Same, rendered for the site footer
docs/workflows/       Optional GitHub Actions (Pages deploy, offline tests)
```

## Run it locally

Any static file server works — no installs required:

```bash
python3 -m http.server 8000      # or: npx serve .
```

Open <http://localhost:8000>. The offline, network-free checks:

```bash
for f in assets/js/*.js; do node --check "$f"; done
node tools/delays-test.mjs    # 26 — status registry, advisories, timeline, box score, cross-checks, transitions
node tools/weather-test.mjs   # 24 — NWS / ECCC / Open-Meteo normalisation, alert classes, risk rules, provider chain
node tools/render-test.mjs    #  6 — scoreboard + delay feed + game page rendered against captured payloads
```

## Deploy to GitHub Pages

The site is 100 % static (repo root = site root). This repo is already published from
`main` / `(root)` at <https://buffedlizard55-lab.github.io/MLBRainDelay/>; every merge
to `main` republishes within about a minute. The offline test suite is enabled as CI in
`.github/workflows/smoke.yml` (every push, pull request and nightly 04:17 UTC).
`docs/workflows/pages.yml` remains optional — copying it to `.github/workflows/`
would switch deploys to the Actions pipeline (the two should not run at the same
time).

## Notes & etiquette

- **MLB StatsAPI** is unofficial and may change without notice. The client is defensive
  (every field optional, `fields=` projections, retries, and a 60-second self-throttle
  after any HTTP 429). The Delay Feed polls the light status sweep every 5 s while games
  are not final (30 s otherwise), the full hydrated schedule every 20 s when a delay is
  open (60 s otherwise), and only fetches play-by-play / box score for games that
  actually report a delay.
- **api.weather.gov** allows browser CORS (`Access-Control-Allow-Origin: *`). The app
  follows the NWS guidance: no custom `User-Agent` header (it would break the preflight),
  no cache-busting query strings (the API answers 400), coordinates rounded to four
  decimals, `/points` cached for 24 h per venue, hourly forecast every 15 min, alerts
  every 2 min, at most six concurrent requests.
- **Environment Canada GeoMet** is an *experimental* API; if it stops answering, Rogers
  Centre falls back to Open-Meteo and the row is flagged.
- Team logos and the underlying data are © MLB Advanced Media / MLB. Weather data is
  public-domain (NOAA/NWS) or © Environment and Climate Change Canada. This is an
  unofficial fan project — not affiliated with or endorsed by MLB, NOAA or ECCC.

## Limitations

See the end of [`docs/verification.md`](docs/verification.md) for the full list. In short:
no social-media or news scanning (no keyless, verifiable way to do it from a static
page); browser CORS for the ECCC endpoint could not be exercised from the build sandbox;
the Sacramento (Athletics), London, Mexico City and other special-venue coordinates come
from MLB's venue record and may be missing (flagged `no-coordinates`); the risk chip is a
threshold reading of the forecast, not a delay prediction.

## License

MIT — see [LICENSE](LICENSE).
