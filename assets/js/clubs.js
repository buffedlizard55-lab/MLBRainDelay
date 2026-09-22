/* ============================================================================
 * clubs.js — official club pages & verified accounts for MANUAL review
 * ----------------------------------------------------------------------------
 * A static GitHub Page cannot read X/Twitter, Facebook, Instagram, Reddit or
 * Meta's Threads without authorized API credentials (anonymous reads are
 * blocked, CORS is denied, and most of those endpoints now require
 * authentication). Nothing on this site is scraped from social media.
 *
 * Instead, this module surfaces discovery links to every OFFICIAL channel
 * each club operates, plus the major independent MLB newsrooms whose
 * reporters cover rain delays. These are HUMAN-REVIEW links — the user opens
 * them in a new tab to verify a start time or an announced restart.
 *
 * Slugs are the club paths used by MLB.com (https://www.mlb.com/{slug}),
 * keyed by the StatsAPI team id from GET /api/v1/teams?sportId=1.
 * Official X/Twitter handles use the handles published on each club's
 * MLB.com page (verified 2026-09-21).
 * ==========================================================================*/
'use strict';

const Clubs = (() => {
  const SLUG_BY_TEAM_ID = {
    108: 'angels', 109: 'dbacks', 110: 'orioles', 111: 'redsox', 112: 'cubs',
    113: 'reds', 114: 'guardians', 115: 'rockies', 116: 'tigers', 117: 'astros',
    118: 'royals', 119: 'dodgers', 120: 'nationals', 121: 'mets', 133: 'athletics',
    134: 'pirates', 135: 'padres', 136: 'mariners', 137: 'giants', 138: 'cardinals',
    139: 'rays', 140: 'rangers', 141: 'bluejays', 142: 'twins', 143: 'phillies',
    144: 'braves', 145: 'whitesox', 146: 'marlins', 147: 'yankees', 158: 'brewers',
  };

  /**
   * Verified official X/Twitter handles per club (published on each club's
   * MLB.com page — the handle the club itself links from its official site).
   * These are discovery links for MANUAL review, not data sources the app reads.
   */
  const X_HANDLE_BY_TEAM_ID = {
    108: 'Angels', 109: 'Dbacks', 110: 'Orioles', 111: 'RedSox', 112: 'Cubs',
    113: 'Reds', 114: 'CleGuardians', 115: 'Rockies', 116: 'Tigers', 117: 'astros',
    118: 'Royals', 119: 'Dodgers', 120: 'Nationals', 121: 'Mets', 133: 'Athletics',
    134: 'Pirates', 135: 'Padres', 136: 'Mariners', 137: 'SFGiants', 138: 'Cardinals',
    139: 'RaysBaseball', 140: 'Rangers', 141: 'BlueJays', 142: 'Twins', 143: 'Phillies',
    144: 'Braves', 145: 'whitesox', 146: 'Marlins', 147: 'Yankees', 158: 'Brewers',
  };

  function slug(teamId) { return SLUG_BY_TEAM_ID[teamId] || null; }
  function xHandle(teamId) { return X_HANDLE_BY_TEAM_ID[teamId] || null; }

  function teamName(team) {
    return (team && (team.teamName || team.name)) || 'club';
  }

  /** Links for one team: official MLB.com club page + news + official social. */
  function links(team) {
    const id = team && team.id;
    const s = slug(id);
    if (!s) return [];
    const name = teamName(team);
    const out = [
      { label: `${name} — club news (MLB.com, official)`, url: `https://www.mlb.com/${s}/news`, kind: 'official' },
      { label: `${name} — official site`, url: `https://www.mlb.com/${s}`, kind: 'official' },
      { label: `${name} — Gameday`, url: `https://www.mlb.com/${s}/scores`, kind: 'official' },
    ];
    const handle = xHandle(id);
    if (handle) {
      out.push({ label: `@${handle} — official club X/Twitter`, url: `https://x.com/${handle}`, kind: 'social' });
    }
    return out;
  }

  /** Links for both clubs in a game. */
  function gameLinks(game) {
    const out = [];
    if (!game || !game.teams) return out;
    ['away', 'home'].forEach((side) => {
      const t = game.teams[side] && game.teams[side].team;
      links(t).forEach((l) => out.push(l));
    });
    return out;
  }

  /**
   * One official club-news link per team in a list of games (de-duplicated
   * by team id, in schedule order). The club's MLB.com news page is the
   * official place where tarp / delay / first-pitch updates are posted —
   * the human check point for anything the StatsAPI does not yet show.
   */
  function newsLinks(games) {
    const seen = new Set();
    const out = [];
    (Array.isArray(games) ? games : []).forEach((g) => {
      if (!g || !g.teams) return;
      ['away', 'home'].forEach((side) => {
        const t = g.teams[side] && g.teams[side].team;
        const id = t && t.id;
        const s = id != null ? slug(id) : null;
        if (!s || seen.has(id)) return;
        seen.add(id);
        const name = teamName(t);
        out.push({ label: `${name} news (official MLB.com)`, url: `https://www.mlb.com/${s}/news`, kind: 'official' });
        const handle = xHandle(id);
        if (handle) out.push({ label: `@${handle} (official X/Twitter)`, url: `https://x.com/${handle}`, kind: 'social' });
      });
    });
    return out;
  }

  /**
   * League-wide / independent channels the user can open when verifying
   * a delay. These are editorial outlets, not official club statements.
   */
  const INDEPENDENT_CHANNELS = [
    { label: 'MLB.com News (league)', url: 'https://www.mlb.com/news', kind: 'official' },
    { label: 'MLB.com Scores', url: 'https://www.mlb.com/scores', kind: 'official' },
    { label: '@MLB (league X/Twitter)', url: 'https://x.com/MLB', kind: 'social' },
    { label: '@MLB_PR (league PR)', url: 'https://x.com/MLB_PR', kind: 'social' },
    { label: 'ESPN MLB', url: 'https://www.espn.com/mlb/', kind: 'independent' },
    { label: 'The Associated Press — MLB', url: 'https://apnews.com/hub/mlb', kind: 'independent' },
    { label: 'USA Today — MLB', url: 'https://www.usatoday.com/sports/mlb/', kind: 'independent' },
    { label: 'Reuters Sports', url: 'https://www.reuters.com/sports/', kind: 'independent' },
    { label: 'r/baseball (community, NOT official)', url: 'https://www.reddit.com/r/baseball/', kind: 'community' },
  ];

  /**
   * Official weather / government channels for manual review.
   */
  const WEATHER_CHANNELS = [
    { label: 'NWS — weather.gov', url: 'https://www.weather.gov/', kind: 'gov' },
    { label: 'NWS radar (national mosaic)', url: 'https://radar.weather.gov/', kind: 'gov' },
    { label: 'SPC convective outlook', url: 'https://www.spc.noaa.gov/products/outlook/', kind: 'gov' },
    { label: 'NWS Weather Prediction Center', url: 'https://www.wpc.ncep.noaa.gov/', kind: 'gov' },
    { label: 'Lightning detection (Vaisala/NOAA)', url: 'https://www.lightningmaps.org/', kind: 'ref' },
    { label: 'Environment Canada — warnings', url: 'https://weather.gc.ca/warnings/index_e.html', kind: 'gov' },
    { label: 'ECCC Canadian radar', url: 'https://weather.gc.ca/radar/index_e.html', kind: 'gov' },
  ];

  return {
    SLUG_BY_TEAM_ID, X_HANDLE_BY_TEAM_ID,
    slug, xHandle, links, gameLinks, newsLinks,
    INDEPENDENT_CHANNELS, WEATHER_CHANNELS,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Clubs;
