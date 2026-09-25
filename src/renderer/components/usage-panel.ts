import { renderSidebarUsage } from './sidebar-usage.js';
import { renderLiveUsage } from './live-usage.js';
import { renderChangesPane } from './changes-pane.js';
import { renderClawdTank } from './clawd-tank.js';
import { refreshSkills, renderSkillsPane } from './skills-pane.js';
import { appState } from '../state.js';
import { onClaudeHistoryChange, refreshUsage } from '../claude-history-store.js';
import { onPlanUsageChange } from '../plan-usage.js';
import { onChangesViewChange, refreshChanges } from '../conversation-changes-store.js';
import { onLocaleChange, t } from '../i18n.js';
import { DOCK_MAX_WIDTH, DOCK_MIN_WIDTH, isFixedPane, planPaneHeights, ringsThatFit, totalsShowFull } from './usage-panel-layout.js';

// The right-hand column, top to bottom: the Clawd tub, 本轮修改 and 本对话修改
// (the focused conversation's file changes),
// Skills (switches for Claude Code's skills), 当前用量 (plan-limit rings) and
// the usage totals.
// Each pane has its own tab-bar toggle and close button; whichever are open
// share the column and the last one fills it. The edges between panes drag to
// resize (double-click resets); the totals show everything when their pane is
// tall enough and just the ranges, cards and mix line when it is not.
// 当前用量 can instead dock below the conversation, beside the project terminal.
// Visibility, sizes and the dock persist per machine. Terminals only refit on
// window resize, so geometry changes dispatch one.

type Pane = 'clawd' | 'turn' | 'session' | 'skills' | 'live' | 'totals';
type LiveDock = 'right' | 'bottom';
const PANES: Pane[] = ['clawd', 'turn', 'session', 'skills', 'live', 'totals'];

const PANE_IDS: Record<Pane, string> = {
  clawd: 'usage-clawd-pane',
  turn: 'usage-turn-pane',
  session: 'usage-session-pane',
  skills: 'usage-skills-pane',
  live: 'usage-live-pane',
  totals: 'usage-totals-pane',
};
const TOGGLE_IDS: Record<Pane, string> = {
  clawd: 'btn-toggle-clawd',
  turn: 'btn-toggle-turn-changes',
  session: 'btn-toggle-session-changes',
  skills: 'btn-toggle-skills',
  live: 'btn-toggle-live-usage',
  totals: 'btn-toggle-usage',
};
const TOGGLE_LABELS: Record<Pane, string> = {
  clawd: 'clawd.toggle',
  turn: 'changes.toggleTurn',
  session: 'changes.toggleSession',
  skills: 'skills.toggle',
  live: 'liveUsage.toggle',
  totals: 'usagePanel.toggle',
};
const VISIBLE_KEYS: Record<Pane, string> = {
  clawd: 'myclaudetui.usagePanel.clawd',
  turn: 'myclaudetui.usagePanel.turn',
  session: 'myclaudetui.usagePanel.session',
  skills: 'myclaudetui.usagePanel.skills',
  live: 'myclaudetui.usagePanel.live',
  totals: 'myclaudetui.usagePanel.totals',
};
/** Before the split one flag covered the whole column, which held the totals. */
const LEGACY_VISIBLE_KEY = 'myclaudetui.usagePanel.visible';
const WIDTH_KEY = 'myclaudetui.usagePanel.width';
const HEIGHTS_KEY = 'myclaudetui.usagePanel.heights';
const DOCK_KEY = 'myclaudetui.liveUsage.dock';
const DOCK_WIDTH_KEY = 'myclaudetui.liveUsage.dockWidth';
/** Bumped when the column gains a pane, so dragged heights sized for the old column don't starve it. */
const LAYOUT_VERSION_KEY = 'myclaudetui.usagePanel.layoutVersion';
const LAYOUT_VERSION = '2';
const MIN_WIDTH = 240;
const MAX_WIDTH = 520;
const DEFAULT_WIDTH = 300;
/** Matches `.usage-pane { min-height }`. */
const MIN_PANE_HEIGHT = 72;
const POLL_MS = 30_000;
/** The change panes follow a live conversation, so they poll faster. */
const CHANGES_POLL_MS = 4_000;

