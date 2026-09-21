/* Publisher reports are review candidates, never machine-confirmed game facts. */
'use strict';
const Reports = (() => {
  const HOSTS = new Set(['www.mlb.com', 'mlb.com', 'www.espn.com', 'espn.com']);
  function safeUrl(value) {
    try {
      const u = new URL(value);
      return u.protocol === 'https:' && !u.username && !u.password && HOSTS.has(u.hostname) ? u.href : null;
    } catch (_) { return null; }
  }
  function prepare(report, now = Date.now()) {
    if (!report || !Array.isArray(report.flagged) || !Array.isArray(report.feeds) || !Number.isFinite(Date.parse(report.generatedAt))) throw new Error('Invalid report format');
    const warnings = [];
    const age = now - Date.parse(report.generatedAt);
    if (age > 45 * 60000) warnings.push('Report snapshot is stale (over 45 minutes old).');
    if (age < -5 * 60000) warnings.push('Snapshot timestamp is in the future. Check source / system clocks.');
    const failures = report.feeds.filter(f => !f.ok);
    if (failures.length) warnings.push(`${failures.length} feeds unavailable; coverage is incomplete.`);
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
    root.appendChild(UI.el('p', 'feed-desc', `Snapshot: ${new Date(report.generatedAt).toLocaleString()} · ${report.feeds.filter(f => f.ok).length}/${report.feeds.length} feeds read. Times below are publication times, not game start times.`));
    data.warnings.forEach(w => root.appendChild(UI.el('p', 'report-warning', `⚑ ${w}`)));
    if (data.failures.length) {
      const details = UI.el('details');
      details.appendChild(UI.el('summary', '', 'Review unavailable feeds'));
      data.failures.forEach(f => {
        const p = UI.el('p', '', `${f.name}: ${f.error || 'unavailable'} `);
        if (safeUrl(f.url)) p.appendChild(UI.el('a', '', 'Source feed', { href: safeUrl(f.url), target: '_blank', rel: 'noopener noreferrer' }));
        details.appendChild(p);
      });
      root.appendChild(details);
    }
    if (!data.items.length) root.appendChild(UI.el('p', '', 'No matching headlines in this snapshot. This does not mean there are no delays.'));
    data.items.slice(0, 100).forEach(item => {
      const card = UI.el('article', 'report-message');
      const official = new URL(item.link).hostname.endsWith('mlb.com');
      card.appendChild(UI.el('p', 'report-byline', `${official ? 'MLB publisher' : 'ESPN • independent reporting'} · ${item.author || 'Author not supplied'} · ${item.epoch ? new Date(item.epoch).toLocaleString() : 'Publication time unknown'}`));
      card.appendChild(UI.el('h3', '', item.title));
      card.appendChild(UI.el('p', 'feed-desc', 'Review candidate — not matched to a game. Headline keywords can refer to historical events, injuries, or unrelated stories.'));
      if (!item.epoch || item.epoch > Date.now() + 300000 || Date.now() - item.epoch > 86400000) card.appendChild(UI.el('p', 'report-warning', '⚑ Publication time unknown, future-dated, or older than 24 hours. Do not use as a current restart confirmation.'));
      card.appendChild(UI.sourceLinks([{label: 'Read original report', url: safeUrl(item.link)}, {label: 'Publisher RSS', url: safeUrl(item.feedUrl)}], 'Verify'));
      root.appendChild(card);
    });
    if (data.items.length > 100) root.appendChild(UI.el('p', '', `Showing newest 100 of ${data.items.length} distinct reports. Complete snapshot is linked below.`));
  }
  async function refresh() {
    const root = document.getElementById('written-reports');
    if (!root) return;
    try {
      const response = await fetch(`docs/news-report.json?t=${Date.now()}`, {cache: 'no-store', signal: AbortSignal.timeout(20000)});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      render(await response.json(), root);
    } catch (err) {
      UI.clear(root).appendChild(UI.el('p', 'report-warning', `Written reports unavailable (${err.message}). No claim about delay status can be made from this missing snapshot. Retrying automatically.`));
    }
  }
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => {
    refresh();
    setInterval(() => { if (!document.hidden) refresh(); }, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  });
  return { safeUrl, prepare, render };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Reports;
