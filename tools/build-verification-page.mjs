#!/usr/bin/env node
/* ============================================================================
 * tools/build-verification-page.mjs — render docs/verification.md → .html
 * ----------------------------------------------------------------------------
 * Minimal Markdown subset (headings, paragraphs, pipe tables, ordered/unordered
 * lists, fenced code, inline code/bold/links, horizontal rules). No deps.
 *   node tools/build-verification-page.mjs
 * ==========================================================================*/
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const mdPath = path.join(here, '..', 'docs', 'verification.md');
const outPath = path.join(here, '..', 'docs', 'verification.html');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function inline(s) {
  // protect code spans first
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(`<code>${esc(c)}</code>`); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${u}"${/^https?:/.test(u) ? ' target="_blank" rel="noopener"' : ''}>${t}</a>`);
  s = s.replace(/&lt;(https?:\/\/[^&\s]+)&gt;/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
  return s;
}
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');

const lines = readFileSync(mdPath, 'utf8').split('\n');
const out = [];
let i = 0;
let para = [];
const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
while (i < lines.length) {
  const line = lines[i];
  if (/^```/.test(line)) {
    flushPara();
    const buf = [];
    i += 1;
    while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i += 1; }
    out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
    i += 1; continue;
  }
  const h = /^(#{1,6})\s+(.*)$/.exec(line);
  if (h) { flushPara(); const lvl = h[1].length; out.push(`<h${lvl} id="${slug(h[2])}">${inline(h[2])}</h${lvl}>`); i += 1; continue; }
  if (/^---+\s*$/.test(line)) { flushPara(); out.push('<hr>'); i += 1; continue; }
  if (/^\|/.test(line) && i + 1 < lines.length && /^\|\s*-+/.test(lines[i + 1])) {
    flushPara();
    const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
    const head = cells(line);
    i += 2;
    const rows = [];
    while (i < lines.length && /^\|/.test(lines[i])) { rows.push(cells(lines[i])); i += 1; }
    out.push('<div class="table-wrap"><table>');
    out.push(`<thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`);
    out.push(`<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody>`);
    out.push('</table></div>');
    continue;
  }
  const li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
  if (li) {
    flushPara();
    const ordered = /\d+\./.test(li[2]);
    const items = [];
    while (i < lines.length) {
      const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
      if (m) { items.push(m[3]); i += 1; continue; }
      if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += ` ${lines[i].trim()}`; i += 1; continue; }
      break;
    }
    out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
    continue;
  }
  if (!line.trim()) { flushPara(); i += 1; continue; }
  para.push(line.trim());
  i += 1;
}
flushPara();

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MLB Rain Delay — Verification report</title>
  <meta name="description" content="Line-by-line verification of every fact the MLB Rain Delay site shows against its official source: MLB StatsAPI, the US National Weather Service and Environment Canada, with the URLs used and the remaining limitations.">
  <link rel="stylesheet" href="../assets/css/style.css">
  <style>
    .doc { max-width: 1100px; margin: 0 auto; padding: 18px 16px 60px; line-height: 1.55; }
    .doc h1 { font-size: 1.5rem; margin: 8px 0 14px; }
    .doc h2 { font-size: 1.15rem; margin: 30px 0 8px; padding-top: 12px; border-top: 1px solid var(--line, #223352); }
    .doc h3 { font-size: 1rem; margin: 22px 0 6px; }
    .doc p, .doc li { color: var(--text, #e9f0fa); font-size: 0.93rem; }
    .doc code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; background: rgba(110,118,129,0.25); padding: 1px 5px; border-radius: 5px; word-break: break-word; }
    .doc pre { background: var(--panel, #111c2e); border: 1px solid var(--line, #223352); border-radius: 8px; padding: 12px; overflow: auto; }
    .doc pre code { background: none; padding: 0; }
    .doc .table-wrap { overflow-x: auto; margin: 10px 0 16px; }
    .doc table { border-collapse: collapse; width: 100%; font-size: 0.86rem; }
    .doc th, .doc td { border: 1px solid var(--line, #223352); padding: 6px 9px; vertical-align: top; text-align: left; }
    .doc th { background: rgba(110,118,129,0.15); white-space: nowrap; }
    .doc td:nth-child(2) { white-space: nowrap; }
    .doc a { color: var(--accent, #2f81f7); }
    .doc hr { border: 0; border-top: 1px solid var(--line, #223352); margin: 26px 0; }
  </style>
</head>
<body class="page-doc">
  <header class="topbar">
    <div class="brand">
      <span class="brand-ball">⚾</span>
      <span>MLB Rain Delay</span>
      <span class="brand-sub">verification report</span>
    </div>
    <a class="btn btn-ghost" href="../index.html">← Scoreboard</a>
    <a class="btn btn-ghost" href="../delays.html">Delay feed</a>
    <a class="btn btn-ghost" href="https://github.com/buffedlizard55-lab/MLBRainDelay/blob/main/docs/verification.md" target="_blank" rel="noopener">Markdown source ↗</a>
  </header>
  <main class="doc">
${out.join('\n')}
  </main>
  <footer class="site-footer">
    <p>Generated from <code>docs/verification.md</code> by <code>tools/build-verification-page.mjs</code>. Unofficial fan project — not affiliated with MLB, NOAA or ECCC.</p>
  </footer>
</body>
</html>
`;
writeFileSync(outPath, html);
console.log(`wrote ${path.relative(process.cwd(), outPath)} (${html.length} bytes)`);
