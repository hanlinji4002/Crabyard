import { esc } from '../dom-utils.js';
import { t } from '../i18n.js';
import { deriveProjectName } from '../../shared/project-name.js';
import { getUsageReport, isUsageLoading, refreshUsage, usageFailed } from '../claude-history-store.js';
import { formatTokens, formatUsd, lastNDays, localDateKey } from '../claude-history-format.js';
import type { ClaudeUsageRow } from '../../shared/types.js';

// The sidebar's Usage view: Claude Code token usage and an API-price cost
// estimate aggregated from local transcripts (see main/claude-history.ts).

export type UsageRange = 'today' | '7d' | '30d' | 'all';
const RANGES: UsageRange[] = ['today', '7d', '30d', 'all'];
const RANGE_KEY = 'vibeyard.sidebarUsageRange';
const TOP_FOLDERS = 8;

let range: UsageRange = readStoredRange();

function readStoredRange(): UsageRange {
  try {
    const v = localStorage.getItem(RANGE_KEY);
    if (v && (RANGES as string[]).includes(v)) return v as UsageRange;
  } catch {
    // storage unavailable
  }
  return '7d';
}

function storeRange(v: UsageRange): void {
  try {
    localStorage.setItem(RANGE_KEY, v);
  } catch {
    // storage unavailable
  }
}

interface Totals {
  cost: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  requests: number;
}

function emptyTotals(): Totals {
  return { cost: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, requests: 0 };
}

function add(total: Totals, row: ClaudeUsageRow): void {
  total.cost += row.costUsd;
  total.input += row.inputTokens;
  total.output += row.outputTokens;
  total.cacheWrite += row.cacheWriteTokens;
  total.cacheRead += row.cacheReadTokens;
  total.requests += row.requests;
}

function allTokens(total: Totals): number {
  return total.input + total.output + total.cacheWrite + total.cacheRead;
}

/** First date key (inclusive) of the range, or '' for all time. */
function rangeStart(r: UsageRange, now: number): string {
  if (r === 'today') return localDateKey(now);
  if (r === '7d') return lastNDays(7, now)[0];
  if (r === '30d') return lastNDays(30, now)[0];
  return '';
}

function chartDays(r: UsageRange, now: number): string[] {
  return lastNDays(r === '30d' || r === 'all' ? 30 : 7, now);
}

function statCard(value: string, label: string): string {
  return `<div class="usage-side-card"><div class="usage-side-value">${esc(value)}</div><div class="usage-side-label">${esc(label)}</div></div>`;
}

function breakdownRow(name: string, detail: string, cost: number, max: number, title?: string): string {
  const pct = max > 0 ? Math.max(2, Math.round((cost / max) * 100)) : 0;
  return `
    <div class="usage-side-row"${title ? ` title="${esc(title)}"` : ''}>
      <div class="usage-side-row-top">
        <span class="usage-side-row-name">${esc(name)}</span>
        <span class="usage-side-row-cost">${esc(formatUsd(cost))}</span>
      </div>
      <div class="usage-side-bar"><span style="width:${pct}%"></span></div>
      <div class="usage-side-row-detail">${esc(detail)}</div>
    </div>`;
}

