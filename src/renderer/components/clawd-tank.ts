import { appState } from '../state.js';
import { getStatus, onChange as onStatusChange, type SessionStatus } from '../session-activity.js';
import { getEvents, onChange as onEventsChange } from '../session-inspector-state.js';
import { esc } from '../dom-utils.js';
import { t } from '../i18n.js';
import { deriveActivity, pickAnim, type ClawdAnim } from '../clawd-tank-model.js';
import type { ProjectRecord, SessionRecord } from '../../shared/types.js';

// The Clawd tub: every open conversation as one of clawd-tank's pixel crabs
// (github.com/marciogranzotto/clawd-tank, MIT — sprites in assets/clawd),
// animated by what Claude is doing in it. It sits in the title bar above the
// tabs or as a pane in the right column; usage-panel.ts moves the pane between
// the two and calls renderClawdTank. Crabs are kept across renders so their
// animations don't restart; a new conversation walks in, a closed one burrows
// away, and clicking a crab opens its conversation.

export type ClawdPlace = 'top' | 'right';

interface Options {
  place: ClawdPlace;
  onClose: () => void;
  onTogglePlace: () => void;
}

interface Entry {
  project: ProjectRecord;
  session: SessionRecord;
}

/** Crabs shown at once, like clawd-tank; the rest are counted in a +N badge. */
const MAX_CRABS = 4;
const WALK_IN_MS = 1600;
const GO_AWAY_MS = 1500;
const TICK_MS = 1000;
/** The crab that sleeps in an empty tub. */
const SLEEPER_KEY = 'sleeper';
/** Which conversations keep a crab when there are more than MAX_CRABS. */
const STATUS_RANK: Record<SessionStatus, number> = { input: 0, working: 1, completed: 2, waiting: 3, idle: 4 };

const ICON_TO_RIGHT = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>';
const ICON_TO_TOP = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9.5h18"/></svg>';

/** When each conversation's status last changed. */
const since = new Map<string, { status: SessionStatus; at: number }>();
let options: Options | null = null;
let paneEl: HTMLElement | null = null;
let tubEl: HTMLElement | null = null;
/** A freshly built tub shows its crabs without walking them in. */
let fresh = true;
let frame = 0;
let initialized = false;

function conversations(): Entry[] {
  const out: Entry[] = [];
  for (const project of appState.projects) {
    for (const session of project.sessions) {
      if (!session.type) out.push({ project, session });
    }
  }
  return out;
}

/** Up to MAX_CRABS, in tab order: the focused conversation, then the busiest. */
function pickShown(all: Entry[]): Entry[] {
  if (all.length <= MAX_CRABS) return all;
  const activeId = appState.activeSession?.id;
  const rank = (e: Entry) => (e.session.id === activeId ? -1 : STATUS_RANK[getStatus(e.session.id)]);
  const keep = new Set([...all].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_CRABS).map((e) => e.session.id));
  return all.filter((e) => keep.has(e.session.id));
}

function statusSince(sessionId: string, now: number): { status: SessionStatus; at: number } {
  const status = getStatus(sessionId);
  let entry = since.get(sessionId);
  if (!entry || entry.status !== status) {
    entry = { status, at: now };
    since.set(sessionId, entry);
  }
  return entry;
}

function focusConversation(sessionId: string): void {
  const project = appState.projects.find((p) => p.sessions.some((s) => s.id === sessionId));
  if (!project) return;
  if (appState.activeProjectId !== project.id) appState.setActiveProject(project.id);
  appState.setActiveSession(project.id, sessionId);
}

function buildCrab(key: string): HTMLElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'clawd-crab';
  el.dataset.key = key;
  el.innerHTML = '<span class="clawd-stage"><img class="clawd-sprite" alt="" draggable="false"></span><span class="clawd-name"></span>';
  el.addEventListener('click', () => focusConversation(key));
  return el;
}

function setSprite(el: HTMLElement, anim: ClawdAnim): void {
  if (el.dataset.anim === anim) return;
  el.dataset.anim = anim;
  el.querySelector<HTMLImageElement>('.clawd-sprite')!.src = `assets/clawd/${anim}.svg`;
}

function buildHead(place: ClawdPlace): HTMLElement {
  const head = document.createElement('div');
  const move = place === 'top' ? t('clawd.moveRight') : t('clawd.moveTop');
  const actions = `
    <button type="button" class="icon-btn clawd-move" title="${esc(move)}" aria-label="${esc(move)}">${place === 'top' ? ICON_TO_RIGHT : ICON_TO_TOP}</button>
    <button type="button" class="icon-btn usage-panel-close clawd-close" title="${esc(t('clawd.hide'))}" aria-label="${esc(t('clawd.hide'))}">&times;</button>`;
  if (place === 'top') {
    head.className = 'clawd-head clawd-head-inline';
    head.innerHTML = actions;
  } else {
    head.className = 'sidebar-view-header clawd-head';
    head.innerHTML = `<span class="sidebar-view-title">${esc(t('clawd.title'))}</span><div class="sidebar-view-actions">${actions}</div>`;
  }
  head.querySelector('.clawd-move')!.addEventListener('click', () => options?.onTogglePlace());
  head.querySelector('.clawd-close')!.addEventListener('click', () => options?.onClose());
  return head;
}

