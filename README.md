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
- **All-games Delay Feed** (`delays.html`) — a live, chat-style feed for the whole slate,
  organized newest/most-urgent first so you can see every delayed game and its status
  at a glance:
  - **⏸ DELAYED NOW** strip at the very top for every game currently delayed or suspended,
    with the official reason, how long it has been going, and a clear "Expected restart:
    not announced" notice so scheduled first pitch is never mistaken for an ETA;
  - a **delay history row** for every game that had a delay, with MLB's official minutes,
    the play-by-play **status-change timeline** (`Delayed Start: Rain` at 12:26 PM →
    `Warmup` at 4:38 PM → `In Progress` at 4:59 PM, inning and half for mid-game
    delays), the box-score `T: 2:50 (3:50 delay)` line, and the first-pitch offset;
  - **📅 postponed / cancelled / suspended** rows with the official reason and
    reschedule / resume date;
  - a **🌧 forecast row per game** (hourly chances in the game window, thunder, wind, roof)
    and one **⚠ alert row** per active weather warning (Severe Thunderstorm Warning,
    Tornado Watch, Flood Advisory, …), de-duplicated across parks the warning covers;
  - **👁 observed transitions** — when the page itself sees a game flip to Delayed, resume,
    or get postponed between two polls it logs the moment (clearly labelled as seen by
    this browser, never as an official timestamp) and plays an optional chime;
  - a **written-reports inbox** of publisher headlines from 39 RSS feeds (MLB league,
    30 club feeds, ESPN, CBS Sports, Yahoo! Sports, Sports Illustrated, NBC Sports,
    The Athletic) plus the r/baseball community feed (Reddit, labelled **community —
    NOT official**), each flagged for delay/weather keywords and linked to the original
    article/post; entries are labeled MLB-official, independent or community, and the
    section shows the latest scheduled-scan run (status + link to the workflow run)
    as proof the scanner is alive. A **deterministic linker** (`assets/js/match.js`)
    attaches a `gamePk` when named team(s) uniquely identify one game on the selected
    slate (doubleheaders without a game-number cue, non-opponents and three-plus clubs
    abstain). Explicit restart / first-pitch announcement phrasing is quoted with the
    original evidence string; speculative wording ("hoping to", "around") is rejected;
  - a **manual-review panel** of discovery links: league accounts (@MLB, @MLB_PR),
    verified club X/Twitter handles for every team playing today, independent newsrooms,
    government weather sources (NWS radar, SPC outlook, ECCC warnings), and community
    outlets like r/baseball (clearly marked as community, not official).

  Delay and postponement rows are produced **only from official MLB status and advisory
  data** — a game that MLB has not officially delayed never appears as a delay row,
  whatever the forecast says. Weather forecasts are shown for **every** game, in the
  separate forecast-row category; a non-weather delay (power, injury, ceremony) still
  appears — it genuinely delayed the game — but is flagged `(non-weather)`, never hidden.
  **Expected start / restart times are never inferred** from the schedule, from forecast
  clearing, or from a reporter's speculation.
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
| `sparse-schedule` | the official schedule reports far fewer games for a date than its neighbours (observed live 2026-09-22: 3 games on 2026-09-21 vs 15 on both neighbours) — shown with the counts and a link to the date's schedule JSON |

### Social-media / news scanning (what is automated and what is not)

**Reddit is attempted on every scan.** It is the only platform named in the
project goals with a keyless public read path (`www.reddit.com/r/baseball/new.json`).
Anonymous requests from the build network answered HTTP 403 on 2026-09-22, so the
snapshot lists it as an unavailable source (with a link to the subreddit) instead of
skipping it — if the egress ever allows it, posts flow with no code change, labelled
*community (NOT official)*.

**X/Twitter, Facebook, Instagram, Threads and Bluesky are not scanned.** None of
them provides a keyless public read API (re-verified 2026-09-22); ingesting them
requires authorized credentials stored server-side. Never put API credentials in this
static site.

**Written reports are displayed on [the delay feed](delays.html).** The scanner
requests RSS feeds from MLB (league news + transactions + all 30 clubs), ESPN,
CBS Sports, Yahoo! Sports, Sports Illustrated, NBC Sports Hardball Talk and The
Athletic, plus the r/baseball community feed, every 15 minutes in GitHub Actions.
Deployment and upstream publishing latency mean this is not a real-time guarantee.
The Pages artifact includes `docs/news-report.json`; reports are not committed back
to main. The inbox refreshes once a minute, shows which words triggered each
headline, labels articles as MLB-official, independent or community, de-duplicates
URLs, flags old / future / dateless items, and displays per-source failures and
stale snapshots. It also shows the latest scheduled-scan run (status + link to the
workflow run) so a reviewer can see the scanner is alive. Independent outlets are
reporting context and community posts are fan discussion — neither is a team
announcement.

Headlines remain review candidates across all dates, **not verified game-specific
restart reports**. Deterministic team/opponent matching and explicit announcement
quotes are applied when the rules fire cleanly; ambiguous cases stay unlinked and
unquoted on purpose. The app explicitly says when a restart is not confirmed.
Scheduled first pitch, forecast clearing times and play-event end timestamps must
not be substituted for an announcement.