let panelEl: HTMLElement | null = null;
let handleEl: HTMLElement | null = null;
let dockEl: HTMLElement | null = null;
let dockSplitEl: HTMLElement | null = null;
/** Width of 当前用量 docked beside the terminal: it only narrows from the full two-ring width. */
let dockWidth = DOCK_MAX_WIDTH;
/** Rings shown in the dock; recomputed as its width changes. */
let dockRings: 1 | 2 = 2;
const paneEls: Partial<Record<Pane, HTMLElement>> = {};
const toggleBtns: Partial<Record<Pane, HTMLElement>> = {};
const visible: Record<Pane, boolean> = { clawd: true, turn: true, session: true, skills: true, live: true, totals: true };
let heights: Partial<Record<Pane, number>> = {};
let liveDock: LiveDock = 'right';
/** While an edge is being dragged, the drag owns the pane sizes. */
let dragging = false;
/** A fixed pane's (the tub's, 当前用量's) natural height is capped at this share of the column. */
const FIXED_MAX_SHARE = 0.45;

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable
  }
}

function readVisible(pane: Pane): boolean {
  const stored = readStorage(VISIBLE_KEYS[pane]);
  if (stored !== null) return stored !== '0';
  if (pane === 'totals') return readStorage(LEGACY_VISIBLE_KEY) !== '0';
  return true;
}

function readHeights(): Partial<Record<Pane, number>> {
  try {
    const parsed = JSON.parse(readStorage(HEIGHTS_KEY) ?? '{}') as Record<string, unknown>;
    const out: Partial<Record<Pane, number>> = {};
    for (const pane of PANES) {
      const h = parsed[pane];
      if (typeof h === 'number' && Number.isFinite(h) && h >= MIN_PANE_HEIGHT) out[pane] = Math.round(h);
    }
    return out;
  } catch {
    return {};
  }
}

function clampWidth(width: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));
}

function refitTerminals(): void {
  window.dispatchEvent(new Event('resize'));
}

/** Open panes that live in the right column (当前用量 may be docked below instead). */
function columnPanes(): Pane[] {
  return PANES.filter((p) => visible[p] && !(p === 'live' && liveDock === 'bottom'));
}

function renderPane(pane: Pane): void {
  const el = paneEls[pane];
  if (!el || !visible[pane]) return;
  scheduleFit();
  const onClose = () => setPaneVisible(pane, false);
  if (pane === 'clawd') {
    renderClawdTank(el, { onClose });
  } else if (pane === 'turn' || pane === 'session') {
    renderChangesPane(el, { mode: pane, onClose, rerender: () => renderPane(pane) });
  } else if (pane === 'skills') {
    renderSkillsPane(el, { onClose, rerender: () => renderPane('skills') });
  } else if (pane === 'live') {
    renderLiveUsage(el, {
      solo: liveDock === 'right' && columnPanes().length === 1,
      onClose,
      dock: liveDock,
      onToggleDock: () => setLiveDock(liveDock === 'right' ? 'bottom' : 'right'),
      maxRings: liveDock === 'bottom' ? dockRings : 2,
    });
  } else {
    renderSidebarUsage(el);
    const actions = el.querySelector('.sidebar-view-actions');
    if (!actions) return;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'icon-btn usage-panel-close';
    close.title = t('usagePanel.hide');
    close.setAttribute('aria-label', t('usagePanel.hide'));
    close.innerHTML = '&times;';
    close.addEventListener('click', onClose);
    actions.appendChild(close);
  }
}

function renderAll(): void {
  for (const pane of PANES) renderPane(pane);
}

let fitFrame = 0;

/**
 * Height (border box, like the planned sizes) a pane needs for its content.
 * `scrollHeight` never reports less than the pane itself, so it cannot tell a
 * pane with room to spare from a full one.
 */
function contentHeight(el: HTMLElement): number {
  const last = el.lastElementChild;
  if (!last) return 0;
  const style = getComputedStyle(el);
  const bottom = last.getBoundingClientRect().bottom + parseFloat(getComputedStyle(last).marginBottom);
  return Math.ceil(bottom - el.getBoundingClientRect().top + el.scrollTop + parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth));
}

/**
 * Height of the totals' compact block — ranges, the four cards and the mix
 * line — measured by collapsing them for a moment. In a shared column the
 * totals never get less, so the compact view keeps a fixed size.
 */
