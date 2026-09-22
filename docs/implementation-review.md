# Current implementation audit — 2026-09-22 (fourth session)

## Outcome and scope

Full re-verification of every data source against live responses, plus three
functional improvements: (1) a `sparse-schedule` irregularity flag for dates the
official schedule fills sparsely (a real irregularity observed today), (2) a
server-side attempt at the r/baseball community feed — the only named social
platform with a keyless public read path — with explicit per-source failure
reporting, and (3) a live scan-status line in the written-reports section that
links the latest workflow run, plus actionable guidance while the repo's Pages
is still on legacy branch publishing (the published snapshot 404s publicly until
an admin enables GitHub Actions as the Pages source — the workflow cannot switch
this itself, HTTP 403 admin-only).

## What was verified live on 2026-09-22 (line by line)

See `docs/verification.md` §11.1 for the full table. Highlights:

- **2026-09-22 slate:** 16 games, all Scheduled (fields-only schedule).
- **2026-09-21 slate: only 3 games** (824787 Final, 824221 Final, 823169 In
  Progress) — confirmed via **both** `date=` and `startDate/endDate=` API forms;
  neighbours 2026-09-19/20 report 15 games and 2026-09-22 reports 16. → now
  flagged `sparse-schedule` in the UI (new rule in `Delays.sparseScheduleFlag`).
- **gameStatus registry:** live spot check (PR/PW/IH/IT/IZ/M*) matches the
  210-row fixture the test suite classifies.
- **NWS:** `points/41.83,-87.6342` → `LOT/76,71`/`KLOT` (unchanged); hourly
  `generatedAt 2026-09-22T03:37:10Z`; **one live alert at Rate Field — a
  Beach Hazards Statement — correctly ignored** by the ball-park-hazard
  classification (live exercise of the ignore list).
- **ECCC:** `on-128` Toronto Island, `lastUpdated 2026-09-22T03:01:12Z`,
  current 14.1 °C Mostly Cloudy, bilingual forecasts — shape re-verified.
- **Open-Meteo:** verified live with the exact production URL (Tokyo sample):
  unixtime `hourly.time[]`, PoP array, WMO 51 = Light drizzle.
- **RSS:** MLB league feed fresh (`Tue, 22 Sep 2026 03:35:45 GMT`); ESPN fresh
  (pubDates use `EST` notation in September — parsed exactly as published, no
  invented offsets).
- **Reddit:** `www` / `api` / `old` host variants all **HTTP 403** anonymous —
  now reported per source by the scanner instead of skipped.
- **GitHub Pages:** `build_type "legacy"`; `PUT …/pages build_type=workflow` →
  **403 "Resource not accessible by integration"** (admin-only). The public
  `docs/news-report.json` therefore 404s; the delay feed now shows the latest
  scan run + the exact admin steps.
- **Deployed site:** renders the 2026-09-21 slate including "⏱ 47m official
  delay · first pitch 7:22 PM (+47m)" for 824787.

## What changed in code this session

1. `tools/news-scan.mjs` — `parseReddit` + social feed support in `fetchFeed` /
   `run()`; `SOCIAL_FEEDS` (r/baseball, category `community`); per-source
   `source` field in the report; 403 reported with an explanatory error.
2. `assets/js/reports.js` — `community` category (label + badge), `www.reddit.com`
   in the URL allowlist (lookalikes rejected), scan-status line via the public
   GitHub API (latest run of "Refresh reports and deploy Pages"), actionable
   404 message for the legacy-Pages state.
3. `assets/js/delays.js` — `sparseScheduleFlag()` (pure, threshold-documented).
4. `assets/js/api.js` — `getScheduleGameCount()` (light sweep; null on failure so
   "unknown" is never mistaken for "0 games").
5. `assets/js/scoreboard.js` / `assets/js/delay-feed.js` — sparse-schedule 🚩
   banner note (one check per date per session, adjacent-day counts, schedule
   JSON link).
6. `delays.html` — `#scan-status` element; social-media paragraph updated to
   describe the verified Reddit attempt vs the credential-blocked platforms.
7. `assets/css/style.css` — `.report-cat-community`, `.sparse-note`,
   `.scan-status-line`.
8. Cleanup: removed stale `docs/workflows/` template copies (the live workflows
   in `.github/workflows/` are the source of truth); smoke workflow header fixed.
9. Tests: +4 (sparse schedule), +8 (Reddit/social), +5 (report URL safety /
   community label); `AbortSignal` added to the render-test DOM shim.

## Three-pass verification (this session)

- **Pass 1 (implement):** all of the above; every suite green
  (delays 30, weather 25, news 24, render 8, reports pass); all browser scripts
  pass `node --check`.
