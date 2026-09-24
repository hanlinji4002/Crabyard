import { CLAWD_ANIMATIONS, ClawdPlayer } from '../clawd-anim/player.js';
import { esc } from '../dom-utils.js';
import { onLocaleChange, t } from '../i18n.js';

// The Clawd animations (clawd-anim/, drawn after the clawd avatar skill) in two
// places: a card at the top of the sidebar that cycles through all five, which
// the sidebar header's button or the card's × hides, and a player above
// "Ready when you are" on a project with no sessions, with play/pause,
// previous/next and a dot per animation.

const SIDEBAR_KEY = 'myclaudetui.showcase.sidebar';
/** Loops of each animation before the next one. */
const LOOPS_EACH = 2;

const ICON_PREV = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>';
const ICON_NEXT = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/></svg>';

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

function animTitle(i: number): string {
  return t(`clawdShow.anim.${CLAWD_ANIMATIONS[i].id}`);
}

function modeLabel(i: number): string {
  return t(`clawdShow.mode.${CLAWD_ANIMATIONS[i].mode}`);
}

// ─── Sidebar card ────────────────────────────────────────────────────

let sidebarPlayer: ClawdPlayer | null = null;
/** Relabel the open card and player when the language changes. */
let relabelSidebar: (() => void) | null = null;
let relabelEmpty: (() => void) | null = null;

function buildSidebarCard(slot: HTMLElement): void {
  slot.innerHTML = `
    <div class="clawd-show-stage" role="button" tabindex="0"></div>
    <div class="clawd-show-caption">
      <span class="clawd-show-title"></span>
      <span class="clawd-show-mode"></span>
      <button type="button" class="icon-btn clawd-show-hide">&times;</button>
    </div>`;
  const stage = slot.querySelector<HTMLElement>('.clawd-show-stage')!;
  const title = slot.querySelector<HTMLElement>('.clawd-show-title')!;
  const mode = slot.querySelector<HTMLElement>('.clawd-show-mode')!;
  const hide = slot.querySelector<HTMLButtonElement>('.clawd-show-hide')!;
  const label = () => {
    const i = sidebarPlayer?.currentIndex ?? 0;
    title.textContent = animTitle(i);
    mode.textContent = modeLabel(i);
    stage.title = t('clawdShow.clickNext');
    stage.setAttribute('aria-label', `${animTitle(i)} · ${modeLabel(i)}`);
    hide.title = t('clawdShow.hideSidebar');
    hide.setAttribute('aria-label', t('clawdShow.hideSidebar'));
  };
  sidebarPlayer = new ClawdPlayer(stage, { loopsEach: LOOPS_EACH, onChange: label });
  label();
  stage.addEventListener('click', () => sidebarPlayer?.next());
  stage.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      sidebarPlayer?.next();
    }
  });
  hide.addEventListener('click', () => setSidebarShowcase(false));
  relabelSidebar = label;
}

function setSidebarShowcase(on: boolean): void {
  writeStorage(SIDEBAR_KEY, on ? '1' : '0');
  applySidebarShowcase();
}

function applySidebarShowcase(): void {
  const slot = document.getElementById('sidebar-showcase');
  const toggle = document.getElementById('btn-toggle-showcase');
  if (!slot) return;
  const on = readStorage(SIDEBAR_KEY) !== '0';
  slot.hidden = !on;
  toggle?.classList.toggle('active', on);
  toggle?.setAttribute('aria-pressed', String(on));
  if (on && !sidebarPlayer) buildSidebarCard(slot);
  if (!on && sidebarPlayer) {
    sidebarPlayer.destroy();
    sidebarPlayer = null;
    relabelSidebar = null;
    slot.innerHTML = '';
  }
}

export function initSidebarShowcase(): void {
  const toggle = document.getElementById('btn-toggle-showcase');
  if (toggle) {
    const label = () => {
      toggle.title = t('clawdShow.toggleSidebar');
      toggle.setAttribute('aria-label', t('clawdShow.toggleSidebar'));
    };
    label();
    onLocaleChange(label);
    toggle.addEventListener('click', () => setSidebarShowcase(readStorage(SIDEBAR_KEY) === '0'));
  }
  onLocaleChange(() => {
    relabelSidebar?.();
    relabelEmpty?.();
  });
  applySidebarShowcase();
}

// ─── Player above "Ready when you are" ───────────────────────────────

let emptyPlayer: ClawdPlayer | null = null;

export function destroyEmptyStatePlayer(): void {
  emptyPlayer?.destroy();
  emptyPlayer = null;
  relabelEmpty = null;
}

/** A playable Clawd animation for the empty project screen. */
export function createEmptyStatePlayer(): HTMLElement {
  destroyEmptyStatePlayer();
  const wrap = document.createElement('div');
  wrap.className = 'clawd-player';
  wrap.innerHTML = `
    <div class="clawd-show-stage"></div>
    <div class="clawd-player-bar">
      <button type="button" class="icon-btn clawd-player-prev">${ICON_PREV}</button>
      <button type="button" class="icon-btn clawd-player-play"></button>
      <button type="button" class="icon-btn clawd-player-next">${ICON_NEXT}</button>
      <span class="clawd-player-title"></span>
      <span class="clawd-player-dots">${CLAWD_ANIMATIONS.map((_, i) => `<button type="button" class="clawd-player-dot" data-index="${i}"></button>`).join('')}</span>
    </div>`;
  const stage = wrap.querySelector<HTMLElement>('.clawd-show-stage')!;
  const play = wrap.querySelector<HTMLButtonElement>('.clawd-player-play')!;
  const prev = wrap.querySelector<HTMLButtonElement>('.clawd-player-prev')!;
  const next = wrap.querySelector<HTMLButtonElement>('.clawd-player-next')!;
  const title = wrap.querySelector<HTMLElement>('.clawd-player-title')!;
  const dots = Array.from(wrap.querySelectorAll<HTMLButtonElement>('.clawd-player-dot'));

  const update = () => {
    const player = emptyPlayer;
    if (!player) return;
    const i = player.currentIndex;
    title.innerHTML = `${esc(animTitle(i))}<span class="clawd-player-mode">${esc(modeLabel(i))}</span>`;
    const playLabel = player.isPlaying ? t('clawdShow.pause') : t('clawdShow.play');
    play.innerHTML = player.isPlaying ? ICON_PAUSE : ICON_PLAY;
    play.title = playLabel;
    play.setAttribute('aria-label', playLabel);
    prev.title = t('clawdShow.prev');
    prev.setAttribute('aria-label', t('clawdShow.prev'));
    next.title = t('clawdShow.next');
    next.setAttribute('aria-label', t('clawdShow.next'));
    dots.forEach((dot, k) => {
      dot.classList.toggle('active', k === i);
      dot.title = `${animTitle(k)} · ${modeLabel(k)}`;
      dot.setAttribute('aria-label', dot.title);
    });
  };

  // Start on a different animation from the sidebar card.
  const start = ((sidebarPlayer?.currentIndex ?? 0) + 2) % CLAWD_ANIMATIONS.length;
  emptyPlayer = new ClawdPlayer(stage, { loopsEach: LOOPS_EACH, start, onChange: update });
  relabelEmpty = update;
  update();
  play.addEventListener('click', () => emptyPlayer?.toggle());
  prev.addEventListener('click', () => emptyPlayer?.prev());
  next.addEventListener('click', () => emptyPlayer?.next());
  dots.forEach((dot) => dot.addEventListener('click', () => emptyPlayer?.select(Number(dot.dataset.index))));
  stage.addEventListener('click', () => emptyPlayer?.toggle());
  return wrap;
}
