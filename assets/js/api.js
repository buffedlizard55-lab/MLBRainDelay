/* ============================================================================
 * api.js — MLB StatsAPI client (weather + delay edition)
 * ----------------------------------------------------------------------------
 * Wraps the same public, keyless, open-CORS JSON API that powers mlb.com
 * Gameday. Every endpoint and every hydration used here was verified live
 * against statsapi.mlb.com (dates noted per function) — see
 * docs/verification.md for the exact URLs and captured shapes.
 *
 *   GET /api/v1/schedule?sportId=1&date=YYYY-MM-DD
 *       &hydrate=team,linescore,weather,venue(location,timezone,fieldInfo),
 *                gameInfo,probablePitcher,decisions
 *       -> games for a date incl. official game weather, venue coordinates +
 *          roof type, official delay minutes, reschedule fields
 *   GET /api/v1/schedule?sportId=1&date=…&fields=…      -> tiny status sweep
 *   GET /api/v1/game/{pk}/playByPlay?fields=…            -> status-change
 *                                                          advisories timeline
 *   GET /api/v1/game/{pk}/boxscore?fields=info,label,value
 *                                                       -> official box-score
 *                                                          notes ("Weather",
 *                                                          "T: 2:50 (3:50 delay)")
 *   GET /api/v1/gameStatus                               -> status registry
 * ==========================================================================*/
'use strict';

