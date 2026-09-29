import type { ClaudeConversation, ConversationTitle, PersistedState } from '../../shared/types.js';

// Names the user typed for a conversation in Crabyard, keyed by CLI session id.
// The transcript is Claude Code's file and stays untouched: the sidebar lays
// these over the title it reads from the transcript, and a tab reopened from
// the sidebar takes them as a sticky (userRenamed) name. Each entry remembers
// the transcript's own custom title when it was set, so a /rename typed in the
// CLI afterwards wins again, and when, so the entries of conversations that are
// gone for good are dropped after a while.

/** Entries of conversations neither listed nor open for this long are dropped (Claude Code keeps transcripts 30 days by default). */
export const TITLE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function getConversationTitleEntry(state: PersistedState, cliSessionId: string | null | undefined): ConversationTitle | undefined {
  if (!cliSessionId) return undefined;
  return state.conversationTitles?.[cliSessionId];
}

export function getConversationTitle(state: PersistedState, cliSessionId: string | null | undefined): string | undefined {
  return getConversationTitleEntry(state, cliSessionId)?.title || undefined;
}

/** @returns true when the stored title changed. */
export function setConversationTitle(
  state: PersistedState,
  cliSessionId: string,
  title: string,
  opts: { at?: number; base?: string | null } = {},
): boolean {
  const map = (state.conversationTitles ??= {});
  const prev = map[cliSessionId];
  if (prev?.title === title && opts.base === undefined) return false;
  map[cliSessionId] = { title, at: opts.at ?? Date.now(), ...(opts.base !== undefined ? { base: opts.base } : {}) };
  return true;
}

/** @returns true when a title was removed. */
export function removeConversationTitle(state: PersistedState, cliSessionId: string): boolean {
  if (!state.conversationTitles || !(cliSessionId in state.conversationTitles)) return false;
  delete state.conversationTitles[cliSessionId];
  return true;
}

/** The user renamed the conversation in the CLI (a new custom title) after naming it in Crabyard. */
function renamedInCliSince(entry: ConversationTitle, conv: ClaudeConversation): boolean {
  return entry.base !== undefined && conv.customTitle !== undefined && conv.customTitle !== (entry.base ?? undefined);
}

/**
 * The name to show for a listed conversation, if the user gave one: its own,
 * unless a CLI /rename came after it, else one given to a conversation it
 * carries on (a hand-off to a background session). A pure read.
 */
export function titleFor(state: PersistedState, conv: ClaudeConversation): string | undefined {
  const own = getConversationTitleEntry(state, conv.cliSessionId);
  if (own) return renamedInCliSince(own, conv) ? undefined : own.title;
  for (const id of conv.continuedFrom ?? []) {
    const entry = getConversationTitleEntry(state, id);
    if (entry) return entry.title;
  }
  return undefined;
}

/**
 * Line the stored names up with a fresh conversation list:
 * - a conversation that carries on others takes the newest name among them;
 * - an entry notes the transcript's custom title the first time it is seen;
 * - an entry is dropped once the user renamed the conversation in the CLI,
 *   whose new title is returned so open tabs can take it;
 * - entries of conversations neither listed nor open go after a while.
 */
export function reconcileConversationTitles(
  state: PersistedState,
  list: ClaudeConversation[],
  openIds: ReadonlySet<string>,
  now = Date.now(),
): { changed: boolean; renamedInCli: Array<{ cliSessionId: string; title: string }> } {
  const renamedInCli: Array<{ cliSessionId: string; title: string }> = [];
  const map = state.conversationTitles;
  if (!map) return { changed: false, renamedInCli };
  let changed = false;
  const listed = new Set<string>();
  for (const conv of list) {
    const id = conv.cliSessionId;
    listed.add(id);
    for (const prev of conv.continuedFrom ?? []) listed.add(prev);
    let own = map[id];
    let newest: ConversationTitle | undefined;
    for (const prev of conv.continuedFrom ?? []) {
      const entry = map[prev];
      if (entry && (!newest || entry.at > newest.at)) newest = entry;
    }
    if (newest && (!own || newest.at > own.at)) {
      own = map[id] = { title: newest.title, at: newest.at, base: conv.customTitle ?? null };
      changed = true;
      continue;
    }
    if (!own) continue;
    if (own.base === undefined) {
      own.base = conv.customTitle ?? null;
      changed = true;
    } else if (renamedInCliSince(own, conv)) {
      delete map[id];
      renamedInCli.push({ cliSessionId: id, title: conv.customTitle! });
      changed = true;
    }
  }
  for (const [id, entry] of Object.entries(map)) {
    if (!listed.has(id) && !openIds.has(id) && now - entry.at > TITLE_RETENTION_MS) {
      delete map[id];
      changed = true;
    }
  }
  return { changed, renamedInCli };
}

/**
 * Load-time cleanup: keep well-formed entries (a plain string from before
 * entries carried a time is taken as set now), and adopt the names of open
 * tabs the user renamed before this map existed (their `userRenamed` name
 * belongs to their current `cliSessionId` — a new id resets the flag). Closed
 * tabs' history entries carry no such flag, so they are not guessed at.
 */
export function hydrateConversationTitles(state: PersistedState, now = Date.now()): void {
  const raw: unknown = state.conversationTitles;
  const clean: Record<string, ConversationTitle> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string') {
        if (value.trim()) clean[id] = { title: value, at: now };
        continue;
      }
      if (!value || typeof value !== 'object') continue;
      const v = value as Record<string, unknown>;
      if (typeof v.title !== 'string' || !v.title.trim()) continue;
      clean[id] = {
        title: v.title,
        at: typeof v.at === 'number' && Number.isFinite(v.at) ? v.at : now,
        ...(typeof v.base === 'string' || v.base === null ? { base: v.base as string | null } : {}),
      };
    }
  }
  for (const project of state.projects) {
    for (const session of project.sessions) {
      if (session.userRenamed && session.cliSessionId && session.name && !(session.cliSessionId in clean)) {
        clean[session.cliSessionId] = { title: session.name, at: now };
      }
    }
  }
  if (raw !== undefined || Object.keys(clean).length > 0) state.conversationTitles = clean;
}
