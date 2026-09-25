import type { Terminal } from '@xterm/xterm';
import { t } from '../i18n.js';
import { esc } from '../dom-utils.js';
import { hideTabContextMenu, setActiveContextMenu } from './tab-bar/menu.js';
import { appState } from '../state.js';
import { openConversationView } from '../open-file-reader.js';
import {
  EFFORT_LEVELS,
  MODEL_CHOICES,
  PERMISSION_MODES,
  readEffortExchange,
  readPromptState,
  readUltracodeTag,
  transcriptText,
  shortModelName,
  type PermissionMode,
  type PromptState,
  type ScreenLine,
} from '../claude-tui.js';

// Model / thinking / mode pills and an Ultracode switch on a Claude session's
// status bar. They drive the running CLI the way a person would: `/model <id>`
// and `/effort <level>` typed into an empty prompt, Alt+T for the thinking
// toggle, Shift+Tab to cycle permission modes, `/effort ultracode` to turn on
// ultracode and `/effort xhigh` (the app's default effort) to turn it off.
// Keys are only sent after reading the screen confirms the prompt box is
// showing and empty — never over a dialog, where Enter could answer a
// permission request, and never on top of an unsent draft.

const SHIFT_TAB = '\x1b[Z';
const ALT_T = '\x1bt';
const POLL_MS = 60;
const MODE_STEP_TIMEOUT_MS = 1200;
const DIALOG_TIMEOUT_MS = 1500;
const CONFIRM_TIMEOUT_MS = 800;
const HINT_MS = 4000;
const MODE_REFRESH_MS = 400;
const REPLY_TIMEOUT_MS = 2500;
/** Effort the Ultracode switch goes back to when turned off: the app's launch default. */
const ULTRACODE_OFF_EFFORT = 'xhigh';

export interface SessionStatusFields {
  model?: string;
  model_id?: string;
  effort?: string;
  thinking?: boolean;
}

interface ControlsState {
  sessionId: string;
  el: HTMLElement;
  pillsEl: HTMLElement;
  hintEl: HTMLElement;
  getTerminal: () => Terminal | undefined;
  modelName?: string;
  effort?: string;
  thinking?: boolean;
  mode: PermissionMode | null;
  /** Ultracode as last read from the CLI; off until it says otherwise. */
  ultracode: boolean;
  /** The CLI has drawn its "ultracode" tag in this session, so its absence now means off. */
  tagSeen: boolean;
  busy: boolean;
  hintTimer: ReturnType<typeof setTimeout> | null;
  modeTimer: ReturnType<typeof setTimeout> | null;
}

const controls = new Map<string, ControlsState>();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function readScreen(term: Terminal): ScreenLine[] {
  const buf = term.buffer.active;
  const cell = buf.getNullCell();
  const lines: ScreenLine[] = [];
  for (let y = Math.max(0, buf.length - term.rows); y < buf.length; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    let strong = '';
    for (let x = 0; x < line.length; x++) {
      line.getCell(x, cell);
      if (cell.getWidth() === 0) continue; // trailing half of a wide glyph
      const ch = cell.getChars() || ' ';
      strong += cell.isDim() ? ' '.repeat(ch.length) : ch;
    }
    lines.push({ text: line.translateToString(true), strongText: strong.trimEnd() });
  }
  return lines;
}

function promptState(state: ControlsState): PromptState | null {
  const term = state.getTerminal();
  return term ? readPromptState(readScreen(term)) : null;
}

function write(state: ControlsState, data: string): void {
  window.vibeyard.pty.write(state.sessionId, data);
}

function showHint(state: ControlsState, text: string): void {
  const hint = state.hintEl;
  hint.textContent = text;
  hint.hidden = false;
  if (state.hintTimer) clearTimeout(state.hintTimer);
  state.hintTimer = setTimeout(() => {
    hint.hidden = true;
    state.hintTimer = null;
  }, HINT_MS);
}

