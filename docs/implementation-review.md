# Current implementation audit — 2026-09-22 (fifth session)

## Outcome and scope

Expanded the written-reports layer with two deterministic, evidence-preserving
features that were the next items on the prior session's plan:

1. **Game-linked headlines** (`assets/js/match.js`) — a pure linker that attaches
   a `gamePk` only when named team(s) uniquely identify one game on the selected
   slate. Doubleheaders without an explicit game-number cue, non-opponents, and
   three-or-more clubs abstain (left unlinked on purpose). Matched phrases are
   retained as evidence.
2. **Explicit restart / first-pitch quotes** — only announcement phrasing
   ("restart at 8:35 p.m. ET", "first pitch now set for 7:10pm", "targeting an
   8:30 restart") is extracted, with the matched substring kept verbatim.
   Speculative wording ("hoping to", "could resume", "around") is rejected;
   12-hour clocks without a.m./p.m. leave `hour24` null so nothing is invented.
   Times are not converted across zones and are never treated as official MLB
   status.

Wired into the Delay Feed: once today's slate loads, `Reports.setGames(games)`
re-renders the inbox so linked cards and quoted times appear without waiting for
the next 60-second refresh. Cards that stay unmatched keep the previous
"review candidate only" wording.

## What changed in code this session

1. `assets/js/match.js` — new pure module: alias index, team finder (longest
   phrase first, possessive-safe), `matchItem`, `extractAnnouncedTimes`,
   `annotate`. No network, no DOM.
2. `assets/js/reports.js` — `prepare(report, now, games)` annotates when a slate
   is provided; `render` shows Linked game / Quoted time blocks with evidence;
   `setGames(games)` re-renders the last snapshot.
3. `assets/js/delay-feed.js` — hands the loaded slate to `Reports.setGames`.
4. `delays.html` — loads `match.js`; written-reports blurb documents the linker.
5. `assets/css/style.css` — `.report-game-match*`, `.report-eta*` styles.
6. `about.html` / `README.md` — sources, limitations and next-steps updated to
   match the new behaviour (no claim of full social ingestion or invented ETAs).
7. Tests: `tools/match-test.mjs` (18), reports-test annotation cases, render-test
   linked-card + doubleheader-abstain case; smoke workflow runs match-test.

## Three-pass verification (this session)

- **Pass 1 (implement):** match module + reports/delay-feed wiring + docs; offline
  suites green (delays 32, weather 25, news 25, match 18, render 9, reports pass);
  all browser scripts pass `node --check`.
- **Pass 2 (adversarial review):** possessive team names (`Yankees' rain delay`);
  bare ambiguous tokens (`sox`, `LA`) refused; 12h clock without am/pm keeps
  `hour24` null; hours 13–23 without am/pm accepted as 24h; speculative windows
  rejected; doubleheader without game number abstains; input arrays not mutated
  by `annotate`.
- **Pass 3 (requirements re-check):** game linking and ETA quotes map to the
  prior "remaining work" items 4–5 without credentials; still no invented times;
  ambiguous headlines stay unlinked; docs no longer claim "no matching at all".

## Requirements → implementation map (re-checked 2026-09-22)

| Requirement | Status | Evidence |
| --- | --- | --- |
| Written reports in chat format for every delayed game | ✅ | `delays.html` feed rows (active-first, newest-first) |
| Which games are delayed + expected start times from official sources | ✅ (expected start explicitly "not confirmed" until an official source says otherwise; publisher quotes shown only with evidence) | Active strip + quoted-time cards + per-game official links |
| Weather integrated for every game | ✅ | NWS/ECCC/Open-Meteo chain per game |
| Scan social media + news orgs | ⚠️ Partial (verified boundary) | 39 RSS + Reddit attempt; X/FB/IG/Threads/Bluesky credential-blocked |
| Line-by-line from verified sources with links | ✅ | Every row ends in Verify; match evidence strings are the matched phrases |
| Flag irregularities; no hallucinations | ✅ | Prior flags + linker abstains rather than guessing |
| Game-linked announcements | ✅ Deterministic subset | `match.js` unique team/opponent + game-number cues; abstains otherwise |
| Restart-time extraction | ✅ Explicit quotes only | `extractAnnouncedTimes`; speculative rejected |
| PR created and merged to main | ✅ (this branch) | — |

## Remaining work — prioritized for the next session

1. **Repository owner: enable GitHub Actions as the Pages source**
   (Settings → Pages → Build and deployment → Source: GitHub Actions).
2. **Authorized social adapters** (X/Twitter, Facebook/Instagram; optional
   authenticated Reddit if 403 persists) — credentials only in Actions secrets.
3. **ETA revision history** — track "now targeting 8:50" updates per gamePk with
   quoted evidence over time.
4. **Conflict flags** when two publishers disagree on the same gamePk / time.
5. **Persistent history** beyond browser localStorage.
6. **Browser/accessibility acceptance** (mobile, keyboard, screen readers, real
   CORS for ECCC, upstream outage behaviour).

## Limitations (still true, 2026-09-22)

- Social: only Reddit has a keyless public read path, and it is currently 403 from
  the build network; X/FB/IG/Threads/Bluesky need credentials.
- The 15-minute Actions schedule is not real-time; Pages publishing adds latency.
- The published snapshot is not deployed until the one-time admin Pages switch.
- International venues fall back to Open-Meteo (flagged); ECCC browser CORS is
  still a user-side check.
- Ambiguous headlines stay unlinked; speculative ETAs stay unquoted.
- The offline test suite uses captured fixtures; it does not exercise live
  network, real CORS headers, or real-browser end-to-end rendering.

---

# Previous audit — 2026-09-22 (fourth session)

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
7. `assets/js/style.css` — `.report-cat-community`, `.sparse-note`,
   `.scan-status-line`.
8. Cleanup: removed stale `docs/workflows/` template copies (the live workflows
   in `.github/workflows/` are the source of truth); smoke workflow header fixed;
   `.gitignore` for local scan output.
9. Tests: +4 (sparse schedule), +9 (Reddit/social incl. permalink policy), +5
   (report URL safety / community label), +2 (sub-hour box score delay note);
   `AbortSignal` added to the render-test DOM shim.
10. `assets/js/delays.js` — `parseBoxscoreInfo` now parses MLB's sub-hour delay
    note form `:47 delay` (minutes only) as well as `3:50 delay`. Caught in
    Pass 3 from the live site: 824787's box score `T: "2:30 (:47 delay)."`
    (official `delayDurationMinutes` 47) raised a spurious
    `boxscore-note-unparsed` flag.

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
  and to today's live verification (see matrix below); re-fetched the deployed
  site, which surfaced the sub-hour box score delay-note gap (824787,
  `:47 delay`) — fixed in `parseBoxscoreInfo` with 2 regression tests;
  docs updated (README, about.html, verification.md §11 + regenerated
  verification.html); final suites: delays 32, weather 25, news 25, render 8,
  reports pass; no fabricated fields or times introduced anywhere.

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

See git history for the full third-session write-up (expanded RSS, About page,
verified club X handles, chat-style feed readability, workflow artifact checks).
