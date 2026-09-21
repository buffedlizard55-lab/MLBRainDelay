/* ============================================================================
 * clubs.js — official club pages on MLB.com, for MANUAL review only
 * ----------------------------------------------------------------------------
 * A static GitHub Page cannot read X/Twitter, Facebook, Instagram or Reddit
 * (no API keys, anonymous reads blocked, no CORS), so nothing on this site is
 * scraped from social media. Instead each club's official MLB.com news page
 * is linked — that is where the club posts its own delay / tarp / first-pitch
 * updates and where its verified social accounts are listed.
 *
 * Slugs are the club paths used by MLB.com (https://www.mlb.com/{slug}),
 * keyed by the StatsAPI team id from GET /api/v1/teams?sportId=1.
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
  function slug(teamId) { return SLUG_BY_TEAM_ID[teamId] || null; }

  /** Links for one team: official MLB.com club page + club news feed. */
  function links(team) {
    const id = team && team.id;
    const s = slug(id);
    if (!s) return [];
    const name = (team && (team.teamName || team.name)) || s;
    return [
      { label: `${name} — club news (MLB.com)`, url: `https://www.mlb.com/${s}/news` },
      { label: `${name} — official site`, url: `https://www.mlb.com/${s}` },
    ];
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
        const name = (t && (t.teamName || t.name)) || s;
        out.push({ label: `${name} news (MLB.com)`, url: `https://www.mlb.com/${s}/news` });
      });
    });
    return out;
  }

  return { SLUG_BY_TEAM_ID, slug, links, gameLinks, newsLinks };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Clubs;
