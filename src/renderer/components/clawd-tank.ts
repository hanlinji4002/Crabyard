import { appState } from '../state.js';
import { getStatus, onChange as onStatusChange, type SessionStatus } from '../session-activity.js';
import { getEvents, onChange as onEventsChange } from '../session-inspector-state.js';
import { closeSessionWithConfirm } from '../session-close.js';
import { esc } from '../dom-utils.js';
import { t } from '../i18n.js';
import { deriveActivity, pickAnim, type ClawdAnim } from '../clawd-tank-model.js';
import { showContextMenu, type MenuOption } from './context-menu.js';
import type { ProjectRecord, SessionRecord } from '../../shared/types.js';

// The Clawd tub: a pane in the right column where every open conversation is
// one of clawd-tank's pixel crabs (github.com/marciogranzotto/clawd-tank, MIT —
// sprites in assets/clawd), under the night sky of clawd-tank's display and
// animated by what Claude is doing. Crabs are kept across renders so their
// animations don't restart; a new conversation walks in, a closed one burrows
// away. A turn that dies on an API error knocks its crab out (X eyes and a
// popped "!") until you come back to the conversation, when it wakes up; a
// conversation whose CLI quits abnormally leaves its knocked-out crab behind,
// and clicking that crab reopens the conversation. Subagents at work show as a
// mini-crab ×N badge. Click a crab to open its conversation; right-click it to
// close the conversation.

interface Options {
  onClose: () => void;
}

interface Entry {
  project: ProjectRecord;
  session: SessionRecord;
}

/** A conversation whose CLI quit abnormally, kept as a knocked-out crab. */
interface Ghost {
  projectId: string;
  cliSessionId: string | null;
  name: string;
}

interface Want {
  anim: ClawdAnim;
  label: string;
  name: string;
  knockedOut: boolean;
  agents: number;
}

/** Crabs shown at once, like clawd-tank; the rest are counted in a +N badge. */
const MAX_CRABS = 4;
const WALK_IN_MS = 1600;
const GO_AWAY_MS = 1500;
const WAKE_MS = 1800;
const TICK_MS = 1000;
/** The crab that sleeps in an empty tub. */
const SLEEPER_KEY = 'sleeper';
const GHOST_PREFIX = 'ghost:';
/** Failures recorded before this window opened are old news, not a knock-out. */
const STARTED_AT = Date.now();
/** Which conversations keep a crab when there are more than MAX_CRABS. */
const STATUS_RANK: Record<SessionStatus, number> = { input: 0, working: 1, completed: 2, waiting: 3, idle: 4 };

/** When each conversation's status last changed. */
const since = new Map<string, { status: SessionStatus; at: number }>();
/** When the user last came back to a conversation, which clears a knock-out. */
const revivedAt = new Map<string, number>();
/** Conversations waking up, until the given time. */
const wakingUntil = new Map<string, number>();
const ghosts = new Map<string, Ghost>();
let lastActiveId: string | undefined;
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