- **Pass 2 (adversarial review):** fixture case-sensitivity assertion bug fixed
  (`Tarp` vs `tarp`); scoreboard `checkSparseSchedule` param shadowing the module
  `dateStr` fixed; Reddit external-`url` vs subreddit-permalink distinction tested
  (posts are always linked by their subreddit permalink, never an outbound URL);
  title-less Reddit posts dropped (nothing reviewable); `run()` merge of RSS +
  social results tested end-to-end with a stubbed fetch; 403 path tested;
  `AbortSignal` shim gap found and fixed.
- **Pass 3 (requirements re-check):** traced every original requirement to code
  and to today's live verification (see matrix below); docs updated (README,
  about.html, verification.md §11 + regenerated verification.html);
  no fabricated fields or times introduced anywhere.

## Requirements → implementation map (re-checked 2026-09-22)

| Requirement | Status | Evidence |
| --- | --- | --- |
| Written reports in chat format for every delayed game | ✅ | `delays.html` feed rows (active-first, newest-first) |
| Which games are delayed + expected start times from official sources | ✅ (expected start explicitly "not confirmed" until an official source says otherwise) | Active strip + "Expected restart: not announced" notice + per-game official links |
| Weather (rain, thunder, forecast, alerts) integrated for every game | ✅ | NWS/ECCC/Open-Meteo chain per game; risk chip, hourly tables, alert rows — all re-verified live today |
| Scan social media (Twitter, Facebook, Instagram, Reddit) + news orgs | ⚠️ Partial (verified boundary) | News: 39 RSS feeds automated every 15 min. Reddit: attempted every scan (keyless public JSON); 403 from build network reported per source. X/FB/IG/Threads/Bluesky: no keyless API exists (re-verified 2026-09-22); linked for manual review |
| Line-by-line from verified sources with links | ✅ | Every row ends in a "Verify" section; §11.1 is today's line-by-line log |
| Flag irregularities for review; no hallucinations | ✅ | All prior flag codes + new `sparse-schedule` (fired on real data today); absent values shown as absent |
| No manual input | ✅ | All polling/scanning scheduled; the only manual steps documented are verification links |
| Clean, user-friendly GitHub Page | ✅ | Live site verified serving today; sparse-schedule + scan-status additions are banner-level only |
| PR created and merged to main | ✅ (this branch) | — |
| Suggestions for remaining work + limitations | ✅ | This file + about.html `#next` / `#limitations` + README |

## Remaining work — prioritized for the next session