/** Bring the crabs in line with the open conversations and what each is doing. */
function sync(): void {
  const tub = tubEl;
  if (!tub || !paneEl?.isConnected || paneEl.hidden) return;
  const now = Date.now();
  const all = conversations();
  const shown = pickShown(all);
  const activeId = appState.activeSession?.id;
  const manyProjects = new Set(all.map((e) => e.project.id)).size > 1;

  const wanted = new Map<string, { anim: ClawdAnim; label: string; name: string }>();
  if (shown.length === 0) wanted.set(SLEEPER_KEY, { anim: 'sleeping', label: t('clawd.empty'), name: '' });
  for (const { project, session } of shown) {
    const { status, at } = statusSince(session.id, now);
    const anim = pickAnim(status, at, deriveActivity(getEvents(session.id)), now);
    const name = manyProjects ? `${project.name} · ${session.name}` : session.name;
    wanted.set(session.id, { anim, label: `${name} — ${t(`clawd.state.${anim}`)}`, name: session.name });
  }
  for (const id of since.keys()) {
    if (!all.some((e) => e.session.id === id)) since.delete(id);
  }

  for (const el of Array.from(tub.querySelectorAll<HTMLElement>('.clawd-crab:not(.leaving)'))) {
    const key = el.dataset.key!;
    if (wanted.has(key)) continue;
    if (fresh || key === SLEEPER_KEY) {
      el.remove();
      continue;
    }
    el.classList.add('leaving');
    el.classList.remove('is-active');
    el.removeAttribute('title');
    setSprite(el, 'going-away');
    setTimeout(() => el.remove(), GO_AWAY_MS);
  }

  let prev: Element | null = null;
  for (const [key, want] of wanted) {
    let el = Array.from(tub.querySelectorAll<HTMLElement>('.clawd-crab:not(.leaving)')).find((c) => c.dataset.key === key);
    if (!el) {
      el = buildCrab(key);
      if (!fresh && key !== SLEEPER_KEY) {
        el.classList.add('arriving');
        el.dataset.arriveUntil = String(now + WALK_IN_MS);
      }
    }
    const arriving = Number(el.dataset.arriveUntil ?? 0) > now;
    if (!arriving) el.classList.remove('arriving');
    setSprite(el, arriving ? 'walking' : want.anim);
    el.title = want.label;
    el.setAttribute('aria-label', want.label);
    el.classList.toggle('is-active', key === activeId);
    el.querySelector('.clawd-name')!.textContent = want.name;
    const slot: Element | null = prev ? prev.nextElementSibling : tub.firstElementChild;
    if (el !== slot) tub.insertBefore(el, slot);
    prev = el;
  }

  const extra = all.length - shown.length;
  let more = tub.querySelector<HTMLElement>('.clawd-more');
  if (extra > 0) {
    if (!more) {
      more = document.createElement('span');
      more.className = 'clawd-more';
    }
    more.textContent = `+${extra}`;
    more.title = t('clawd.more', { count: extra });
    tub.appendChild(more);
  } else {
    more?.remove();
  }
  fresh = false;
}

function scheduleSync(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    sync();
  });
}

function init(): void {
  if (initialized) return;
  initialized = true;
  onStatusChange((sessionId, status) => {
    since.set(sessionId, { status, at: Date.now() });
    scheduleSync();
  });
  onEventsChange(() => scheduleSync());
  for (const event of ['session-added', 'session-removed', 'session-changed', 'project-changed', 'state-loaded'] as const) {
    appState.on(event, () => scheduleSync());
  }
  // Time alone moves some animations on: a finished turn's celebration ends,
  // a long wait turns into confusion, an idle conversation falls asleep.
  setInterval(() => {
    if (document.visibilityState !== 'hidden') sync();
  }, TICK_MS);
}

/** Render the tub into `container` for where it sits: above the tabs or in the right column. */
export function renderClawdTank(container: HTMLElement, opts: Options): void {
  options = opts;
  init();
  if (paneEl !== container || !tubEl || container.dataset.place !== opts.place) {
    paneEl = container;
    container.dataset.place = opts.place;
    container.innerHTML = '';
    tubEl = document.createElement('div');
    tubEl.className = 'clawd-tub';
    const head = buildHead(opts.place);
    if (opts.place === 'top') container.append(tubEl, head);
    else container.append(head, tubEl);
    fresh = true;
  } else {
    container.querySelector('.clawd-head')?.replaceWith(buildHead(opts.place));
  }
  sync();
}