/** The prompt must be on screen and empty before any keys are sent. */
function readyForInput(state: ControlsState): boolean {
  const ps = promptState(state);
  if (!ps?.found) {
    showHint(state, t('sessionControls.notReady'));
    return false;
  }
  if (!ps.empty) {
    showHint(state, t('sessionControls.draftPresent'));
    return false;
  }
  return true;
}

async function runExclusive(state: ControlsState, action: () => Promise<void>): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  state.el.classList.add('busy');
  try {
    await action();
  } finally {
    state.busy = false;
    state.el.classList.remove('busy');
  }
}

/** Type `command` into the empty prompt and submit it; false when the prompt wasn't ready. */
async function sendSlashCommand(state: ControlsState, command: string): Promise<boolean> {
  if (!readyForInput(state)) return false;
  write(state, command);
  // Separate write so the CLI sees Enter as a keypress, not part of a paste.
  await sleep(80);
  write(state, '\r');
  showHint(state, t('sessionControls.sent', { command }));
  return true;
}

async function waitForScreen(state: ControlsState, matches: RegExp, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const term = state.getTerminal();
    if (term && readScreen(term).some((l) => matches.test(l.text))) return true;
  }
  return false;
}

/**
 * Turn ultracode on (`/effort ultracode`) or off (`/effort xhigh`), then read
 * the CLI's reply under this command's echo: it says when ultracode can't run
 * here (dynamic workflows off, an effort cap, a model without xhigh, an effort
 * env override), which the hint passes on. A confirmation dialog is left to
 * the person, in the terminal.
 */
async function setUltracode(state: ControlsState, on: boolean): Promise<void> {
  const term = state.getTerminal();
  if (!term) return;
  // The CLI may redraw the whole screen, so rows don't tell old from new:
  // a reply counts once the conversation above the prompt has changed.
  const before = transcriptText(readScreen(term));
  const arg = on ? 'ultracode' : ULTRACODE_OFF_EFFORT;
  const command = `/effort ${arg}`;
  if (!(await sendSlashCommand(state, command))) return;
  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const lines = readScreen(term);
    if (lines.some((l) => /Change effort level\?/.test(l.text))) {
      term.focus();
      showHint(state, t('sessionControls.confirmInTerminal'));
      return;
    }
    if (transcriptText(lines) === before) continue;
    const exchange = readEffortExchange(lines);
    if (!exchange?.reply || exchange.arg !== arg) continue;
    const reply = exchange.reply;
    state.ultracode = reply === 'on';
    render(state);
    if (reply === 'on' || reply === 'off') {
      showHint(state, t(reply === 'on' ? 'sessionControls.ultracodeEnabled' : 'sessionControls.ultracodeDisabled'));
    } else {
      showHint(state, t(`sessionControls.ultracodeUnavailable.${reply}`));
    }
    return;
  }
}

async function setThinking(state: ControlsState, enabled: boolean): Promise<void> {
  if (!readyForInput(state)) return;
  write(state, ALT_T);
  if (!(await waitForScreen(state, /Toggle thinking mode/i, DIALOG_TIMEOUT_MS))) {
    showHint(state, t('sessionControls.failed'));
    return;
  }
  write(state, enabled ? '1' : '2');
  // Mid-conversation the CLI warns that switching costs latency and quality and
  // asks to proceed. That choice stays with the person: hand them the terminal.
  if (await waitForScreen(state, /Do you want to proceed\?/i, CONFIRM_TIMEOUT_MS)) {
    state.getTerminal()?.focus();
    showHint(state, t('sessionControls.confirmInTerminal'));
  }
}

async function waitForModeChange(state: ControlsState, from: PermissionMode): Promise<PermissionMode | null> {
  const deadline = Date.now() + MODE_STEP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const ps = promptState(state);
    if (!ps?.found) continue;
    const mode = ps.mode ?? 'default';
    if (mode !== from) return mode;
  }
  return null;
}

/**
 * Shift+Tab until the footer shows `target`. Stops if the cycle comes back to
 * where it started (the target is unavailable — e.g. bypass needs a launch
 * flag), which also leaves the session in its original mode.
 */
