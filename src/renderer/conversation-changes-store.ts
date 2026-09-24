import { appState } from './state.js';
import type { ConversationChanges } from '../shared/types.js';

// The focused Claude conversation's file changes, for the right column's
// 本轮修改 / 本对话修改 panes. Follows whichever tab is active; refreshed on tab
// switches, after each statusLine report from that conversation, and by the
// panel's poll. The main process reads transcripts incrementally, so refreshing
// is cheap.

export type ChangesView =
  | { kind: 'none' }
  | { kind: 'loading'; sessionName: string }
  | { kind: 'missing'; sessionName: string }
  | { kind: 'ready'; sessionName: string; changes: ConversationChanges };

let view: ChangesView = { kind: 'none' };
let signature = '';
let inFlight = false;
let again = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const cb of listeners) cb();
}

function signatureOf(v: ChangesView): string {
  if (v.kind !== 'ready') return `${v.kind}:${'sessionName' in v ? v.sessionName : ''}`;
  const c = v.changes;
  const files = (list: ConversationChanges['total']) => list.map((f) => `${f.path}:${f.added}:${f.removed}:${f.edits}`).join('|');
  return `ready:${v.sessionName}:${c.cliSessionId}:${c.turns}:${c.lastTurn?.index ?? 0}:${files(c.lastTurn?.files ?? [])}#${files(c.total)}`;
}

function setView(next: ChangesView): void {
  const sig = signatureOf(next);
  if (sig === signature) return;
  signature = sig;
  view = next;
  notify();
}

export function getChangesView(): ChangesView {
  return view;
}

/** The active tab's Claude session, when it is a Claude CLI conversation. */
function activeClaudeSession(): { name: string; cliSessionId: string | null } | null {
  const session = appState.activeSession;
  if (!session || session.type) return null;
  if ((session.providerId ?? 'claude') !== 'claude') return null;
  return { name: session.name, cliSessionId: session.cliSessionId };
}

export async function refreshChanges(): Promise<void> {
  if (inFlight) {
    again = true;
    return;
  }
  const session = activeClaudeSession();
  if (!session) {
    setView({ kind: 'none' });
    return;
  }
  if (!session.cliSessionId) {
    setView({ kind: 'missing', sessionName: session.name });
    return;
  }
  if (view.kind === 'none') setView({ kind: 'loading', sessionName: session.name });
  inFlight = true;
  try {
    const changes = await window.vibeyard.claudeHistory.changes(session.cliSessionId);
    // The user may have switched tabs while the read was in flight.
    const still = activeClaudeSession();
    if (still?.cliSessionId === session.cliSessionId) {
      setView(changes ? { kind: 'ready', sessionName: still.name, changes } : { kind: 'missing', sessionName: still.name });
    } else {
      again = true;
    }
  } catch {
    // leave the last view in place; the next refresh retries
  } finally {
    inFlight = false;
    if (again) {
      again = false;
      void refreshChanges();
    }
  }
}

/** Coalesce bursts (statusLine reports arrive many times a second while Claude streams). */
export function scheduleChangesRefresh(delayMs = 700): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void refreshChanges();
  }, delayMs);
}

export function onChangesViewChange(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function initConversationChanges(): void {
  appState.on('session-changed', () => scheduleChangesRefresh(50));
  appState.on('project-changed', () => scheduleChangesRefresh(50));
  appState.on('session-removed', () => scheduleChangesRefresh(50));
  appState.on('state-loaded', () => scheduleChangesRefresh(50));
}

/** @internal Test-only: reset all module state */
export function _resetForTesting(): void {
  view = { kind: 'none' };
  signature = '';
  inFlight = false;
  again = false;
  if (timer) clearTimeout(timer);
  timer = null;
  listeners.clear();
}
