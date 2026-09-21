/* ============================================================================
 * scoreboard.js — today's games, mlb.com scoreboard style, plus the official
 * weather / delay layer on every card:
 *   - official MLB game weather string (weather.condition/temp/wind)
 *   - roof type + roof state (venue.fieldInfo.roofType / "Roof Closed")
 *   - forecast-risk chip for the game window (NWS / ECCC / Open-Meteo)
 *   - active weather alerts at the ballpark (count + severe highlight)
 *   - official delay status / reason / minutes + reschedule info
 *   - irregularity count (every cross-check that disagreed)
 * ==========================================================================*/
'use strict';

(() => {
  // Hydrated schedule: 15s while anything is live (scores, statuses, official
  // weather string), 60s otherwise. A tiny status-only sweep runs faster so a
  // "Delayed" flip shows within seconds without re-downloading hydrations.
  const LIVE_POLL_MS = 15000;
  const IDLE_POLL_MS = 60000;
  const STATUS_POLL_MS = 5000;
  const STATUS_IDLE_MS = 30000;
  const WEATHER_REFRESH_MS = 5 * 60 * 1000;

  let dateStr = todayStr();
  let games = [];
  let filter = 'all';
  let pollTimer = null;
  let statusTimer = null;
  let requestInFlight = false;
  let statusInFlight = false;
  let lastCycleStartedAt = 0;
  let statusCodes = new Map();
  const weatherByPk = new Map(); // gamePk -> Weather.forGame() result
  const inspections = new Map(); // gamePk -> Delays.inspectGame()
  let lastWeatherRunAt = 0;
  let weatherRunning = false;

  /* ------------------------------------------------------------------ state */

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function shiftDate(days) {
    const d = new Date(`${dateStr}T12:00:00`);
    d.setDate(d.getDate() + days);
    dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function resetForDate() {
    games = [];
    statusCodes = new Map();
    weatherByPk.clear();
    inspections.clear();
    lastWeatherRunAt = 0;
  }

  /* ------------------------------------------------------------------ fetch */

  async function load() {
    if (requestInFlight) return;
    const requestDate = dateStr;
    requestInFlight = true;
    lastCycleStartedAt = Date.now();
    const listEl = $('#game-list');
    const banner = $('#banner');
    const statusLine = $('#status-line');

    if (!games.length) UI.clear(listEl).appendChild(UI.el('div', 'spinner'));
    const errBox = banner.querySelector('.banner-error');
    if (errBox) errBox.remove();
    if (!games.length) statusLine.textContent = 'Loading…';

    try {
      const nextGames = await MLB.getSchedule(requestDate);
      if (requestDate !== dateStr) return;
      games = nextGames;
      games.forEach((g) => inspections.set(g.gamePk, Delays.inspectGame(g)));
      render();
      statusLine.textContent =
        `${games.length} game${games.length === 1 ? '' : 's'} · ` +
        `${games.filter((g) => g.status.abstractGameState === 'Live').length} in progress · ` +
        `${games.filter((g) => (inspections.get(g.gamePk) || {}).active).length} delayed now · ` +
        `updated ${new Date().toLocaleTimeString()}`;
      scheduleNext();
      refreshWeather(requestDate);
    } catch (err) {
      if (requestDate !== dateStr) return;
      console.error(err);
      if (!games.length) UI.clear(listEl);
      const box = UI.el('div', 'banner-error',
        `Couldn't reach the MLB StatsAPI (${err.message || err}). Check your connection — retrying automatically. `);
      box.appendChild(UI.el('button', 'btn', 'Retry now', { onclick: 'Scoreboard.retry()' }));
      banner.prepend(box);
      statusLine.textContent = 'Load failed — retrying soon';
      scheduleNext(10000);
    } finally {
      requestInFlight = false;
      if (requestDate !== dateStr) load();
    }
  }

  function scheduleNext(overrideMs) {
    clearTimeout(pollTimer);
    const hasLiveGame = games.some((g) => g.status.abstractGameState === 'Live' || (inspections.get(g.gamePk) || {}).active);
    const interval = overrideMs != null ? overrideMs : (hasLiveGame ? LIVE_POLL_MS : IDLE_POLL_MS);
    const elapsed = lastCycleStartedAt ? Date.now() - lastCycleStartedAt : 0;
    const wait = overrideMs != null ? overrideMs : Math.max(0, interval - elapsed);
    pollTimer = setTimeout(() => {
      if (!document.hidden) load();
      else scheduleNext();
    }, wait);
  }

  /* ----------------------------------------------------- status watcher */

  function statusSignature(s) {
    return [s.abstractGameState || '', s.codedGameState || '', s.statusCode || '', s.detailedState || '', s.reason || ''].join('|');
  }

  /** Pure diff of a status sweep against the last observed signatures. */
  function statusFlips(prevCodes, list) {
    const codes = new Map();
    (list || []).forEach((g) => {
      if (!g || g.gamePk == null || !g.status) return;
      codes.set(g.gamePk, statusSignature(g.status));
    });
    let changed = false;
    if (prevCodes && prevCodes.size) {
      if (prevCodes.size !== codes.size) changed = true;
      codes.forEach((sig, pk) => { if (prevCodes.get(pk) !== sig) changed = true; });
    }
    return { changed, codes };
  }

  function statusIntervalMs() {
    if (document.hidden) return STATUS_IDLE_MS;
    const canFlip = games.some((g) => g && g.status && (g.status.abstractGameState !== 'Final'));
    return canFlip ? STATUS_POLL_MS : STATUS_IDLE_MS;
  }

  function scheduleStatus(initialFast) {
    clearTimeout(statusTimer);
    const wait = initialFast ? 1500 : statusIntervalMs();
    statusTimer = setTimeout(() => {
      if (document.hidden) { scheduleStatus(); return; }
      pollStatus();
    }, wait);
  }

  async function pollStatus() {
    if (statusInFlight || requestInFlight) { scheduleStatus(); return; }
    statusInFlight = true;
    const requestDate = dateStr;
    try {
      const list = await MLB.getStatusSweep(requestDate);
      if (requestDate !== dateStr) return;
      const { changed, codes } = statusFlips(statusCodes, list);
      statusCodes = codes;
      if (changed && games.length) {
        const byPk = new Map(list.map((g) => [g.gamePk, g]));
        games.forEach((g) => {
          const fresh = byPk.get(g.gamePk);
          if (!fresh) return;
          g.status = Object.assign({}, fresh.status || {}); // replace, not merge: no stale `reason`
          ['rescheduleDate', 'rescheduleGameDate', 'rescheduledFrom', 'rescheduledFromDate', 'resumeDate', 'resumedFrom'].forEach((k) => {
            if (fresh[k] != null) g[k] = fresh[k];
          });
          inspections.set(g.gamePk, Delays.inspectGame(g));
        });
        render();
        scheduleNext(0); // a status flip usually means new hydrated data too
      }
    } catch (_) {
      // quiet: the hydrated poll keeps the page correct on its own cadence
    } finally {
      statusInFlight = false;
      scheduleStatus();
    }
  }

  /* ------------------------------------------------------------ weather */

  async function refreshWeather(requestDate, force) {
    if (weatherRunning) return;
    if (!force && Date.now() - lastWeatherRunAt < WEATHER_REFRESH_MS && weatherByPk.size) return;
    weatherRunning = true;
    lastWeatherRunAt = Date.now();
    try {
      const list = games.slice();
      // Group by venue so a doubleheader / shared park is fetched once.
      await Promise.all(list.map(async (g) => {
        try {
          const wx = await Weather.forGame(g);
          if (requestDate !== dateStr) return;
          weatherByPk.set(g.gamePk, wx);
        } catch (err) {
          console.warn('weather', g.gamePk, err);
        }
      }));
      if (requestDate === dateStr) render();
    } finally {
      weatherRunning = false;
    }
  }

  function updateDateLabel() {
    const labelDate = new Date(`${dateStr}T12:00:00`);
    $('#date-label').textContent = labelDate.toLocaleDateString([], {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    });
    $('#date-picker').value = dateStr;
  }

  /* ---------------------------------------------------------------- render */

  function riskOf(g) {
    const wx = weatherByPk.get(g.gamePk);
    return wx && wx.risk ? wx.risk : null;
  }

  function render() {
    const listEl = $('#game-list');
    UI.clear(listEl);

    const byState = { Preview: [], Live: [], Final: [], Other: [] };
    const activeDelays = [];
    const disrupted = [];
    const wetForecast = [];
    const alerted = [];
    const flagged = [];

    games.forEach((g) => {
      const key = byState[g.status.abstractGameState] ? g.status.abstractGameState : 'Other';
      byState[key].push(g);
      const ins = inspections.get(g.gamePk);
      if (ins && ins.active) activeDelays.push(g);
      if (ins && ins.hadDelay) disrupted.push(g);
      const risk = riskOf(g);
      if (risk && (risk.level === 'high' || risk.level === 'moderate')) wetForecast.push(g);
      if (risk && risk.alerts && risk.alerts.length) alerted.push(g);
      if (allFlags(g).length) flagged.push(g);
    });

    renderDelayTicker(activeDelays);

    // Active delays first, then live, previews, finals.
    const ordered = [
      ...activeDelays,
      ...byState.Live.filter((g) => !activeDelays.includes(g)),
      ...byState.Preview.filter((g) => !activeDelays.includes(g)),
      ...byState.Final,
      ...byState.Other.filter((g) => !activeDelays.includes(g)),
    ];

    const filtered = filter === 'all' ? ordered : ordered.filter((g) => {
      if (filter === 'live') return g.status.abstractGameState === 'Live';
      if (filter === 'scheduled') return g.status.abstractGameState === 'Preview';
      if (filter === 'final') return g.status.abstractGameState === 'Final';
      if (filter === 'delays') return disrupted.includes(g);
      if (filter === 'forecast') return wetForecast.includes(g);
      if (filter === 'alerts') return alerted.includes(g);
      if (filter === 'flags') return flagged.includes(g);
      return true;
    });

    renderTabs({
      all: games.length, live: byState.Live.length, scheduled: byState.Preview.length,
      final: byState.Final.length, delays: disrupted.length, forecast: wetForecast.length,
      alerts: alerted.length, flags: flagged.length,
    });

    if (!filtered.length) {
      listEl.appendChild(UI.el('div', 'empty', games.length ? 'No games in this category.' : 'No games scheduled for this date.'));
      return;
    }
    filtered.forEach((game) => listEl.appendChild(gameCard(game)));
    wireScoreBumps();
  }

  /** Every irregularity known for a game on this page (status + weather). */
  function allFlags(g) {
    const ins = inspections.get(g.gamePk);
    const wx = weatherByPk.get(g.gamePk);
    const out = [];
    if (ins) out.push(...ins.flags);
    if (wx) {
      out.push(...(wx.issues || []).filter((i) => i.code !== 'stale').map((i) => ({ code: i.code, text: i.text })));
      out.push(...Delays.weatherConsistencyFlags(g, wx.risk));
    }
    return out;
  }

  function teamLabel(t, fallback) {
    if (!t) return fallback;
    return t.abbreviation || t.teamName || t.name || fallback;
  }

  function renderDelayTicker(list) {
    const banner = $('#banner');
    const old = banner.querySelector('.delay-ticker');
    if (old) old.remove();
    if (!list.length) return;
    const bar = UI.el('div', 'delay-ticker');
    bar.appendChild(UI.el('span', 'delay-ticker-badge', '⏸ ACTIVE DELAYS'));
    const items = UI.el('div', 'review-ticker-items');
    list.forEach((g) => {
      const ins = inspections.get(g.gamePk);
      const item = UI.el('a', 'review-ticker-link', '', { href: `game.html?gamePk=${g.gamePk}` });
      item.appendChild(UI.el('span', 'ticker-game', `${teamLabel(g.teams.away.team, 'AWY')} @ ${teamLabel(g.teams.home.team, 'HOM')}`));
      if (g.linescore && g.status.abstractGameState === 'Live') item.appendChild(UI.el('span', 'ticker-inn', MLB.inningLabel(g.linescore, g.status)));
      item.appendChild(UI.el('span', 'ticker-type', Delays.statusLabel(ins.status)));
      item.appendChild(UI.el('span', 'ticker-cta', 'View →'));
      items.appendChild(item);
    });
    items.appendChild(UI.el('a', 'ticker-feed-link', '🌧 Open the all-games delay feed →', { href: `delays.html?date=${dateStr}` }));
    bar.appendChild(items);
    banner.appendChild(bar);
  }

  function renderTabs(counts) {
    const tabs = [
      ['all', `All (${counts.all})`],
      ['live', `Live (${counts.live})`],
      ['scheduled', `Scheduled (${counts.scheduled})`],
      ['final', `Final (${counts.final})`],
    ];
    if (counts.delays > 0) tabs.push(['delays', `⏸ Delays (${counts.delays})`]);
    if (counts.forecast > 0) tabs.push(['forecast', `🌧 Rain risk (${counts.forecast})`]);
    if (counts.alerts > 0) tabs.push(['alerts', `⚠ Alerts (${counts.alerts})`]);
    if (counts.flags > 0) tabs.push(['flags', `🚩 Flagged (${counts.flags})`]);
    const wrap = UI.clear($('#tabs'));
    tabs.forEach(([key, label]) => {
      wrap.appendChild(UI.el('button', `tab ${filter === key ? 'tab-on' : ''}`, label, {
        onclick: `Scoreboard.setFilter('${key}')`,
      }));
    });
    if (filter !== 'all' && !tabs.some(([k]) => k === filter)) { filter = 'all'; }
  }

  /* ------------------------------------------------------------ game cards */

  function officialWeatherText(g) {
    const w = g.weather || {};
    const parts = [];
    if (w.condition) parts.push(w.condition);
    if (w.temp) parts.push(`${w.temp}°F`);
    if (w.wind) parts.push(`wind ${w.wind}`);
    return parts.join(' · ');
  }

  function gameCard(game) {
    const gd = game.gameDate;
    const status = game.status;
    const isLive = status.abstractGameState === 'Live';
    const isFinal = status.abstractGameState === 'Final';
    const away = game.teams.away;
    const home = game.teams.home;
    const ls = game.linescore || null;
    const ins = inspections.get(game.gamePk) || Delays.inspectGame(game);
    const wx = weatherByPk.get(game.gamePk) || null;
    const risk = wx ? wx.risk : null;
    const tz = game.venue && game.venue.timeZone && game.venue.timeZone.id;

    const card = UI.el('a', `card game-card ${isLive ? 'card-live' : ''} ${ins.active ? 'card-delay-active' : ins.hadDelay ? 'card-delayed' : ''}`);
    card.href = `game.html?gamePk=${game.gamePk}`;

    /* header: status chip + start time / venue */
    const head = UI.el('div', 'card-head');
    let chipLabel = null;
    if ((isLive || isFinal) && ls && !ins.active) chipLabel = MLB.inningLabel(ls, status);
    if (ins.disrupted) {
      const label = Delays.statusLabel(ins.status);
      head.appendChild(UI.kindChip(ins.status.kind, label));
    } else {
      head.appendChild(UI.statusChip(status, chipLabel));
    }
    const venueName = (game.venue && game.venue.name) || '';
    head.appendChild(UI.el('span', 'card-meta',
      isLive && ls ? `${MLB.inningGlyph(ls)} ${ls.currentInningOrdinal || ''} · ${venueName}` :
      isFinal ? venueName :
      `${MLB.startLabel(game)} · ${venueName}`));

    /* team rows */
    const body = UI.el('div', 'card-body');
    [['away', away], ['home', home]].forEach(([side, t]) => {
      const row = UI.el('div', `card-row row-${side}`);
      row.appendChild(UI.teamLogo(t.team.id, t.team.name, t.team.abbreviation, 'card-logo'));
      const nameWrap = UI.el('span', 'card-team');
      nameWrap.appendChild(UI.el('span', 'card-team-name', t.team.name));
      if (t.leagueRecord) nameWrap.appendChild(UI.el('span', 'card-record', `${t.leagueRecord.wins}-${t.leagueRecord.losses}`));
      row.appendChild(nameWrap);
      const score = UI.el('span', `card-score ${isFinal ? (t.isWinner ? 'score-win' : '') : ''}`);
      score.dataset.score = `${side}:${MLB.scoreOf(game, side)}`;
      score.textContent = MLB.scoreOf(game, side) == null ? '' : MLB.scoreOf(game, side);
      row.appendChild(score);
      body.appendChild(row);
    });

    /* weather strip */
    const strip = UI.el('div', 'wx-strip');
    const roof = wx ? wx.roof : Weather.roofInfo(game);
    if (risk) {
      strip.appendChild(UI.riskChip(risk.level, null, risk.reasons.join(' ')));
      strip.appendChild(UI.el('span', 'wx-summary', Weather.summaryText(risk, tz)));
    } else if (roof.covered) {
      strip.appendChild(UI.riskChip('covered'));
    } else {
      strip.appendChild(UI.riskChip('unknown', 'Forecast…'));
    }
    if (roof.roofType && roof.roofType !== 'Open') strip.appendChild(UI.el('span', 'wx-roof', roof.label));
    if (risk && risk.alerts && risk.alerts.length) {
      const severe = risk.alerts.some((a) => a.kind.severe);
      strip.appendChild(UI.el('span', 'wx-alert-count', `${severe ? '🚨' : '⚠'} ${risk.alerts.length} alert${risk.alerts.length === 1 ? '' : 's'}`));
    }
    const flags = allFlags(game);
    if (flags.length) strip.appendChild(UI.el('span', 'wx-flag-count', `🚩 ${flags.length}`));
    if (wx && wx.provider && wx.provider !== 'nws') strip.appendChild(UI.el('span', 'chip chip-provider', wx.provider === 'eccc' ? 'ECCC' : 'Open-Meteo'));
    const officialWx = officialWeatherText(game);
    if (officialWx) strip.appendChild(UI.el('span', 'card-official-weather', `MLB: ${officialWx}`));

    /* footer: delay facts / probables / count / decisions */
    const foot = UI.el('div', 'card-foot');
    if (ins.hadDelay) {
      const bits = [];
      if (ins.official.delayMinutes != null && ins.official.delayMinutes > 0) bits.push(`${MLB.fmtMinutes(ins.official.delayMinutes)} official delay`);
      if (ins.reschedule && ins.reschedule.toDate) bits.push(`makeup ${ins.reschedule.toDate}${ins.reschedule.toIso ? ` ${MLB.localTime(ins.reschedule.toIso)}` : ''}`);
      if (ins.resume && (ins.resume.toDate || ins.resume.toIso)) bits.push(`resumes ${ins.resume.toDate || MLB.localDate(ins.resume.toIso)}`);
      if (ins.official.firstPitch && ins.official.startDelayMinutes > 0 && ins.status.kind !== 'postponed') bits.push(`first pitch ${MLB.localTime(ins.official.firstPitch)} (+${ins.official.startDelayMinutes}m)`);
      foot.appendChild(UI.el('span', `card-delay-indicator ${ins.active ? 'card-delay-active' : ''}`,
        `${ins.active ? '⏸ ' : '⏱ '}${bits.join(' · ') || ins.status.detailedState}`));
    }
    if (ins.makeupOf) foot.appendChild(UI.el('span', 'card-probables', ins.makeupOf.description || `Makeup of ${ins.makeupOf.fromDate}`));
    if (isLive && ls && !ins.active) {
      foot.appendChild(UI.countDots(ls.balls, ls.strikes, ls.outs, 'card-count'));
    } else if (isFinal) {
      const d = game.decisions;
      const pieces = [];
      if (d && d.winner) pieces.push(`W: ${d.winner.fullName}`);
      if (d && d.loser) pieces.push(`L: ${d.loser.fullName}`);
      if (d && d.save) pieces.push(`SV: ${d.save.fullName}`);
      if (pieces.length) foot.appendChild(UI.el('span', 'card-decisions', pieces.join(' · ')));
    } else if (!ins.hadDelay) {
      const pp = game.probablePitchers;
      const awayP = pp && pp.away;
      const homeP = pp && pp.home;
      if (awayP || homeP) {
        foot.appendChild(UI.el('span', 'card-probables', `Probables: ${awayP ? awayP.fullName : 'TBD'} vs ${homeP ? homeP.fullName : 'TBD'}`));
      } else if (game.description) {
        foot.appendChild(UI.el('span', 'card-probables', game.description));
      }
    }
    card.appendChild(head);
    card.appendChild(body);
    card.appendChild(strip);
    card.appendChild(foot);
    return card;
  }

  function wireScoreBumps() {
    document.querySelectorAll('.card-score').forEach((node) => {
      const prev = node.dataset.prev;
      const cur = node.dataset.score;
      if (prev && prev !== cur) {
        node.classList.add('bump');
        setTimeout(() => node.classList.remove('bump'), 1200);
      }
      node.dataset.prev = cur;
    });
  }

  /* ------------------------------------------------------------------ boot */

  window.Scoreboard = {
    retry() { load(); },
    _statusFlips: statusFlips,
    setFilter(f) { filter = f; render(); },
    prevDay() { shiftDate(-1); syncUrl(); updateDateLabel(); resetForDate(); load(); },
    nextDay() { shiftDate(1); syncUrl(); updateDateLabel(); resetForDate(); load(); },
    today() { dateStr = todayStr(); syncUrl(); updateDateLabel(); resetForDate(); load(); },
    pickDate() {
      const d = $('#date-picker').value;
      if (d) { dateStr = d; syncUrl(); updateDateLabel(); resetForDate(); load(); }
    },
    refreshWeather() { refreshWeather(dateStr, true); },
  };

  function syncUrl() {
    const url = new URL(window.location);
    url.searchParams.set('date', dateStr);
    window.history.replaceState({}, '', url);
    const feedLink = $('#feed-link');
    if (feedLink) feedLink.href = `delays.html?date=${dateStr}`;
  }

  function $(sel) { return document.querySelector(sel); }

  document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    const d = params.get('date');
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) dateStr = d;
    $('#date-picker').value = dateStr;
    updateDateLabel();
    syncUrl();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { scheduleStatus(); load(); }
      else clearTimeout(statusTimer);
    });
    scheduleStatus(true);
    load();
  });
})();
