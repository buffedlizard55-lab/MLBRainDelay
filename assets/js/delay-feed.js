/* ============================================================================
 * delay-feed.js — the all-games Delay Feed (delays.html)
 * ----------------------------------------------------------------------------
 * One chat-style feed for the whole slate, built ONLY from official payloads:
 *
 *   ⏸ / ⏱  Delay rows      — official status-change advisories from the
 *                            play-by-play (start, end, inning, reason) plus
 *                            gameInfo.delayDurationMinutes and the printed
 *                            box-score "T: … (h:mm delay)" line, cross-checked
 *   📅  Postponed rows     — status Postponed / Cancelled / Suspended with the
 *                            official reason and reschedule / resume fields
 *   🌧  Forecast rows      — one per game: NWS / ECCC hourly forecast for the
 *                            game window, roof state, MLB's own weather string
 *   ⚠  Alert rows          — active NWS alerts at ballparks hosting a game
 *   👁  Observed rows       — status flips this browser watched happen (our
 *                            clock, labelled as such, persisted per date)
 *
 * Every row ends with the URLs a reviewer needs to verify it by hand, and
 * anything the sources disagree about is rendered as a 🚩 flag on the row.
 * ==========================================================================*/
'use strict';

(() => {
  const LIVE_POLL_MS = 20000;
  const IDLE_POLL_MS = 60000;
  const STATUS_POLL_MS = 5000;
  const STATUS_IDLE_MS = 30000;
  const WEATHER_REFRESH_MS = 5 * 60 * 1000;
  const PBP_REFRESH_MS = 10 * 60 * 1000;
  const FETCH_CONCURRENCY = 4;
  const OBS_KEY_PREFIX = 'mlbraindelay:observed:';
  const OBS_MAX_ROWS = 300;
  const OBS_KEEP_DATES = 7;

  const state = {
    dateStr: todayStr(),
    games: [],
    inspections: new Map(),
    weather: new Map(),      // gamePk -> Weather.forGame()
    pbp: new Map(),          // gamePk -> { sig, advisories, timeline, fetchedAt, error }
    box: new Map(),          // gamePk -> parsed box-score info
    statusCodes: new Map(),  // gamePk -> raw status (for the observed diff)
    observed: [],            // observed transitions for this date
    filter: 'all',
    seenRowIds: new Set(),
    firstRender: true,
    pollTimer: null,
    statusTimer: null,
    countdownTimer: null,
    nextPollAt: 0,
    inFlight: false,
    statusInFlight: false,
    lastCycleStartedAt: 0,
    lastWeatherAt: 0,
    weatherRunning: false,
    soundOn: false,
    lastChimeAt: 0,
  };

  /* ------------------------------------------------------------------ utils */

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function shiftDate(days) {
    const d = new Date(`${state.dateStr}T12:00:00`);
    d.setDate(d.getDate() + days);
    state.dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function $(sel) { return document.querySelector(sel); }

  function teamLabel(t, fallback) {
    if (!t) return fallback;
    return t.abbreviation || t.teamName || t.name || fallback;
  }

  function gameTitle(g) {
    const a = MLB.scoreOf(g, 'away');
    const h = MLB.scoreOf(g, 'home');
    const away = teamLabel(g.teams.away.team, 'AWY');
    const home = teamLabel(g.teams.home.team, 'HOM');
    return a != null && h != null ? `${away} ${a} @ ${home} ${h}` : `${away} @ ${home}`;
  }

  function venueLine(g) {
    const v = g.venue || {};
    const loc = v.location || {};
    const place = [loc.city, loc.stateAbbrev || loc.state].filter(Boolean).join(', ');
    return [v.name, place].filter(Boolean).join(' · ');
  }

  function tzOf(g) { return g.venue && g.venue.timeZone && g.venue.timeZone.id; }


  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
      while (i < items.length) {
        const idx = i++;
        try { out[idx] = await fn(items[idx], idx); } catch (e) { out[idx] = { error: e }; }
      }
    });
    await Promise.all(workers);
    return out;
  }

  /* -------------------------------------------------------- observed log */

  function obsKey(date) { return `${OBS_KEY_PREFIX}${date}`; }

  function loadObserved(date) {
    try {
      const raw = localStorage.getItem(obsKey(date));
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr.filter((r) => r && typeof r.gamePk === 'number' && typeof r.at === 'number' && r.toRaw && typeof r.toRaw === 'object' && typeof r.event === 'string');
    } catch (err) {
      console.warn('observed log unreadable, ignoring', err);
      return [];
    }
  }

  function saveObserved(date, rows) {
    try {
      localStorage.setItem(obsKey(date), JSON.stringify(rows.slice(-OBS_MAX_ROWS)));
      // prune older dates
      const keys = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i);
        if (k && k.startsWith(OBS_KEY_PREFIX)) keys.push(k);
      }
      keys.sort().slice(0, Math.max(0, keys.length - OBS_KEEP_DATES)).forEach((k) => localStorage.removeItem(k));
    } catch (_) { /* storage full or disabled: the feed still works */ }
  }

  /* ------------------------------------------------------------------ sound */

  let audioCtx = null;
  function chime() {
    if (!state.soundOn) return;
    if (Date.now() - state.lastChimeAt < 2500) return;
    state.lastChimeAt = Date.now();
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t0 = audioCtx.currentTime;
      [0, 0.12, 0.26].forEach((dt, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime([1568, 1976, 2349][i], t0 + dt);
        gain.gain.setValueAtTime(0.0001, t0 + dt);
        gain.gain.exponentialRampToValueAtTime(0.18, t0 + dt + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.35);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(t0 + dt);
        osc.stop(t0 + dt + 0.4);
      });
    } catch (_) { /* audio blocked */ }
  }

  /* ------------------------------------------------------------------ load */

  async function load() {
    if (state.inFlight) return;
    const requestDate = state.dateStr;
    state.inFlight = true;
    state.lastCycleStartedAt = Date.now();
    setLive(true);
    const banner = $('#banner');
    const errBox = banner.querySelector('.banner-error');
    if (errBox) errBox.remove();
    if (!state.games.length) { UI.clear($('#feed-list')).appendChild(UI.el('div', 'spinner')); $('#status-line').textContent = 'Loading…'; }

    try {
      const games = await MLB.getSchedule(requestDate);
      if (requestDate !== state.dateStr) return;
      // Observed transitions from the hydrated schedule too (covers the
      // window between two status sweeps).
      const nextCodes = new Map(games.map((g) => [g.gamePk, g.status]));
      recordTransitions(nextCodes);
      state.games = games;
      games.forEach((g) => state.inspections.set(g.gamePk, Delays.inspectGame(g)));
      renderClubLinks();
      render();
      await Promise.all([scanDelays(requestDate), refreshWeather(requestDate)]);
      if (requestDate !== state.dateStr) return;
      render();
      updateStatusLine();
      scheduleNext();
    } catch (err) {
      if (requestDate !== state.dateStr) return;
      console.error(err);
      if (!state.games.length) UI.clear($('#feed-list'));
      const box = UI.el('div', 'banner-error', `Couldn't reach the MLB StatsAPI (${err.message || err}). Retrying automatically. `);
      box.appendChild(UI.el('button', 'btn', 'Retry now', { onclick: 'DelayFeed.retry()' }));
      banner.prepend(box);
      $('#status-line').textContent = 'Load failed — retrying soon';
      scheduleNext(10000);
    } finally {
      state.inFlight = false;
      setLive(false);
      if (requestDate !== state.dateStr) load();
    }
  }

  function updateStatusLine() {
    const n = state.games.length;
    const live = state.games.filter((g) => g.status.abstractGameState === 'Live').length;
    const active = state.games.filter((g) => (state.inspections.get(g.gamePk) || {}).active).length;
    const wx = state.games.filter((g) => state.weather.get(g.gamePk)?.forecast).length;
    $('#status-line').textContent = `${n} game${n === 1 ? '' : 's'} · ${live} live · ${active} delayed now · forecasts for ${wx}/${n} · updated ${new Date().toLocaleTimeString()}`;
  }

  function scheduleNext(overrideMs) {
    clearTimeout(state.pollTimer);
    const anyOpen = state.games.some((g) => g.status.abstractGameState !== 'Final');
    const interval = overrideMs != null ? overrideMs : (anyOpen ? LIVE_POLL_MS : IDLE_POLL_MS);
    const elapsed = state.lastCycleStartedAt ? Date.now() - state.lastCycleStartedAt : 0;
    const wait = overrideMs != null ? overrideMs : Math.max(0, interval - elapsed);
    state.nextPollAt = Date.now() + wait;
    state.pollTimer = setTimeout(() => {
      if (!document.hidden) load(); else scheduleNext(IDLE_POLL_MS);
    }, wait);
  }

  function tickCountdown() {
    const el = $('#countdown');
    if (!el) return;
    const sec = Math.max(0, Math.round((state.nextPollAt - Date.now()) / 1000));
    el.textContent = state.inFlight ? 'polling…' : (state.nextPollAt ? UI.fmtCountdown(sec) : '');
  }

  function setLive(on) {
    const dot = $('#live-dot');
    if (dot) dot.classList.toggle('on', !!on);
  }

  /* ---------------------------------------------------------- status sweep */

  function recordTransitions(nextCodes) {
    if (state.statusCodes.size) {
      const trans = Delays.diffStatuses(state.statusCodes, nextCodes, Date.now());
      if (trans.length) {
        trans.forEach((t) => state.observed.push({ gamePk: t.gamePk, at: t.at, event: t.event, fromRaw: t.fromRaw, toRaw: t.toRaw }));
        saveObserved(state.dateStr, state.observed);
        if (trans.some((t) => Delays.ACTIVE_KINDS.has(t.event) || t.event === 'postponed' || t.event === 'suspended')) chime();
      }
    }
    state.statusCodes = nextCodes;
  }

  function statusIntervalMs() {
    if (document.hidden) return STATUS_IDLE_MS;
    return state.games.some((g) => g.status.abstractGameState !== 'Final') ? STATUS_POLL_MS : STATUS_IDLE_MS;
  }

  function scheduleStatus(initialFast) {
    clearTimeout(state.statusTimer);
    state.statusTimer = setTimeout(() => {
      if (document.hidden) { scheduleStatus(); return; }
      pollStatus();
    }, initialFast ? 2000 : statusIntervalMs());
  }

  async function pollStatus() {
    if (state.statusInFlight || state.inFlight || !state.games.length) { scheduleStatus(); return; }
    state.statusInFlight = true;
    const requestDate = state.dateStr;
    try {
      const list = await MLB.getStatusSweep(requestDate);
      if (requestDate !== state.dateStr) return;
      const nextCodes = new Map();
      const byPk = new Map();
      list.forEach((g) => { if (g && g.gamePk != null && g.status) { nextCodes.set(g.gamePk, g.status); byPk.set(g.gamePk, g); } });
      let changed = false;
      state.games.forEach((g) => {
        const fresh = byPk.get(g.gamePk);
        if (!fresh) return;
        const before = JSON.stringify(g.status);
        // Replace, don't merge: a stale `reason` ("Rain") must not survive the
        // flip to "In Progress", whose status object carries no reason key.
        g.status = Object.assign({}, fresh.status || {});
        ['rescheduleDate', 'rescheduleGameDate', 'rescheduledFrom', 'rescheduledFromDate', 'resumeDate', 'resumedFrom'].forEach((k) => { if (fresh[k] != null) g[k] = fresh[k]; });
        if (JSON.stringify(g.status) !== before) { changed = true; state.inspections.set(g.gamePk, Delays.inspectGame(g)); }
      });
      recordTransitions(nextCodes);
      if (changed) {
        render();
        scanDelays(requestDate).then(() => { if (requestDate === state.dateStr) render(); });
      }
    } catch (_) {
      // quiet — the hydrated poll is the fallback
    } finally {
      state.statusInFlight = false;
      scheduleStatus();
    }
  }

  /* -------------------------------------------------------------- scanning */

  function pbpSignature(g) {
    const s = g.status || {};
    const gi = g.gameInfo || {};
    return [s.statusCode, s.detailedState, s.reason, gi.delayDurationMinutes, s.abstractGameState].join('|');
  }

  /** Which games need a play-by-play scan this cycle, and why. */
  function scanCandidates(games, pbpCache, now) {
    return games.filter((g) => {
      const ins = state.inspections.get(g.gamePk);
      if (!ins) return false;
      const needs = ins.hadDelay || ins.active || (ins.official.delayMinutes != null && ins.official.delayMinutes > 0);
      if (!needs) return false;
      if (ins.status.kind === 'postponed' || ins.status.kind === 'cancelled') return false; // never played: no play-by-play
      const c = pbpCache.get(g.gamePk);
      if (!c) return true;
      if (c.sig !== pbpSignature(g)) return true;
      if (ins.active) return now - c.fetchedAt > 15000;
      if (g.status.abstractGameState !== 'Final') return now - c.fetchedAt > PBP_REFRESH_MS;
      return !!c.error && now - c.fetchedAt > 60000;
    });
  }

  async function scanDelays(requestDate) {
    const now = Date.now();
    const cands = scanCandidates(state.games, state.pbp, now);
    await mapLimit(cands, FETCH_CONCURRENCY, async (g) => {
      try {
        const pbp = await MLB.getPlayByPlay(g.gamePk);
        if (requestDate !== state.dateStr) return;
        const advisories = Delays.extractAdvisories(pbp);
        const timeline = Delays.buildTimeline(advisories, g);
        const plays = Array.isArray(pbp.allPlays) ? pbp.allPlays.length : 0;
        state.pbp.set(g.gamePk, { sig: pbpSignature(g), advisories, timeline, plays, fetchedAt: Date.now(), error: null });
      } catch (err) {
        const prev = state.pbp.get(g.gamePk);
        state.pbp.set(g.gamePk, { ...(prev || { advisories: [], timeline: [], plays: 0 }), sig: pbpSignature(g), fetchedAt: Date.now(), error: err });
      }
    });
    // Box score notes for finished games with a delay (once per game).
    const boxCands = state.games.filter((g) => {
      const ins = state.inspections.get(g.gamePk);
      return ins && g.status.abstractGameState === 'Final' && ins.hadDelay && !state.box.has(g.gamePk) && ins.status.kind !== 'postponed' && ins.status.kind !== 'cancelled';
    });
    await mapLimit(boxCands, FETCH_CONCURRENCY, async (g) => {
      try {
        const info = await MLB.getBoxscoreInfo(g.gamePk);
        if (requestDate !== state.dateStr) return;
        state.box.set(g.gamePk, Delays.parseBoxscoreInfo(info));
      } catch (err) {
        state.box.set(g.gamePk, { error: err });
      }
    });
  }

  async function refreshWeather(requestDate, force) {
    if (state.weatherRunning) return;
    if (!force && state.weather.size && Date.now() - state.lastWeatherAt < WEATHER_REFRESH_MS) return;
    state.weatherRunning = true;
    state.lastWeatherAt = Date.now();
    try {
      await mapLimit(state.games.slice(), 6, async (g) => {
        const wx = await Weather.forGame(g);
        if (requestDate !== state.dateStr) return;
        state.weather.set(g.gamePk, wx);
      });
    } finally {
      state.weatherRunning = false;
    }
  }

  /* ----------------------------------------------------------------- rows */

  function gameFlags(g) {
    const ins = state.inspections.get(g.gamePk);
    const wx = state.weather.get(g.gamePk);
    const c = state.pbp.get(g.gamePk);
    const box = state.box.get(g.gamePk);
    const out = [];
    if (ins) {
      out.push(...ins.flags);
      out.push(...Delays.crossCheck(ins, c && !c.error ? c.timeline : null, box && !box.error ? box : null));
      if (c && c.error) out.push({ code: 'pbp-unavailable', text: `Play-by-play could not be fetched (${c.error.message}); the delay timeline is missing.` });
      if (box && box.error) out.push({ code: 'boxscore-unavailable', text: `Box score notes could not be fetched (${box.error.message}).` });
    }
    if (wx) {
      out.push(...(wx.issues || []).filter((i) => i.code !== 'stale').map((i) => ({ code: i.code, text: i.text })));
      out.push(...Delays.weatherConsistencyFlags(g, wx.risk));
    }
    return out;
  }

  function mlbLinks(g) {
    const s = MLB.sourceLinks(g.gamePk);
    return [
      { label: 'MLB Gameday', url: s.gameday },
      { label: 'Schedule JSON', url: s.schedule, title: 'status, reason, weather, venue, gameInfo, reschedule fields' },
    ];
  }

  /** Weather source links for one game, de-duplicated by URL (the alerts
   * JSON is reachable from both `sourceUrls` and the human-review links). */
  function wxLinks(wx) {
    if (!wx) return [];
    const out = [];
    const seen = new Set();
    const push = (l) => { if (l && l.url && !seen.has(l.url)) { seen.add(l.url); out.push(l); } };
    (wx.sourceUrls || []).forEach((u, i) => {
      const label = /\/points\//.test(u) ? 'NWS point JSON' : /forecast\/hourly/.test(u) ? 'NWS hourly JSON' : /alerts/.test(u) ? 'NWS alerts JSON' : /weather\.gc\.ca/.test(u) ? 'ECCC JSON' : /open-meteo/.test(u) ? 'Open-Meteo JSON' : `Source ${i + 1}`;
      push({ label, url: u, kind: /open-meteo/.test(u) ? 'model' : 'gov' });
    });
    (wx.links || []).forEach((l) => push({ label: l.label, url: l.url, kind: wx.provider === 'open-meteo' ? 'model' : 'gov' }));
    return out;
  }

  /** Fill the manual-review club links for the current slate (one per club). */
  function renderClubLinks() {
    const el = $('#club-links');
    if (!el) return;
    UI.clear(el);
    if (typeof Clubs === 'undefined') return;
    Clubs.newsLinks(state.games).forEach((l) => {
      el.appendChild(UI.el('a', 'source-link', l.label, { href: l.url, target: '_blank', rel: 'noopener' }));
    });
  }

  /** Build every feed row for the current state (pure over state). */
  function buildRows() {
    const rows = [];
    const alertRows = new Map(); // alert id -> row

    state.games.forEach((g) => {
      const ins = state.inspections.get(g.gamePk);
      if (!ins) return;
      const wx = state.weather.get(g.gamePk) || null;
      const risk = wx ? wx.risk : null;
      const c = state.pbp.get(g.gamePk);
      const box = state.box.get(g.gamePk);
      const flags = gameFlags(g);
      const firstPitchIso = (g.gameInfo && g.gameInfo.firstPitch) || g.gameDate;

      // Forecast row — one per game, always.
      rows.push({
        id: `wx:${g.gamePk}`, type: 'forecast', game: g, ins, wx, risk, flags,
        time: Date.parse(g.gameDate) || 0, active: false,
        level: risk ? risk.level : (Weather.roofInfo(g).covered ? 'covered' : 'unknown'),
      });

      // Alert rows — de-duplicated across games sharing an alert.
      if (risk && risk.alerts) {
        risk.alerts.forEach((a) => {
          const key = a.id || `${a.event}|${a.onset}`;
          if (!alertRows.has(key)) {
            alertRows.set(key, { id: `alert:${key}`, type: 'alert', alert: a, games: [], wx, time: Date.parse(a.onset || '') || Date.now(), active: a.kind.severe, flags: [] });
          }
          alertRows.get(key).games.push(g);
        });
      }

      // Delay / postponement rows.
      if (ins.status.kind === 'postponed' || ins.status.kind === 'cancelled') {
        rows.push({ id: `ppd:${g.gamePk}`, type: 'postponed', game: g, ins, wx, risk, flags, box: null, time: Date.parse(g.gameDate) || 0, active: false });
      } else if (ins.status.kind === 'suspended' || ins.status.kind === 'suspended-about-to-resume') {
        rows.push({ id: `susp:${g.gamePk}`, type: 'suspended', game: g, ins, wx, risk, flags, box: null, time: Date.parse(g.gameDate) || 0, active: ins.active, segments: c ? c.timeline : null });
      } else if (ins.hadDelay) {
        const segments = c && !c.error ? c.timeline : null;
        if (segments && segments.length) {
          segments.forEach((seg, i) => {
            rows.push({
              id: `seg:${g.gamePk}:${i}`, type: 'delay', game: g, ins, wx, risk, seg, box: box && !box.error ? box : null,
              flags: i === segments.length - 1 ? flags : [], // flags once per game, on the latest segment
              time: Date.parse(seg.startTime || '') || Date.parse(firstPitchIso) || 0, active: !!seg.open,
              observed: observedFor(g.gamePk, seg),
            });
          });
        } else {
          // No advisory timeline (yet): a status-only row so an active delay
          // is never invisible while the play-by-play is fetched.
          rows.push({
            id: `st:${g.gamePk}`, type: 'delay', game: g, ins, wx, risk, seg: null, box: box && !box.error ? box : null, flags,
            time: Date.parse(firstPitchIso) || 0, active: ins.active, pending: !c, observed: observedFor(g.gamePk, null),
          });
        }
      }
    });

    // Observed transitions that no delay row absorbed.
    const gamesByPk = new Map(state.games.map((g) => [g.gamePk, g]));
    state.observed.forEach((o, i) => {
      if (o.absorbed) return;
      const g = gamesByPk.get(o.gamePk);
      if (!g) return;
      rows.push({ id: `obs:${o.gamePk}:${o.at}:${i}`, type: 'transition', game: g, ins: state.inspections.get(g.gamePk), obs: o, time: o.at, active: false, flags: [] });
    });

    alertRows.forEach((r) => rows.push(r));

    // Active first, then newest first.
    rows.sort((a, b) => (b.active - a.active) || (b.time - a.time));
    return rows;
  }

  /** Observed transitions matching a segment (±10 min) are attached to it. */
  function observedFor(gamePk, seg) {
    const out = [];
    state.observed.forEach((o) => {
      if (o.gamePk !== gamePk) return;
      if (!seg) { out.push(o); o.absorbed = true; return; }
      const start = Date.parse(seg.startTime || '') || 0;
      const end = Date.parse(seg.endTime || '') || 0;
      const near = (t) => t && Math.abs(o.at - t) < 10 * 60 * 1000;
      if (near(start) || near(end)) { out.push(o); o.absorbed = true; }
    });
    return out;
  }

  /* --------------------------------------------------------------- render */

  function render() {
    state.observed.forEach((o) => { o.absorbed = false; });
    const rows = buildRows();
    renderActiveStrip(rows);
    renderStats(rows);
    renderTabs(rows);
    renderFeed(rows);
  }

  function renderActiveStrip(rows) {
    const wrap = UI.clear($('#active-strip'));
    const active = state.games.filter((g) => (state.inspections.get(g.gamePk) || {}).active);
    if (!active.length) return;
    const strip = UI.el('div', 'feed-active-strip');
    strip.appendChild(UI.el('span', 'feed-active-badge', '⏸ DELAYED NOW'));
    active.forEach((g) => {
      const ins = state.inspections.get(g.gamePk);
      const a = UI.el('a', 'feed-active-link', '', { href: `game.html?gamePk=${g.gamePk}` });
      a.appendChild(UI.el('span', 'feed-active-game', gameTitle(g)));
      a.appendChild(UI.el('span', 'feed-active-type', ins.status.detailedState));
      const extra = Delays.statusLabel(ins.status).slice(ins.status.detailedState.length).replace(/^:\s*/, '');
      if (extra) a.appendChild(UI.el('span', 'feed-active-reason', extra));
      const seg = (state.pbp.get(g.gamePk) || {}).timeline;
      const open = seg && seg.find((s) => s.open);
      if (open && open.startTime) a.appendChild(UI.el('span', 'feed-active-reason', `since ${MLB.localTime(open.startTime)}`));
      a.appendChild(UI.el('span', 'feed-active-reason', 'Expected restart: not confirmed by this app'));
      strip.appendChild(a);
    });
    wrap.appendChild(strip);
  }

  function renderStats(rows) {
    const wrap = UI.clear($('#feed-stats'));
    const ins = state.games.map((g) => state.inspections.get(g.gamePk)).filter(Boolean);
    const active = ins.filter((i) => i.active).length;
    const delayed = ins.filter((i) => i.hadDelay && !['postponed', 'cancelled'].includes(i.status.kind)).length;
    const ppd = ins.filter((i) => ['postponed', 'cancelled', 'suspended', 'suspended-about-to-resume'].includes(i.status.kind)).length;
    const minutes = ins.reduce((s, i) => s + (i.official.delayMinutes || 0), 0);
    const wet = rows.filter((r) => r.type === 'forecast' && (r.level === 'high' || r.level === 'moderate')).length;
    const alerts = rows.filter((r) => r.type === 'alert').length;
    const flags = rows.reduce((s, r) => s + (r.flags ? r.flags.length : 0), 0);
    const items = [
      ['Delayed now', active, active ? 'stat-active-delay' : ''],
      ['Games with delays', delayed, 'stat-delay'],
      ['Postponed / suspended', ppd, 'stat-postponed'],
      ['Official delay minutes', minutes, 'stat-minutes'],
      ['Rain-risk games', wet, 'stat-forecast'],
      ['Active alerts', alerts, 'stat-alert'],
      ['Flags for review', flags, 'stat-flag'],
    ];
    items.forEach(([label, value, cls]) => {
      const it = UI.el('div', `review-stat-item ${cls}`);
      it.appendChild(UI.el('span', 'review-stat-label', label));
      it.appendChild(UI.el('span', 'review-stat-value', String(value)));
      wrap.appendChild(it);
    });
  }

  function rowMatches(row, filter) {
    switch (filter) {
      case 'all': return true;
      case 'active': return !!row.active || (row.type === 'delay' && row.ins && row.ins.active);
      case 'delays': return row.type === 'delay' || row.type === 'suspended';
      case 'postponed': return row.type === 'postponed' || row.type === 'suspended';
      case 'forecast': return row.type === 'forecast';
      case 'alerts': return row.type === 'alert';
      case 'flags': return !!(row.flags && row.flags.length);
      case 'observed': return row.type === 'transition' || !!(row.observed && row.observed.length);
      default: return true;
    }
  }

  function renderTabs(rows) {
    const count = (f) => rows.filter((r) => rowMatches(r, f)).length;
    const tabs = [
      ['all', `All (${rows.length})`],
      ['active', `⏸ Active (${count('active')})`],
      ['delays', `⏱ Delays (${count('delays')})`],
      ['postponed', `📅 Postponed (${count('postponed')})`],
      ['forecast', `🌧 Forecasts (${count('forecast')})`],
      ['alerts', `⚠ Alerts (${count('alerts')})`],
      ['flags', `🚩 Flagged (${count('flags')})`],
    ];
    if (count('observed')) tabs.push(['observed', `👁 Observed (${count('observed')})`]);
    const wrap = UI.clear($('#feed-tabs'));
    tabs.forEach(([key, label]) => {
      wrap.appendChild(UI.el('button', `tab ${state.filter === key ? 'tab-on' : ''}`, label, { onclick: `DelayFeed.setFilter('${key}')` }));
    });
  }

  function renderFeed(rows) {
    const list = UI.clear($('#feed-list'));
    const shown = rows.filter((r) => rowMatches(r, state.filter));
    if (!shown.length) {
      list.appendChild(UI.el('div', 'empty', state.games.length ? 'Nothing in this category.' : 'No games scheduled for this date.'));
      return;
    }
    shown.forEach((r) => list.appendChild(feedRow(r)));
    rows.forEach((r) => state.seenRowIds.add(r.id));
    state.firstRender = false;
  }

  function timeCell(label, tsMs) {
    const cell = UI.el('div', 'feed-time');
    cell.appendChild(UI.el('span', 'feed-time-txt', label));
    cell.appendChild(UI.el('span', 'feed-time-hm', tsMs ? new Date(tsMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—'));
    return cell;
  }

  function gameHead(g, extra) {
    const head = UI.el('div', 'feed-head');
    const link = UI.el('a', 'feed-game', '', { href: `game.html?gamePk=${g.gamePk}` });
    link.appendChild(UI.teamLogo(g.teams.away.team.id, g.teams.away.team.name, g.teams.away.team.abbreviation, 'card-logo'));
    link.appendChild(document.createTextNode(gameTitle(g)));
    link.appendChild(UI.teamLogo(g.teams.home.team.id, g.teams.home.team.name, g.teams.home.team.abbreviation, 'card-logo'));
    head.appendChild(link);
    if (g.status.abstractGameState === 'Live' && g.linescore) head.appendChild(UI.el('span', 'feed-inn', MLB.inningLabel(g.linescore, g.status)));
    (extra || []).forEach((n) => { if (n) head.appendChild(n); });
    head.appendChild(UI.el('span', 'feed-venue', venueLine(g)));
    return head;
  }

  function feedRow(row) {
    const isNew = !state.firstRender && !state.seenRowIds.has(row.id);
    const el = UI.el('div', `feed-row feed-type-${row.type === 'delay' && row.active ? 'active' : row.type} ${row.active ? 'feed-row-live' : ''} ${isNew ? 'feed-new' : ''}`);
    el.dataset.rowId = row.id;
    const body = UI.el('div', 'feed-body');
    switch (row.type) {
      case 'forecast': el.appendChild(timeCell('Forecast', row.time)); forecastBody(body, row); break;
      case 'delay': el.appendChild(timeCell(row.active ? 'Delayed now' : 'Delay', row.time)); delayBody(body, row); break;
      case 'postponed': el.appendChild(timeCell(row.ins.status.kind === 'cancelled' ? 'Cancelled' : 'Postponed', row.time)); postponedBody(body, row); break;
      case 'suspended': el.appendChild(timeCell('Suspended', row.time)); postponedBody(body, row); break;
      case 'alert': el.appendChild(timeCell('Alert', row.time)); alertBody(body, row); break;
      case 'transition': el.appendChild(timeCell('Observed', row.time)); transitionBody(body, row); break;
      default: break;
    }
    if (row.flags && row.flags.length) { const fl = UI.flagList(row.flags); if (fl) body.appendChild(fl); }
    el.appendChild(body);
    return el;
  }

  /* ---- forecast row */

  function hourlyTable(periods, win, tz, firstPitchMs) {
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

  function forecastBody(body, row) {
    const { game: g, wx, risk, ins } = row;
    const tz = tzOf(g);
    const roof = wx ? wx.roof : Weather.roofInfo(g);
    const chips = [UI.riskChip(row.level, null, risk ? risk.reasons.join(' ') : '')];
    if (ins.disrupted) chips.push(UI.kindChip(ins.status.kind, ins.status.detailedState));
    if (wx && wx.provider) chips.push(UI.el('span', 'chip chip-provider', wx.provider === 'nws' ? 'NWS' : wx.provider === 'eccc' ? 'ECCC' : 'Open-Meteo (model)'));
    body.appendChild(gameHead(g, chips));

    const startTxt = g.status && g.status.startTimeTBD
      ? `start time TBD (MLB placeholder ${MLB.localTime(g.gameDate)} local)`
      : `${MLB.localTime(g.gameDate)} local · ${MLB.zonedTime(g.gameDate, tz)} at the park`;
    body.appendChild(UI.el('p', 'feed-reason', risk ? `Forecast risk: ${Weather.RISK_META[risk.level].label} — ${Weather.summaryText(risk, tz) || risk.reasons[0] || ''}` : (roof.covered ? 'Covered ballpark' : 'Forecast not loaded yet')));
    const descBits = [`Scheduled ${startTxt}`, roof.label];
    const w = g.weather || {};
    if (w.condition || w.temp || w.wind) descBits.push(`MLB game weather: ${[w.condition, w.temp ? `${w.temp}°F` : null, w.wind ? `wind ${w.wind}` : null].filter(Boolean).join(', ')}`);
    else descBits.push('MLB game weather: not yet published (appears around first pitch)');
    body.appendChild(UI.el('p', 'feed-desc', descBits.join(' · ')));

    if (risk && risk.reasons.length) {
      const ul = UI.el('ul', 'wx-reasons');
      risk.reasons.forEach((r) => ul.appendChild(UI.el('li', null, r)));
      body.appendChild(ul);
    }
    if (wx && wx.current) {
      const c = wx.current;
      body.appendChild(UI.el('p', 'text-forecast', `Current conditions (${c.station || 'ECCC'}): ${c.condition || '—'}${c.tempC != null ? `, ${c.tempC}°C` : ''}${c.windKmh ? `, wind ${c.windDir} ${c.windKmh} km/h` : ''}`));
    }
    if (wx && wx.textForecasts && wx.textForecasts.length) {
      const p = UI.el('p', 'text-forecast');
      wx.textForecasts.slice(0, 2).forEach((f) => { p.appendChild(UI.el('b', null, `${f.period}: `)); p.appendChild(document.createTextNode(`${f.text} `)); });
      body.appendChild(p);
    }
    if (risk && risk.windowPeriods && risk.windowPeriods.length && !roof.isDome) {
      const det = UI.el('details');
      det.appendChild(UI.el('summary', 'source-links-label', `Hourly forecast for the game window (${risk.windowPeriods.length} hours)`));
      det.appendChild(hourlyTable(risk.windowPeriods, wx.window, tz, wx.window ? wx.window.firstPitch : null));
      if (wx.forecast && (wx.forecast.updateTime || wx.forecast.hourlyIssued)) det.appendChild(UI.el('div', 'feed-observed-note', `Forecast issued ${MLB.localDateTime(wx.forecast.updateTime || wx.forecast.hourlyIssued)}`));
      body.appendChild(det);
    }
    if (risk && risk.alerts && risk.alerts.length) {
      body.appendChild(UI.el('p', 'feed-desc', `${risk.alerts.length} active alert${risk.alerts.length === 1 ? '' : 's'} at the ballpark: ${risk.alerts.map((a) => a.event).join(', ')} — see the ⚠ Alerts tab.`));
    }
    const links = [...mlbLinks(g), ...wxLinks(wx)];
    const sl = UI.sourceLinks(links, 'Verify');
    if (sl) body.appendChild(sl);
  }

  /* ---- delay row */

  function segmentHeadline(seg, ins) {
    const meta = Delays.KIND_META[seg.kind] || Delays.KIND_META.delayed;
    const reason = seg.reason ? `: ${seg.reason}` : '';
    const where = seg.inning != null && seg.kind !== 'delayed-start' ? ` — ${seg.halfInning === 'top' ? 'Top' : seg.halfInning === 'bottom' ? 'Bot' : ''} ${seg.inning}` : '';
    if (seg.open) return `${meta.label}${reason}${where} — ongoing since ${MLB.localTime(seg.startTime)}`;
    // For a delayed start the advisory span (posted → warmup) is not MLB's
    // official figure, which is first pitch − scheduled start; say so.
    const dur = seg.minutes != null
      ? (seg.kind === 'delayed-start' ? ` (advisory posted ${MLB.fmtMinutes(seg.minutes)} before play resumed)` : ` (${MLB.fmtMinutes(seg.minutes)})`)
      : '';
    return `${meta.label}${reason}${where}${dur}`;
  }

  function timelineList(seg) {
    const ul = UI.el('ul', 'timeline');
    seg.events.forEach((ev) => {
      const li = UI.el('li', `timeline-item ${seg.open && ev === seg.events[seg.events.length - 1] ? 'timeline-open' : ''}`);
      li.appendChild(UI.el('span', 'timeline-time', `${MLB.localTime(ev.startTime)}${ev.endTime && ev.endTime !== ev.startTime ? ` → ${MLB.localTime(ev.endTime)}` : ''}`));
      const txt = UI.el('span', 'timeline-text', ev.description);
      if (ev.inning != null) txt.appendChild(UI.el('span', 'feed-venue', ` (${ev.halfInning === 'top' ? 'Top' : ev.halfInning === 'bottom' ? 'Bot' : ''} ${ev.inning})`));
      li.appendChild(txt);
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

  function officialFacts(ins, box) {
    const bits = [];
    if (ins.official.delayMinutes != null) bits.push(`MLB delayDurationMinutes: ${ins.official.delayMinutes} (${MLB.fmtMinutes(ins.official.delayMinutes)})`);
    if (ins.official.firstPitch) bits.push(`first pitch ${MLB.localTime(ins.official.firstPitch)}${ins.official.startDelayMinutes != null && ins.official.startDelayMinutes > 0 ? ` (${ins.official.startDelayMinutes} min after the scheduled ${MLB.localTime(ins.official.scheduledStart)})` : ''}`);
    if (box && box.timeOfGame) bits.push(`box score T: ${box.timeOfGame}${box.delayNote ? ` (${box.delayNote})` : ''}`);
    if (box && box.weather) bits.push(`box score weather: ${box.weather}`);
    return bits;
  }

  function delayBody(body, row) {
    const { game: g, ins, seg, box, wx, risk } = row;
    const kind = seg ? seg.kind : ins.status.kind;
    const chips = [UI.kindChip(kind, seg ? Delays.KIND_META[kind].label : ins.status.detailedState)];
    const reason = seg ? seg.reason : ins.status.reason;
    const rc = Delays.classifyReason(reason ? reason.split(' → ').pop() : null);
    if (reason) chips.push(UI.el('span', `chip ${rc === 'other' ? 'chip-nonweather' : 'chip-weather'}`, rc === 'other' ? `${reason} (non-weather)` : reason));
    if (risk) chips.push(UI.riskChip(risk.level, `Forecast ${Weather.RISK_META[risk.level].label}`, risk.reasons.join(' ')));
    body.appendChild(gameHead(g, chips));

    if (seg) {
      body.appendChild(UI.el('p', 'feed-reason', segmentHeadline(seg, ins)));
      body.appendChild(UI.el('p', 'feed-desc', `${seg.events.length} official status-change advisor${seg.events.length === 1 ? 'y' : 'ies'} in the play-by-play${seg.freeText ? ' (free-text advisory)' : ''}.`));
      body.appendChild(timelineList(seg));
    } else {
      const label = Delays.statusLabel(ins.status);
      body.appendChild(UI.el('p', 'feed-reason', ins.active ? `${label} — per the official game status right now` : `${label}${ins.official.delayMinutes ? ` — ${MLB.fmtMinutes(ins.official.delayMinutes)} official delay` : ''}`));
      body.appendChild(UI.el('p', 'feed-desc', row.pending ? 'Fetching the play-by-play for the official advisory timeline…' : 'No status-change advisory found in the play-by-play; the facts below come from the schedule.'));
    }
    if (ins.active) body.appendChild(UI.el('p', 'feed-reason', 'Expected start / restart: not confirmed by this app. Scheduled first pitch and forecast clearing times are not restart announcements. Check the linked club sources and written reports below.'));
    const facts = officialFacts(ins, box);
    if (facts.length) body.appendChild(UI.el('p', 'feed-desc', `Official: ${facts.join(' · ')}`));
    if (row.observed && row.observed.length) {
      body.appendChild(UI.el('p', 'feed-observed-note', `Observed by this browser: ${row.observed.map((o) => `${new Date(o.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} → ${o.toRaw.detailedState}${o.toRaw.reason ? ` (${o.toRaw.reason})` : ''}`).join('; ')}`));
    }
    const s = MLB.sourceLinks(g.gamePk);
    const links = [...mlbLinks(g), { label: 'Play-by-play JSON', url: s.playByPlay, title: 'game_advisory events: "Status Change - …"' }, { label: 'Box score JSON', url: s.boxscore, title: 'info[]: Weather / Wind / T (delay) / Att' }, { label: 'Status registry', url: s.gameStatus }, ...wxLinks(wx).slice(0, 3)];
    body.appendChild(UI.sourceLinks(links, 'Verify'));
  }

  /* ---- postponed / suspended row */

  function postponedBody(body, row) {
    const { game: g, ins, wx, risk } = row;
    const chips = [UI.kindChip(ins.status.kind, ins.status.detailedState)];
    const rc = Delays.classifyReason(ins.status.reason);
    if (ins.status.reason) chips.push(UI.el('span', `chip ${rc === 'other' ? 'chip-nonweather' : 'chip-weather'}`, rc === 'other' ? `${ins.status.reason} (non-weather)` : ins.status.reason));
    if (risk && risk.level !== 'unknown') chips.push(UI.riskChip(risk.level, `Forecast ${Weather.RISK_META[risk.level].label}`, risk.reasons.join(' ')));
    body.appendChild(gameHead(g, chips));
    body.appendChild(UI.el('p', 'feed-reason', Delays.statusLabel(ins.status)));
    const bits = [`Originally scheduled ${MLB.localDateTime(g.gameDate)}`];
    if (ins.reschedule) bits.push(`rescheduled to ${ins.reschedule.toDate || ''}${ins.reschedule.toIso ? ` (${MLB.localDateTime(ins.reschedule.toIso)})` : ''}`.trim());
    if (ins.resume && (ins.resume.toDate || ins.resume.toIso)) bits.push(`resumes ${ins.resume.toDate || MLB.localDateTime(ins.resume.toIso)}`);
    else if (ins.status.kind === 'suspended') bits.push('resume date not confirmed by this app');
    if (ins.makeupOf) bits.push(ins.makeupOf.description || `makeup of ${ins.makeupOf.fromDate}`);
    if (g.officialDate && g._listingDate && g.officialDate !== g._listingDate) bits.push(`MLB officialDate is ${g.officialDate}`);
    if (!ins.reschedule && ins.status.kind === 'postponed') bits.push('no makeup date published yet');
    if (row.segments && row.segments.length) bits.push(`${row.segments.length} delay segment${row.segments.length === 1 ? '' : 's'} before suspension`);
    body.appendChild(UI.el('p', 'feed-desc', bits.join(' · ')));
    if (row.segments && row.segments.length) row.segments.forEach((seg) => body.appendChild(timelineList(seg)));
    const s = MLB.sourceLinks(g.gamePk);
    body.appendChild(UI.sourceLinks([...mlbLinks(g), { label: 'Status registry', url: s.gameStatus }, ...wxLinks(wx).slice(0, 3)], 'Verify'));
  }

  /* ---- alert row */

  function alertBody(body, row) {
    const a = row.alert;
    const head = UI.el('div', 'feed-head');
    head.appendChild(UI.el('span', `chip ${a.kind.severe ? 'chip-flag' : 'chip-alert'}`, `${a.kind.severe ? '🚨' : '⚠'} ${a.event}`));
    if (a.severity) head.appendChild(UI.el('span', 'chip chip-provider', `${a.severity}${a.urgency ? ` · ${a.urgency}` : ''}${a.certainty ? ` · ${a.certainty}` : ''}`));
    row.games.forEach((g) => {
      const link = UI.el('a', 'feed-game', gameTitle(g), { href: `game.html?gamePk=${g.gamePk}` });
      head.appendChild(link);
    });
    body.appendChild(head);
    body.appendChild(UI.el('p', 'feed-reason', a.headline || a.event));
    const bits = [];
    if (a.sender) bits.push(a.sender);
    if (a.onset) bits.push(`from ${MLB.localDateTime(a.onset)}`);
    if (a.ends || a.expires) bits.push(`until ${MLB.localDateTime(a.ends || a.expires)}`);
    if (a.areaDesc) bits.push(a.areaDesc.length > 160 ? `${a.areaDesc.slice(0, 160)}…` : a.areaDesc);
    body.appendChild(UI.el('p', 'feed-desc', bits.join(' · ')));
    if (a.description) {
      const det = UI.el('details');
      det.appendChild(UI.el('summary', 'source-links-label', 'Full alert text'));
      det.appendChild(UI.el('p', 'alert-head', a.description));
      if (a.instruction) det.appendChild(UI.el('p', 'alert-instruction', a.instruction));
      body.appendChild(det);
    }
    const links = [];
    const seenUrls = new Set();
    const pushLink = (l) => { if (l && l.url && !seenUrls.has(l.url)) { seenUrls.add(l.url); links.push(l); } };
    if (a.url) pushLink({ label: a.provider === 'eccc' ? 'ECCC alert' : 'NWS alert (JSON)', url: a.url, kind: 'gov' });
    if (row.wx && row.wx.alertsUrl) pushLink({ label: 'Alerts at ballpark (JSON)', url: row.wx.alertsUrl, kind: 'gov' });
    (row.wx && row.wx.links ? row.wx.links : []).forEach((l) => pushLink({ label: l.label, url: l.url, kind: 'gov' }));
    body.appendChild(UI.sourceLinks(links, 'Verify'));
  }

  /* ---- observed transition row */

  function transitionBody(body, row) {
    const { game: g, obs } = row;
    const to = Delays.parseStatus(obs.toRaw);
    const chips = [UI.el('span', 'chip chip-observed', '👁 observed'), UI.kindChip(to.kind, obs.toRaw.detailedState)];
    body.appendChild(gameHead(g, chips));
    const from = obs.fromRaw ? `${obs.fromRaw.detailedState}${obs.fromRaw.reason ? ` (${obs.fromRaw.reason})` : ''}` : '—';
    body.appendChild(UI.el('p', 'feed-reason', `Status changed: ${from} → ${obs.toRaw.detailedState}${obs.toRaw.reason ? ` (${obs.toRaw.reason})` : ''}`));
    body.appendChild(UI.el('p', 'feed-observed-note', `Seen by this browser at ${new Date(obs.at).toLocaleTimeString()} — this is when the poll noticed it, not MLB's official timestamp. The official times are in the play-by-play advisories.`));
    body.appendChild(UI.sourceLinks(mlbLinks(g), 'Verify'));
  }

  /* -------------------------------------------------------------- controls */

  function updateDateLabel() {
    const labelDate = new Date(`${state.dateStr}T12:00:00`);
    $('#date-label').textContent = labelDate.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    $('#date-picker').value = state.dateStr;
  }

  function syncUrl() {
    const url = new URL(window.location);
    url.searchParams.set('date', state.dateStr);
    window.history.replaceState({}, '', url);
    const back = $('#back-link');
    if (back) back.href = `index.html?date=${state.dateStr}`;
  }

  function resetForDate() {
    state.games = [];
    state.inspections.clear();
    state.weather.clear();
    state.pbp.clear();
    state.box.clear();
    state.statusCodes = new Map();
    state.observed = loadObserved(state.dateStr);
    state.seenRowIds = new Set();
    state.firstRender = true;
    state.lastWeatherAt = 0;
    renderClubLinks(); // drop the previous date's club links immediately
  }

  function changeDate() { syncUrl(); updateDateLabel(); resetForDate(); load(); }

  window.DelayFeed = {
    retry() { load(); },
    _pollStatus: pollStatus, // test hook
    setFilter(f) { state.filter = f; render(); },
    prevDay() { shiftDate(-1); changeDate(); },
    nextDay() { shiftDate(1); changeDate(); },
    today() { state.dateStr = todayStr(); changeDate(); },
    pickDate() { const d = $('#date-picker').value; if (d) { state.dateStr = d; changeDate(); } },
    refresh() { state.lastWeatherAt = 0; state.pbp.clear(); load(); },
    toggleSound() {
      state.soundOn = !state.soundOn;
      const btn = $('#sound-toggle-btn');
      btn.textContent = state.soundOn ? '🔔 Sound On' : '🔇 Sound Off';
      btn.classList.toggle('btn-sound-on', state.soundOn);
      if (state.soundOn) { state.lastChimeAt = 0; chime(); }
    },
    _buildRows: buildRows,
    _scanCandidates: scanCandidates,
    _state: state,
  };

  document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    const d = params.get('date');
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) state.dateStr = d;
    state.observed = loadObserved(state.dateStr);
    updateDateLabel();
    syncUrl();
    $('#refresh-btn').addEventListener('click', () => window.DelayFeed.refresh());
    $('#sound-toggle-btn').addEventListener('click', () => window.DelayFeed.toggleSound());
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { scheduleStatus(); load(); }
      else clearTimeout(state.statusTimer);
    });
    state.countdownTimer = setInterval(tickCountdown, 1000);
    scheduleStatus(true);
    load();
  });
})();
