/* ============================================================================
 * weather.js — official weather for every ballpark (forecast + alerts)
 * ----------------------------------------------------------------------------
 * Providers, in priority order, all keyless and callable from a static page:
 *
 *  1. NWS — U.S. National Weather Service  https://api.weather.gov
 *       GET /points/{lat},{lon}                  -> grid + forecastHourly URL
 *       GET /gridpoints/{wfo}/{x},{y}/forecast/hourly
 *       GET /alerts/active?point={lat},{lon}
 *     Verified live 2026-09-21 for Rate Field (41.83,-87.634167 -> LOT/76,71).
 *     Points outside the U.S. answer HTTP 404 with a JSON problem document
 *     whose `type` ends in "InvalidPoint" (verified for Rogers Centre) — that
 *     is the trigger for provider 2. CORS: api.weather.gov answers with
 *     `Access-Control-Allow-Origin: *`; do NOT send a custom User-Agent
 *     header from the browser (it forces a preflight that fails).
 *
 *  2. ECCC — Environment and Climate Change Canada, MSC GeoMet OGC API
 *       GET https://api.weather.gc.ca/collections/citypageweather-realtime/
 *           items?f=json&lang=en&bbox=…        -> nearest city-page forecast
 *     Verified live 2026-09-21 (Toronto Island, feature "on-128"):
 *     properties.currentConditions, .forecastGroup.forecasts[],
 *     .hourlyForecastGroup.hourlyForecasts[] (timestamp, condition, lop = PoP,
 *     temperature, wind), .warnings[], .url.en (weather.gc.ca page).
 *     Every leaf is bilingual `{ en, fr }`.
 *
 *  3. Open-Meteo (https://api.open-meteo.com/v1/forecast) — NON-governmental
 *     model output, used ONLY when neither government service covers the
 *     venue (e.g. Mexico City, Santo Domingo, London, Tokyo). Its use is
 *     always flagged as an irregularity for manual review.
 *
 * Nothing here predicts a delay. `assess()` turns the official forecast for
 * the game window into a transparent "forecast risk" bucket whose rules are
 * spelled out in RISK_RULES so a reviewer can re-derive every label.
 * ==========================================================================*/
'use strict';