async function setMode(state: ControlsState, target: PermissionMode): Promise<void> {
  const ps = promptState(state);
  if (!ps?.found) {
    showHint(state, t('sessionControls.notReady'));
    return;
  }
  const start = ps.mode ?? 'default';
  let current = start;
  for (let step = 0; step < PERMISSION_MODES.length + 1 && current !== target; step++) {
    write(state, SHIFT_TAB);
    const next = await waitForModeChange(state, current);
    if (next === null) {
      showHint(state, t('sessionControls.failed'));
      break;
    }
    current = next;
    state.mode = current;
    render(state);
    if (current === start) {
      showHint(state, t('sessionControls.modeUnavailable'));
      break;
    }
  }
}

// --- Menus ------------------------------------------------------------------

interface MenuItem {
  label: string;
  hint?: string;
  current?: boolean;
  run?: () => void;
}

function openMenu(anchor: HTMLElement, items: Array<MenuItem | 'separator'>): void {
  hideTabContextMenu();
  const menu = document.createElement('div');
  menu.className = 'tab-context-menu session-controls-menu';
  for (const item of items) {
    if (item === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'tab-context-menu-separator';
      menu.appendChild(sep);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'tab-context-menu-item' + (item.current ? ' current' : '');
    row.innerHTML = `<span class="sc-menu-label">${item.current ? '✓ ' : ''}${esc(item.label)}</span>${item.hint ? `<span class="shortcut-hint">${esc(item.hint)}</span>` : ''}`;
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTabContextMenu();
      item.run?.();
    });
    menu.appendChild(row);
  }
  document.body.appendChild(menu);
  // The status bar sits at the bottom of the pane, so open upward.
  const rect = anchor.getBoundingClientRect();
  const height = menu.offsetHeight;
  menu.style.left = `${Math.min(rect.left, window.innerWidth - menu.offsetWidth - 4)}px`;
  menu.style.top = `${Math.max(4, rect.top - height - 4)}px`;
  setActiveContextMenu(menu);
}

function modeLabel(mode: PermissionMode): string {
  return t(`sessionControls.modes.${mode}`);
}

function effortLabel(level: string | undefined): string {
  return level ? t(`sessionControls.efforts.${level}`) : '—';
}

function openModelMenu(state: ControlsState, anchor: HTMLElement): void {
  const currentName = shortModelName(state.modelName).toLowerCase();
  openMenu(anchor, MODEL_CHOICES.map((choice) => ({
    label: choice.label,
    hint: choice.id,
    current: currentName === choice.label.toLowerCase(),
    run: () => {
      if (currentName === choice.label.toLowerCase()) return;
      void runExclusive(state, async () => {
        if (!(await sendSlashCommand(state, `/model ${choice.id}`))) return;
        // The CLI may ask before switching models (e.g. with ultracode on): that's the person's call.
        if (await waitForScreen(state, /Switch model\?|Confirm switching the model/i, CONFIRM_TIMEOUT_MS)) {
          state.getTerminal()?.focus();
          showHint(state, t('sessionControls.confirmInTerminal'));
        }
      });
    },
  })));
}

function openEffortMenu(state: ControlsState, anchor: HTMLElement): void {
  const items: Array<MenuItem | 'separator'> = EFFORT_LEVELS.map((level) => ({
    label: effortLabel(level),
    hint: level,
    current: state.effort === level,
    run: () => {
      if (state.effort === level && !state.ultracode) return;
      void runExclusive(state, async () => {
        // any effort level other than ultracode turns ultracode off
        if (await sendSlashCommand(state, `/effort ${level}`) && state.ultracode) {
          state.ultracode = false;
          render(state);
        }
      });
    },
  }));
  items.push('separator');
  items.push({
    label: t('sessionControls.thinkingOn'),
    current: state.thinking === true,
    run: () => {
      if (state.thinking === true) return;
      void runExclusive(state, () => setThinking(state, true));
    },
  });
  items.push({
    label: t('sessionControls.thinkingOff'),
    current: state.thinking === false,
    run: () => {
      if (state.thinking === false) return;
      void runExclusive(state, () => setThinking(state, false));
    },
  });
  openMenu(anchor, items);
}