const MLB = (() => {
  const V1  = 'https://statsapi.mlb.com/api/v1';
  const V11 = 'https://statsapi.mlb.com/api/v1.1';
  const SPORT_ID = 1; // Major League Baseball

  const LOGO_CDN = 'https://www.mlbstatic.com/team-logos';

  /* ------------------------------------------------------------------ utils */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ------------------------------------------------------------------ rate
   * The StatsAPI publishes no rate limit and needs no key, but it CAN answer
   * HTTP 429. After ANY 429 every request funneled through getJSON() waits
   * out the remainder of a 60s quiet period before issuing its next request.
   * The flag is process-wide (one host, one budget).
   */
  const RATE_LIMIT_BACKOFF_MS = 60 * 1000;
  let lastRateLimitedAt = 0;

  function rateLimitedForMs() {
    return lastRateLimitedAt
      ? Math.max(0, lastRateLimitedAt + RATE_LIMIT_BACKOFF_MS - Date.now())
      : 0;
  }

  /**
   * Fetch JSON with a timeout + simple exponential retry.
   * `headers` defaults to a CORS-safelisted Accept header only — never add
   * custom headers here: they force a preflight that public APIs may reject.
   */
  async function getJSON(url, {
    timeout = 8000, retries = 1, signal, cache = 'no-store',
    accept = 'application/json', rateLimitShared = true,
  } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const quiet = rateLimitShared ? rateLimitedForMs() : 0;
      if (quiet > 0) await sleep(quiet);
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => ctrl.abort(), timeout);
      try {
        // `accept: null` sends NO Accept header at all (the browser default
        // `*/*`) — api.weather.gov negotiates on Accept and must not receive
        // the string "null".
        const init = { signal: ctrl.signal, cache };
        if (accept) init.headers = { Accept: accept };
        const res = await fetch(url, init);
        if (!res.ok) {
          if (res.status === 429 && rateLimitShared) lastRateLimitedAt = Date.now();
          const err = new Error(`HTTP ${res.status} for ${url}`);
          err.status = res.status;
          // Keep the body when it is a JSON problem document (NWS 404s carry
          // a machine-readable `type`, e.g. …/problems/InvalidPoint).
          try { err.body = await res.json(); } catch (_) { /* not JSON */ }
          throw err;
        }
        return await res.json();
      } catch (err) {
        lastErr = err;
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
      if (signal && signal.aborted) throw lastErr;
      // 4xx answers are deterministic — retrying them only adds load.
      if (lastErr && lastErr.status && lastErr.status >= 400 && lastErr.status < 500 && lastErr.status !== 429) {
        throw lastErr;
      }
      if (attempt < retries) await sleep(400 * (2 ** attempt));
    }
    throw lastErr;
  }

  /* ------------------------------------------------------------- endpoints */

  /**
   * Hydrated schedule for one calendar date.
   *
   * Verified live (statsapi.mlb.com, 2026-09-21, gamePk 824381):
   *   hydrate=weather,venue(location,timezone,fieldInfo),linescore,gameInfo,team
   * returns per game
   *   weather:  { condition, temp, wind }          — strings; `{}` before
   *                                                  first pitch; "Dome" /
   *                                                  "Roof Closed" for covered parks
   *   venue:    { id, name, location: { city, stateAbbrev,
   *                 defaultCoordinates: { latitude, longitude } },
   *               timeZone: { id }, fieldInfo: { roofType } }
   *   gameInfo: { firstPitch, gameDurationMinutes, delayDurationMinutes?, attendance }
   *   status:   { abstractGameState, codedGameState, detailedState, statusCode, reason? }
   *   rescheduleDate / rescheduleGameDate      (on a postponed game's original date)
   *   rescheduledFrom / rescheduledFromDate    (on the makeup-date entry)
   *   resumeDate / resumedFrom                 (suspended games; documented by
   *                                             the API, handled if present)
   * probablePitcher + decisions are the reference scoreboard's hydrations.
   */
  const SCHEDULE_HYDRATE = 'team,linescore,weather,venue(location,timezone,fieldInfo),' +
                           'gameInfo,probablePitcher,decisions';

  function scheduleUrl(dateStr) {
    return `${V1}/schedule?sportId=${SPORT_ID}&date=${dateStr}&hydrate=${SCHEDULE_HYDRATE}`;
  }

  async function getSchedule(dateStr, options = {}) {
    const data = await getJSON(scheduleUrl(dateStr), { timeout: 6000, ...options });
    const dates = (data && data.dates) || [];
    const day = dates.length ? dates[0] : null;
    const games = day ? (day.games || []) : [];
    // Remember which listing date each game came from: a postponed game's
    // `officialDate` is its MAKEUP date (verified 2026-09-21 on 823062), so
    // the listing date has to travel with the game object.
    games.forEach((g) => { if (g && day && day.date) g._listingDate = day.date; });
    return games;
  }

  /** Same schedule, but for one gamePk — used as a per-game "source" link. */
  function gameScheduleUrl(gamePk) {
    return `${V1}/schedule?sportId=${SPORT_ID}&gamePk=${gamePk}&hydrate=${SCHEDULE_HYDRATE}`;
  }

  /**
   * Status-only schedule sweep for a date — the cheapest possible "did any
   * official status flip?" request (a `fields` projection, no hydrations).
   * Response shape observed: { dates: [ { date, games: [ { gamePk, status,
   * rescheduleDate?, rescheduleGameDate?, … } ] } ] }. `reason` must be
   * whitelisted explicitly or the delay reason is lost.
   */
  const STATUS_FIELDS = [
    'dates', 'date', 'games', 'gamePk', 'gameDate', 'officialDate',
    'status', 'abstractGameState', 'codedGameState', 'detailedState',
    'statusCode', 'reason', 'startTimeTBD', 'abstractGameCode',
    'rescheduleDate', 'rescheduleGameDate', 'rescheduledFrom', 'rescheduledFromDate',
    'resumeDate', 'resumeGameDate', 'resumedFrom', 'resumedFromDate',
  ];

  function statusSweepUrl(dateStr) {
    return `${V1}/schedule?sportId=${SPORT_ID}&date=${dateStr}&fields=${STATUS_FIELDS.join(',')}`;
  }

  async function getStatusSweep(dateStr, options = {}) {
    const data = await getJSON(statusSweepUrl(dateStr), { timeout: 3000, retries: 0, ...options });
    const dates = (data && data.dates) || [];
    return dates.length ? dates[0].games || [] : [];
  }

  /**
   * How many games the official schedule lists for a date. Used only by the
   * sparse-schedule irregularity check (a day that reports far fewer games
   * than its neighbours is flagged for review). Returns null when the sweep
   * itself failed, so callers can distinguish "0 games reported" from
   * "could not ask".
   */
  async function getScheduleGameCount(dateStr) {
    try {
      return (await getStatusSweep(dateStr)).length;
    } catch (_) {
      return null;
    }
  }

  /**
   * Play-by-play projection carrying the official status-change advisories.
   *
   * Verified live (statsapi.mlb.com, 2026-09-21):
   *   - game 824546 (delayed start): the FIRST play's playEvents[] holds
   *     { type:"action", details:{ eventType:"game_advisory",
   *       description:"Status Change - Delayed Start: Rain" },
   *       startTime, endTime }
   *   - game 822686 (mid-game delay, top 4th): the advisories sit inside a
   *     later play's playEvents[] BETWEEN pitches
   *     ("Status Change - Delayed: Inclement Weather" → "Status Change -
   *      Delayed: About to Resume" → "Status Change - In Progress"), and the
   *     play's own about.startTime is LATER than those events — so callers
   *     must scan every play's playEvents and sort by event startTime.
   *   - "Injury Delay." is a game_advisory too (non-weather).
   */
  const PBP_FIELDS = [
    'allPlays', 'about', 'atBatIndex', 'inning', 'halfInning', 'isTopInning',
    'startTime', 'endTime', 'isComplete',
    'result', 'event', 'eventType', 'description', 'awayScore', 'homeScore',
    'playEvents', 'index', 'isPitch', 'type', 'details',
  ];

  function playByPlayUrl(gamePk, projected = true) {
    return projected
      ? `${V1}/game/${gamePk}/playByPlay?fields=${PBP_FIELDS.join(',')}`
      : `${V1}/game/${gamePk}/playByPlay`;
  }

  function isLegacyMiss(err) {
    return err && [400, 404, 410].includes(err.status);
  }

  async function getPlayByPlay(gamePk, options = {}) {
    const opts = { timeout: 6000, ...options };
    try {
      return await getJSON(playByPlayUrl(gamePk, true), opts);
    } catch (errProjected) {
      if (!isLegacyMiss(errProjected)) throw errProjected;
      // A 4xx on the projection can mean this game/version rejected a field
      // name — fall back to the unprojected endpoint once.
      return await getJSON(playByPlayUrl(gamePk, false), opts);
    }
  }

  /**
   * Official box-score notes (the text block printed under every MLB box
   * score). Verified live (statsapi.mlb.com, 2026-09-21, game 824546):
   *   GET /api/v1/game/824546/boxscore?fields=info,label,value
   *   -> info: [ { label:"Weather", value:"65 degrees, Rain." },
   *              { label:"Wind", value:"10 mph, L To R." },
   *              { label:"First pitch", value:"5:00 PM." },
   *              { label:"T", value:"2:50 (3:50 delay)." },
   *              { label:"Att", value:"21,354." }, { label:"Venue", … } ]
   * The "T" line is MLB's own printed delay duration — the second official
   * figure (with gameInfo.delayDurationMinutes) the delay tracker cross-checks.
   */
  function boxscoreInfoUrl(gamePk) {
    return `${V1}/game/${gamePk}/boxscore?fields=info,label,value`;
  }

  async function getBoxscoreInfo(gamePk, options = {}) {
    const data = await getJSON(boxscoreInfoUrl(gamePk), { timeout: 6000, ...options });
    return (data && Array.isArray(data.info)) ? data.info : [];
  }

  /** Full live feed (Gameday payload) — used by the game page for linescore. */
  async function getLiveFeed(gamePk, options = {}) {
    try {
      return await getJSON(`${V11}/game/${gamePk}/feed/live`, options);
    } catch (err1) {
      if (!isLegacyMiss(err1)) throw err1;
      return await getJSON(`${V1}/game/${gamePk}/feed/live`, options);
    }
  }

  /** Linescore only (small) — game page live panel. */
  async function getLinescore(gamePk, options = {}) {
    return getJSON(`${V1}/game/${gamePk}/linescore`, { timeout: 5000, ...options });
  }

  /* -------------------------------------------------------- source links */

  /** Human + machine-readable official sources for one game. */
  function sourceLinks(gamePk) {
    return {
      gameday: `https://www.mlb.com/gameday/${gamePk}`,
      schedule: gameScheduleUrl(gamePk),
      feed: `${V11}/game/${gamePk}/feed/live`,
      playByPlay: playByPlayUrl(gamePk, false),
      boxscore: `${V1}/game/${gamePk}/boxscore`,
      gameStatus: `${V1}/gameStatus`,
    };
  }

  /* -------------------------------------------------------------- CDN URLs */

  function teamLogoUrl(teamId) {
    return `${LOGO_CDN}/team-cap-on-dark/${teamId}.svg`;
  }
  function teamLogoFallbackUrl(teamId) {
    return `${LOGO_CDN}/${teamId}.svg`;
  }

  /* ------------------------------------------------------------- formatters */

  const ORDINALS = ['th', 'st', 'nd', 'rd', 'th', 'th', 'th', 'th', 'th', 'th'];

  function ordinal(n) {
    if (n == null) return '';
    const n10 = n % 100;
    const suffix = (n10 >= 11 && n10 <= 13) ? 'th' : ORDINALS[n % 10] || 'th';
    return `${n}${suffix}`;
  }

  /** "2026-08-07T22:40:00Z" -> local "7:40 PM" */
  function localTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  /**
   * Scheduled-start label that never invents a clock time: MLB flags
   * placeholder times with status.startTimeTBD (typical for game 2 of a
   * split doubleheader created by a postponement).
   */
  function startLabel(game, opts) {
    if (!game) return '';
    const tbd = !!(game.status && game.status.startTimeTBD);
    const dh = game.doubleHeader && game.doubleHeader !== 'N' && game.gameNumber ? ` · Gm ${game.gameNumber}` : '';
    if (tbd) return `TBD${dh}`;
    const t = opts && opts.withDate ? localDateTime(game.gameDate) : localTime(game.gameDate);
    return `${t}${dh}`;
  }

  function localDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function localDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString([], {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  }

  /** Time of day in a specific IANA zone (the ballpark's), e.g. "1:10 PM CDT". */
  function zonedTime(iso, tz) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    try {
      return d.toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', timeZone: tz || undefined, timeZoneName: 'short',
      });
    } catch (_) {
      return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
  }

  /** Minutes -> "3h 50m" / "45m". */
  function fmtMinutes(min) {
    if (min == null || Number.isNaN(Number(min))) return '';
    const m = Math.round(Number(min));
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${h}h ${r}m` : `${h}h`;
  }

  /** Compact inning label from a linescore, mlb.com style. */
  function inningLabel(linescore, status) {
    if (!linescore) return '';
    if (status && status.abstractGameState === 'Final') {
      const n = (linescore.innings || []).length;
      return n > 9 ? `Final/${n}` : 'Final';
    }
    const st = (linescore.inningState || '').toLowerCase();
    const num = linescore.currentInning != null
      ? String(linescore.currentInning)
      : linescore.currentInningOrdinal || '';
    if (st === 'top') return `Top ${num}`;
    if (st === 'bottom') return `Bot ${num}`;
    if (st === 'middle') return `Mid ${num}`;
    if (st === 'end') return `End ${num}`;
    return num ? `${st} ${num}` : '';
  }

  function inningGlyph(linescore) {
    if (!linescore) return '';
    const st = (linescore.inningState || '').toLowerCase();
    const num = linescore.currentInning != null
      ? String(linescore.currentInning)
      : linescore.currentInningOrdinal || '';
    if (st === 'top') return `▲ ${num}`;
    if (st === 'bottom') return `▼ ${num}`;
    if (st === 'middle') return `◆ ${num}`;
    return '';
  }

  function sides() { return ['away', 'home']; }

  function scoreOf(game, side) {
    const t = game.teams && game.teams[side];
    return t && typeof t.score === 'number' ? t.score : null;
  }

  return {
    getJSON, getSchedule, getStatusSweep, getScheduleGameCount, getPlayByPlay, getBoxscoreInfo,
    getLiveFeed, getLinescore,
    scheduleUrl, gameScheduleUrl, statusSweepUrl, playByPlayUrl, boxscoreInfoUrl,
    sourceLinks, rateLimitedForMs,
    teamLogoUrl, teamLogoFallbackUrl,
    ordinal, localTime, localDate, localDateTime, zonedTime, fmtMinutes, startLabel,
    inningLabel, inningGlyph, sides, scoreOf,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MLB;