function measureTotalsCompact(): number {
  const el = paneEls.totals;
  if (!el || !visible.totals) return MIN_PANE_HEIGHT;
  const wasCompact = el.classList.contains('compact');
  // Collapsing would otherwise lose the full view's scroll position.
  const scrollTop = el.scrollTop;
  el.classList.add('compact');
  const height = Math.max(MIN_PANE_HEIGHT, contentHeight(el));
  if (!wasCompact) {
    el.classList.remove('compact');
    el.scrollTop = scrollTop;
  }
  return height;
}

/**
 * The totals show everything (scrolling inside) as soon as their pane is taller
 * than their compact block, and just that block otherwise. As the last pane
 * they fill what the panes above leave, so dragging the edge above them
 * switches between the two.
 */
function fitTotals(compactHeight: number): void {
  const el = paneEls.totals;
  if (!el || !visible.totals) return;
  el.classList.toggle('compact', !totalsShowFull(el.offsetHeight, compactHeight, columnPanes().length <= 1));
}

/**
 * Height of each pane in the column: a pane the user sized keeps its height,
 * 当前用量 takes its natural height (capped), the rest share what is left with
 * the last pane, which fills. When the column is too short, the sized panes
 * scale down together so the last pane keeps its minimum — for the totals,
 * their compact block.
 */
function sizePanes(totalsCompact: number): void {
  if (!panelEl || dragging) return;
  const panes = columnPanes();
  if (panes.length <= 1) {
    for (const pane of panes) if (paneEls[pane]) paneEls[pane]!.style.flex = '';
    return;
  }
  const natural: Partial<Record<Pane, number>> = {};
  for (const pane of panes) {
    if (isFixedPane(pane) && paneEls[pane]) natural[pane] = contentHeight(paneEls[pane]!);
  }
  const planned = planPaneHeights({
    avail: panelEl.clientHeight,
    panes,
    stored: heights,
    natural,
    min: MIN_PANE_HEIGHT,
    lastMin: panes[panes.length - 1] === 'totals' ? totalsCompact : MIN_PANE_HEIGHT,
    fixedMaxShare: FIXED_MAX_SHARE,
  });
  for (const pane of panes.slice(0, -1)) paneEls[pane]!.style.flex = `0 0 ${planned[pane]}px`;
  paneEls[panes[panes.length - 1]]!.style.flex = '1 1 0';
}

function scheduleFit(): void {
  if (fitFrame) return;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0;
    const totalsCompact = measureTotalsCompact();
    sizePanes(totalsCompact);
    fitTotals(totalsCompact);
  });
}

/** Put 当前用量 in the column (before the totals) or in the dock below the conversation. */
function placeLivePane(): void {
  const live = paneEls.live;
  if (!live || !panelEl) return;
  if (liveDock === 'bottom') {
    if (dockEl && live.parentElement !== dockEl) dockEl.appendChild(live);
  } else if (live.parentElement !== panelEl) {
    panelEl.insertBefore(live, paneEls.totals ?? null);
  }
  const docked = liveDock === 'bottom' && visible.live;
  dockEl?.toggleAttribute('hidden', !docked);
  dockSplitEl?.toggleAttribute('hidden', !docked);
  dockEl?.style.setProperty('--dock-width', `${dockWidth}px`);
}

/** Re-render the docked rings when the dock's width changes how many fit. */
function syncDockRings(): void {
  if (!dockEl || liveDock !== 'bottom' || !visible.live) return;
  const fit = ringsThatFit(dockEl.getBoundingClientRect().width);
  if (fit === dockRings) return;
  dockRings = fit;
  renderPane('live');
}

/**
 * Drag the edge between the terminal and the docked 当前用量. It only narrows
 * the dock (dragging right), down to the width of the 5-hour ring alone.
 */