/** Up to `limit`, in tab order: the focused conversation, then the busiest. */
function pickShown(all: Entry[], limit: number): Entry[] {
  if (all.length <= limit) return all;
  const activeId = appState.activeSession?.id;
  const rank = (e: Entry) => (e.session.id === activeId ? -1 : STATUS_RANK[getStatus(e.session.id)]);
  const keep = new Set([...all].sort((a, b) => rank(a) - rank(b)).slice(0, limit).map((e) => e.session.id));
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

function isKnockedOut(sessionId: string, failedAt: number | undefined): boolean {
  return failedAt !== undefined && failedAt > STARTED_AT && (revivedAt.get(sessionId) ?? 0) < failedAt;
}

function revive(sessionId: string, now = Date.now()): void {
  revivedAt.set(sessionId, now);
  wakingUntil.set(sessionId, now + WAKE_MS);
}

function projectOf(sessionId: string): ProjectRecord | undefined {
  return appState.projects.find((p) => p.sessions.some((s) => s.id === sessionId));
}

function focusConversation(sessionId: string): void {
  const project = projectOf(sessionId);
  if (!project) return;
  if (appState.activeProjectId !== project.id) appState.setActiveProject(project.id);
  appState.setActiveSession(project.id, sessionId);
}

/** Reopen a crashed conversation; its knocked-out crab wakes up as the new tab's. */
function reopenGhost(key: string): void {
  const id = key.slice(GHOST_PREFIX.length);
  const ghost = ghosts.get(id);
  if (!ghost?.cliSessionId) return;
  const session = appState.openCliSession(ghost.projectId, ghost.cliSessionId, ghost.name);
  ghosts.delete(id);
  const el = crabEl(key);
  if (session && el) {
    el.dataset.key = session.id;
    revive(session.id);
  }
  scheduleSync();
}

function dismissGhost(key: string): void {
  ghosts.delete(key.slice(GHOST_PREFIX.length));
  scheduleSync();
}

/**
 * Called when a conversation's CLI quits abnormally, before its tab closes: its
 * crab stays in the tub, knocked out, until it is clicked (to reopen the
 * conversation) or dismissed.
 */
export function noteCrashedConversation(projectId: string, session: SessionRecord): void {
  ghosts.set(session.id, { projectId, cliSessionId: session.cliSessionId, name: session.name });
  // Keep the crab where it is rather than burrowing it away and adding another.
  const el = crabEl(session.id);
  if (el) el.dataset.key = GHOST_PREFIX + session.id;
  scheduleSync();
}

function crabEl(key: string): HTMLElement | undefined {
  return tubEl ? Array.from(tubEl.querySelectorAll<HTMLElement>('.clawd-crab:not(.leaving)')).find((c) => c.dataset.key === key) : undefined;
}

function onCrabClick(key: string): void {
  if (key.startsWith(GHOST_PREFIX)) {
    reopenGhost(key);
    return;
  }
  // A knocked-out crab wakes when you come to it, even if its tab is already open.
  if (isKnockedOut(key, deriveActivity(getEvents(key)).failedAt)) revive(key);
  focusConversation(key);
  scheduleSync();
}

function onCrabMenu(key: string, e: MouseEvent): void {
  e.preventDefault();
  let items: MenuOption[] = [];
  if (key.startsWith(GHOST_PREFIX)) {
    const ghost = ghosts.get(key.slice(GHOST_PREFIX.length));
    items = [
      { label: t('clawd.menu.reopen'), action: () => reopenGhost(key), disabled: !ghost?.cliSessionId },
      { label: t('clawd.menu.dismiss'), action: () => dismissGhost(key) },
    ];
  } else if (key !== SLEEPER_KEY) {
    const project = projectOf(key);
    if (!project) return;
    items = [
      { label: t('clawd.menu.open'), action: () => onCrabClick(key) },
      { label: t('clawd.menu.close'), action: () => closeSessionWithConfirm(project.id, key), danger: true, separatorBefore: true },
    ];
  }
  if (items.length) showContextMenu(e.clientX, e.clientY, items);
}

function buildCrab(key: string): HTMLElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'clawd-crab';
  el.dataset.key = key;
  el.innerHTML = `
    <span class="clawd-stage"><img class="clawd-sprite" alt="" draggable="false"></span>
    <span class="clawd-alert" aria-hidden="true">!</span>
    <span class="clawd-agents" aria-hidden="true"><img src="assets/clawd/mini-crab.svg" alt="" draggable="false"><b></b></span>
    <span class="clawd-name"></span>`;
  // The key changes when a crab turns into a crashed conversation's and back.
  el.addEventListener('click', () => onCrabClick(el.dataset.key!));
  el.addEventListener('contextmenu', (e) => onCrabMenu(el.dataset.key!, e));
  return el;
}

function setSprite(el: HTMLElement, anim: ClawdAnim): void {
  if (el.dataset.anim === anim) return;
  el.dataset.anim = anim;
  el.querySelector<HTMLImageElement>('.clawd-sprite')!.src = `assets/clawd/${anim}.svg`;
}

