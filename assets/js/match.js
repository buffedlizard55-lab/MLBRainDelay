/* ============================================================================
 * match.js — deterministic headline ↔ game linking + restart-time quotes
 * ----------------------------------------------------------------------------
 * Pure functions. Never invents a game link or a restart time.
 *
 * Game matching rules (all must hold; otherwise the headline stays unmatched):
 *   1. Only team names / abbreviations / nicknames published by MLB (and a
 *      short, fixed list of unambiguous city/club aliases) are recognised.
 *   2. A single recognised team matches a game only when that team plays
 *      exactly one game on the slate (no doubleheader ambiguity).
 *   3. Two recognised teams match a game only when they are the two sides of
 *      the same game (away + home). Mentions of two teams that are not
 *      opponents on the slate, or of three or more teams, abstain.
 *   4. Doubleheaders: a match is refused unless the headline also carries an
 *      explicit game-number cue ("game 1", "game 2", "first game", "nightcap",
 *      "opener", "twin bill game N"). Without that cue the match is refused
 *      even if the teams are unique opponents.
 *   5. Date cues in the headline are optional. When present they must agree
 *      with the slate's listing date (or the makeup / resume date of a
 *      postponed / suspended game); a disagreement abstains.
 *
 * Restart-time extraction rules:
 *   - Only explicit announcement phrasing is accepted (e.g. "restart at
 *     8:35 p.m.", "first pitch now set for 7:10 ET", "targeting an 8:30
 *     restart"). Weather-forecast times and scheduled first-pitch times are
 *     never treated as announcements.
 *   - The matched substring is retained verbatim as `evidence`.
 *   - The clock time is kept as published (hour, minute, am/pm, optional
 *     timezone token). No conversion to another zone is performed — the
 *     publisher's zone label, if any, is preserved as text.
 *   - Speculative phrasing ("hoping to", "could resume", "maybe around")
 *     is rejected so a soft estimate never becomes a hard claim.
 * ==========================================================================*/
'use strict';

