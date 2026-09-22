/* Publisher reports are review candidates, never machine-confirmed game facts. */
'use strict';
const Reports = (() => {
  // Only HTTPS URLs from hosts whose content we've validated as safe to
  // render as linked headlines. The list is intentionally narrow so a
  // compromised or misconfigured RSS feed cannot link a user to a
  // malicious destination through this inbox.
  const HOSTS = new Set([
    'www.mlb.com', 'mlb.com',
    'www.espn.com', 'espn.com',
    'www.cbssports.com', 'cbssports.com',
    'sports.yahoo.com', 'www.yahoo.com',
    'www.si.com', 'si.com',
    'feeds.theathletic.com', 'theathletic.com', 'www.theathletic.com',
    'mlb.nbcsports.com', 'www.nbcsports.com', 'nbcsports.com',
  ]);

  const CATEGORY_LABEL = {
    official: 'MLB official',
    wire: 'Independent reporting',
  };
  const CATEGORY_CLS = {
    official: 'report-cat-official',
    wire: 'report-cat-wire',
  };

  function safeUrl(value) {
    try {
      const u = new URL(value);
      return u.protocol === 'https:' && !u.username && !u.password && HOSTS.has(u.hostname) ? u.href : null;
    } catch (_) { return null; }
  }

  function prepare(report, now = Date.now()) {
    if (!report || !Array.isArray(report.flagged) || !Array.isArray(report.feeds) || !Number.isFinite(Date.parse(report.generatedAt))) {
      throw new Error('Invalid report format');
    }
    const warnings = [];
    const age = now - Date.parse(report.generatedAt);
    if (age > 45 * 60000) warnings.push('Report snapshot is stale (over 45 minutes old). GitHub Actions scheduling and Pages publishing latency can delay refresh.');
    if (age < -5 * 60000) warnings.push('Snapshot timestamp is in the future. Check source / system clocks.');
    const failures = report.feeds.filter(f => !f.ok);
    if (failures.length) warnings.push(`${failures.length} of ${report.feeds.length} feeds unavailable; coverage is incomplete. See the per-feed list below.`);
    const seen = new Set();
    let rejected = 0;
    const items = report.flagged.filter(item => {
      if (!item || !safeUrl(item.link) || !safeUrl(item.feedUrl)) { rejected++; return false; }
      if (seen.has(item.link)) return false;
      seen.add(item.link);
      return true;
    }).map(item => ({ ...item, epoch: Date.parse(item.pubDate) || null }));
    if (rejected) warnings.push(`${rejected} entries omitted because their source links were missing or outside the publisher allowlist.`);
    items.sort((a, b) => (b.epoch || 0) - (a.epoch || 0));
    return { items, warnings, failures };
  }

  function render(report, root) {
    const data = prepare(report);
    UI.clear(root);

    // Header: snapshot stats
    const feedsOk = report.feeds.filter(f => f.ok).length;
    const officialCount = report.feeds.filter(f => f.ok && f.category === 'official').length;
    const wireCount = report.feeds.filter(f => f.ok && f.category === 'wire').length;
    root.appendChild(UI.el('p', 'feed-desc',
      `Snapshot: ${new Date(report.generatedAt).toLocaleString()} · ${feedsOk}/${report.feeds.length} feeds responding ` +
      `(${officialCount} official MLB · ${wireCount} independent). Times below are publication times — not game start or restart times.`
    ));

    // Warnings
    data.warnings.forEach(w => root.appendChild(UI.el('p', 'report-warning', `⚑ ${w}`)));

    // Feed status detail (collapsible)
    if (data.failures.length) {
      const details = UI.el('details');
      details.appendChild(UI.el('summary', '', `Unavailable feeds (${data.failures.length})`));
      data.failures.forEach(f => {
        const p = UI.el('p', '', `${f.name}: ${f.error || 'unavailable'} `);
        const url = safeUrl(f.url);
        if (url) p.appendChild(UI.el('a', '', 'Source feed', { href: url, target: '_blank', rel: 'noopener noreferrer' }));
        details.appendChild(p);
      });
      root.appendChild(details);
    }

    if (!data.items.length) {
      root.appendChild(UI.el('p', 'report-empty-note',
        'No headlines matching delay/rain/thunder vocabulary in the latest scan. This does NOT mean there are no delays — the official game status above is the source of truth for active delays, and a tarp announcement can break on club social channels before an RSS item is published.'));
      return;
    }

    data.items.slice(0, 100).forEach(item => {
      const card = UI.el('article', 'report-message');

      // Byline: category, author, publication time
      const bylineBits = [];
      const cat = item.category || (new URL(item.link).hostname.endsWith('mlb.com') ? 'official' : 'wire');
      const catLabel = CATEGORY_LABEL[cat] || 'News';
      bylineBits.push(catLabel);
      if (item.feed) bylineBits.push(item.feed.replace(/^MLB\.com — /, '').replace(/ \(official\)$/, ''));
      if (item.author) bylineBits.push(item.author);
      const byline = UI.el('p', `report-byline ${CATEGORY_CLS[cat] || ''}`, bylineBits.join(' · '));
      card.appendChild(byline);

      // Matched keywords (transparency: exactly why this headline was surfaced)
      if (item.matched && (item.matched.delay.length || item.matched.weather.length)) {
        const kw = UI.el('p', 'report-keywords');
        const bits = [];
        if (item.matched.delay.length) bits.push(`delay words: ${item.matched.delay.join(', ')}`);
        if (item.matched.weather.length) bits.push(`weather words: ${item.matched.weather.join(', ')}`);
        kw.appendChild(UI.el('span', 'report-kw-label', 'Matched: '));
        kw.appendChild(document.createTextNode(bits.join(' · ')));
        card.appendChild(kw);
      }

      card.appendChild(UI.el('h3', '', item.title));
      if (item.description) {
        const safe = String(item.description).replace(/\s+/g, ' ').trim();
        if (safe && safe !== item.title) {
          const trimmed = safe.length > 280 ? `${safe.slice(0, 280)}…` : safe;
          card.appendChild(UI.el('p', 'report-summary', trimmed));
        }
      }

      card.appendChild(UI.el('p', 'feed-desc report-review-note',
        'Review candidate only — not matched to a specific game. Headlines may refer to injuries, historical events, or unrelated stories. Open the article to verify.'));

      const pubEpoch = item.epoch;
      if (!pubEpoch) {
        card.appendChild(UI.el('p', 'report-warning', '⚑ Publication time not parseable.'));
      } else if (pubEpoch > Date.now() + 300000) {
        card.appendChild(UI.el('p', 'report-warning', '⚑ Publication time is in the future. Feed may be misconfigured.'));
      } else if (Date.now() - pubEpoch > 86400000) {
        card.appendChild(UI.el('p', 'report-warning', '⚑ Older than 24 hours — do not use as a current restart confirmation.'));
      } else {
        const pubEl = UI.el('p', 'report-time', `Published: ${new Date(pubEpoch).toLocaleString()}`);
        card.appendChild(pubEl);
      }

      card.appendChild(UI.sourceLinks([
        { label: 'Read original report', url: safeUrl(item.link) },
        { label: 'Publisher RSS feed', url: safeUrl(item.feedUrl) },
      ], 'Verify'));

      root.appendChild(card);
    });

    if (data.items.length > 100) {
      root.appendChild(UI.el('p', '', `Showing newest 100 of ${data.items.length} distinct reports. Complete snapshot is linked below.`));
    }
  }

  async function refresh() {
    const root = document.getElementById('written-reports');
    if (!root) return;
    try {
      const response = await fetch(`docs/news-report.json?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      render(await response.json(), root);
    } catch (err) {
      UI.clear(root).appendChild(UI.el('p', 'report-warning',
        `Written reports unavailable (${err.message}). No claim about delay status can be made from this missing snapshot. ` +
        'The server-side RSS scan runs every 15 minutes via GitHub Actions; check the official club links above in the meantime. Retrying automatically.'));
    }
  }

  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => {
    refresh();
    setInterval(() => { if (!document.hidden) refresh(); }, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  });

  return { safeUrl, prepare, render, HOSTS, CATEGORY_LABEL };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Reports;