function initDockResize(): void {
  const split = dockSplitEl;
  const dock = dockEl;
  if (!split || !dock) return;
  split.title = t('liveUsage.dockResizeHint');
  onLocaleChange(() => { split.title = t('liveUsage.dockResizeHint'); });
  split.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = dock.getBoundingClientRect().width;
    split.classList.add('active');
    document.body.classList.add('sidebar-resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const move = (ev: MouseEvent) => {
      dockWidth = Math.round(Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, startWidth - (ev.clientX - startX))));
      dock.style.setProperty('--dock-width', `${dockWidth}px`);
    };
    const up = () => {
      split.classList.remove('active');
      document.body.classList.remove('sidebar-resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      writeStorage(DOCK_WIDTH_KEY, String(dockWidth));
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  split.addEventListener('dblclick', () => {
    dockWidth = DOCK_MAX_WIDTH;
    writeStorage(DOCK_WIDTH_KEY, String(dockWidth));
    dock.style.setProperty('--dock-width', `${dockWidth}px`);
  });
  // Width changes from the drag, the window, or the terminal opening/closing
  // beside it all decide how many rings fit.
  new ResizeObserver(() => syncDockRings()).observe(dock);
}

/**
 * Drag the edge under `pane`: height moves between it and the pane below, the
 * way a split view works; when the pane below is the last one it simply fills.
 */
function startSplitDrag(pane: Pane, splitter: HTMLElement, e: MouseEvent): void {
  const panes = columnPanes();
  const index = panes.indexOf(pane);
  const last = panes[panes.length - 1];
  // The tub and 当前用量 keep their size, so height trades with the next pane
  // that resizes; when that is the last pane, it just fills what is left.
  const below = panes.slice(index + 1).find((p) => !isFixedPane(p)) ?? last;
  const above = paneEls[pane];
  const under = paneEls[below];
  if (!above || !under) return;
  e.preventDefault();
  const belowIsLast = below === last;
  const startY = e.clientY;
  const startAbove = above.getBoundingClientRect().height;
  const startUnder = under.getBoundingClientRect().height;
  const totalsCompact = measureTotalsCompact();
  // The totals stop shrinking at their compact block.
  const underMin = below === 'totals' ? totalsCompact : MIN_PANE_HEIGHT;
  let delta = 0;
  dragging = true;
  splitter.classList.add('active');
  document.body.style.cursor = 'row-resize';
  document.body.style.userSelect = 'none';
  const move = (ev: MouseEvent) => {
    delta = Math.min(Math.max(0, startUnder - underMin), Math.max(MIN_PANE_HEIGHT - startAbove, ev.clientY - startY));
    above.style.flex = `0 0 ${Math.round(startAbove + delta)}px`;
    if (!belowIsLast) under.style.flex = `0 0 ${Math.round(startUnder - delta)}px`;
    fitTotals(totalsCompact);
  };
  const up = () => {
    dragging = false;
    splitter.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    heights[pane] = Math.round(startAbove + delta);
    if (!belowIsLast) heights[below] = Math.round(startUnder - delta);
    writeStorage(HEIGHTS_KEY, JSON.stringify(heights));
    scheduleFit();
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

/** Put a drag edge under every pane in the column but the last. */
function layoutColumn(): void {
  if (!panelEl) return;
  panelEl.querySelectorAll('.usage-split').forEach((el) => el.remove());
  const panes = columnPanes();
  panes.forEach((pane, i) => {
    const el = paneEls[pane];
    if (!el) return;
    el.classList.toggle('stacked', i > 0);
    if (i === panes.length - 1 || isFixedPane(pane)) return;
    const splitter = document.createElement('div');
    splitter.className = 'usage-split';
    splitter.title = t('usagePanel.resizeHint');
    splitter.addEventListener('mousedown', (e) => startSplitDrag(pane, splitter, e));
    splitter.addEventListener('dblclick', () => {
      delete heights[pane];
      writeStorage(HEIGHTS_KEY, JSON.stringify(heights));
      scheduleFit();
    });
    el.after(splitter);
  });
}

function applyLayout(): void {
  placeLivePane();
  const inColumn = columnPanes();
  panelEl?.toggleAttribute('hidden', inColumn.length === 0);
  handleEl?.toggleAttribute('hidden', inColumn.length === 0);
  panelEl?.classList.toggle('multi', inColumn.length > 1);
  for (const pane of PANES) {
    const el = paneEls[pane];
    el?.toggleAttribute('hidden', !visible[pane]);
    if (el && !inColumn.includes(pane)) {
      el.classList.remove('stacked');
      el.style.flex = '';
    }
    toggleBtns[pane]?.classList.toggle('active', visible[pane]);
    toggleBtns[pane]?.setAttribute('aria-pressed', String(visible[pane]));
  }
  layoutColumn();
  scheduleFit();
}

export function setPaneVisible(pane: Pane, next: boolean): void {
  visible[pane] = next;
  writeStorage(VISIBLE_KEYS[pane], next ? '1' : '0');
  applyLayout();
  // The rings change layout when they gain or lose the column to themselves.
  renderPane('live');
  if (next) {
    renderPane(pane);
    if (pane === 'totals') void refreshUsage();
    if (pane === 'turn' || pane === 'session') void refreshChanges();
    if (pane === 'skills') void refreshSkills(() => renderPane('skills'));
  }
  refitTerminals();
}

export function setLiveDock(next: LiveDock): void {
  liveDock = next;
  writeStorage(DOCK_KEY, next);
  applyLayout();
  renderPane('live');
  refitTerminals();
}

function initResize(): void {
  if (!handleEl || !panelEl) return;
  const panel = panelEl;
  const handle = handleEl;
  let dragging = false;
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('active');
    document.body.classList.remove('sidebar-resizing');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    writeStorage(WIDTH_KEY, String(parseInt(panel.style.width, 10)));
    refitTerminals();
  };
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    handle.classList.add('active');
    document.body.classList.add('sidebar-resizing');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    if (!e.buttons) {
      stop();
      return;
    }
    panel.style.width = `${clampWidth(window.innerWidth - e.clientX)}px`;
  });
  document.addEventListener('mouseup', stop);
}