export function renderSidebarUsage(container: HTMLElement): void {
  container.innerHTML = '';
  const report = getUsageReport();
  if (report === null && !isUsageLoading()) void refreshUsage();

  const header = document.createElement('div');
  header.className = 'sidebar-view-header';
  header.innerHTML = `
    <span class="sidebar-view-title">${esc(t('sidebarUsage.title'))}</span>
    <div class="sidebar-view-actions">
      <button type="button" class="icon-btn usage-side-refresh${isUsageLoading() ? ' spinning' : ''}" aria-label="${esc(t('sidebarUsage.refresh'))}" title="${esc(t('sidebarUsage.refresh'))}">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>
      </button>
    </div>
  `;
  header.querySelector('.usage-side-refresh')!.addEventListener('click', () => { void refreshUsage(true); });
  container.appendChild(header);

  const seg = document.createElement('div');
  seg.className = 'usage-side-ranges';
  for (const r of RANGES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'usage-side-range' + (r === range ? ' active' : '');
    btn.textContent = t(`sidebarUsage.range.${r}`);
    btn.addEventListener('click', () => {
      range = r;
      storeRange(r);
      renderSidebarUsage(container);
    });
    seg.appendChild(btn);
  }
  container.appendChild(seg);

  if (report === null) {
    const status = document.createElement('div');
    status.className = 'conv-empty conv-status';
    status.textContent = usageFailed() ? t('sidebarUsage.loadFailed') : t('sidebarUsage.loading');
    container.appendChild(status);
    return;
  }

  const now = Date.now();
  const start = rangeStart(range, now);
  const rows = report.rows.filter((r) => r.date >= start);

  const total = emptyTotals();
  const byModel = new Map<string, Totals>();
  const byFolder = new Map<string, Totals>();
  const byDay = new Map<string, number>();
  for (const row of rows) {
    add(total, row);
    if (!byModel.has(row.model)) byModel.set(row.model, emptyTotals());
    add(byModel.get(row.model)!, row);
    if (!byFolder.has(row.project)) byFolder.set(row.project, emptyTotals());
    add(byFolder.get(row.project)!, row);
  }
  const days = chartDays(range, now);
  const firstDay = days[0];
  for (const row of report.rows) {
    if (row.date >= firstDay) byDay.set(row.date, (byDay.get(row.date) ?? 0) + row.costUsd);
  }

  const body = document.createElement('div');
  body.className = 'usage-side-body';

  const cards = `
    <div class="usage-side-cards">
      ${statCard(formatUsd(total.cost), t('sidebarUsage.cost'))}
      ${statCard(formatTokens(allTokens(total)), t('sidebarUsage.tokens'))}
      ${statCard(formatTokens(total.output), t('sidebarUsage.outputTokens'))}
      ${statCard(total.requests.toLocaleString(), t('sidebarUsage.requests'))}
    </div>
    <div class="usage-side-mix">${esc(t('sidebarUsage.mix', {
      input: formatTokens(total.input),
      output: formatTokens(total.output),
      write: formatTokens(total.cacheWrite),
      read: formatTokens(total.cacheRead),
    }))}</div>`;

  const today = localDateKey(now);
  const maxDay = Math.max(0, ...days.map((d) => byDay.get(d) ?? 0));
  const bars = days.map((d) => {
    const cost = byDay.get(d) ?? 0;
    const pct = maxDay > 0 ? Math.max(cost > 0 ? 3 : 0, Math.round((cost / maxDay) * 100)) : 0;
    const inRange = d >= start;
    return `<div class="usage-side-day${d === today ? ' today' : ''}${inRange ? '' : ' dim'}" title="${esc(`${d}  ${formatUsd(cost)}`)}"><span style="height:${pct}%"></span></div>`;
  }).join('');
  const chart = `
    <div class="usage-side-section">${esc(t(days.length > 7 ? 'sidebarUsage.daily30' : 'sidebarUsage.daily7'))}</div>
    <div class="usage-side-chart">${bars}</div>
    <div class="usage-side-axis"><span>${esc(days[0].slice(5))}</span><span>${esc(days[days.length - 1].slice(5))}</span></div>`;

  const models = [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost);
  const maxModel = models[0]?.[1].cost ?? 0;
  const modelRows = models.map(([model, v]) =>
    breakdownRow(model, t('sidebarUsage.rowDetail', { tokens: formatTokens(allTokens(v)), requests: v.requests.toLocaleString() }), v.cost, maxModel),
  ).join('');

  const folders = [...byFolder.entries()].sort((a, b) => b[1].cost - a[1].cost);
  const maxFolder = folders[0]?.[1].cost ?? 0;
  const folderRows = folders.slice(0, TOP_FOLDERS).map(([folder, v]) =>
    breakdownRow(
      folder ? deriveProjectName(folder) : t('conversations.unknownFolder'),
      t('sidebarUsage.rowDetail', { tokens: formatTokens(allTokens(v)), requests: v.requests.toLocaleString() }),
      v.cost,
      maxFolder,
      folder,
    ),
  ).join('');

  const updated = new Date(report.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const unpriced = report.unpricedModels.length
    ? `<div class="usage-side-note">${esc(t('sidebarUsage.unpriced', { models: report.unpricedModels.join(', ') }))}</div>`
    : '';

  body.innerHTML = `
    ${cards}
    ${chart}
    ${rows.length === 0 ? `<div class="conv-empty">${esc(t('sidebarUsage.empty'))}</div>` : `
      <div class="usage-side-section">${esc(t('sidebarUsage.byModel'))}</div>
      ${modelRows}
      <div class="usage-side-section">${esc(t('sidebarUsage.byFolder'))}</div>
      ${folderRows}`}
    <div class="usage-side-note">${esc(t('sidebarUsage.disclaimer'))}</div>
    ${unpriced}
    <div class="usage-side-note">${esc(t('sidebarUsage.updated', { time: updated }))}</div>
  `;
  container.appendChild(body);
}