See [the current audit and next-session plan](docs/implementation-review.md).

## Project structure

```
index.html            Scoreboard (all games, weather strip + delay ticker)
delays.html           All-games Delay Feed (live delays, history, forecast, alerts, written reports)
game.html             Single game (delay panel, weather panel, sources)
about.html            About this project, sources, methodology and limitations
404.html              GitHub Pages fallback
assets/css/style.css  Stylesheet with weather/delay/report blocks
assets/js/api.js      StatsAPI client (retry, 429 self-throttle, cache, source-link helpers)
assets/js/weather.js  NWS → ECCC → Open-Meteo provider chain, alerts, risk rules
assets/js/delays.js   Status registry parsing, advisory timeline, box-score cross-checks, flags
assets/js/clubs.js    Club news + verified X/Twitter handles + independent & weather channel links
assets/js/reports.js  Written-reports renderer (safe, categorized, de-duplicated, game-linked)
assets/js/match.js    Deterministic headline↔game linker + explicit restart-time quotes
assets/js/scoreboard.js · delay-feed.js · game.js   Page controllers
assets/js/ui.js       DOM helpers, chips, logos
tools/fixtures/       Captured, verified API payloads (each has _source / _verified)
tools/*-test.mjs      Offline test suites (run in Node, no network) — 100+ passing assertions
tools/news-scan.mjs   News + community scanner (league + 30 clubs + 7 outlets + r/baseball) → snapshot
docs/verification.md  Line-by-line verification log with the URLs used
docs/verification.html  Same, rendered for the site footer
docs/implementation-review.md  Audit log and next-session plan
```

## Run it locally

Any static file server works — no installs required:

```bash
python3 -m http.server 8000      # or: npx serve .
```

Open <http://localhost:8000>. The offline, network-free checks:

```bash
for f in assets/js/*.js; do node --check "$f"; done
node tools/delays-test.mjs    # 32 — status registry, advisories, timeline, box score, cross-checks, transitions, sparse schedule
node tools/weather-test.mjs   # 25 — NWS / ECCC / Open-Meteo normalisation, alert classes, risk rules, provider chain
node tools/news-test.mjs      # 25 — RSS + Reddit social parsing, delay/weather vocabulary classification, feed config
node tools/match-test.mjs     # 18 — deterministic headline↔game linking, doubleheader abstention, restart-time quotes
node tools/render-test.mjs    #  9 — scoreboard + delay feed + game page + linked report cards against captured payloads
node tools/reports-test.mjs   #   — report URL safety, community category, dedup, stale/future/failed, game-link annotation
```

Run the news scan locally (needs outbound network — works in GitHub Actions):

```bash
node tools/news-scan.mjs --out docs/news-report.json
```

## Deploy to GitHub Pages

The site is static at <https://buffedlizard55-lab.github.io/MLBRainDelay/>.
`.github/workflows/news-scan.yml` builds and deploys Pages on main updates and every
15 minutes, using Pages artifacts with read-only repository permissions. Pages must
use the **GitHub Actions** build type. No bot pushes to main are required. The build
runs all offline tests before scanning. A failed individual feed is published as an
explicit source-health warning; a failed deployment leaves the previous snapshot,
which the UI flags after 45 minutes. GitHub scheduled jobs can be delayed or disabled;
this is not a continuous monitoring service.

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

See the [About page](about.html#limitations) and
[`docs/implementation-review.md`](docs/implementation-review.md) for the full list. In short:

- **Partial social-media ingestion.** Reddit (r/baseball) is the only named platform with a
  keyless public read path and is attempted on every scan, but anonymous access from the build
  network answered HTTP 403 on 2026-09-22, so it is reported as an unavailable source (with a link
  to the subreddit) rather than skipped. X/Twitter, Facebook, Instagram, Threads and Bluesky have
  no keyless public read API (re-verified 2026-09-22) and are linked as discovery links for manual
  review, not read automatically.
- **The published snapshot needs a one-time admin switch.** The repo's GitHub Pages is still on
  legacy branch publishing, so the workflow-built snapshot (written reports) is not served publicly.
  The workflow cannot switch Pages mode itself (admin-only). Enable
  **Settings → Pages → Build and deployment → Source: GitHub Actions**; until then the Delay Feed
  shows the latest scan run's status with a link to the run and prints the exact steps.
- **Restart times are quoted, never invented.** Explicit announcement phrasing is
  extracted with evidence; speculative estimates and forecast-clearing times are
  rejected. Expected start / restart is never inferred from scheduled first pitch.
- **RSS scanning is ~15-minute scheduled, not real-time.** GitHub Actions scheduling and
  Pages publishing add latency; this is not a continuous monitoring service.
- **Some venues have no government forecast coverage** (e.g., London, Mexico City, Tokyo)
  and fall back to Open-Meteo model data, flagged as non-government.
- **Browser CORS for the ECCC (Canada) endpoint could not be exercised from the build
  sandbox;** Rogers Centre falls back to Open-Meteo (flagged) if the ECCC request fails.
- **Headlines are not matched to specific games** — they are review candidates, not
  confirmed restart announcements.

The social/headline layer is a "flag for review" aid — **never** an assertion that a
delay happened.

## License

MIT — see [LICENSE](LICENSE).