/** Bring the crabs in line with the open conversations and what each is doing. */
function sync(): void {
  const tub = tubEl;
  if (!tub || !paneEl?.isConnected || paneEl.hidden) return;
  const now = Date.now();
  const all = conversations();
  const activeId = appState.activeSession?.id;

  const activity = new Map(all.map((e) => [e.session.id, deriveActivity(getEvents(e.session.id))]));
  // Coming back to a knocked-out conversation wakes its crab.
  if (activeId !== lastActiveId) {
    lastActiveId = activeId;
    if (activeId && isKnockedOut(activeId, activity.get(activeId)?.failedAt)) revive(activeId, now);
  }

  const shown = pickShown(all, MAX_CRABS);
  const liveIds = new Set(all.map((e) => e.session.id));
  const ghostKeys = [...ghosts.keys()].filter((id) => !liveIds.has(id)).map((id) => GHOST_PREFIX + id);
  const ghostsShown = ghostKeys.slice(0, Math.max(0, MAX_CRABS - shown.length));
  const manyProjects = new Set(all.map((e) => e.project.id)).size > 1;

  const wanted = new Map<string, Want>();
  for (const { project, session } of shown) {
    const act = activity.get(session.id)!;
    const knockedOut = isKnockedOut(session.id, act.failedAt);
    const { status, at } = statusSince(session.id, now);
    const anim: ClawdAnim = knockedOut ? 'dizzy' : (wakingUntil.get(session.id) ?? 0) > now ? 'wake' : pickAnim(status, at, act, now);
    const name = manyProjects ? `${project.name} · ${session.name}` : session.name;
    const state = knockedOut ? t('clawd.knockedOut') : t(`clawd.state.${anim}`);
    const agents = !knockedOut && status === 'working' ? act.subagents : 0;
    const agentNote = agents ? ` · ${t('clawd.agents', { count: agents })}` : '';
    wanted.set(session.id, { anim, label: `${name} — ${state}${agentNote}`, name: session.name, knockedOut, agents });
  }
  for (const key of ghostsShown) {
    const ghost = ghosts.get(key.slice(GHOST_PREFIX.length))!;
    wanted.set(key, { anim: 'dizzy', label: `${ghost.name} — ${t('clawd.crashed')}`, name: ghost.name, knockedOut: true, agents: 0 });
  }
  if (wanted.size === 0) wanted.set(SLEEPER_KEY, { anim: 'sleeping', label: t('clawd.empty'), name: '', knockedOut: false, agents: 0 });
  for (const id of since.keys()) {
    if (!liveIds.has(id)) since.delete(id);
  }

  for (const el of Array.from(tub.querySelectorAll<HTMLElement>('.clawd-crab:not(.leaving)'))) {
    const key = el.dataset.key!;
    if (wanted.has(key)) continue;
    if (fresh || key === SLEEPER_KEY) {
      el.remove();
      continue;
    }
    el.classList.add('leaving');
    el.classList.remove('is-active', 'knocked-out', 'has-agents');
    el.removeAttribute('title');
    setSprite(el, 'going-away');
    setTimeout(() => el.remove(), GO_AWAY_MS);
  }

  let prev: Element | null = null;
  for (const [key, want] of wanted) {
    let el = crabEl(key);
    if (!el) {
      el = buildCrab(key);
      if (!fresh && key !== SLEEPER_KEY && !key.startsWith(GHOST_PREFIX)) {
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
    el.classList.toggle('knocked-out', want.knockedOut);
    el.classList.toggle('has-agents', want.agents > 0);
    el.querySelector('.clawd-agents b')!.textContent = `×${want.agents}`;
    el.querySelector('.clawd-name')!.textContent = want.name;
    const slot: Element | null = prev ? prev.nextElementSibling : tub.firstElementChild;
    if (el !== slot) tub.insertBefore(el, slot);
    prev = el;
  }

  const extra = all.length - shown.length + (ghostKeys.length - ghostsShown.length);
  let more = tub.querySelector<HTMLElement>('.clawd-more');
  if (extra > 0) {
    if (!more) {
      more = document.createElement('span');
      more.className = 'clawd-more';
      more.innerHTML = '<img src="assets/clawd/mini-crab.svg" alt="" draggable="false"><b></b>';
    }
    more.querySelector('b')!.textContent = `+${extra}`;
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

/** Render the tub pane into `container` (the right column's Clawd pane). */
export function renderClawdTank(container: HTMLElement, opts: Options): void {
  options = opts;
  init();
  const head = document.createElement('div');
  head.className = 'sidebar-view-header clawd-head';
  head.innerHTML = `
    <span class="sidebar-view-title">${esc(t('clawd.title'))}</span>
    <div class="sidebar-view-actions">
      <button type="button" class="icon-btn usage-panel-close" title="${esc(t('clawd.hide'))}" aria-label="${esc(t('clawd.hide'))}">&times;</button>
    </div>`;
  head.querySelector('.usage-panel-close')!.addEventListener('click', () => options?.onClose());
  if (paneEl !== container || !tubEl || !container.contains(tubEl)) {
    paneEl = container;
    container.innerHTML = '';
    tubEl = document.createElement('div');
    tubEl.className = 'clawd-tub';
    tubEl.innerHTML = '<span class="clawd-sky" aria-hidden="true"></span><span class="clawd-sky clawd-sky-2" aria-hidden="true"></span>';
    container.append(head, tubEl);
    fresh = true;
  } else {
    container.querySelector('.clawd-head')?.replaceWith(head);
  }
  sync();
}
