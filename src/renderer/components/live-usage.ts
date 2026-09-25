import { esc } from '../dom-utils.js';
import { getLocale, t } from '../i18n.js';
import { formatRelativeTime, formatResetTime } from '../claude-history-format.js';
import { getPlanUsage, limitLevel, windowAt, type PlanWindow } from '../plan-usage.js';

// Top pane of the right-hand column: the Claude plan's usage limits as two
// rings — the 5-hour window and the weekly window. Numbers come from Claude
// Code's statusLine via plan-usage.ts, so they refresh while a Claude
// conversation runs here.

const RADIUS = 26;
const ICON_DOCK_BOTTOM = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 15h18"/></svg>';
const ICON_DOCK_RIGHT = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/></svg>';
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

interface Ring {
  label: string;
  window: PlanWindow | null;
}

function dialSvg(percent: number | null): string {
  const fill = percent !== null && percent > 0
    ? `<circle class="live-ring-fill" cx="32" cy="32" r="${RADIUS}" stroke-dasharray="${CIRCUMFERENCE.toFixed(2)}" stroke-dashoffset="${(CIRCUMFERENCE * (1 - percent / 100)).toFixed(2)}"/>`
    : '';
  return `<svg class="live-ring-svg" viewBox="0 0 64 64" aria-hidden="true"><circle class="live-ring-track" cx="32" cy="32" r="${RADIUS}"/>${fill}</svg>`;
}

function buildRing(ring: Ring, now: number, locale: string): HTMLElement {
  const w = windowAt(ring.window, now);
  const percent = w?.percent ?? null;
  const el = document.createElement('div');
  el.className = 'live-ring ' + (percent === null ? 'empty' : limitLevel(percent));
  const value = percent === null ? '—' : `${Math.round(percent)}<span>%</span>`;
  const reset = w?.reset
    ? t('liveUsage.reset')
    : w?.resetsAt ? formatResetTime(w.resetsAt, now, locale) : '';
  el.innerHTML = `
    <div class="live-ring-dial">${dialSvg(percent)}<div class="live-ring-value">${value}</div></div>
    <div class="live-ring-text">
      <div class="live-ring-label">${esc(ring.label)}</div>
      <div class="live-ring-reset">${esc(reset)}</div>
    </div>
  `;
  return el;
}

/**
 * Render the pane into `container`. `solo` is set when the pane has the column
 * to itself: the rings then stack one per row, larger, with text beside them.
 * `dock` says where it sits now; the header button moves it to the other place.
 */
export function renderLiveUsage(
  container: HTMLElement,
  opts: { solo: boolean; onClose: () => void; dock: 'right' | 'bottom'; onToggleDock: () => void; maxRings?: number },
): void {
  const now = Date.now();
  const locale = getLocale();
  const usage = getPlanUsage();
  container.innerHTML = '';
  container.classList.toggle('solo', opts.solo);

  const header = document.createElement('div');
  header.className = 'sidebar-view-header';
  const updated = usage ? t('liveUsage.updated', { time: formatRelativeTime(usage.updatedAt, now, locale) }) : '';
  const dockLabel = opts.dock === 'right' ? t('liveUsage.dockBottom') : t('liveUsage.dockRight');
  header.innerHTML = `
    <span class="sidebar-view-title">${esc(t('liveUsage.title'))}</span>
    <div class="sidebar-view-actions">
      <span class="live-usage-updated">${esc(updated)}</span>
      <button type="button" class="icon-btn usage-panel-close live-usage-dock" title="${esc(dockLabel)}" aria-label="${esc(dockLabel)}">${opts.dock === 'right' ? ICON_DOCK_BOTTOM : ICON_DOCK_RIGHT}</button>
      <button type="button" class="icon-btn usage-panel-close live-usage-hide" title="${esc(t('usagePanel.hide'))}" aria-label="${esc(t('usagePanel.hide'))}">&times;</button>
    </div>
  `;
  header.querySelector('.live-usage-dock')!.addEventListener('click', opts.onToggleDock);
  header.querySelector('.live-usage-hide')!.addEventListener('click', opts.onClose);
  container.appendChild(header);

  const rings: Ring[] = [
    { label: t('liveUsage.fiveHour'), window: usage?.fiveHour ?? null },
    { label: t('liveUsage.weekly'), window: usage?.sevenDay ?? null },
  ];
  // A narrow dock keeps just the 5-hour ring.
  const shown = rings.slice(0, Math.max(1, Math.min(rings.length, opts.maxRings ?? 2)));
  const grid = document.createElement('div');
  grid.className = 'live-rings';
  if (!opts.solo) grid.style.gridTemplateColumns = `repeat(${shown.length}, minmax(0, 1fr))`;
  for (const ring of shown) grid.appendChild(buildRing(ring, now, locale));
  container.appendChild(grid);

  if (!usage) {
    const note = document.createElement('div');
    note.className = 'live-usage-note';
    note.textContent = t('liveUsage.empty');
    container.appendChild(note);
  }
}
