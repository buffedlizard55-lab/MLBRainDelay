# Current implementation audit — 2026-09-21

## Outcome and scope

This is a useful **partial implementation**, not exhaustive social monitoring.
No claim is made that every report, every delayed game worldwide, or every announced
restart time is captured. The date-selected MLB schedule is the game inventory.
News is a separate publisher inbox across all dates, not evidence of a specific
current game's restart. No language model generates game facts.

## Three passes

1. **Implement:** reviewed the existing browser/API/weather/delay code, tests and
   workflows. Added source-linked written-report cards, attribution, publication
   timestamps, automatic refresh, snapshot health, duplicate suppression and an
   artifact-based 15-minute scan / Pages workflow. Added explicit unknown restart
   messaging. Preserved the existing status / forecast / alert / postponed filters.
2. **Adversarial review:** fixed RSS timezone handling (EST was treated as GMT),
   invalid numeric entity crashes, HTML-as-successful-RSS responses, noisy word
   matching, hidden-tab zero-delay polling loops, and inaccurate forecast counts.
   Added malicious URL, stale/future snapshot, failed-feed, empty snapshot and DOM
   rendering tests. Raw report text is rendered with textContent, never innerHTML.
3. **Requirements re-check:** clarified independent versus official publishers,
   date scope, unverified reporter identities and unimplemented social access.
   Removed broad current claims about all other public sources being inaccessible.
   Fixed missing/out-of-range venue coordinate handling and a resume-date display
   that could render an absent destination. Checked Pages settings and deployment
   authorization; documented the blocking permission rather than claiming deployment.

## Evidence ledger (field-by-field boundaries)

| Displayed information | Evidence | Unknown / failure policy |
| --- | --- | --- |
| Teams, date, status, reason | MLB schedule payload, linked per game | Fetch failure banner; no inferred delay |
| Historical delay segments / durations | MLB play-by-play and boxscore | Differences flagged, not silently reconciled |
| Makeup / resume destination | MLB reschedule/resume fields | No destination invented |
| Expected restart | Not reliably extracted by this implementation | Explicitly not confirmed; scheduled time is not an ETA |
| Weather risk | NWS/ECCC forecasts at MLB venue coordinates; labeled Open-Meteo fallback | Forecast is not an actual delay; missing coverage flagged |
| Written headline / author / publication date | Publisher RSS fields | Author/time may be unknown; older/future reports flagged |
| Article link | HTTPS MLB/ESPN hostname allowlist | Missing/off-list links excluded with a warning |
| Game association for written reports | Not implemented | Reports explicitly not matched; no team/date guess |
| Social account verification | Not implemented | No badge/account identity claimed as verified |

## Verification performed this session

- All browser scripts syntax-checked. Offline tests cover parser, weather, rendering
  and report handling. Fixtures include synthetic cases; these are **not live evidence**.
- Direct Node scan of all 32 configured feeds: **0 succeeded, 32 connection failures**
  from this sandbox. A zero-headline result here cannot establish absence of delays.
- Separate page-fetch service successfully returned content from:
  - [MLB league RSS](https://www.mlb.com/feeds/news/rss.xml).
  - [MLB September 21 schedule](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-09-21).
  - [NWS Baltimore point](https://api.weather.gov/points/39.2838,-76.6217), including an hourly forecast endpoint.
  These spot checks do not verify all club feeds, browser CORS, or source completeness.
- GitHub Pages API reported the existing site built at
  <https://buffedlizard55-lab.github.io/MLBRainDelay/> using `main` / root, legacy mode.
- Changing Pages to Actions returned **403 Resource not accessible by integration**.
  The workflow first attempts the authorized mode change with its own `pages:write`
  token. If that fails, it uploads the report artifact and warns instead of attempting
  an invalid deployment. Existing branch publishing is not disabled.
  Until authorized settings are changed, the new automated report artifact cannot
  reach the public inbox; the inbox will explicitly show unavailable reports.
- Browser visual / real-network end-to-end verification is not established by the
  Node DOM-shim tests. No blanket “line-by-line verified from official sources” claim
  is warranted for the whole historical repository.

## Next session — prioritized remaining work

1. **Deployment permission:** enable GitHub Actions as the Pages source through an
   authorized repository administration connection, then confirm the scan and public
   `docs/news-report.json`. Do not mark the feature live until those checks pass.
2. **Authorized source adapters:** select platform-supported X, Meta and Reddit access
   and confirm licensing, quotas and retention. Store credentials only server-side.
   Discover team accounts via team-owned websites; verify reporter identities via
   employers. Reddit/community posts must remain leads, not official confirmations.
3. **Game-linked announcements:** store immutable source excerpts, canonical URL,
   publisher identity, publication/retrieval times and exact team/game/date identifiers.
   Handle doubleheaders, local time zones, midnight rollover, revised estimates,
   deleted posts and conflicting announcements. Abstain on ambiguous matches.
4. **ETA extraction and reconciliation:** use only explicit announcement text; retain
   quoted evidence, original timezone and revision history. Never predict from weather.
   Add fixture-driven tests for each provider and conflict rule before promotion.
5. **Always-on ingestion:** use a durable scheduler / database for push-like freshness
   and history. Actions schedules can be delayed and disabled; browser status history
   exists only while a page is open. Add monitoring for failures and stale deployments.
6. **Browser and accessibility acceptance:** test mobile layouts, keyboard/screen-reader
   flows, CORS at US/Canadian/international parks, timezone behavior, and upstream outages
   using a real browser. Add integration coverage without making CI depend on live APIs.

The existing static site needs no manually entered game updates. Manual source links
are for verification, not data entry. Fully automatic, trusted social-report coverage
and comprehensive restart ETAs remain unmet requirements, not completed features.

## GitHub follow-through

PR #5 merged after local verification; its GitHub test job passed. The first main
report build also passed but deployment was correctly skipped in legacy mode.
A follow-up tries the same Pages mode change with the workflow's explicitly granted
`pages:write` token, without changing repository branches or bypassing authorization.
The scan now emits a workflow warning if any feed is unavailable. Log/artifact
retrieval through the sandbox failed with connection errors, so successful job
completion alone is not treated as proof that all feeds succeeded.
