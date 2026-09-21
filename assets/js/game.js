/* ============================================================================
 * game.js — one game: status, score, official weather, forecast + alerts at
 * the ballpark, the official delay timeline and every source URL.
 * ==========================================================================*/
'use strict';

(() => {
  const LIVE_POLL_MS = 20000;
  const IDLE_POLL_MS = 60000;
  const WEATHER_REFRESH_MS = 5 * 60 * 1000;

  const state = {
    gamePk: null,
    entries: [],     // every schedule entry for this gamePk (postponed + makeup)
    game: null,      // the primary entry
    ins: null,
    wx: null,
    pbp: null,       // { advisories, timeline, error }
    box: null,
    pollTimer: null,
    countdownTimer: null,
    nextPollAt: 0,
    inFlight: false,
    lastWeatherAt: 0,
    lastCycleStartedAt: 0,
  };

  function $(sel) { return document.querySelector(sel); }
  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /* ------------------------------------------------------------------ load */

  async function fetchEntries(gamePk) {
    const data = await MLB.getJSON(MLB.gameScheduleUrl(gamePk), { timeout: 6000 });
    const out = [];
    ((data && data.dates) || []).forEach((day) => {
      (day.games || []).forEach((g) => { if (g && g.gamePk === gamePk) { g._listingDate = day.date; out.push(g); } });
    });
    return out;
  }

  function pickPrimary(entries) {
    if (!entries.length) return null;
    // Prefer the entry that is (or will be) played; the postponed-date entry
    // becomes the "history" line.
    const playable = entries.filter((g) => !/^Postponed/i.test((g.status && g.status.detailedState) || ''));
    return playable.length ? playable[playable.length - 1] : entries[entries.length - 1];
  }

  async function load() {
    if (state.inFlight) return;
    state.inFlight = true;
    state.lastCycleStartedAt = Date.now();
    const banner = $('#banner');
    const err0 = banner.querySelector('.banner-error');
    if (err0) err0.remove();
    try {
      const entries = await fetchEntries(state.gamePk);
      if (!entries.length) throw new Error(`gamePk ${state.gamePk} is not on the MLB schedule`);
      state.entries = entries;
      state.game = pickPrimary(entries);
      state.ins = Delays.inspectGame(state.game);
      $('#loading').classList.remove('visible');
      renderHeader();
      renderDelayPanel();
      renderSources();
      const jobs = [];
      if (Date.now() - state.lastWeatherAt > WEATHER_REFRESH_MS || !state.wx) {
        state.lastWeatherAt = Date.now();
        jobs.push(Weather.forGame(state.game).then((wx) => { state.wx = wx; renderWeatherPanel(); }).catch((e) => console.warn('weather', e)));
      }
      const needsPbp = state.ins.hadDelay && !['postponed', 'cancelled'].includes(state.ins.status.kind);
      if (needsPbp && (!state.pbp || state.game.status.abstractGameState !== 'Final' || state.pbp.error)) {
        jobs.push(MLB.getPlayByPlay(state.gamePk).then((pbp) => {
          const advisories = Delays.extractAdvisories(pbp);
          state.pbp = { advisories, timeline: Delays.buildTimeline(advisories, state.game), error: null };
        }).catch((e) => { state.pbp = { advisories: [], timeline: [], error: e }; }));
      }
      const needsBox = state.game.status.abstractGameState === 'Final' && !state.box;
      if (needsBox) {
        jobs.push(MLB.getBoxscoreInfo(state.gamePk).then((info) => { state.box = Delays.parseBoxscoreInfo(info); }).catch((e) => { state.box = { error: e }; }));
      }
      jobs.push(MLB.getLinescore(state.gamePk).then((ls) => { state.game.linescore = ls; renderLinescore(); }).catch(() => renderLinescore()));
      await Promise.all(jobs);
      renderHeader();
      renderDelayPanel();
      renderWeatherPanel();
      renderSources();
      $('#status-line').textContent = `updated ${new Date().toLocaleTimeString()}`;
      scheduleNext();
    } catch (err) {
      console.error(err);
      $('#loading').classList.remove('visible');
      const box = UI.el('div', 'banner-error', `Couldn't load this game (${err.message || err}). `);
      box.appendChild(UI.el('button', 'btn', 'Retry', { onclick: 'GamePage.retry()' }));
      banner.prepend(box);
      scheduleNext(15000);
    } finally {
      state.inFlight = false;
    }
  }

  function scheduleNext(overrideMs) {
    clearTimeout(state.pollTimer);
    const g = state.game;
    const live = g && (g.status.abstractGameState === 'Live' || (state.ins && state.ins.active));
    const interval = overrideMs != null ? overrideMs : (g && g.status.abstractGameState === 'Final' ? IDLE_POLL_MS : live ? LIVE_POLL_MS : 30000);
    const elapsed = state.lastCycleStartedAt ? Date.now() - state.lastCycleStartedAt : 0;
    const wait = overrideMs != null ? overrideMs : Math.max(0, interval - elapsed);
    state.nextPollAt = Date.now() + wait;
    state.pollTimer = setTimeout(() => { if (!document.hidden) load(); else scheduleNext(); }, wait);
  }

  function tickCountdown() {
    const el = $('#countdown');
    if (!el) return;
    const sec = Math.max(0, Math.round((state.nextPollAt - Date.now()) / 1000));
    el.textContent = state.inFlight ? 'polling…' : (state.nextPollAt ? UI.fmtCountdown(sec) : '');
  }

  /* ---------------------------------------------------------------- header */

  function teamBlock(t, side) {
    const wrap = UI.el('div', `team-block ${side === 'home' ? 'team-home' : ''}`);
    wrap.appendChild(UI.teamLogo(t.team.id, t.team.name, t.team.abbreviation, 'header-logo'));
    const info = UI.el('div', 'team-block-info');
    info.appendChild(UI.el('div', 'team-block-name', t.team.name));
    if (t.leagueRecord) info.appendChild(UI.el('div', 'team-block-record', `${t.leagueRecord.wins}-${t.leagueRecord.losses}`));
    wrap.appendChild(info);
    return wrap;
  }

  function renderHeader() {
    const g = state.game;
    const ins = state.ins;
    document.title = `${g.teams.away.team.abbreviation || g.teams.away.team.name} @ ${g.teams.home.team.abbreviation || g.teams.home.team.name} — MLB Rain Delay`;
    UI.clear($('#header-away')).appendChild(teamBlock(g.teams.away, 'away'));
    UI.clear($('#header-home')).appendChild(teamBlock(g.teams.home, 'home'));
    const center = UI.clear($('#header-center'));
    const a = MLB.scoreOf(g, 'away');
    const h = MLB.scoreOf(g, 'home');
    center.appendChild(UI.el('div', 'big-score', a != null && h != null ? `${a} – ${h}` : MLB.startLabel(g)));
    if (ins.disrupted) {
      const label = ins.status.reason && !new RegExp(escapeRe(ins.status.reason), 'i').test(g.status.detailedState) ? `${g.status.detailedState}: ${ins.status.reason}` : g.status.detailedState;
      center.appendChild(UI.kindChip(ins.status.kind, label));
    } else {
      center.appendChild(UI.statusChip(g.status, g.linescore && g.status.abstractGameState !== 'Preview' ? MLB.inningLabel(g.linescore, g.status) : null));
    }
    if (g.linescore && g.status.abstractGameState === 'Live') center.appendChild(UI.el('div', 'header-inning', `${MLB.inningGlyph(g.linescore)} · ${g.linescore.balls}-${g.linescore.strikes}, ${g.linescore.outs} out`));

    const tz = g.venue && g.venue.timeZone && g.venue.timeZone.id;
    const v = g.venue || {};
    const loc = v.location || {};
    const metaBits = [
      g.status && g.status.startTimeTBD
        ? `${MLB.localDate(g.gameDate)} · start time TBD (MLB placeholder ${MLB.localTime(g.gameDate)} local)`
        : `${MLB.localDateTime(g.gameDate)} (${MLB.zonedTime(g.gameDate, tz)} at the park)`,
      [v.name, loc.city, loc.stateAbbrev].filter(Boolean).join(', '),
    ];
    if (g.doubleHeader && g.doubleHeader !== 'N') metaBits.push(`Doubleheader game ${g.gameNumber}`);
    if (g.description) metaBits.push(g.description);
    if (g.seriesDescription && g.gameType !== 'R') metaBits.push(g.seriesDescription);
    $('#header-meta').textContent = metaBits.join(' · ');

    const dec = UI.clear($('#header-decisions'));
    const w = g.weather || {};
    if (w.condition || w.temp || w.wind) {
      dec.appendChild(UI.el('span', 'decisions', `MLB game weather: ${[w.condition, w.temp ? `${w.temp}°F` : null, w.wind ? `wind ${w.wind}` : null].filter(Boolean).join(', ')}`));
    } else {
      dec.appendChild(UI.el('span', 'game-note', 'MLB publishes the game-time weather string around first pitch.'));
    }
    const d = g.decisions;
    if (d && (d.winner || d.loser)) {
      const pieces = [];
      if (d.winner) pieces.push(`W: ${d.winner.fullName}`);
      if (d.loser) pieces.push(`L: ${d.loser.fullName}`);
      if (d.save) pieces.push(`SV: ${d.save.fullName}`);
      dec.appendChild(UI.el('span', 'game-note', pieces.join(' · ')));
    }
  }

  /* ------------------------------------------------------------- linescore */

  function renderLinescore() {
    const wrap = UI.clear($('#linescore-wrap'));
    const g = state.game;
    const ls = g.linescore;
    if (!ls || !Array.isArray(ls.innings) || !ls.innings.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    const table = UI.el('table', 'linescore-table');
    const thead = UI.el('thead');
    const hr = UI.el('tr');
    hr.appendChild(UI.el('th', null, ''));
    ls.innings.forEach((inn) => hr.appendChild(UI.el('th', null, String(inn.num))));
    ['R', 'H', 'E'].forEach((x) => hr.appendChild(UI.el('th', null, x)));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = UI.el('tbody');
    ['away', 'home'].forEach((side) => {
      const tr = UI.el('tr');
      tr.appendChild(UI.el('td', 'ls-abbrev', g.teams[side].team.abbreviation || g.teams[side].team.name));
      ls.innings.forEach((inn) => { const r = inn[side] && inn[side].runs; tr.appendChild(UI.el('td', r ? 'inn-run' : '', r == null ? '' : String(r))); });
      const t = (ls.teams && ls.teams[side]) || {};
      tr.appendChild(UI.el('td', 'total-cell strong', t.runs == null ? '' : String(t.runs)));
      tr.appendChild(UI.el('td', 'total-cell', t.hits == null ? '' : String(t.hits)));
      tr.appendChild(UI.el('td', 'total-cell', t.errors == null ? '' : String(t.errors)));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  /* --------------------------------------------------------- delay panel */

  function allFlags() {
    const out = [...state.ins.flags];
    const tl = state.pbp && !state.pbp.error ? state.pbp.timeline : null;
    const box = state.box && !state.box.error ? state.box : null;
    out.push(...Delays.crossCheck(state.ins, tl, box));
    if (state.pbp && state.pbp.error) out.push({ code: 'pbp-unavailable', text: `Play-by-play could not be fetched (${state.pbp.error.message}).` });
    if (state.box && state.box.error) out.push({ code: 'boxscore-unavailable', text: `Box score could not be fetched (${state.box.error.message}).` });
    if (state.wx) {
      out.push(...(state.wx.issues || []).filter((i) => i.code !== 'stale').map((i) => ({ code: i.code, text: i.text })));
      out.push(...Delays.weatherConsistencyFlags(state.game, state.wx.risk));
    }
    // Postponed-then-made-up games: keep the history visible.
    if (state.entries.length > 1) out.push({ code: 'multiple-schedule-entries', text: `This gamePk appears on ${state.entries.length} schedule dates (${state.entries.map((e) => `${e._listingDate}: ${e.status.detailedState}`).join('; ')}).` });
    return out;
  }

  function timelineList(seg) {
    const ul = UI.el('ul', 'timeline');
    seg.events.forEach((ev) => {
      const li = UI.el('li', `timeline-item ${seg.open && ev === seg.events[seg.events.length - 1] ? 'timeline-open' : ''}`);
      li.appendChild(UI.el('span', 'timeline-time', `${MLB.localTime(ev.startTime)}${ev.endTime && ev.endTime !== ev.startTime ? ` → ${MLB.localTime(ev.endTime)}` : ''}`));
      const t = UI.el('span', 'timeline-text', ev.description);
      if (ev.inning != null) t.appendChild(UI.el('span', 'feed-venue', ` (${ev.halfInning === 'top' ? 'Top' : ev.halfInning === 'bottom' ? 'Bot' : ''} ${ev.inning})`));
      li.appendChild(t);
      ul.appendChild(li);
    });
    if (!seg.open && seg.endTime) {
      const li = UI.el('li', 'timeline-item');
      li.appendChild(UI.el('span', 'timeline-time', MLB.localTime(seg.endTime)));
      const t = UI.el('span', 'timeline-text', seg.closedByEventEnd ? 'Advisory end time' : `Play resumed (${Delays.KIND_META[seg.resumedKind] ? Delays.KIND_META[seg.resumedKind].label : 'status changed'})`);
      if (seg.minutes != null) t.appendChild(UI.el('span', 'timeline-dur', MLB.fmtMinutes(seg.minutes)));
      li.appendChild(t);
      ul.appendChild(li);
    }
    return ul;
  }

  function fact(label, value, sub) {
    const f = UI.el('div', 'wx-fact');
    f.appendChild(UI.el('span', 'wx-fact-label', label));
    f.appendChild(UI.el('span', 'wx-fact-value', value == null || value === '' ? '—' : String(value)));
    if (sub) f.appendChild(UI.el('span', 'wx-fact-sub', sub));
    return f;
  }

  function renderDelayPanel() {
    const wrap = UI.clear($('#delay-wrap'));
    const g = state.game;
    const ins = state.ins;
    const card = UI.el('div', 'panel-card');
    card.appendChild(UI.el('h2', 'panel-title', 'Official delay status'));

    const head = UI.el('div', 'feed-head');
    if (ins.disrupted) {
      head.appendChild(UI.kindChip(ins.status.kind, g.status.detailedState));
      if (ins.status.reason) head.appendChild(UI.el('span', `chip ${ins.status.isWeather ? 'chip-weather' : 'chip-nonweather'}`, ins.status.isWeather ? ins.status.reason : `${ins.status.reason} (non-weather)`));
    } else if (ins.hadDelay) {
      head.appendChild(UI.kindChip('delayed', 'Delay recorded'));
    } else {
      head.appendChild(UI.statusChip(g.status));
      head.appendChild(UI.el('span', 'feed-venue', 'No delay, postponement or suspension in the official status for this game.'));
    }
    card.appendChild(head);

    const grid = UI.el('div', 'wx-panel-grid');
    grid.appendChild(fact('Status code', `${g.status.statusCode || '—'} / ${g.status.codedGameState || '—'}`, g.status.detailedState));
    grid.appendChild(fact('Official delay minutes', ins.official.delayMinutes != null ? `${ins.official.delayMinutes} (${MLB.fmtMinutes(ins.official.delayMinutes)})` : 'not reported', 'gameInfo.delayDurationMinutes'));
    grid.appendChild(fact('Scheduled start', MLB.startLabel(g), g.status && g.status.startTimeTBD ? `startTimeTBD — placeholder ${g.gameDate}` : g.gameDate));
    grid.appendChild(fact('First pitch', ins.official.firstPitch ? MLB.localTime(ins.official.firstPitch) : 'not yet', ins.official.startDelayMinutes != null ? `${ins.official.startDelayMinutes >= 0 ? '+' : ''}${ins.official.startDelayMinutes} min vs. scheduled` : 'gameInfo.firstPitch'));
    if (ins.official.gameDurationMinutes != null) grid.appendChild(fact('Time of game', MLB.fmtMinutes(ins.official.gameDurationMinutes), 'gameInfo.gameDurationMinutes'));
    if (state.box && !state.box.error && state.box.timeOfGame) grid.appendChild(fact('Box score “T”', `${state.box.timeOfGame}${state.box.delayNote ? ` (${state.box.delayNote})` : ''}`, 'printed box-score line'));
    if (state.box && !state.box.error && state.box.weather) grid.appendChild(fact('Box score weather', `${state.box.weather}${state.box.wind ? ` · ${state.box.wind}` : ''}`, 'printed box-score line'));
    if (ins.reschedule) grid.appendChild(fact('Rescheduled to', ins.reschedule.toDate || '', ins.reschedule.toIso ? MLB.localDateTime(ins.reschedule.toIso) : 'rescheduleGameDate'));
    if (ins.makeupOf) grid.appendChild(fact('Makeup of', ins.makeupOf.fromDate || '', ins.makeupOf.description || 'rescheduledFromDate'));
    if (ins.resume) grid.appendChild(fact('Resumes', ins.resume.toDate || MLB.localDateTime(ins.resume.toIso), ins.resume.fromDate ? `suspended from ${ins.resume.fromDate}` : 'resumeDate'));
    card.appendChild(grid);

    // History (postponed entry) when the gamePk has several schedule entries.
    state.entries.filter((e) => e !== g).forEach((e) => {
      const p = Delays.parseStatus(e.status);
      card.appendChild(UI.el('p', 'text-forecast', `Schedule entry for ${e._listingDate}: ${e.status.detailedState}${p.reason ? ` — ${p.reason}` : ''}${e.rescheduleGameDate ? ` → rescheduled to ${e.rescheduleGameDate}` : ''}.`));
    });

    // Advisory timeline.
    if (state.pbp && !state.pbp.error) {
      const tl = state.pbp.timeline;
      if (tl.length) {
        card.appendChild(UI.el('h3', 'panel-title', `Official status-change advisories (${state.pbp.advisories.length})`));
        tl.forEach((seg) => {
          const meta = Delays.KIND_META[seg.kind] || Delays.KIND_META.delayed;
          const where = seg.inning != null && seg.kind !== 'delayed-start' ? ` — ${seg.halfInning === 'top' ? 'Top' : 'Bot'} ${seg.inning}` : '';
          card.appendChild(UI.el('p', 'feed-reason', `${meta.label}${seg.reason ? `: ${seg.reason}` : ''}${where}${seg.open ? ` — ongoing since ${MLB.localTime(seg.startTime)}` : seg.minutes != null ? ` (${MLB.fmtMinutes(seg.minutes)})` : ''}`));
          card.appendChild(timelineList(seg));
        });
      } else if (ins.hadDelay) {
        card.appendChild(UI.el('p', 'feed-desc', 'No status-change advisory in the play-by-play for this game.'));
      }
    } else if (ins.hadDelay && !['postponed', 'cancelled'].includes(ins.status.kind)) {
      card.appendChild(UI.el('p', 'feed-desc', state.pbp ? 'Play-by-play unavailable.' : 'Loading the official advisory timeline…'));
    }

    const fl = UI.flagList(allFlags());
    if (fl) card.appendChild(fl);
    wrap.appendChild(card);
  }

  /* ------------------------------------------------------- weather panel */

  function hourlyTable(periods, tz, firstPitchMs) {
    const wrap = UI.el('div', 'wx-table-wrap');
    const table = UI.el('table', 'wx-table');
    const thead = UI.el('thead');
    const hr = UI.el('tr');
    ['Hour (park time)', 'Precip', 'Forecast', 'Temp', 'Wind'].forEach((h) => hr.appendChild(UI.el('th', null, h)));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = UI.el('tbody');
    let marked = false;
    periods.forEach((p) => {
      const tr = UI.el('tr', `${p.pop != null && p.pop >= 60 ? 'wx-hour-soaked' : p.pop != null && p.pop >= 30 ? 'wx-hour-wet' : ''} ${p.flags && p.flags.thunder ? 'wx-hour-thunder' : ''}`);
      if (!marked && firstPitchMs && p.start <= firstPitchMs && (p.end || p.start + 3600000) > firstPitchMs) { tr.classList.add('wx-hour-firstpitch'); tr.title = 'First pitch falls in this hour'; marked = true; }
      tr.appendChild(UI.el('td', null, MLB.zonedTime(new Date(p.start).toISOString(), tz)));
      const popCell = UI.el('td');
      if (p.pop != null) {
        const bar = UI.el('span', `wx-pop-bar ${p.pop >= 60 ? 'wx-pop-high' : ''}`);
        bar.style.width = `${Math.max(2, Math.round(p.pop * 0.6))}px`;
        popCell.appendChild(bar);
        popCell.appendChild(document.createTextNode(`${p.pop}%`));
      } else popCell.textContent = '—';
      tr.appendChild(popCell);
      tr.appendChild(UI.el('td', null, p.text || '—'));
      tr.appendChild(UI.el('td', null, p.tempF != null ? `${p.tempF}°F` : p.tempC != null ? `${p.tempC}°C` : '—'));
      tr.appendChild(UI.el('td', null, [p.windDir, p.wind].filter(Boolean).join(' ') || '—'));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function alertCard(a) {
    const card = UI.el('div', `alert-card ${a.kind.severe ? 'alert-card-severe' : ''} ${a.kind.ignored ? 'alert-card-ignored' : ''}`);
    card.appendChild(UI.el('div', 'alert-event', `${a.kind.severe ? '🚨' : '⚠'} ${a.event}${a.kind.ignored ? ' (not a ballpark hazard — listed for completeness)' : ''}`));
    const bits = [a.severity, a.urgency, a.certainty].filter(Boolean).join(' · ');
    const when = [a.onset ? `from ${MLB.localDateTime(a.onset)}` : null, (a.ends || a.expires) ? `until ${MLB.localDateTime(a.ends || a.expires)}` : null].filter(Boolean).join(' ');
    card.appendChild(UI.el('div', 'alert-meta', [a.sender, bits, when].filter(Boolean).join(' · ')));
    if (a.headline) card.appendChild(UI.el('div', 'alert-head', a.headline));
    if (a.description) {
      const det = UI.el('details');
      det.appendChild(UI.el('summary', 'source-links-label', 'Full text'));
      det.appendChild(UI.el('p', 'alert-head', a.description));
      if (a.instruction) det.appendChild(UI.el('p', 'alert-instruction', a.instruction));
      card.appendChild(det);
    }
    if (a.url) card.appendChild(UI.sourceLinks([{ label: 'Official alert (JSON)', url: a.url, kind: 'gov' }], 'Source'));
    return card;
  }

  function renderWeatherPanel() {
    const wrap = UI.clear($('#weather-wrap'));
    const g = state.game;
    const wx = state.wx;
    const tz = g.venue && g.venue.timeZone && g.venue.timeZone.id;
    const card = UI.el('div', 'panel-card');
    card.appendChild(UI.el('h2', 'panel-title', 'Weather at the ballpark'));
    const roof = wx ? wx.roof : Weather.roofInfo(g);
    const risk = wx ? wx.risk : null;

    const head = UI.el('div', 'feed-head');
    head.appendChild(UI.riskChip(risk ? risk.level : roof.covered ? 'covered' : 'unknown', risk ? `Forecast risk: ${Weather.RISK_META[risk.level].label}` : roof.covered ? 'Covered' : 'Loading forecast…'));
    if (wx && wx.provider) head.appendChild(UI.el('span', 'chip chip-provider', wx.provider === 'nws' ? 'Source: NWS (api.weather.gov)' : wx.provider === 'eccc' ? 'Source: Environment and Climate Change Canada' : 'Source: Open-Meteo model (non-government)'));
    head.appendChild(UI.el('span', 'feed-venue', roof.label));
    card.appendChild(head);

    if (risk && risk.reasons.length) {
      const ul = UI.el('ul', 'wx-reasons');
      risk.reasons.forEach((r) => ul.appendChild(UI.el('li', null, r)));
      card.appendChild(ul);
    }

    const grid = UI.el('div', 'wx-panel-grid');
    const c = wx && wx.coords;
    grid.appendChild(fact('Venue coordinates', c ? `${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}` : 'not published by MLB', 'venue.location.defaultCoordinates'));
    grid.appendChild(fact('Roof', roof.roofType || 'not reported', roof.closedNow === true ? 'closed per MLB weather string' : roof.closedNow === false ? 'open per MLB weather string' : 'venue.fieldInfo.roofType'));
    if (risk && risk.maxPop != null) grid.appendChild(fact('Peak precip chance (window)', `${risk.maxPop}%`, risk.worst && risk.worst.start ? `${MLB.zonedTime(new Date(risk.worst.start).toISOString(), tz)} — ${risk.worst.text}` : ''));
    if (wx && wx.window) grid.appendChild(fact('Forecast window', `${MLB.zonedTime(new Date(wx.window.start).toISOString(), tz)} → ${MLB.zonedTime(new Date(wx.window.end).toISOString(), tz)}`, 'first pitch −1h to +4h (or game end)'));
    if (wx && wx.point && wx.point.gridId) grid.appendChild(fact('NWS grid', `${wx.point.gridId} ${wx.point.gridX},${wx.point.gridY}`, wx.point.radarStation ? `radar ${wx.point.radarStation}` : ''));
    if (wx && wx.current) grid.appendChild(fact(`Current (${wx.current.station || 'ECCC'})`, `${wx.current.condition || '—'}${wx.current.tempC != null ? `, ${wx.current.tempC}°C` : ''}`, wx.current.time ? MLB.localDateTime(wx.current.time) : ''));
    if (wx && wx.forecast && (wx.forecast.updateTime || wx.forecast.hourlyIssued)) grid.appendChild(fact('Forecast issued', MLB.localDateTime(wx.forecast.updateTime || wx.forecast.hourlyIssued), wx.forecast.stale ? 'stale — last successful fetch' : ''));
    card.appendChild(grid);

    if (wx && wx.textForecasts && wx.textForecasts.length) {
      const p = UI.el('p', 'text-forecast');
      wx.textForecasts.forEach((f) => { p.appendChild(UI.el('b', null, `${f.period}: `)); p.appendChild(document.createTextNode(`${f.text} `)); });
      card.appendChild(p);
    }

    if (risk && risk.windowPeriods && risk.windowPeriods.length) {
      card.appendChild(UI.el('h3', 'panel-title', 'Hourly forecast — game window'));
      card.appendChild(hourlyTable(risk.windowPeriods, tz, wx.window ? wx.window.firstPitch : null));
    } else if (wx && wx.forecast && wx.forecast.periods && wx.forecast.periods.length && !roof.isDome) {
      card.appendChild(UI.el('p', 'feed-desc', 'The game window is outside the hourly forecast range (NWS publishes ~156 hours).'));
    }

    const alerts = wx ? wx.alerts || [] : [];
    card.appendChild(UI.el('h3', 'panel-title', `Active alerts at the ballpark (${alerts.length})`));
    if (!alerts.length) card.appendChild(UI.el('p', 'feed-desc', wx && wx.provider === 'nws' ? 'No active NWS alerts for this point.' : wx && wx.provider === 'eccc' ? 'No ECCC warnings on the city page.' : wx && wx.provider === 'open-meteo' ? 'Open-Meteo carries no official alerts — check the local weather service.' : '—'));
    else {
      const list = UI.el('div', 'alert-list');
      alerts.forEach((a) => list.appendChild(alertCard(a)));
      card.appendChild(list);
    }

    const rules = UI.el('div', 'rules-box');
    rules.appendChild(document.createTextNode('How the forecast-risk chip is derived (fixed rules, not a prediction):'));
    const ul = UI.el('ul');
    Weather.RISK_RULES.forEach((r) => ul.appendChild(UI.el('li', null, r)));
    rules.appendChild(ul);
    card.appendChild(rules);
    wrap.appendChild(card);
  }

  /* --------------------------------------------------------------- sources */

  function renderSources() {
    const wrap = UI.clear($('#sources-wrap'));
    const g = state.game;
    const s = MLB.sourceLinks(g.gamePk);
    const card = UI.el('div', 'panel-card');
    card.appendChild(UI.el('h2', 'panel-title', 'Verify every line — official sources'));
    const mlb = [
      { label: 'MLB Gameday', url: s.gameday },
      { label: 'Schedule JSON (status, weather, venue, gameInfo, reschedule)', url: s.schedule },
      { label: 'Play-by-play JSON (game_advisory events)', url: s.playByPlay },
      { label: 'Box score JSON (Weather / Wind / T lines)', url: s.boxscore },
      { label: 'Live feed JSON', url: s.feed },
      { label: 'Game status registry', url: s.gameStatus },
    ];
    card.appendChild(UI.sourceLinks(mlb, 'MLB'));
    if (state.wx) {
      const wxl = [];
      (state.wx.sourceUrls || []).forEach((u) => wxl.push({ label: /\/points\//.test(u) ? 'NWS point JSON' : /forecast\/hourly/.test(u) ? 'NWS hourly forecast JSON' : /alerts/.test(u) ? 'NWS active alerts JSON' : /weather\.gc\.ca/.test(u) ? 'ECCC city-page JSON' : 'Open-Meteo JSON', url: u, kind: /open-meteo/.test(u) ? 'model' : 'gov' }));
      (state.wx.links || []).forEach((l) => wxl.push({ label: l.label, url: l.url, kind: state.wx.provider === 'open-meteo' ? 'model' : 'gov' }));
      const row = UI.sourceLinks(wxl, 'Weather');
      if (row) card.appendChild(row);
    }
    const clubs = (typeof Clubs !== 'undefined') ? Clubs.gameLinks(g) : [];
    if (clubs.length) card.appendChild(UI.sourceLinks(clubs, 'Clubs'));
    card.appendChild(UI.el('p', 'feed-observed-note', 'Social-media and news feeds are not read by this site; the club pages above are the official places where tarp, delay and first-pitch announcements are posted.'));
    wrap.appendChild(card);
  }

  /* ------------------------------------------------------------------ boot */

  window.GamePage = { retry() { load(); }, refresh() { state.lastWeatherAt = 0; state.pbp = null; state.box = null; load(); } };

  document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    const pk = parseInt(params.get('gamePk'), 10);
    if (!pk) {
      $('#loading').classList.remove('visible');
      $('#banner').appendChild(UI.el('div', 'banner-error', 'No gamePk in the URL — open a game from the scoreboard.'));
      return;
    }
    state.gamePk = pk;
    $('#loading').classList.add('visible');
    $('#refresh-btn').addEventListener('click', () => window.GamePage.refresh());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
    state.countdownTimer = setInterval(tickCountdown, 1000);
    load();
  });
})();