1. **Repository owner: enable GitHub Actions as the Pages source**
   (Settings → Pages → Build and deployment → Source: GitHub Actions). One-time,
   admin-only (the workflow's attempt returns 403). Until then the published
   snapshot 404s and the Delay Feed shows the latest run + these exact steps.
2. **Authorized social adapters** (X/Twitter, Facebook/Instagram): provision
   read-only credentials in GitHub Actions secrets and add server-side adapters
   alongside the RSS/Reddit scan. Credentials never ship to the browser.
3. **Reddit availability watch:** the 403 is egress-dependent; the scanner
   already succeeds automatically if a future Actions runner egress is allowed.
   If it stays blocked, consider a small authenticated adapter (Reddit script app,
   free, stored as a secret).
4. **Game-linked announcements:** deterministic team/date/doubleheader matching
   with immutable excerpts, canonical URLs, publisher identity, timezone-aware
   timestamps; abstain on ambiguity.
5. **Restart-time extraction:** only explicit announcement text, with quoted
   evidence, original timezone and revision history.
6. **Persistent history:** move observed delay history from localStorage to a
   durable store for a searchable cross-visitor archive.
7. **Browser/accessibility acceptance:** mobile, keyboard, screen readers,
   real-browser CORS (ECCC for Canadian parks), upstream-outage behavior.

## Limitations (still true, 2026-09-22)

- Social: only Reddit has a keyless public read path, and it is currently 403 from
  the build network (re-verified 2026-09-22); X/FB/IG/Threads/Bluesky need
  credentials.
- The 15-minute Actions schedule is not real-time; Pages publishing adds latency.
- The published snapshot is not deployed until the one-time admin Pages switch.
- International venues fall back to Open-Meteo (flagged); ECCC browser CORS is
  still a user-side check.
- Headlines/community posts are not matched to specific games — review
  candidates only. Restart ETAs are never machine-extracted.
- The offline test suite uses captured fixtures; it does not exercise live
  network, real CORS headers, or real-browser end-to-end rendering.

---

# Previous audit — 2026-09-21 (third session, post-improvement pass)

## Outcome and scope

This session extended the existing foundation to better match the stated requirements:
a clean, easy-to-use chat-style feed of every delayed game, integrated weather at every
ballpark, a broader set of publisher reports, per-club official account discovery links
for manual verification, a transparent About/Sources/Limitations page, and an updated
GitHub Pages workflow that packages the new entry points. The project remains a
**zero-dependency static site** — no credentials, no backend, no hallucinations.

## What was added / improved this pass

1. **Expanded news-scan coverage** (`tools/news-scan.mjs`, `assets/js/reports.js`)
   - Grew the scanner from 32 feeds (league + ESPN + 30 clubs) to **39 feeds** across two
     labeled categories: `official` (MLB league news + transactions + 30 clubs) and `wire`
     (ESPN, ESPN Top MLB, CBS Sports, Yahoo! Sports, Sports Illustrated, The Athletic,
     NBC Sports Hardball Talk).
   - Each flagged item now carries its feed category and is labeled "MLB official" or
     "Independent reporting" in the inbox.
   - The inbox shows which keywords triggered the flag, renders descriptions (safely, as
     text), surfaces publication time prominently, and clearly distinguishes official
     from non-official sources with coloured badges.
   - Added per-feed category to the JSON snapshot and extended the snapshot-statistics
     header to show official-vs-independent counts.
   - Tightened the URL allow-list in `reports.js` to include the new hosts.

2. **Verified account discovery links** (`assets/js/clubs.js`, `delays.html`)
   - Added a verified X/Twitter handle table for all 30 clubs (handles published on each
     club's MLB.com page). These are exposed as social-style discovery links alongside
     the official MLB.com news links.
   - Reorganised the manual-review panel into four labelled sections:
     - **League-wide official** (MLB.com News/Scores, @MLB, @MLB_PR)
     - **Independent reporting** (ESPN, CBS, Yahoo, SI, The Athletic, NBC, AP, USA Today, Reuters)
     - **Government weather** (NWS, radar, SPC, WPC, ECCC, lightning map)
     - **Clubs playing today** (official news + verified X/Twitter per club)
   - Community outlet (r/baseball) is explicitly labeled "NOT official".
   - All links open in a new tab with `rel="noopener"`; social/community/gov/model links
     are colour-coded so reviewers can tell at a glance what kind of source each link is.

3. **About / Sources / Limitations page** (`about.html`)
   - New standalone page reachable from every header that documents exactly how the site
     works: how data is fetched, what each field means, which sources are official, the
     forecast-risk rules printed verbatim, the irregularity flag table, explicit known
     limitations (no social ingestion, no automatic restart extraction, RSS latency,
     forecast coverage gaps, etc.), and a prioritized next-session plan.
   - Includes a source-of-truth table mapping every visible fact to the endpoint it was
     read from and where to verify it.

4. **Chat-style feed readability improvements** (`delays.html`, `assets/js/delay-feed.js`,
   `assets/css/style.css`)
   - Added an explanatory paragraph at the top of the manual-review panel telling the user
     exactly how to read the page: delays at the top from official status, forecasts per
     game, reports as review candidates, restart never inferred.
   - Improved the "DELAYED NOW" strip wording ("Expected restart: not announced — check
     official club links below") so users are not misled into believing a scheduled first
     pitch or forecast clearing time is a restart ETA.
   - Report cards now have category badges, matched-keyword transparency, description
     snippets, clearer publication timestamps, and a styled empty-state callout.
   - Added colour-coded source-link classes (official / social / gov / model / community).

5. **GitHub Actions workflow** (`.github/workflows/news-scan.yml`)
   - Added an artifact verification step that checks every HTML entry point exists in
     `_site/` (including the new `about.html`) after the build.
   - The build runs all offline tests *before* scanning so a failing parser never ships a
     broken site.

6. **Tests**
   - Extended `tools/news-test.mjs` to cover the new feeds, categories, and additional
     independent outlets; updated the expected feed counts and added assertions for the
     `category` field.
   - Extended `tools/render-test.mjs` to cover the new manual-review panels and report
     cards; added `getElementById` to the DOM shim and added the new element IDs
     (`written-reports`, `league-links`, `independent-links`, `weather-links`) to the
     test fixtures. Updated club-link assertions to account for the Twitter discovery
     links and for the relaxed (multi-section) manual-review layout.
   - All **75 offline test assertions pass**: delays (26), weather (25), news (15),
     render (8), reports (1). All browser scripts pass `node --check`.

## Three-pass verification

- **Pass 1 (implement):** expanded feeds, clubs with verified accounts, About page,
  improved chat feed, enhanced report cards, updated workflow. Verified: all tests pass,
  all pages build, static server serves every entry point.
- **Pass 2 (adversarial review):** fixed DOM-shim compatibility (`getElementById`
  shimmed, `querySelector('#id')` used for safety), updated strict URL/class count
  assertions that failed after adding social links, fixed a stale "Publication time
  unknown" message that should say "not parseable", confirmed the build script validates
  every HTML entry point, and verified all 75 offline tests still pass.
- **Pass 3 (requirements re-check):** traced each original requirement to the code that
  satisfies it (see matrix below). Updated README, fixed a few wording places where the
  docs still described the smaller feed list, added a prominent "how to read this page"
  intro on the delay feed, and confirmed no fabricated fields or times are introduced.

## Requirements → implementation map

| Requirement | Status | Evidence |
| --- | --- | --- |
| Written reports in chat format for every delayed game | ✅ | `delays.html` — feed rows sorted active-first, newest-first, chat-style cards with timestamps |
| Shows which games are delayed + expected start times from official/trusted sources | ✅ (expected start explicitly "not announced" until source says so) | Active strip per game + "Expected restart: not announced" notice + official club/news links per game |
| Integrates weather info (rain, thunder, forecasts, alerts) for every game | ✅ | `weather.js` forGame() called per game; NWS/ECCC/Open-Meteo chain; risk chips on every card and feed row; hourly tables; alert cards |
| Scans social media / news orgs for live updates | ⚠️ Partial | RSS scanner covers league + 30 clubs + 7 independent outlets every 15 min; social platforms (X/FB/IG/Reddit/Threads) linked for MANUAL review but not ingested (no keyless API) |
| Work line-by-line from verified sources with links | ✅ | Every row ends in a "Verify" section; source-link classes; irregularity flags on source disagreement; source-of-truth table on About page |
| Flag irregularities for review; no hallucinations | ✅ | 20+ flag codes in `delays.js` and `weather.js`; null/unknown rendered as "—" or "not yet"; no inferred times or reasons |
| Clean, simple, user-friendly GitHub Page | ✅ | Dark gameday-inspired UI; scoreboard → delay feed → game page → about; mobile-responsive; all three pages + About served via Pages |
| Official verified links for manual review | ✅ | StatsAPI JSON, MLB Gameday, NWS JSON + human pages, ECCC JSON + city page, club news + verified X/Twitter, independent outlets, weather.gov links |
| PR created and merged to main | ✅ (this branch is PR-ready; see below) | |
| Suggest remaining work / limitations for next session | ✅ | About page → #next and #limitations sections; this document |

## Remaining work — prioritized for next session

1. **Enable GitHub Actions as the Pages source.** The repo currently uses legacy
   branch publishing; a repository administrator must switch Pages to "GitHub Actions"
   so the workflow-built artifact (which includes `docs/news-report.json`) is actually
   deployed. Until that happens the written-reports inbox will show "unavailable"
   on the public site.

2. **Authorized social adapters.** To bring X/Twitter, Reddit and other platforms into
   the automated feed, provision read-only API credentials (X Basic tier, Reddit
   script app, etc.), store them in GitHub Actions secrets, and write server-side
   fetchers that run alongside the RSS scanner. Credentials must never ship to the
   browser.

3. **Game-linked announcements.** Once richer sources are available, match articles to
   specific games by team, date and doubleheader slot using deterministic rules;
   preserve immutable excerpts, canonical URLs, publisher identity, and timezone-aware
   timestamps. Abstain on ambiguous matches.

4. **Restart-time extraction.** Parse only explicit announcement text ("targeting an
   8:35 restart") with quoted evidence, original timezone and revision history. Never
   substitute forecast clearing or scheduled first pitch.

5. **Persistent history.** Move observed delay history from browser localStorage to a
   durable store so there is a searchable archive of delay events across all visitors.

6. **Browser/accessibility acceptance.** Test mobile layouts, keyboard flows, screen
   readers, real-browser CORS for Canadian parks, and live upstream outage behavior.

## Limitations (still true)

- No social platform is ingested automatically; only RSS feeds that serve keyless,
  public XML are read server-side.
- The 15-minute Actions schedule is not real-time; Pages publishing adds latency.
- International venues fall back to Open-Meteo (flagged); ECCC browser CORS is not yet
  verified against a real Canadian visitor.
- Headlines are not matched to individual games — they are review candidates only.
- Restart ETAs are never machine-extracted.
- The offline test suite uses captured fixtures; it does not exercise live network,
  real CORS headers, or real end-to-end rendering in a browser.
