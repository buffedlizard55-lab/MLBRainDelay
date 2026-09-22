/* ============================================================================
 * delays.js — official delay / postponement / suspension detection
 * ----------------------------------------------------------------------------
 * Pure functions over StatsAPI payloads. Every rule below is tied to a field
 * that was verified live (dates noted); nothing is inferred from social media
 * or news text. Three official signals are combined and cross-checked:
 *
 *  A. The game STATUS on the schedule (GET /api/v1/gameStatus registry):
 *       status.{ codedGameState, statusCode, detailedState, reason }
 *     Registry verified 2026-09-21. The two-letter statusCode's first letter
 *     is codedGameState, the second letter is the reason code:
 *       P? "Delayed Start: <reason>"  PO "Delayed Start"   PW Warmup
 *       I? "Delayed: <reason>"        IO "Delayed"         IZ "Delayed: About to Resume"
 *       IH Instant Replay             IT Delayed: Tiebreaker
 *       D? "Postponed: <reason>"      DO Postponed
 *       C? / CO Cancelled             O?/F? "Completed Early: <reason>"  OO/FO Completed Early
 *       T?/TO/U?/UO Suspended         UZ "Suspended: About to Resume"
 *       Q?/R? Forfeit                 M?/N? manager challenge / umpire review
 *     Reason letters: R Rain, S Snow, G Wet Grounds, V Venue, F Fog, C Cold,
 *       D Air Quality, B Wind, I Inclement Weather, P Power, Y Ceremony,
 *       L Lightning, E Emergency, 9 COVID-19, A Tragedy, M Mercy, O none.
 *     The live schedule keeps the reason in `status.reason` (verified
 *     2026-09-21 on 823062: statusCode "DI", detailedState "Postponed",
 *     reason "Inclement Weather").
 *
 *  B. Official play-by-play advisories: playEvents[] entries with
 *       details.eventType === "game_advisory" and description
 *       "Status Change - <detailedState>" (or free text like "Injury Delay.")
 *     carrying startTime / endTime. Verified 2026-09-21 on 824546 (pre-game,
 *     first play) and 822686 (mid-game, top 4th, between pitches).
 *
 *  C. Official duration figures: gameInfo.delayDurationMinutes on the
 *     schedule (verified: 824546 → 230, 824381 → 125, 822686 → 86) and the
 *     printed box-score line  T: "2:50 (3:50 delay)."  (verified 824546).
 *
 * Any disagreement between A, B and C is surfaced as an irregularity flag —
 * never resolved silently.
 * ==========================================================================*/
'use strict';