function openModeMenu(state: ControlsState, anchor: HTMLElement): void {
  openMenu(anchor, PERMISSION_MODES.map((mode) => ({
    label: modeLabel(mode),
    hint: mode === 'default' ? 'manual' : mode,
    current: (state.mode ?? 'default') === mode,
    run: () => { void runExclusive(state, () => setMode(state, mode)); },
  })));
}

// --- Rendering --------------------------------------------------------------

function pill(kind: string, icon: string, text: string, title: string): string {
  return `<button type="button" class="sc-pill sc-${kind}" title="${esc(title)}"><span class="sc-icon" aria-hidden="true">${icon}</span><span class="sc-text">${esc(text)}</span><span class="sc-caret" aria-hidden="true"></span></button>`;
}

// Claude Code's rainbow for "ultracode"/"ultrathink" (its theme's rainbow_* and
// rainbow_*_shimmer colours): each letter takes the next colour, and a brighter
// shimmer sweeps across the word (styles/session-controls.css).
const RAINBOW = ['rgb(235,95,87)', 'rgb(245,139,87)', 'rgb(250,195,95)', 'rgb(145,200,130)', 'rgb(130,170,220)', 'rgb(155,130,200)', 'rgb(200,130,180)'];
const RAINBOW_SHIMMER = ['rgb(250,155,147)', 'rgb(255,185,137)', 'rgb(255,225,155)', 'rgb(185,230,180)', 'rgb(180,205,240)', 'rgb(195,180,230)', 'rgb(230,180,210)'];

function rainbowWord(word: string): string {
  return [...word]
    .map((ch, i) => `<span class="sc-uc-letter" style="--i:${i};--c:${RAINBOW[i % RAINBOW.length]};--s:${RAINBOW_SHIMMER[i % RAINBOW_SHIMMER.length]}">${esc(ch)}</span>`)
    .join('');
}

/** Open this conversation's typeset view (排版视图) in a tab next to it. */
async function openTypesetView(state: ControlsState): Promise<void> {
  const project = appState.projects.find((p) => p.sessions.some((s) => s.id === state.sessionId));
  const session = project?.sessions.find((s) => s.id === state.sessionId);
  const transcript = session?.cliSessionId
    ? await window.vibeyard.claudeHistory.transcriptPath(session.cliSessionId).catch(() => null)
    : null;
  if (!project || !session || !transcript) {
    showHint(state, t('preview.notStarted'));
    return;
  }
  openConversationView(project.id, transcript, session.name);
}

/** The Ultracode switch: a pill without a menu, its name in Claude Code's shimmering rainbow while on. */
function ultracodeSwitch(on: boolean): string {
  const label = t('sessionControls.ultracode');
  const text = on ? `${rainbowWord(label)}<span class="sc-uc-state">${esc(t('sessionControls.ultracodeOnSuffix'))}</span>` : esc(label);
  return `<button type="button" class="sc-pill sc-ultracode${on ? ' on' : ''}" role="switch" aria-checked="${on}" aria-label="${esc(on ? t('sessionControls.ultracodeOn') : label)}" title="${esc(t('sessionControls.ultracodeTitle'))}"><span class="sc-icon" aria-hidden="true">✺</span><span class="sc-text">${text}</span></button>`;
}