export function initUsagePanel(): void {
  panelEl = document.getElementById('usage-panel');
  handleEl = document.getElementById('usage-panel-resize-handle');
  dockEl = document.getElementById('bottom-usage-dock');
  dockSplitEl = document.getElementById('bottom-dock-split');
  for (const pane of PANES) {
    paneEls[pane] = document.getElementById(PANE_IDS[pane]) ?? undefined;
    toggleBtns[pane] = document.getElementById(TOGGLE_IDS[pane]) ?? undefined;
    visible[pane] = readVisible(pane);
  }
  if (!panelEl) return;
  heights = readHeights();
  if (readStorage(LAYOUT_VERSION_KEY) !== LAYOUT_VERSION) {
    heights = {};
    writeStorage(HEIGHTS_KEY, '{}');
    writeStorage(LAYOUT_VERSION_KEY, LAYOUT_VERSION);
  }
  // The tub and 当前用量 are not resizable.
  delete heights.live;
  delete heights.clawd;
  liveDock = readStorage(DOCK_KEY) === 'bottom' ? 'bottom' : 'right';
  const savedDockWidth = Number(readStorage(DOCK_WIDTH_KEY));
  if (savedDockWidth) dockWidth = Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, Math.round(savedDockWidth)));

  const savedWidth = Number(readStorage(WIDTH_KEY));
  panelEl.style.width = `${clampWidth(savedWidth || DEFAULT_WIDTH)}px`;

  const applyToggleLabels = () => {
    for (const pane of PANES) {
      const btn = toggleBtns[pane];
      if (!btn) continue;
      btn.title = t(TOGGLE_LABELS[pane]);
      btn.setAttribute('aria-label', t(TOGGLE_LABELS[pane]));
    }
  };
  applyToggleLabels();
  for (const pane of PANES) {
    toggleBtns[pane]?.addEventListener('click', () => setPaneVisible(pane, !visible[pane]));
  }

  initResize();
  initDockResize();
  onClaudeHistoryChange(() => renderPane('totals'));
  onPlanUsageChange(() => renderPane('live'));
  onChangesViewChange(() => {
    renderPane('turn');
    renderPane('session');
  });
  // Skills include the open project's own.
  appState.on('project-changed', () => renderPane('skills'));
  onLocaleChange(() => {
    applyToggleLabels();
    layoutColumn();
    renderAll();
  });

  const poll = () => {
    if (document.visibilityState === 'hidden') return;
    if (visible.totals) void refreshUsage();
    if (visible.skills) void refreshSkills(() => renderPane('skills'));
    // Keeps "updated …" and the reset countdowns current.
    renderPane('live');
  };
  setInterval(poll, POLL_MS);
  setInterval(() => {
    if (document.visibilityState !== 'hidden' && (visible.turn || visible.session)) void refreshChanges();
  }, CHANGES_POLL_MS);
  window.addEventListener('focus', poll);
  window.addEventListener('resize', scheduleFit);

  applyLayout();
  renderAll();
  if (visible.totals) void refreshUsage();
  if (visible.turn || visible.session) void refreshChanges();
  refitTerminals();
}