const Delays = (() => {
  /* Second letter of statusCode -> reason, for the P/I/D/C/O/F/T/U families.
   * Verified against GET /api/v1/gameStatus on 2026-09-21 (full registry). */
  const REASON_BY_CODE = {
    R: 'Rain', S: 'Snow', G: 'Wet Grounds', V: 'Venue', F: 'Fog', C: 'Cold',
    D: 'Air Quality', B: 'Wind', I: 'Inclement Weather', P: 'Power', Y: 'Ceremony',
    L: 'Lightning', E: 'Emergency', 9: 'COVID-19', A: 'Tragedy', M: 'Mercy', O: null,
    Z: 'About to Resume', T: 'Tiebreaker', H: 'Instant Replay', W: 'Warmup', U: 'Appeal Upheld',
  };
  /* Forfeits (Q… / R… codes) use their OWN letter table — "QR" is
   * "Forfeit: Rule", not Rain (verified 2026-09-21). */
  const FORFEIT_REASON_BY_CODE = {
    K: 'Delay', X: 'Appear', Q: 'Lineup', J: 'Ejection', I: 'Ineligible',
    N: 'Refusal', V: 'Unplayable', R: 'Rule', O: null,
  };
  /* Codes whose second letter is a game-state qualifier, not a reason. */
  const NON_REASON_WORDS = new Set(['About to Resume', 'Tiebreaker', 'Instant Replay', 'Warmup', 'Review', 'Tied', 'Tied (won in tiebreaker)']);

  const WEATHER_REASONS = new Set([
    'Rain', 'Snow', 'Wet Grounds', 'Fog', 'Cold', 'Wind', 'Inclement Weather', 'Lightning',
  ]);
  const WEATHER_ADJACENT_REASONS = new Set(['Air Quality']); // wildfire smoke etc.

  /* Kinds that mean play is stopped RIGHT NOW. */
  const ACTIVE_KINDS = new Set(['delayed-start', 'delayed', 'about-to-resume', 'suspended', 'suspended-about-to-resume']);
  /* Kinds that mean the game was disrupted (active or terminal). */
  const DISRUPTION_KINDS = new Set([...ACTIVE_KINDS, 'postponed', 'cancelled', 'completed-early', 'forfeit']);

  const KIND_META = {
    'delayed-start':            { label: 'Delayed Start', cls: 'chip-warn',  glyph: '⏳' },
    delayed:                    { label: 'Delayed',       cls: 'chip-warn',  glyph: '⏸' },
    'about-to-resume':          { label: 'About to Resume', cls: 'chip-warn', glyph: '▶' },
    suspended:                  { label: 'Suspended',     cls: 'chip-muted', glyph: '⏹' },
    'suspended-about-to-resume':{ label: 'Suspended — About to Resume', cls: 'chip-warn', glyph: '▶' },
    postponed:                  { label: 'Postponed',     cls: 'chip-muted', glyph: '📅' },
    cancelled:                  { label: 'Cancelled',     cls: 'chip-muted', glyph: '✖' },
    'completed-early':          { label: 'Completed Early', cls: 'chip-muted', glyph: '⏱' },
    forfeit:                    { label: 'Forfeit',       cls: 'chip-muted', glyph: '⚑' },
    resumed:                    { label: 'Resumed',       cls: 'chip-live',  glyph: '▶' },
    review:                     { label: 'Review',        cls: 'chip-review', glyph: '🚨' },
    warmup:                     { label: 'Warmup',        cls: 'chip-live',  glyph: '' },
    live:                       { label: 'In Progress',   cls: 'chip-live',  glyph: '' },
    pregame:                    { label: 'Pre-Game',      cls: 'chip-sched', glyph: '' },
    scheduled:                  { label: 'Scheduled',     cls: 'chip-sched', glyph: '' },
    final:                      { label: 'Final',         cls: 'chip-final', glyph: '' },
    note:                       { label: 'Advisory',      cls: 'chip-muted', glyph: '📝' },
    forecast:                   { label: 'Forecast',      cls: 'chip-sched', glyph: '🌧' },
    unknown:                    { label: 'Unknown',       cls: 'chip-muted', glyph: '' },
  };

  /* ---------------------------------------------------------- status parse */

  function classifyReason(reason) {
    if (!reason) return 'none';
    if (WEATHER_REASONS.has(reason)) return 'weather';
    if (WEATHER_ADJACENT_REASONS.has(reason)) return 'weather-adjacent';
    if (/rain|snow|storm|lightning|thunder|fog|wind|cold|heat|wet|weather|drizzle|hail|flood|smoke/i.test(reason)) return 'weather';
    return 'other';
  }

  /**
   * Parse one official status object into { kind, reason, reasonClass,
   * reasonSource, flags[] }. Works on the schedule's status object AND on a
   * synthetic { detailedState } built from an advisory's text.
   */
  function parseStatus(status) {
    const s = status || {};
    const detailed = String(s.detailedState || '').trim();
    const code = String(s.statusCode || '').trim().toUpperCase();
    const coded = String(s.codedGameState || code.charAt(0) || '').toUpperCase();
    const abstract = String(s.abstractGameState || '');
    const flags = [];

    /* 1. The words win: detailedState is what MLB.com prints. */
    let kind = null;
    if (detailed) {
      if (/^Delayed Start/i.test(detailed)) kind = 'delayed-start';
      else if (/^Delayed: About to Resume/i.test(detailed)) kind = 'about-to-resume';
      else if (/^Delayed/i.test(detailed)) kind = 'delayed';
      else if (/^Postponed/i.test(detailed)) kind = 'postponed';
      else if (/^Suspended: About to Resume/i.test(detailed)) kind = 'suspended-about-to-resume';
      else if (/^Suspended/i.test(detailed)) kind = 'suspended';
      else if (/^Cancell?ed/i.test(detailed)) kind = 'cancelled';
      else if (/^Completed Early/i.test(detailed)) kind = 'completed-early';
      else if (/^Forfeit/i.test(detailed)) kind = 'forfeit';
      else if (/challenge|review|instant replay/i.test(detailed)) kind = 'review';
      else if (/^(Final|Game Over)/i.test(detailed)) kind = 'final';
      else if (/^Warmup/i.test(detailed)) kind = 'warmup';
      else if (/^In Progress/i.test(detailed)) kind = 'live';
      else if (/^Pre-?Game/i.test(detailed)) kind = 'pregame';
      else if (/^Scheduled/i.test(detailed)) kind = 'scheduled'; // incl. "Scheduled: COVID-19" (T9)
    }
    /* 2. Otherwise the letters (statusCode = state letter + qualifier). */
    if (!kind) {
      if (coded === 'P' && code.length === 2 && code[1] !== 'W') kind = 'delayed-start';
      else if (code === 'IZ') kind = 'about-to-resume';
      else if (coded === 'I' && code.length === 2 && !['H', 'T'].includes(code[1])) kind = 'delayed';
      else if (coded === 'D') kind = 'postponed';
      else if (code === 'UZ') kind = 'suspended-about-to-resume';
      else if (coded === 'T' || coded === 'U') kind = 'suspended';
      else if (coded === 'C') kind = 'cancelled';
      else if ((coded === 'O' || coded === 'F') && code.length === 2 && !['T', 'W'].includes(code[1])) kind = 'completed-early';
      else if (coded === 'Q' || coded === 'R') kind = 'forfeit';
      else if (coded === 'M' || coded === 'N' || code === 'IH') kind = 'review';
      else if (abstract === 'Final' || coded === 'F' || coded === 'O') kind = 'final';
      else if (code === 'PW') kind = 'warmup';
      else if (coded === 'I') kind = 'live';
      else if (coded === 'S' || abstract === 'Preview') kind = 'scheduled';
      else kind = 'unknown';
    }

    // Reason: explicit field first, then the "X: <reason>" suffix, then the
    // code letter. "About to Resume" / "Tiebreaker" / "Tied" are state
    // qualifiers MLB puts in `reason` too — they are never a delay reason.
    const resumeKind = kind === 'about-to-resume' || kind === 'suspended-about-to-resume';
    let reason = null;
    let reasonSource = null;
    const explicit = s.reason ? String(s.reason).trim() : '';
    if (explicit && !NON_REASON_WORDS.has(explicit)) { reason = explicit; reasonSource = 'status.reason'; }
    const m = /^(?:Delayed Start|Delayed|Postponed|Suspended|Cancelled|Canceled|Completed Early|Forfeit|Scheduled):\s*(.+)$/i.exec(detailed);
    const suffix = m ? m[1].trim() : null;
    if (!reason && suffix && !NON_REASON_WORDS.has(suffix)) { reason = suffix; reasonSource = 'detailedState'; }
    let codeReason = null;
    if (code.length === 2 && DISRUPTION_KINDS.has(kind) && !resumeKind) {
      const letter = code[1];
      const table = kind === 'forfeit' ? FORFEIT_REASON_BY_CODE : REASON_BY_CODE;
      if (letter in table) codeReason = table[letter];
      else flags.push({ code: 'unknown-reason-code', text: `Status code "${code}" carries an unrecognised reason letter "${letter}".` });
    }
    if (codeReason && NON_REASON_WORDS.has(codeReason)) codeReason = null;
    if (!reason && codeReason) { reason = codeReason; reasonSource = 'statusCode'; }
    if (reason && codeReason && codeReason !== reason) {
      flags.push({ code: 'reason-conflict', text: `Reason "${reason}" (${reasonSource}) disagrees with status code ${code} (${codeReason}).` });
    }
    const qualifierOnly = NON_REASON_WORDS.has(explicit) || (suffix && NON_REASON_WORDS.has(suffix));
    if (DISRUPTION_KINDS.has(kind) && !reason && !resumeKind && !qualifierOnly) {
      flags.push({ code: 'reason-missing', text: `MLB reports "${detailed || kind}" without a reason.` });
    }
    // Cross-check the words against the letters.
    const conflict = () => flags.push({ code: 'status-conflict', text: `detailedState "${detailed}" but codedGameState "${coded}".` });
    if (coded) {
      if ((kind === 'delayed' || kind === 'about-to-resume') && coded !== 'I') conflict();
      if (kind === 'postponed' && coded !== 'D') conflict();
      if (kind === 'delayed-start' && coded !== 'P') conflict();
      if (kind === 'cancelled' && coded !== 'C') conflict();
      if ((kind === 'suspended' || kind === 'suspended-about-to-resume') && !['T', 'U'].includes(coded)) conflict();
      if (kind === 'forfeit' && !['Q', 'R'].includes(coded)) conflict();
      if (kind === 'completed-early' && !['O', 'F'].includes(coded)) conflict();
    }

    return {
      kind, reason, reasonSource, reasonClass: classifyReason(reason),
      qualifier: qualifierOnly ? (NON_REASON_WORDS.has(explicit) ? explicit : suffix) : null,
      detailedState: detailed, statusCode: code, codedGameState: coded, abstractGameState: abstract,
      active: ACTIVE_KINDS.has(kind), disruption: DISRUPTION_KINDS.has(kind),
      isWeather: classifyReason(reason) !== 'other' && classifyReason(reason) !== 'none',
      flags,
    };
  }

  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /**
   * Human label for a parsed status: "<detailedState>: <reason>" when the
   * reason is not already part of the state text ("Delayed Start: Rain" stays
   * as is; "Delayed" + reason "Rain" → "Delayed: Rain"), plus any game-state
   * qualifier MLB put in the reason field ("Delayed (Tiebreaker)"). Pure text,
   * safe for any reason string (regex metacharacters are escaped).
   */
  function statusLabel(ps) {
    if (!ps) return '';
    const state = ps.detailedState || '';
    let label = state;
    if (ps.reason && !new RegExp(escapeRe(ps.reason), 'i').test(state)) label += `: ${ps.reason}`;
    if (ps.qualifier && !new RegExp(escapeRe(ps.qualifier), 'i').test(label)) label += ` (${ps.qualifier})`;
    return label;
  }

  /* ------------------------------------------------------------ reschedule */

  function rescheduleInfo(game) {
    const g = game || {};
    const out = { reschedule: null, makeupOf: null, resume: null, listingMismatch: false, flags: [] };
    if (g.rescheduleGameDate || g.rescheduleDate) {
      out.reschedule = { toDate: g.rescheduleGameDate || null, toIso: g.rescheduleDate || null };
    }
    if (g.rescheduledFromDate || g.rescheduledFrom) {
      out.makeupOf = { fromDate: g.rescheduledFromDate || null, fromIso: g.rescheduledFrom || null, description: g.description || null };
    }
    if (g.resumeDate || g.resumeGameDate || g.resumedFrom || g.resumedFromDate) {
      out.resume = { toDate: g.resumeGameDate || null, toIso: g.resumeDate || null, fromDate: g.resumedFromDate || null, fromIso: g.resumedFrom || null };
    }
    if (g._listingDate && g.officialDate && g._listingDate !== g.officialDate) {
      out.listingMismatch = true;
      if (!out.reschedule && !out.resume) {
        out.flags.push({ code: 'official-date-shift', text: `Listed on ${g._listingDate} but officialDate is ${g.officialDate} with no reschedule fields.` });
      }
    }
    return out;
  }

  /* ------------------------------------------------------------- inspect */

  function minutesBetween(aIso, bIso) {
    const a = Date.parse(aIso);
    const b = Date.parse(bIso);
    if (Number.isNaN(a) || Number.isNaN(b)) return null;
    return Math.round((b - a) / 60000);
  }

  /**
   * Inspect a hydrated schedule game.
   * Returns { status, reschedule, official, active, disrupted, flags[] }.
   */
  function inspectGame(game) {
    const g = game || {};
    const status = parseStatus(g.status);
    const res = rescheduleInfo(g);
    const gi = g.gameInfo || {};
    const official = {
      delayMinutes: typeof gi.delayDurationMinutes === 'number' ? gi.delayDurationMinutes : null,
      gameDurationMinutes: typeof gi.gameDurationMinutes === 'number' ? gi.gameDurationMinutes : null,
      firstPitch: gi.firstPitch || null,
      scheduledStart: g.gameDate || null,
      startDelayMinutes: gi.firstPitch && g.gameDate ? minutesBetween(g.gameDate, gi.firstPitch) : null,
      attendance: typeof gi.attendance === 'number' ? gi.attendance : null,
    };
    const flags = [...status.flags, ...res.flags];
    if (g.status && g.status.startTimeTBD) flags.push({ code: 'start-tbd', text: 'Start time is TBD — the forecast window uses the placeholder gameDate.' });
    if (official.delayMinutes != null && official.delayMinutes > 0 && status.kind === 'final' && official.startDelayMinutes != null && official.startDelayMinutes < 0) {
      flags.push({ code: 'first-pitch-before-schedule', text: `First pitch ${official.firstPitch} is before the scheduled ${official.scheduledStart}.` });
    }
    if (status.disruption && status.kind !== 'postponed' && status.kind !== 'cancelled' && !status.isWeather && status.reason) {
      flags.push({ code: 'non-weather', text: `Delay reason "${status.reason}" is not a weather reason.` });
    }
    if ((status.kind === 'postponed' || status.kind === 'cancelled') && status.reason && !status.isWeather) {
      flags.push({ code: 'non-weather', text: `${KIND_META[status.kind].label} reason "${status.reason}" is not a weather reason.` });
    }
    const hadDelay = (official.delayMinutes != null && official.delayMinutes > 0) || status.disruption;
    return {
      gamePk: g.gamePk, status, reschedule: res.reschedule, makeupOf: res.makeupOf, resume: res.resume,
      listingMismatch: res.listingMismatch, official,
      active: status.active, disrupted: status.disruption, hadDelay,
      flags,
    };
  }

  /* ------------------------------------------------------------ advisories */

  function isAdvisoryEvent(ev) {
    if (!ev || ev.isPitch) return false;
    const d = ev.details || {};
    const eventType = String(d.eventType || '').toLowerCase();
    // eventType is authoritative when present (mound_visit, pitching_substitution,
    // … must never be mistaken for a status change even if `event` is loose).
    if (eventType) return eventType === 'game_advisory';
    return /^game advisory$/i.test(String(d.event || ''));
  }

  /**
   * Every official game_advisory in a playByPlay payload, sorted by the
   * event's own startTime (NOT play order — see api.js PBP notes).
   */
  function extractAdvisories(pbp) {
    const plays = (pbp && Array.isArray(pbp.allPlays)) ? pbp.allPlays : [];
    const out = [];
    plays.forEach((play, playIdx) => {
      const about = (play && play.about) || {};
      const events = (play && Array.isArray(play.playEvents)) ? play.playEvents : [];
      events.forEach((ev, evIdx) => {
        if (!isAdvisoryEvent(ev)) return;
        const description = String((ev.details && ev.details.description) || '').trim();
        const m = /^Status Change\s*-\s*(.+)$/i.exec(description);
        const statusText = m ? m[1].trim() : null;
        const parsed = statusText ? parseStatus({ detailedState: statusText }) : null;
        let kind = parsed ? parsed.kind : (/delay/i.test(description) ? 'delayed' : 'note');
        let reason = parsed ? parsed.reason : null;
        if (!parsed && /injury/i.test(description)) { reason = 'Injury'; }
        if (!parsed && !reason && kind === 'delayed') reason = description.replace(/\.$/, '');
        out.push({
          id: `${playIdx}:${evIdx}`,
          description, statusText, kind, reason,
          reasonClass: classifyReason(reason),
          isStatusChange: !!m,
          startTime: ev.startTime || null, endTime: ev.endTime || null,
          inning: about.inning != null ? about.inning : null,
          halfInning: about.halfInning || null,
          atBatIndex: about.atBatIndex != null ? about.atBatIndex : playIdx,
          playIndex: playIdx, eventIndex: evIdx,
          flags: parsed ? parsed.flags : [],
        });
      });
    });
    out.sort((a, b) => {
      const ta = Date.parse(a.startTime || '') || 0;
      const tb = Date.parse(b.startTime || '') || 0;
      if (ta !== tb) return ta - tb;
      return a.playIndex - b.playIndex || a.eventIndex - b.eventIndex;
    });
    return out;
  }

  /**
   * Turn sorted advisories into delay segments:
   *   [{ kind, reason, reasonClass, startTime, endTime, minutes, inning,
   *      halfInning, open, events[] }]
   * A segment opens on a delay-like status and closes on the next
   * non-delay status ("In Progress", "Warmup", …); "About to Resume" keeps it
   * open. Free-text advisories with their own endTime ("Injury Delay.") are
   * one-event segments.
   */
  function buildTimeline(advisories, game) {
    const segments = [];
    let open = null;
    (advisories || []).forEach((a) => {
      if (!a.isStatusChange) {
        if (a.kind === 'delayed') {
          const mins = a.startTime && a.endTime ? minutesBetween(a.startTime, a.endTime) : null;
          segments.push({ kind: 'delayed', reason: a.reason, reasonClass: a.reasonClass, startTime: a.startTime, endTime: a.endTime, minutes: mins, inning: a.inning, halfInning: a.halfInning, open: !a.endTime, events: [a], freeText: true });
        }
        return;
      }
      if (ACTIVE_KINDS.has(a.kind)) {
        if (!open) {
          open = { kind: a.kind, reason: a.reason, reasonClass: a.reasonClass, startTime: a.startTime, endTime: null, minutes: null, inning: a.inning, halfInning: a.halfInning, open: true, events: [a] };
          segments.push(open);
        } else {
          open.events.push(a);
          if (a.reason && a.reason !== open.reason && a.kind !== 'about-to-resume' && a.kind !== 'suspended-about-to-resume') {
            open.reason = open.reason ? `${open.reason} → ${a.reason}` : a.reason;
          }
          if (a.kind === 'suspended' || a.kind === 'suspended-about-to-resume') open.kind = 'suspended';
        }
      } else if (open) {
        open.events.push(a);
        open.endTime = a.startTime || null;
        open.minutes = open.startTime && open.endTime ? minutesBetween(open.startTime, open.endTime) : null;
        open.open = false;
        open.resumedKind = a.kind;
        open = null;
      }
    });
    if (open) {
      // Still open: fall back to the last delay event's own endTime when the
      // game has since moved on (Final), otherwise it is genuinely ongoing.
      const last = open.events[open.events.length - 1];
      const isFinal = game && game.status && game.status.abstractGameState === 'Final';
      if (isFinal && last && last.endTime) {
        open.endTime = last.endTime;
        open.minutes = minutesBetween(open.startTime, open.endTime);
        open.open = false;
        open.closedByEventEnd = true;
      }
    }
    return segments;
  }

  /* ------------------------------------------------------------ box score */

  /**
   * Parse the official box-score info block. Verified labels (824546):
   *   "Weather" "65 degrees, Rain."   "Wind" "10 mph, L To R."
   *   "First pitch" "5:00 PM."        "T" "2:50 (3:50 delay)."   "Att" "21,354."
   */
  function parseBoxscoreInfo(info) {
    const out = { weather: null, wind: null, firstPitch: null, timeOfGame: null, delayMinutes: null, delayNote: null, attendance: null, venue: null, raw: {} };
    (Array.isArray(info) ? info : []).forEach((row) => {
      if (!row || !row.label) return;
      const label = String(row.label).trim();
      const value = String(row.value == null ? '' : row.value).trim();
      out.raw[label] = value;
      if (/^weather$/i.test(label)) out.weather = value.replace(/\.$/, '');
      else if (/^wind$/i.test(label)) out.wind = value.replace(/\.$/, '');
      else if (/^first pitch$/i.test(label)) out.firstPitch = value.replace(/\.$/, '');
      else if (/^att$/i.test(label)) out.attendance = value.replace(/\.$/, '');
      else if (/^venue$/i.test(label)) out.venue = value.replace(/\.$/, '');
      else if (/^T$/i.test(label)) {
        const m = /^(\d+):(\d{2})(?:\s*\(([^)]*)\))?/.exec(value);
        if (m) {
          out.timeOfGame = `${m[1]}:${m[2]}`;
          if (m[3]) {
            out.delayNote = m[3].trim();
            const dm = /(\d+):(\d{2})\s*delay/i.exec(m[3]);
            if (dm) out.delayMinutes = parseInt(dm[1], 10) * 60 + parseInt(dm[2], 10);
          }
        } else if (value) {
          out.delayNote = value;
        }
      }
    });
    return out;
  }

  /* --------------------------------------------------------- cross-checks */

  const DURATION_TOLERANCE_MIN = 10;

  /**
   * Compare the three official sources for one game. Returns flags[].
   *   inspection : inspectGame(game)
   *   timeline   : buildTimeline(advisories) or null when not scanned
   *   box        : parseBoxscoreInfo(info) or null when not fetched
   */
  function crossCheck(inspection, timeline, box) {
    const flags = [];
    const official = inspection.official.delayMinutes;
    const isFinal = inspection.status.kind === 'final' || inspection.status.kind === 'completed-early';

    if (timeline) {
      const segs = timeline.filter((s) => !s.freeText);
      const startSegs = segs.filter((s) => s.kind === 'delayed-start');
      const midSegs = segs.filter((s) => s.kind !== 'delayed-start' && !s.open && s.minutes != null);
      const anyOpen = segs.some((s) => s.open);
      if (official != null && official > 0 && !segs.length && !inspection.status.disruption) {
        flags.push({ code: 'minutes-without-advisory', text: `MLB reports ${official} delay minutes but the play-by-play carries no status-change advisory.` });
      }
      if (segs.length && isFinal && (official == null || official === 0)) {
        flags.push({ code: 'advisory-without-minutes', text: 'Play-by-play shows a delay advisory but gameInfo.delayDurationMinutes is missing or 0.' });
      }
      if (official != null && official > 0 && isFinal && !anyOpen && segs.length) {
        // MLB's figure for a delayed start is first pitch minus scheduled
        // start (verified 824381: 17:40Z → 19:45Z = 125 = delayDurationMinutes).
        const startPart = startSegs.length && inspection.official.startDelayMinutes != null && inspection.official.startDelayMinutes > 0
          ? inspection.official.startDelayMinutes : 0;
        const midPart = midSegs.reduce((sum, s) => sum + s.minutes, 0);
        const derived = startPart + midPart;
        if (derived > 0 && Math.abs(derived - official) > DURATION_TOLERANCE_MIN) {
          flags.push({ code: 'duration-mismatch', text: `Official delay ${official} min vs ${derived} min derived from status advisories (start ${startPart} + in-game ${midPart}).` });
        }
      }
    }
    if (box && box.delayMinutes != null && official != null && Math.abs(box.delayMinutes - official) > 1) {
      flags.push({ code: 'boxscore-mismatch', text: `Box score prints a ${box.delayMinutes}-minute delay but gameInfo.delayDurationMinutes is ${official}.` });
    }
    if (box && box.delayNote && box.delayMinutes == null) {
      flags.push({ code: 'boxscore-note-unparsed', text: `Box score time note "${box.delayNote}" could not be parsed as a delay.` });
    }
    if (box && box.delayMinutes != null && official == null) {
      flags.push({ code: 'boxscore-only-delay', text: `Box score prints a ${box.delayMinutes}-minute delay but the schedule carries no delayDurationMinutes.` });
    }
    return flags;
  }

  /**
   * Official MLB game weather string vs the forecast risk read — a
   * disagreement is flagged for review, never "corrected".
   */
  function weatherConsistencyFlags(game, risk) {
    const flags = [];
    const cond = String((game && game.weather && game.weather.condition) || '');
    if (!cond || !risk || risk.level === 'covered' || risk.level === 'unknown' || risk.maxPop == null) return flags;
    const saysWet = /rain|drizzle|shower|storm|snow/i.test(cond);
    if (saysWet && risk.maxPop < 20) flags.push({ code: 'mlb-wet-forecast-dry', text: `MLB lists "${cond}" at first pitch while the official forecast peaks at ${risk.maxPop}% precipitation.` });
    if (!saysWet && /clear|sunny/i.test(cond) && risk.maxPop >= 70) flags.push({ code: 'mlb-dry-forecast-wet', text: `MLB lists "${cond}" at first pitch while the official forecast peaks at ${risk.maxPop}% precipitation.` });
    return flags;
  }

  /* ------------------------------------------------------ sparse schedule */

  /**
   * Schedule-completeness check. The official schedule for a date can report
   * far fewer games than adjacent days (observed live 2026-09-22: 2026-09-21
   * reported 3 games while 2026-09-20 and 2026-09-22 reported 15 and 16).
   * That may be a legitimate sparse slate (after a weather-cancelled day,
   * holiday, …) or incomplete schedule data — either way it is surfaced as a
   * flag for review, never resolved silently. Pure function; no fetching.
   *
   * Thresholds: a full MLB slate is typically 12–20 games. `count <= 8` with
   * an adjacent day at least 4 games larger (or zero games with an adjacent
   * day of 8+) is "sparse enough to flag". Returns { code, text } or null.
   */
  function sparseScheduleFlag(date, count, prevDate, prevCount, nextDate, nextCount) {
    const n = Number.isFinite(count) ? count : null;
    if (n == null || n > 8) return null;
    const bigger = (d, c) => (Number.isFinite(c) && c >= n + 4) ? `${d} reports ${c}` : null;
    const bits = [bigger(prevDate, prevCount), bigger(nextDate, nextCount)].filter(Boolean);
    if (!bits.length) return null;
    return {
      code: 'sparse-schedule',
      text: `The official MLB schedule reports ${n} game${n === 1 ? '' : 's'} for ${date} while ${bits.join('; ')} — flagged for review (may be a legitimate sparse slate or incomplete schedule data).`,
    };
  }

  /* --------------------------------------------------------- transitions */

  /**
   * Diff two status snapshots (gamePk -> status) and return observed
   * transitions [{ gamePk, from, to, at }]. `at` is the observer's clock —
   * these rows are always labelled "observed", never as official timestamps.
   */
  function diffStatuses(prev, next, at) {
    const out = [];
    (next || new Map()).forEach((status, pk) => {
      const before = prev ? prev.get(pk) : null;
      if (!before) return;
      const a = parseStatus(before);
      const b = parseStatus(status);
      const sameWords = (before.detailedState || '') === (status.detailedState || '') && (before.reason || '') === (status.reason || '') && (before.statusCode || '') === (status.statusCode || '');
      if (sameWords) return;
      if (a.kind === b.kind && a.reason === b.reason) return;
      let event = null;
      if (b.active && !a.active) event = b.kind;
      else if (a.active && !b.active && (b.kind === 'live' || b.kind === 'warmup' || b.kind === 'pregame')) event = 'resumed';
      else if (b.disruption && !a.disruption) event = b.kind;
      else if (a.active && b.active && (a.kind !== b.kind || a.reason !== b.reason)) event = b.kind;
      else if (a.active && b.kind === 'final') event = 'final';
      if (!event) return;
      out.push({ gamePk: pk, from: a, to: b, event, at: at || Date.now(), fromRaw: before, toRaw: status });
    });
    return out;
  }

  return {
    REASON_BY_CODE, FORFEIT_REASON_BY_CODE, WEATHER_REASONS, ACTIVE_KINDS, DISRUPTION_KINDS, KIND_META,
    classifyReason, parseStatus, statusLabel, rescheduleInfo, inspectGame,
    isAdvisoryEvent, extractAdvisories, buildTimeline,
    parseBoxscoreInfo, crossCheck, weatherConsistencyFlags, diffStatuses, sparseScheduleFlag,
    minutesBetween,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Delays;