function render(state: ControlsState): void {
  const model = shortModelName(state.modelName) || t('sessionControls.model');
  let effort = `${t('sessionControls.effort')} · ${effortLabel(state.effort)}`;
  if (state.thinking === false) effort += ` · ${t('sessionControls.off')}`;
  const mode = state.mode ? modeLabel(state.mode) : t('sessionControls.mode');
  state.pillsEl.innerHTML = `
    ${pill('model', '✦', model, t('sessionControls.modelTitle'))}
    ${pill('effort', '◐', effort, t('sessionControls.effortTitle'))}
    ${pill('mode', state.mode === 'plan' || state.mode === 'default' ? '⏸' : '⏵⏵', mode, t('sessionControls.modeTitle'))}
    ${ultracodeSwitch(state.ultracode)}
    <button type="button" class="sc-pill sc-typeset" title="${esc(t('sessionControls.typesetTitle'))}"><span class="sc-icon" aria-hidden="true">∑</span><span class="sc-text">${esc(t('sessionControls.typeset'))}</span></button>
  `;
  state.el.dataset.mode = state.mode ?? '';
  const bind = (selector: string, open: (s: ControlsState, a: HTMLElement) => void) => {
    const btn = state.pillsEl.querySelector<HTMLElement>(selector);
    btn?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!state.busy) open(state, btn);
    });
  };
  bind('.sc-model', openModelMenu);
  bind('.sc-effort', openEffortMenu);
  bind('.sc-mode', openModeMenu);
  bind('.sc-ultracode', (s) => { void runExclusive(s, () => setUltracode(s, !s.ultracode)); });
  bind('.sc-typeset', (s) => { void openTypesetView(s); });
}

// --- Public API ---------------------------------------------------------------

export function mountSessionControls(statusBar: HTMLElement, sessionId: string, getTerminal: () => Terminal | undefined): void {
  const el = document.createElement('div');
  el.className = 'session-controls';
  const pillsEl = document.createElement('div');
  pillsEl.className = 'sc-pills';
  const hintEl = document.createElement('span');
  hintEl.className = 'sc-hint';
  hintEl.hidden = true;
  el.append(pillsEl, hintEl);
  const state: ControlsState = { sessionId, el, pillsEl, hintEl, getTerminal, mode: null, ultracode: false, tagSeen: false, busy: false, hintTimer: null, modeTimer: null };
  controls.set(sessionId, state);
  statusBar.classList.add('has-controls');
  statusBar.insertBefore(el, statusBar.firstChild);
  render(state);
}

export function unmountSessionControls(sessionId: string): void {
  const state = controls.get(sessionId);
  if (!state) return;
  if (state.hintTimer) clearTimeout(state.hintTimer);
  if (state.modeTimer) clearTimeout(state.modeTimer);
  controls.delete(sessionId);
}

/** Model / effort / thinking as reported by Claude's statusLine payload. */
export function updateSessionControlsStatus(sessionId: string, fields: SessionStatusFields): void {
  const state = controls.get(sessionId);
  if (!state) return;
  const next = {
    modelName: fields.model ?? state.modelName,
    effort: fields.effort ?? state.effort,
    thinking: fields.thinking ?? state.thinking,
    // ultracode always runs at xhigh: any other effort, or none (a model without
    // effort levels), means it's off
    ultracode: state.ultracode && fields.effort === 'xhigh',
  };
  if (next.modelName === state.modelName && next.effort === state.effort && next.thinking === state.thinking && next.ultracode === state.ultracode) return;
  Object.assign(state, next);
  render(state);
}

/**
 * Re-read the footer's mode label, and whether ultracode is on, shortly after
 * terminal output settles. Ultracode follows the CLI's "ultracode" tag on the
 * prompt box once the CLI has drawn it this session (its absence then means
 * off), and otherwise the reply to the newest `/effort` on screen, e.g. one
 * typed by hand.
 */
export function scheduleModeRefresh(sessionId: string): void {
  const state = controls.get(sessionId);
  if (!state || state.modeTimer || state.busy) return;
  state.modeTimer = setTimeout(() => {
    state.modeTimer = null;
    const term = state.getTerminal();
    if (!term) return;
    const lines = readScreen(term);
    const ps = readPromptState(lines);
    if (!ps.found) return;
    const mode = ps.mode ?? 'default';
    let ultracode = state.ultracode;
    const tag = readUltracodeTag(lines);
    if (tag) state.tagSeen = true;
    if (tag || state.tagSeen) {
      ultracode = tag === true;
    } else {
      const reply = readEffortExchange(lines)?.reply;
      if (reply) ultracode = reply === 'on';
    }
    if (mode !== state.mode || ultracode !== state.ultracode) {
      state.mode = mode;
      state.ultracode = ultracode;
      render(state);
    }
  }, MODE_REFRESH_MS);
}