const Weather = (() => {
  const NWS = 'https://api.weather.gov';
  const ECCC_ITEMS = 'https://api.weather.gc.ca/collections/citypageweather-realtime/items';
  const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';

  /* Refresh intervals — NWS hourly forecasts are regenerated roughly hourly
   * and served with Cache-Control; alerts are cheap and time-critical. */
  const HOURLY_TTL_MS = 15 * 60 * 1000;
  const ALERTS_TTL_MS = 2 * 60 * 1000;
  const POINT_TTL_MS = 24 * 60 * 60 * 1000; // /points mappings are stable
  const RETRY_AFTER_ERROR_MS = 60 * 1000;
  const MAX_CONCURRENT = 6;

  /* Game window used for the risk read: pre-game tarp decisions start about
   * an hour before first pitch; a nine-inning game runs ~3h, so +4h. */
  const WINDOW_BEFORE_MS = 60 * 60 * 1000;
  const WINDOW_AFTER_MS = 4 * 60 * 60 * 1000;

  /* The risk rules, as data, so the UI can print them verbatim. */
  const RISK_RULES = [
    'HIGH — max hourly precipitation chance in the game window ≥ 60%, or thunderstorms in the window with chance ≥ 40%, or an active Tornado / Severe Thunderstorm / Flash Flood WARNING at the ballpark.',
    'MODERATE — max chance 30–59%, or any thunderstorm mention in the window, or an active weather WATCH / ADVISORY at the ballpark (marine, beach and rip-current products are ignored).',
    'LOW — max chance 10–29% with no thunderstorms.',
    'NONE — max chance below 10% and no thunderstorms.',
    'COVERED — fixed dome, or a retractable roof MLB reports as "Roof Closed" for this game (alerts are still listed).',
    'UNKNOWN — no forecast could be fetched; see the manual-review links.',
  ];

  /* ------------------------------------------------------------ small utils */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const round4 = (n) => Math.round(Number(n) * 10000) / 10000;
  const isNum = (n) => typeof n === 'number' && !Number.isNaN(n);

  /** Bilingual ECCC leaf `{en, fr}` -> "en" text; plain strings/numbers pass through. */
  function enText(v) {
    if (v == null) return null;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'object') {
      if ('en' in v) return v.en;
      if ('value' in v) return enText(v.value);
    }
    return null;
  }

  function cToF(c) { return isNum(c) ? Math.round((c * 9) / 5 + 32) : null; }
  function fToC(f) { return isNum(f) ? Math.round(((f - 32) * 5) / 9) : null; }
  function kmhToMph(k) { return isNum(k) ? Math.round(k / 1.609344) : null; }

  function ts(iso) {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : t;
  }

  /* ------------------------------------------------------------ text tests */

  const RE_THUNDER = /thunder|t-storm|tstm|lightning|orage/i;
  const RE_RAIN = /rain|shower|drizzle|storm|precip|averse|pluie/i;
  const RE_SNOW = /snow|sleet|ice|freez|wintry|blizzard|flurr|neige|verglas/i;
  const RE_FOG = /fog|mist|haze|smoke|brouillard/i;

  function textFlags(text) {
    const s = String(text || '');
    return {
      thunder: RE_THUNDER.test(s),
      rain: RE_RAIN.test(s),
      snow: RE_SNOW.test(s),
      fog: RE_FOG.test(s),
    };
  }

  /* WMO 4677 weather codes as used by Open-Meteo (documented code table). */
  const WMO = {
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Depositing rime fog',
    51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
    56: 'Light freezing drizzle', 57: 'Dense freezing drizzle',
    61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
    66: 'Light freezing rain', 67: 'Heavy freezing rain',
    71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow', 77: 'Snow grains',
    80: 'Slight rain showers', 81: 'Moderate rain showers', 82: 'Violent rain showers',
    85: 'Slight snow showers', 86: 'Heavy snow showers',
    95: 'Thunderstorm', 96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail',
  };

  /* ------------------------------------------------------------- normalize */

  /**
   * NWS hourly -> [{ start, end, tempF, tempC, pop, text, wind, windDir, flags }]
   * Shape (verified 2026-09-21): properties.periods[].{ startTime, endTime,
   * temperature, temperatureUnit, probabilityOfPrecipitation.value,
   * windSpeed "15 mph", windDirection, shortForecast }.
   */
  function normalizeNwsHourly(json) {
    const props = (json && json.properties) || {};
    const periods = Array.isArray(props.periods) ? props.periods : [];
    const out = periods.map((p) => {
      const pop = p.probabilityOfPrecipitation && isNum(p.probabilityOfPrecipitation.value)
        ? p.probabilityOfPrecipitation.value : null;
      const unit = String(p.temperatureUnit || 'F').toUpperCase();
      const tempF = unit === 'F' ? (isNum(p.temperature) ? p.temperature : null) : cToF(p.temperature);
      return {
        start: ts(p.startTime), end: ts(p.endTime),
        startIso: p.startTime || null, endIso: p.endTime || null,
        tempF, tempC: unit === 'C' ? p.temperature : fToC(tempF),
        pop,
        text: p.shortForecast || '',
        wind: p.windSpeed || '', windDir: p.windDirection || '',
        flags: textFlags(p.shortForecast),
      };
    }).filter((p) => p.start != null);
    return {
      periods: out,
      generatedAt: props.generatedAt || null,
      updateTime: props.updateTime || null,
    };
  }

  /* NWS alert events that can stop a ballgame or endanger a crowd. */
  const RE_ALERT_SEVERE = /tornado|severe thunderstorm|flash flood|hurricane|typhoon|extreme wind|dust storm/i;
  const RE_ALERT_WEATHER = /thunder|flood|wind|winter|snow|ice|freez|blizzard|heat|cold|frost|fog|air quality|smoke|lightning|rain|storm|tropical|hail|dust|excessive|extreme|fire weather|red flag/i;
  const RE_ALERT_IGNORE = /beach|rip current|marine|small craft|gale|surf|coastal flood|lakeshore|seiche|hydrologic outlook|special weather statement/i;

  function classifyAlertEvent(event) {
    const e = String(event || '');
    const isWarning = /warning/i.test(e);
    const isWatch = /watch/i.test(e);
    const isAdvisory = /advisory|statement/i.test(e);
    const ignored = RE_ALERT_IGNORE.test(e) && !RE_ALERT_SEVERE.test(e);
    const severe = RE_ALERT_SEVERE.test(e) && isWarning;
    const weather = RE_ALERT_WEATHER.test(e) || RE_ALERT_SEVERE.test(e);
    return {
      severe, weather, ignored,
      level: severe ? 'severe' : isWarning ? 'warning' : isWatch ? 'watch' : isAdvisory ? 'advisory' : 'other',
    };
  }

  /**
   * NWS alerts -> [{ id, event, headline, severity, urgency, certainty,
   *                  onset, ends, expires, sender, areaDesc, url, kind }]
   * Shape (verified 2026-09-21): features[].properties.{ id (URL), event,
   * headline, severity, certainty, urgency, onset, ends, expires, senderName,
   * areaDesc, description, instruction, status, messageType }.
   */
  function normalizeNwsAlerts(json) {
    const feats = (json && Array.isArray(json.features)) ? json.features : [];
    return feats.map((f) => {
      const p = (f && f.properties) || {};
      // Verified 2026-09-21: properties.id is the bare "urn:oid:…" identifier;
      // the browsable URL is the feature `id` / properties["@id"].
      const url = (typeof f.id === 'string' && /^https?:/.test(f.id)) ? f.id
        : (typeof p['@id'] === 'string' && /^https?:/.test(p['@id'])) ? p['@id']
        : (p.id ? `${NWS}/alerts/${p.id}` : null);
      return {
        id: p.id || f.id || null,
        url,
        event: p.event || '',
        headline: p.headline || '',
        severity: p.severity || '', urgency: p.urgency || '', certainty: p.certainty || '',
        status: p.status || '', messageType: p.messageType || '',
        onset: p.onset || p.effective || p.sent || null,
        ends: p.ends || null, expires: p.expires || null,
        sender: p.senderName || '',
        areaDesc: p.areaDesc || '',
        description: p.description || '',
        instruction: p.instruction || '',
        kind: classifyAlertEvent(p.event),
        provider: 'nws',
      };
    }).filter((a) => a.status !== 'Test' && a.status !== 'Exercise');
  }

  /**
   * ECCC city-page feature -> same normalized shape as NWS.
   * Verified 2026-09-21 on collection citypageweather-realtime, item on-128.
   */
  function normalizeEccc(feature) {
    const p = (feature && feature.properties) || {};
    const hourlyGroup = p.hourlyForecastGroup || {};
    const hourly = Array.isArray(hourlyGroup.hourlyForecasts) ? hourlyGroup.hourlyForecasts : [];
    const periods = hourly.map((h) => {
      const tempC = Number(enText(h.temperature && h.temperature.value));
      const pop = Number(enText(h.lop && h.lop.value));
      const speed = Number(enText(h.wind && h.wind.speed && h.wind.speed.value));
      const text = enText(h.condition) || '';
      const start = ts(h.timestamp);
      return {
        start, end: start != null ? start + 3600 * 1000 : null,
        startIso: h.timestamp || null, endIso: null,
        tempC: isNum(tempC) ? tempC : null, tempF: isNum(tempC) ? cToF(tempC) : null,
        pop: isNum(pop) ? pop : null,
        text,
        wind: isNum(speed) ? `${kmhToMph(speed)} mph` : '',
        windDir: enText(h.wind && h.wind.direction && h.wind.direction.value) || '',
        flags: textFlags(text),
      };
    }).filter((x) => x.start != null);

    const cc = p.currentConditions || {};
    const current = Object.keys(cc).length ? {
      time: enText(cc.timestamp) || null,
      condition: enText(cc.condition) || '',
      tempC: Number(enText(cc.temperature && cc.temperature.value)),
      humidity: Number(enText(cc.relativeHumidity && cc.relativeHumidity.value)),
      windKmh: Number(enText(cc.wind && cc.wind.speed && cc.wind.speed.value)),
      windDir: enText(cc.wind && cc.wind.direction && cc.wind.direction.value) || '',
      station: enText(cc.station && cc.station.value) || '',
    } : null;
    if (current && !isNum(current.tempC)) current.tempC = null;

    const textForecasts = (p.forecastGroup && Array.isArray(p.forecastGroup.forecasts)
      ? p.forecastGroup.forecasts : []).slice(0, 4).map((f) => ({
      period: enText(f.period && f.period.textForecastName) || '',
      text: enText(f.textSummary) || '',
    }));

    const warnings = Array.isArray(p.warnings) ? p.warnings : [];
    const alerts = warnings.map((w, i) => {
      // Field names come from the collection's published queryables schema
      // (https://api.weather.gc.ca/collections/citypageweather-realtime/queryables,
      // read 2026-09-21): warnings[].description / type / priority /
      // alertColourLevel / eventIssue / expiryTime / url, all bilingual.
      // A populated example was not observed live (the verified items had
      // `warnings: []`), so unknown leaves fall back to the city-page URL.
      const description = enText(w && w.description) || '';
      const type = enText(w && w.type) || '';
      const event = description || type || 'Weather warning';
      const url = enText(w && w.url) || enText(p.url) || null;
      return {
        id: `eccc-${p.identifier || 'x'}-${i}`,
        url, event, headline: description || event,
        severity: enText(w && (w.priority || w.alertColourLevel)) || '', urgency: '', certainty: '',
        status: 'Actual', messageType: type,
        onset: enText(w && w.eventIssue) || null, ends: null, expires: enText(w && w.expiryTime) || null,
        sender: 'Environment and Climate Change Canada',
        areaDesc: enText(p.name) || '',
        description: type && type !== description ? type : '', instruction: '',
        kind: classifyAlertEvent(event),
        provider: 'eccc',
      };
    });

    return {
      periods, current, textForecasts, alerts,
      station: enText(p.name) || '',
      region: enText(p.region) || '',
      url: enText(p.url) || null,
      lastUpdated: p.lastUpdated || null,
      hourlyIssued: enText(hourlyGroup.timestamp) || null,
    };
  }

  /**
   * Open-Meteo hourly -> normalized periods. Requested with
   * `timeformat=unixtime&timezone=UTC` so `hourly.time[]` is epoch seconds.
   * Documented fields: hourly.{ time, temperature_2m, precipitation_probability,
   * precipitation, weather_code, wind_speed_10m }.
   */
  function normalizeOpenMeteo(json) {
    const h = (json && json.hourly) || {};
    const times = Array.isArray(h.time) ? h.time : [];
    const get = (arr, i) => (Array.isArray(arr) && isNum(arr[i]) ? arr[i] : null);
    const periods = times.map((t, i) => {
      const start = isNum(t) ? t * 1000 : ts(t);
      const code = get(h.weather_code, i);
      const tempC = get(h.temperature_2m, i);
      const text = code != null ? (WMO[code] || `WMO code ${code}`) : '';
      const wind = get(h.wind_speed_10m, i);
      return {
        start, end: start != null ? start + 3600 * 1000 : null,
        startIso: start != null ? new Date(start).toISOString() : null, endIso: null,
        tempC, tempF: cToF(tempC),
        pop: get(h.precipitation_probability, i),
        precipMm: get(h.precipitation, i),
        text,
        wind: wind != null ? `${kmhToMph(wind)} mph` : '', windDir: '',
        flags: textFlags(text),
      };
    }).filter((x) => x.start != null);
    return { periods, generatedAt: null };
  }

  /* -------------------------------------------------------------- windows */

  /** Game window from the schedule item: firstPitch (if known) else gameDate. */
  function windowFor(game, now) {
    const gi = (game && game.gameInfo) || {};
    const startIso = gi.firstPitch || (game && game.gameDate) || null;
    const start = ts(startIso);
    if (start == null) return null;
    let end = start + WINDOW_AFTER_MS;
    // A finished game's window ends when it ended (firstPitch + duration).
    if (isNum(gi.gameDurationMinutes) && game.status && game.status.abstractGameState === 'Final') {
      end = start + (gi.gameDurationMinutes + (isNum(gi.delayDurationMinutes) ? gi.delayDurationMinutes : 0)) * 60 * 1000;
    }
    return { start: start - WINDOW_BEFORE_MS, end, firstPitch: start, now: now || Date.now() };
  }

  function periodsInWindow(periods, win) {
    if (!win) return [];
    return (periods || []).filter((p) => p.start != null && p.start < win.end && (p.end == null ? p.start : p.end) > win.start);
  }

  /* ------------------------------------------------------------------ roof */

  /**
   * Roof state from official fields only:
   *   venue.fieldInfo.roofType ∈ Open | Dome | Retractable (verified via
   *   hydrate=venue(fieldInfo)), and the game's weather.condition string,
   *   which MLB sets to "Dome" / "Roof Closed" for covered games (verified
   *   2026-09-20: 822922 "Dome", 824139 "Roof Closed").
   */
  function roofInfo(game) {
    const roofType = (game && game.venue && game.venue.fieldInfo && game.venue.fieldInfo.roofType) || null;
    const cond = String((game && game.weather && game.weather.condition) || '');
    const closedNow = /roof closed|dome/i.test(cond) ? true : (/roof open/i.test(cond) ? false : null);
    const isDome = roofType === 'Dome';
    const covered = isDome || closedNow === true;
    let label = roofType ? `${roofType} roof` : 'Roof type not reported';
    if (isDome) label = 'Dome (fixed roof)';
    else if (roofType === 'Retractable') label = closedNow === true ? 'Retractable roof — closed (per MLB)' : closedNow === false ? 'Retractable roof — open (per MLB)' : 'Retractable roof — state not yet reported';
    else if (roofType === 'Open') label = 'Open-air ballpark';
    return { roofType, isDome, covered, closedNow, label };
  }

  /* --------------------------------------------------------------- assess */

  /**
   * Forecast risk for one game. Pure: (normalized forecast, alerts, game window,
   * roof) -> { level, maxPop, thunder, worst, reasons[], windowPeriods }.
   */
  function assess(forecast, alerts, win, roof) {
    const reasons = [];
    const periods = periodsInWindow(forecast && forecast.periods, win);
    let maxPop = null;
    let thunder = false;
    let snow = false;
    let worst = null;
    periods.forEach((p) => {
      if (p.pop != null && (maxPop == null || p.pop > maxPop)) { maxPop = p.pop; worst = p; }
      if (p.flags && p.flags.thunder) thunder = true;
      if (p.flags && p.flags.snow) snow = true;
    });
    const activeAlerts = (alerts || []).filter((a) => !a.kind.ignored && a.kind.weather);
    const severe = activeAlerts.some((a) => a.kind.severe);

    if (roof && roof.covered) {
      reasons.push(roof.isDome ? 'Fixed dome — precipitation cannot reach the field.' : 'MLB reports the roof closed for this game.');
      if (activeAlerts.length) reasons.push(`${activeAlerts.length} active weather alert(s) still listed for the area.`);
      return { level: 'covered', maxPop, thunder, snow, worst, reasons, windowPeriods: periods, alerts: activeAlerts };
    }
    if (!forecast || !periods.length) {
      reasons.push('No hourly forecast available for the game window.');
      if (severe) reasons.push('Severe warning active at the ballpark.');
      return { level: severe ? 'high' : activeAlerts.length ? 'moderate' : 'unknown', maxPop, thunder, snow, worst, reasons, windowPeriods: periods, alerts: activeAlerts };
    }

    let level = 'none';
    if (maxPop != null && maxPop >= 60) { level = 'high'; reasons.push(`Precipitation chance peaks at ${maxPop}% in the game window.`); }
    else if (thunder && maxPop != null && maxPop >= 40) { level = 'high'; reasons.push(`Thunderstorms in the forecast with a ${maxPop}% chance.`); }
    else if (maxPop != null && maxPop >= 30) { level = 'moderate'; reasons.push(`Precipitation chance peaks at ${maxPop}%.`); }
    else if (thunder) { level = 'moderate'; reasons.push('Thunderstorms mentioned in the game-window forecast.'); }
    else if (maxPop != null && maxPop >= 10) { level = 'low'; reasons.push(`Precipitation chance peaks at ${maxPop}%.`); }
    else if (maxPop == null) { level = 'unknown'; reasons.push('Forecast periods carry no precipitation probability.'); }
    else reasons.push(`Precipitation chance stays below 10% (max ${maxPop}%).`);

    if (snow) reasons.push('Snow / freezing precipitation mentioned in the window.');
    if (severe) { level = 'high'; reasons.push('Severe weather WARNING active at the ballpark.'); }
    else if (activeAlerts.length && (level === 'none' || level === 'low')) { level = 'moderate'; reasons.push('Weather watch/advisory active at the ballpark.'); }

    return { level, maxPop, thunder, snow, worst, reasons, windowPeriods: periods, alerts: activeAlerts };
  }

  const RISK_META = {
    high:     { label: 'High',     cls: 'risk-high',     glyph: '⛈' },
    moderate: { label: 'Moderate', cls: 'risk-moderate', glyph: '🌧' },
    low:      { label: 'Low',      cls: 'risk-low',      glyph: '🌦' },
    none:     { label: 'Clear',    cls: 'risk-none',     glyph: '☀' },
    covered:  { label: 'Covered',  cls: 'risk-covered',  glyph: '🏟' },
    unknown:  { label: 'No data',  cls: 'risk-unknown',  glyph: '❔' },
  };

  /* --------------------------------------------------------------- caches */

  const cache = new Map(); // key -> { at, value, error, errorAt }

  function cached(key, ttl) {
    const c = cache.get(key);
    if (!c) return null;
    if (c.value !== undefined && Date.now() - c.at < ttl) return c;
    if (c.error && Date.now() - c.errorAt < RETRY_AFTER_ERROR_MS) return c;
    return null;
  }

  function remember(key, value) { cache.set(key, { at: Date.now(), value }); return value; }
  function rememberError(key, error) {
    const prev = cache.get(key) || {};
    cache.set(key, { ...prev, error, errorAt: Date.now() });
    return prev.value;
  }

  /* Simple concurrency gate shared by all weather requests. */
  let active = 0;
  const queue = [];
  async function gated(fn) {
    if (active >= MAX_CONCURRENT) await new Promise((r) => queue.push(r));
    active += 1;
    try { return await fn(); } finally {
      active -= 1;
      const next = queue.shift();
      if (next) next();
    }
  }

  function fetchJson(url, opts) {
    // Weather hosts have their own budget: never share the StatsAPI 429 gate.
    return gated(() => MLB.getJSON(url, { timeout: 10000, retries: 1, accept: null, rateLimitShared: false, cache: 'default', ...opts }));
  }

  /* ---------------------------------------------------------------- NWS */

  function nwsPointUrl(lat, lon) { return `${NWS}/points/${round4(lat)},${round4(lon)}`; }
  function nwsAlertsUrl(lat, lon) { return `${NWS}/alerts/active?point=${round4(lat)},${round4(lon)}`; }

  function isInvalidPoint(err) {
    const type = err && err.body && err.body.type;
    return !!(err && err.status === 404 && (!type || /InvalidPoint/i.test(String(type))));
  }

  async function nwsPoint(lat, lon) {
    const key = `nws:point:${round4(lat)},${round4(lon)}`;
    const hit = cached(key, POINT_TTL_MS);
    if (hit) { if (hit.value) return hit.value; throw hit.error; }
    try {
      const json = await fetchJson(nwsPointUrl(lat, lon), { retries: 0 });
      const p = (json && json.properties) || {};
      if (!p.forecastHourly) throw new Error('NWS /points answered without a forecastHourly URL');
      return remember(key, {
        forecastHourly: p.forecastHourly, forecast: p.forecast || null,
        gridId: p.gridId || null, gridX: p.gridX, gridY: p.gridY,
        radarStation: p.radarStation || null, timeZone: p.timeZone || null,
        city: p.relativeLocation && p.relativeLocation.properties ? p.relativeLocation.properties.city : null,
        state: p.relativeLocation && p.relativeLocation.properties ? p.relativeLocation.properties.state : null,
        url: nwsPointUrl(lat, lon),
      });
    } catch (err) {
      // An InvalidPoint is permanent for these coordinates — cache it as long
      // as a good mapping so the fallback provider is chosen without re-asking.
      if (isInvalidPoint(err)) { cache.set(key, { at: Date.now(), error: err, errorAt: Date.now() + POINT_TTL_MS }); }
      else rememberError(key, err);
      throw err;
    }
  }

  async function nwsHourly(point) {
    const key = `nws:hourly:${point.forecastHourly}`;
    const hit = cached(key, HOURLY_TTL_MS);
    if (hit && hit.value) return hit.value;
    if (hit && hit.error) throw hit.error;
    try {
      const json = await fetchJson(point.forecastHourly);
      return remember(key, { ...normalizeNwsHourly(json), url: point.forecastHourly });
    } catch (err) {
      const stale = rememberError(key, err);
      if (stale) return { ...stale, stale: true };
      throw err;
    }
  }

  async function nwsAlerts(lat, lon) {
    const url = nwsAlertsUrl(lat, lon);
    const key = `nws:alerts:${url}`;
    const hit = cached(key, ALERTS_TTL_MS);
    if (hit && hit.value) return hit.value;
    if (hit && hit.error) throw hit.error;
    try {
      const json = await fetchJson(url);
      return remember(key, { alerts: normalizeNwsAlerts(json), updated: json && json.updated, url });
    } catch (err) {
      const stale = rememberError(key, err);
      if (stale) return { ...stale, stale: true };
      throw err;
    }
  }

  /* --------------------------------------------------------------- ECCC */

  function ecccItemsUrl(lat, lon) {
    const bbox = [lon - 0.4, lat - 0.3, lon + 0.4, lat + 0.3].map((n) => n.toFixed(3)).join(',');
    return `${ECCC_ITEMS}?f=json&lang=en&limit=10&bbox=${bbox}`;
  }

  function nearestFeature(json, lat, lon) {
    const feats = (json && Array.isArray(json.features)) ? json.features : [];
    let best = null;
    let bestD = Infinity;
    feats.forEach((f) => {
      const c = f && f.geometry && Array.isArray(f.geometry.coordinates) ? f.geometry.coordinates : null;
      if (!c) return;
      const d = (c[1] - lat) ** 2 + (c[0] - lon) ** 2;
      if (d < bestD) { bestD = d; best = f; }
    });
    return best;
  }

  async function ecccForecast(lat, lon) {
    const url = ecccItemsUrl(lat, lon);
    const key = `eccc:${url}`;
    const hit = cached(key, HOURLY_TTL_MS);
    if (hit && hit.value) return hit.value;
    if (hit && hit.error) throw hit.error;
    try {
      const json = await fetchJson(url);
      const feat = nearestFeature(json, lat, lon);
      if (!feat) { const e = new Error('No ECCC city page within 0.4° of the venue'); e.noCoverage = true; throw e; }
      return remember(key, { ...normalizeEccc(feat), apiUrl: url });
    } catch (err) {
      const stale = rememberError(key, err);
      if (stale) return { ...stale, stale: true };
      throw err;
    }
  }

  /* ----------------------------------------------------------- Open-Meteo */

  function openMeteoUrl(lat, lon) {
    return `${OPEN_METEO}?latitude=${round4(lat)}&longitude=${round4(lon)}` +
      '&hourly=temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m' +
      '&forecast_days=3&timeformat=unixtime&timezone=UTC';
  }

  async function openMeteoForecast(lat, lon) {
    const url = openMeteoUrl(lat, lon);
    const key = `om:${url}`;
    const hit = cached(key, HOURLY_TTL_MS);
    if (hit && hit.value) return hit.value;
    if (hit && hit.error) throw hit.error;
    try {
      const json = await fetchJson(url);
      return remember(key, { ...normalizeOpenMeteo(json), url });
    } catch (err) {
      const stale = rememberError(key, err);
      if (stale) return { ...stale, stale: true };
      throw err;
    }
  }

  /* ----------------------------------------------------------- per venue */

  function coordsOf(venue) {
    const c = venue && venue.location && venue.location.defaultCoordinates;
    if (!c || !isNum(Number(c.latitude)) || !isNum(Number(c.longitude))) return null;
    const lat = Number(c.latitude);
    const lon = Number(c.longitude);
    if (!lat && !lon) return null;
    return { lat, lon };
  }

  /** Manual-review links for a venue (all official, all human-readable). */
  function reviewLinks(venue, provider, point) {
    const c = coordsOf(venue);
    const links = [];
    if (!c) return links;
    if (provider === 'nws' || provider == null) {
      links.push({ label: 'NWS forecast page', url: `https://forecast.weather.gov/MapClick.php?lat=${round4(c.lat)}&lon=${round4(c.lon)}` });
      links.push({ label: 'NWS alerts (JSON)', url: nwsAlertsUrl(c.lat, c.lon) });
      if (point && point.radarStation) links.push({ label: `NWS radar ${point.radarStation}`, url: `https://radar.weather.gov/station/${String(point.radarStation).toLowerCase()}/standard` });
    }
    if (provider === 'eccc') {
      links.push({ label: 'weather.gc.ca city page', url: `https://weather.gc.ca/en/location/index.html?coords=${c.lat.toFixed(2)},${c.lon.toFixed(2)}` });
      links.push({ label: 'ECCC alerts', url: 'https://weather.gc.ca/warnings/index_e.html' });
    }
    if (provider === 'open-meteo') {
      links.push({ label: 'Open-Meteo (model data)', url: openMeteoUrl(c.lat, c.lon) });
    }
    return links;
  }

  const providerByVenue = new Map(); // venueId -> 'nws' | 'eccc' | 'open-meteo'

  /**
   * Fetch (or serve from cache) everything the UI needs for one venue.
   * Never throws: returns { ok:false, error } with the issue list instead.
   */
  async function forVenue(venue, opts = {}) {
    const issues = [];
    const c = coordsOf(venue);
    const vid = venue && venue.id;
    if (!c) {
      issues.push({ code: 'no-coordinates', text: 'MLB lists no coordinates for this venue — no forecast can be fetched.' });
      return { ok: false, provider: null, coords: null, issues, links: [], alerts: [], forecast: null };
    }
    const country = String((venue && venue.location && venue.location.country) || '');
    let provider = providerByVenue.get(vid) || null;
    if (!provider && country && !/^(usa|united states|us)$/i.test(country)) provider = /canada/i.test(country) ? 'eccc' : 'open-meteo';

    const tryOrder = provider ? [provider] : ['nws', 'eccc', 'open-meteo'];
    let lastErr = null;
    for (const p of tryOrder) {
      try {
        if (p === 'nws') {
          const point = await nwsPoint(c.lat, c.lon);
          const [hourly, alerts] = await Promise.all([
            nwsHourly(point).catch((e) => { issues.push({ code: 'nws-hourly-failed', text: `NWS hourly forecast unavailable (${e.message}).` }); return null; }),
            nwsAlerts(c.lat, c.lon).catch((e) => { issues.push({ code: 'nws-alerts-failed', text: `NWS alerts unavailable (${e.message}).` }); return null; }),
          ]);
          providerByVenue.set(vid, 'nws');
          if (hourly && hourly.stale) issues.push({ code: 'stale', text: 'Showing the last successful NWS forecast fetch (refresh failed).' });
          return {
            ok: !!(hourly || alerts), provider: 'nws', coords: c, point, issues,
            forecast: hourly, alerts: alerts ? alerts.alerts : [], alertsUrl: alerts ? alerts.url : nwsAlertsUrl(c.lat, c.lon),
            links: reviewLinks(venue, 'nws', point),
            sourceUrls: [point.url, hourly && hourly.url, alerts && alerts.url].filter(Boolean),
          };
        }
        if (p === 'eccc') {
          const fc = await ecccForecast(c.lat, c.lon);
          providerByVenue.set(vid, 'eccc');
          if (provider !== 'eccc') issues.push({ code: 'nws-no-coverage', text: 'Outside NWS coverage — using Environment and Climate Change Canada.' });
          if (fc.stale) issues.push({ code: 'stale', text: 'Showing the last successful ECCC fetch (refresh failed).' });
          return {
            ok: true, provider: 'eccc', coords: c, issues,
            forecast: fc, alerts: fc.alerts || [], current: fc.current, textForecasts: fc.textForecasts,
            links: [{ label: `weather.gc.ca — ${fc.station || 'city page'}`, url: fc.url || `https://weather.gc.ca/en/location/index.html?coords=${c.lat.toFixed(2)},${c.lon.toFixed(2)}` }, ...reviewLinks(venue, 'eccc')],
            sourceUrls: [fc.apiUrl].filter(Boolean),
          };
        }
        if (p === 'open-meteo') {
          const fc = await openMeteoForecast(c.lat, c.lon);
          providerByVenue.set(vid, 'open-meteo');
          issues.push({ code: 'non-government-source', text: 'No government forecast API covers this venue — Open-Meteo model data shown; verify manually.' });
          if (fc.stale) issues.push({ code: 'stale', text: 'Showing the last successful Open-Meteo fetch (refresh failed).' });
          return {
            ok: true, provider: 'open-meteo', coords: c, issues,
            forecast: fc, alerts: [], links: reviewLinks(venue, 'open-meteo'), sourceUrls: [fc.url],
          };
        }
      } catch (err) {
        lastErr = err;
        if (p === 'nws' && !isInvalidPoint(err)) {
          // A transient NWS failure must not silently switch the venue to a
          // different country's service: report and stop.
          issues.push({ code: 'nws-failed', text: `NWS unavailable (${err.message}); will retry.` });
          return { ok: false, provider: 'nws', coords: c, issues, forecast: null, alerts: [], links: reviewLinks(venue, 'nws', null), sourceUrls: [nwsPointUrl(c.lat, c.lon)] };
        }
        if (p === 'eccc' && !(err.noCoverage || err.status === 404)) {
          issues.push({ code: 'eccc-failed', text: `ECCC unavailable (${err.message}); will retry.` });
          return { ok: false, provider: 'eccc', coords: c, issues, forecast: null, alerts: [], links: reviewLinks(venue, 'eccc'), sourceUrls: [ecccItemsUrl(c.lat, c.lon)] };
        }
        // otherwise: no coverage -> next provider
      }
    }
    issues.push({ code: 'no-provider', text: `No weather provider could serve this venue (${lastErr ? lastErr.message : 'unknown error'}).` });
    return { ok: false, provider: null, coords: c, issues, forecast: null, alerts: [], links: reviewLinks(venue, null, null), sourceUrls: [] };
  }

  /** Forecast + risk for one schedule game (never throws). */
  async function forGame(game, opts = {}) {
    const roof = roofInfo(game);
    const win = windowFor(game, opts.now);
    const wx = await forVenue(game && game.venue, opts);
    const risk = assess(wx.forecast, wx.alerts, win, roof);
    if (!win) risk.reasons.push('Game has no start time yet (TBD).');
    return { ...wx, roof, window: win, risk };
  }

  /** "62% · Chance Showers And Thunderstorms · 7 PM" for a risk's worst period. */
  function summaryText(risk, tz) {
    if (!risk) return '';
    if (risk.level === 'covered') return 'Covered';
    if (risk.level === 'unknown') return 'No forecast';
    const parts = [];
    if (risk.maxPop != null) parts.push(`${risk.maxPop}%`);
    if (risk.worst && risk.worst.text) parts.push(risk.worst.text);
    if (risk.worst && risk.worst.start) parts.push(MLB.zonedTime(new Date(risk.worst.start).toISOString(), tz));
    return parts.join(' · ');
  }

  return {
    RISK_RULES, RISK_META,
    normalizeNwsHourly, normalizeNwsAlerts, normalizeEccc, normalizeOpenMeteo,
    classifyAlertEvent, textFlags, enText,
    windowFor, periodsInWindow, roofInfo, assess, summaryText,
    coordsOf, reviewLinks, nwsPointUrl, nwsAlertsUrl, ecccItemsUrl, openMeteoUrl,
    nearestFeature, isInvalidPoint,
    forVenue, forGame,
    _cache: cache, _providerByVenue: providerByVenue,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Weather;