const Match = (() => {
  /* Fixed, unambiguous aliases beyond the official name/abbreviation/teamName.
   * Keys are lowercased tokens as they appear in prose; values are StatsAPI
   * team ids. City-only aliases that collide across clubs (e.g. "new york",
   * "chicago", "los angeles") are intentionally omitted — they would force
   * false multi-team hits. */
  const EXTRA_ALIASES = {
    // Common short forms / nicknames used in headlines.
    // Ambiguous tokens are set to null so they never produce a hit on their own.
    "a's": 133, athletics: 133,
    dbacks: 109, 'd-backs': 109, diamondbacks: 109, 'diamond backs': 109,
    sox: null, // Red Sox / White Sox — only the longer forms below count
    'red sox': 111, redsox: 111, bosox: 111,
    'white sox': 145, whitesox: 145, 'chi sox': 145, chisox: 145,
    jays: 141, 'blue jays': 141, bluejays: 141,
    yankees: 147, yanks: 147, bombers: 147,
    mets: 121,
    phillies: 143, phils: 143,
    braves: 144,
    nationals: 120, nats: 120,
    marlins: 146, fish: 146,
    pirates: 134, bucs: 134,
    reds: 113,
    cubs: 112,
    brewers: 158, brewcrew: 158,
    cardinals: 138, cards: 138,
    twins: 142,
    guardians: 114, 'cle guardians': 114, tribe: 114,
    tigers: 116,
    royals: 118,
    astros: 117, stros: 117,
    rangers: 140,
    angels: 108, halos: 108,
    dodgers: 119,
    la: null, // Dodgers / Angels — refuse bare "LA"
    giants: 137,
    padres: 135, frears: 135,
    mariners: 136,
    "m's": 136,
    rockies: 115, rox: 115,
    rays: 139, 'tampa bay': 139, 'devil rays': 139,
    orioles: 110, "o's": 110,
  };

  /* Words that make a clock-time reading speculative — never promote these. */
  const SPECULATIVE = /\b(?:hop(?:e|ing|es)|could|might|may|maybe|possibly|potentially|around|roughly|approximately|estimate|estimated|unofficial|target(?:ing)?\s+weather|weather\s+permitting)\b/i;

  /* Explicit announcement verbs / frames that introduce a restart or first-pitch time.
   * Group layout is always: 1=hour 2=minute 3=ampm 4=zone so the extractor is shared. */
  const ANNOUNCE_FRAMES = [
    // "restart at 8:35 p.m.", "resume at 7:10 ET", "first pitch at 8:05pm",
    // "first pitch now set for 7:10pm"
    /\b(?:re-?start(?:ing)?|resum(?:e|es|ed|ing)|first\s+pitch|underway|under\s+way|first\s+ball)\s+(?:is\s+|now\s+|now\s+set\s+|set\s+)?(?:for\s+|at\s+|around\s+)?(\d{1,2})(?::(\d{2}))?\s*((?:a\.?m\.?|p\.?m\.?)?)\s*((?:ET|EST|EDT|CT|CST|CDT|MT|MST|MDT|PT|PST|PDT|AT|UTC|GMT|local(?:\s+time)?)?)/ig,
    // "targeting an 8:30 restart", "set for a 7:05 first pitch", "announced 9:05 p.m. restart"
    /\b(?:target(?:ing|s|ed)?|set|scheduled|announced|now)\s+(?:an?\s+|for\s+(?:an?\s+)?)?(\d{1,2})(?::(\d{2}))?\s*((?:a\.?m\.?|p\.?m\.?)?)\s*((?:ET|EST|EDT|CT|CST|CDT|MT|MST|MDT|PT|PST|PDT|AT|UTC|GMT|local(?:\s+time)?)?)?\s*(?:re-?start|resumption|first\s+pitch|first\s+ball)/ig,
    // "8:35 p.m. ET restart", "7:10 p.m. first pitch" (time then role; am/pm required)
    /\b(\d{1,2})(?::(\d{2}))?\s*((?:a\.?m\.?|p\.?m\.?))\s*((?:ET|EST|EDT|CT|CST|CDT|MT|MST|MDT|PT|PST|PDT|AT|UTC|GMT)?)?\s*(?:re-?start|resumption|first\s+pitch)/ig,
  ];

  const GAME_NUMBER_CUES = [
    { re: /\bgame\s*(?:no\.?\s*)?(1|one|i)\b/i, n: 1 },
    { re: /\bgame\s*(?:no\.?\s*)?(2|two|ii)\b/i, n: 2 },
    { re: /\b(?:first\s+game|opener|game\s+one)\b/i, n: 1 },
    { re: /\b(?:second\s+game|nightcap|game\s+two|night\s+cap)\b/i, n: 2 },
    { re: /\btwin\s*bill\s+game\s*(1|2)\b/i, n: null }, // filled from capture
  ];

  function norm(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9'@.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Build the lookup of phrase → teamId from a list of schedule games plus the
   * fixed EXTRA_ALIASES table. Longer phrases are preferred at match time so
   * "blue jays" wins over a bare "jays" collision never arises.
   */
  function buildAliasIndex(games) {
    const map = new Map(); // phrase -> teamId | null (null = ambiguous, refuse)
    const add = (phrase, id) => {
      const p = norm(phrase);
      if (!p || p.length < 2) return;
      if (!map.has(p)) map.set(p, id);
      else if (map.get(p) !== id) map.set(p, null); // colliding → refuse
    };
    (Array.isArray(games) ? games : []).forEach((g) => {
      if (!g || !g.teams) return;
      ['away', 'home'].forEach((side) => {
        const t = g.teams[side] && g.teams[side].team;
        if (!t || t.id == null) return;
        add(t.abbreviation, t.id);
        add(t.teamName, t.id);
        add(t.name, t.id);
        // Last word of the full name ("Detroit Tigers" → "tigers") is already
        // covered by teamName for most clubs; keep the full name too.
        if (t.name && t.teamName && t.name !== t.teamName) {
          add(t.name.replace(new RegExp(`\\b${t.teamName}$`, 'i'), '').trim(), t.id); // city
        }
      });
    });
    Object.entries(EXTRA_ALIASES).forEach(([phrase, id]) => add(phrase, id));
    return map;
  }

  /**
   * Find every team id mentioned in text. Uses longest-phrase-first so
   * "white sox" is preferred over a bare "sox" (which is intentionally null).
   * Returns { ids: number[], hits: [{ phrase, teamId }] }.
   */
  function findTeams(text, aliasIndex) {
    const hay = ` ${norm(text)} `;
    const hits = [];
    const used = []; // [start, end) spans already claimed
    const phrases = [...aliasIndex.keys()].sort((a, b) => b.length - a.length);
    phrases.forEach((phrase) => {
      const id = aliasIndex.get(phrase);
      if (id == null) return; // ambiguous alias — never a hit
      // Word-boundary search over the normalised haystack. A trailing
      // possessive ("Yankees' rain delay", "O's") is allowed after the phrase
      // so a headline apostrophe does not hide the club name.
      const re = new RegExp(`([^a-z0-9']|^)(${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})('s|')?(?=[^a-z0-9']|$)`, 'g');
      let m;
      while ((m = re.exec(hay)) !== null) {
        const start = m.index + m[1].length;
        const end = start + m[2].length + (m[3] ? m[3].length : 0);
        if (used.some(([s, e]) => start < e && end > s)) continue;
        used.push([start, end]);
        hits.push({ phrase: m[2], teamId: id });
      }
    });
    const ids = [...new Set(hits.map((h) => h.teamId))];
    return { ids, hits };
  }

  function gameNumberCue(text) {
    const t = String(text || '');
    for (const cue of GAME_NUMBER_CUES) {
      const m = cue.re.exec(t);
      if (!m) continue;
      if (cue.n != null) return cue.n;
      const n = parseInt(m[1], 10);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  /**
   * Optional date cue. Accepts ISO dates, "September 20", "Sep 20, 2026",
   * "9/20", "9/20/2026". Returns 'YYYY-MM-DD' or null when absent / unparseable.
   * A bare month+day without a year is returned as '****-MM-DD' so the caller
   * can compare month/day only.
   */
  function dateCue(text, refYear) {
    const t = String(text || '');
    const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(t);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const us = /\b(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}))?\b/.exec(t);
    if (us) {
      const y = us[3] || (refYear != null ? String(refYear) : null);
      if (!y) return `****-${String(us[1]).padStart(2, '0')}-${String(us[2]).padStart(2, '0')}`;
      return `${y}-${String(us[1]).padStart(2, '0')}-${String(us[2]).padStart(2, '0')}`;
    }
    const months = {
      january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
      may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
      september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11,
      december: 12, dec: 12,
    };
    const md = /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(20\d{2}))?\b/i.exec(t);
    if (md) {
      const mon = months[md[1].toLowerCase()];
      const day = parseInt(md[2], 10);
      const y = md[3] || (refYear != null ? String(refYear) : null);
      if (!mon || !day) return null;
      if (!y) return `****-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return `${y}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    return null;
  }

  function gameDates(game) {
    const out = new Set();
    if (game._listingDate) out.add(game._listingDate);
    if (game.officialDate) out.add(game.officialDate);
    if (game.rescheduleGameDate) out.add(game.rescheduleGameDate);
    if (game.rescheduledFromDate) out.add(game.rescheduledFromDate);
    if (game.resumeGameDate) out.add(game.resumeGameDate);
    if (game.gameDate) {
      const d = String(game.gameDate).slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) out.add(d);
    }
    return out;
  }

  function dateAgrees(cue, game) {
    if (!cue) return true;
    const dates = gameDates(game);
    if (cue.startsWith('****-')) {
      const md = cue.slice(5);
      return [...dates].some((d) => d.endsWith(`-${md}`));
    }
    return dates.has(cue);
  }

  function teamIdsOf(game) {
    const out = [];
    if (!game || !game.teams) return out;
    ['away', 'home'].forEach((side) => {
      const id = game.teams[side] && game.teams[side].team && game.teams[side].team.id;
      if (id != null) out.push(id);
    });
    return out;
  }

  /**
   * Match one headline item against a slate of games.
   * Returns {
   *   status: 'matched' | 'unmatched' | 'ambiguous',
   *   games: [{ gamePk, awayId, homeId, reason }],  // 0 or 1 when matched
   *   teamsFound: number[],
   *   evidence: string[],   // phrases that drove the match
   *   abstainReason: string|null
   * }
   */
  function matchItem(item, games, opts = {}) {
    const text = `${(item && item.title) || ''} ${(item && item.description) || ''}`;
    const list = Array.isArray(games) ? games : [];
    if (!list.length || !text.trim()) {
      return { status: 'unmatched', games: [], teamsFound: [], evidence: [], abstainReason: list.length ? 'empty-text' : 'no-slate' };
    }
    const aliasIndex = opts.aliasIndex || buildAliasIndex(list);
    const found = findTeams(text, aliasIndex);
    if (!found.ids.length) {
      return { status: 'unmatched', games: [], teamsFound: [], evidence: [], abstainReason: 'no-team-mention' };
    }
    const cueDate = dateCue(text, opts.refYear);
    const cueGameN = gameNumberCue(text);

    // Candidate games: every game whose roster intersects the mentioned teams,
    // and whose dates agree with any date cue.
    let candidates = list.filter((g) => {
      const ids = teamIdsOf(g);
      if (!ids.some((id) => found.ids.includes(id))) return false;
      if (!dateAgrees(cueDate, g)) return false;
      return true;
    });

    // Two-team case: require both sides of the same game.
    if (found.ids.length >= 2) {
      candidates = candidates.filter((g) => {
        const ids = teamIdsOf(g);
        return found.ids.includes(ids[0]) && found.ids.includes(ids[1]);
      });
      // Mentions of 3+ distinct clubs cannot identify one game.
      if (found.ids.length >= 3) {
        return {
          status: 'ambiguous', games: [], teamsFound: found.ids,
          evidence: found.hits.map((h) => h.phrase),
          abstainReason: 'three-or-more-teams',
        };
      }
      // Two teams named that are not opponents on this slate → abstain.
      if (!candidates.length) {
        return {
          status: 'ambiguous', games: [], teamsFound: found.ids,
          evidence: found.hits.map((h) => h.phrase),
          abstainReason: 'two-teams-not-opponents',
        };
      }
    } else {
      // Single team: keep only games featuring that team.
      const only = found.ids[0];
      candidates = candidates.filter((g) => teamIdsOf(g).includes(only));
    }

    // Doubleheader disambiguation.
    if (candidates.length > 1) {
      // Same matchup, multiple gameNumbers?
      const byMatchup = new Map();
      candidates.forEach((g) => {
        const ids = teamIdsOf(g).slice().sort().join('-');
        byMatchup.set(ids, (byMatchup.get(ids) || []).concat([g]));
      });
      if (cueGameN != null) {
        candidates = candidates.filter((g) => Number(g.gameNumber) === cueGameN || (cueGameN === 1 && (g.gameNumber == null || g.doubleHeader === 'N')));
      }
      if (candidates.length > 1) {
        return {
          status: 'ambiguous', games: candidates.map((g) => summary(g, 'doubleheader-or-multiple')),
          teamsFound: found.ids, evidence: found.hits.map((h) => h.phrase),
          abstainReason: cueGameN == null ? 'multiple-games-no-game-number' : 'multiple-games-after-game-number',
        };
      }
    }

    if (candidates.length === 1) {
      const g = candidates[0];
      // If the slate itself is a doubleheader for this matchup and no game
      // number was supplied, refuse — even when filter left one (shouldn't).
      const siblings = list.filter((x) => {
        const a = teamIdsOf(x).slice().sort().join('-');
        const b = teamIdsOf(g).slice().sort().join('-');
        return a === b && x.gamePk !== g.gamePk;
      });
      if (siblings.length && cueGameN == null && (g.doubleHeader === 'Y' || g.doubleHeader === 'S' || siblings.some((s) => s.doubleHeader === 'Y' || s.doubleHeader === 'S'))) {
        return {
          status: 'ambiguous', games: [summary(g, 'doubleheader-sibling'), ...siblings.map((s) => summary(s, 'doubleheader-sibling'))],
          teamsFound: found.ids, evidence: found.hits.map((h) => h.phrase),
          abstainReason: 'doubleheader-without-game-number',
        };
      }
      return {
        status: 'matched',
        games: [summary(g, found.ids.length >= 2 ? 'both-teams' : 'single-team-unique')],
        teamsFound: found.ids,
        evidence: found.hits.map((h) => h.phrase),
        abstainReason: null,
      };
    }

    if (!candidates.length) {
      return {
        status: 'unmatched', games: [], teamsFound: found.ids,
        evidence: found.hits.map((h) => h.phrase),
        abstainReason: cueDate ? 'date-disagreement' : 'team-not-on-slate',
      };
    }
    return {
      status: 'ambiguous', games: candidates.map((g) => summary(g, 'multiple')),
      teamsFound: found.ids, evidence: found.hits.map((h) => h.phrase),
      abstainReason: 'multiple-candidates',
    };
  }

  function summary(g, reason) {
    const ids = teamIdsOf(g);
    return {
      gamePk: g.gamePk,
      awayId: ids[0] != null ? ids[0] : null,
      homeId: ids[1] != null ? ids[1] : null,
      listingDate: g._listingDate || g.officialDate || null,
      doubleHeader: g.doubleHeader || 'N',
      gameNumber: g.gameNumber != null ? g.gameNumber : null,
      reason,
    };
  }

  /**
   * Extract explicit restart / first-pitch announcement times from prose.
   * Returns an array of {
   *   hour24: number|null,  // 0–23 when am/pm present; null if 12h clock without am/pm
   *   hour: number, minute: number,
   *   ampm: string|null, zone: string|null,
   *   evidence: string,     // exact matched substring
   *   kind: 'restart'|'first-pitch'|'resume'
   * }
   * Speculative sentences are dropped entirely.
   */
  function extractAnnouncedTimes(text) {
    const src = String(text || '');
    if (!src.trim()) return [];
    // Reject whole-string speculative framing up front when the only cues are soft.
    const out = [];
    const seen = new Set();
    ANNOUNCE_FRAMES.forEach((re) => {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src)) !== null) {
        const evidence = m[0].replace(/\s+/g, ' ').trim();
        // Local window around the match: reject if speculative words sit next to it.
        const windowStart = Math.max(0, m.index - 40);
        const windowEnd = Math.min(src.length, m.index + evidence.length + 40);
        const window = src.slice(windowStart, windowEnd);
        if (SPECULATIVE.test(window) && !/\b(?:now\s+set|announced|official(?:ly)?\s+set)\b/i.test(window)) {
          continue;
        }
        const hourRaw = parseInt(m[1], 10);
        const minute = m[2] != null && m[2] !== '' ? parseInt(m[2], 10) : 0;
        let ampm = (m[3] || '').replace(/\./g, '').toLowerCase() || null;
        if (ampm === 'a') ampm = 'am';
        if (ampm === 'p') ampm = 'pm';
        if (ampm === 'am' || ampm === 'pm') { /* ok */ } else if (!ampm) ampm = null;
        else ampm = ampm.slice(0, 2) === 'am' ? 'am' : ampm.slice(0, 2) === 'pm' ? 'pm' : null;
        let zone = (m[4] || '').trim() || null;
        if (zone) zone = zone.replace(/\s+/g, ' ');
        if (!Number.isFinite(hourRaw) || hourRaw < 0 || hourRaw > 23) continue;
        if (!Number.isFinite(minute) || minute < 0 || minute > 59) continue;
        // 12-hour clock without am/pm keeps hour24 null (no invention of a.m./p.m.).
        // 24-hour style is accepted only when the hour is 13–23 (unambiguous) or
        // exactly 0 with minutes (00:15). Hours 1–12 without am/pm stay unresolved.
        let hour24 = null;
        if (ampm === 'am' || ampm === 'pm') {
          const h12 = hourRaw % 12;
          hour24 = ampm === 'pm' ? h12 + 12 : h12;
          if (ampm === 'am' && hourRaw === 12) hour24 = 0;
          if (ampm === 'pm' && hourRaw === 12) hour24 = 12;
        } else if (!ampm && m[2] != null && ((hourRaw >= 13 && hourRaw <= 23) || hourRaw === 0)) {
          hour24 = hourRaw;
        }
        const kind = /first\s+pitch|first\s+ball/i.test(evidence) ? 'first-pitch'
          : /resum/i.test(evidence) ? 'resume'
          : 'restart';
        const key = `${hourRaw}:${String(minute).padStart(2, '0')}|${ampm || ''}|${zone || ''}|${kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          hour: hourRaw,
          minute,
          ampm,
          zone,
          hour24,
          evidence,
          kind,
          display: formatAnnounced(hourRaw, minute, ampm, zone),
        });
      }
    });
    return out;
  }

  function formatAnnounced(hour, minute, ampm, zone) {
    const hh = String(hour);
    const mm = String(minute).padStart(2, '0');
    const ap = ampm ? ` ${ampm}` : '';
    const z = zone ? ` ${zone}` : '';
    return `${hh}:${mm}${ap}${z}`.replace(/\s+/g, ' ').trim();
  }

  /**
   * Annotate a list of prepared report items with match + announced-time info
   * against a slate of games. Pure; does not mutate the input items.
   */
  function annotate(items, games, opts = {}) {
    const list = Array.isArray(games) ? games : [];
    const aliasIndex = buildAliasIndex(list);
    const refYear = opts.refYear || (list[0] && (list[0]._listingDate || list[0].officialDate || '').slice(0, 4)) || null;
    return (Array.isArray(items) ? items : []).map((item) => {
      const match = matchItem(item, list, { aliasIndex, refYear: refYear ? parseInt(refYear, 10) : null });
      const times = extractAnnouncedTimes(`${item.title || ''} ${item.description || ''}`);
      return { ...item, match, announcedTimes: times };
    });
  }

  return {
    EXTRA_ALIASES,
    buildAliasIndex, findTeams, matchItem, extractAnnouncedTimes, annotate,
    gameNumberCue, dateCue, norm,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Match;
