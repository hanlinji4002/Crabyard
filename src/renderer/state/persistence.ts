import type { PersistedState, Preferences, ProjectRecord, SessionRecord } from '../../shared/types.js';
import { restoreCost } from '../session-cost.js';
import { restoreContext } from '../session-context.js';
import { hydrateConversationTitles } from './conversation-titles.js';

/** Tab types this fork removed: Overview, Kanban, Browser, MCP inspector, joined remote sessions. */
const REMOVED_SESSION_TYPES = new Set<string>(['project-tab', 'kanban', 'browser-tab', 'mcp-inspector', 'remote-terminal']);

/** Per-project fields only those removed features used. */
const REMOVED_PROJECT_FIELDS = ['board', 'overviewLayout', 'readiness', 'readinessHistory', 'githubLastSeen'];

/** Preferences only those removed features read. */
const REMOVED_PREFERENCE_KEYS = ['readinessExcludedProviders', 'boardCardMetrics', 'chromeImport'];

/** Top-level state only the removed Discussions card used. */
const REMOVED_STATE_KEYS = ['discussionsLastSeen'];

/**
 * Apply forward-compat migrations and runtime priming to a freshly-loaded state.
 * Mutates `state` in place.
 */
export function hydrateLoadedState(state: PersistedState, defaultPreferences: Preferences): void {
  state.preferences = { ...defaultPreferences, ...state.preferences };
  for (const key of REMOVED_PREFERENCE_KEYS) delete (state.preferences as Preferences & Record<string, unknown>)[key];
  for (const key of REMOVED_STATE_KEYS) delete (state as PersistedState & Record<string, unknown>)[key];
  for (const project of state.projects) {
    for (const session of project.sessions) {
      if (session.cost) restoreCost(session.id, session.cost);
      if (session.contextWindow) restoreContext(session.id, session.contextWindow);
    }
    if (project.sessionHistory) {
      const seenIds = new Set<string>();
      for (const entry of project.sessionHistory) {
        if (seenIds.has(entry.id)) entry.id = crypto.randomUUID();
        seenIds.add(entry.id);
      }
    }
  }
  hydrateConversationTitles(state);
}

/**
 * Drop what the removed Overview and Kanban features left in saved state —
 * their tabs, the per-project board, overview layout, readiness history and
 * GitHub unread markers — and migrate the legacy `layout.mode === 'board'`.
 */
export function ensureProjectDefaults(state: PersistedState): void {
  for (const project of state.projects) {
    const record = project as ProjectRecord & Record<string, unknown>;
    for (const field of REMOVED_PROJECT_FIELDS) delete record[field];

    if ((project.layout as { mode: string }).mode === 'board') project.layout.mode = 'tabs';

    const kept = project.sessions.filter((s) => !REMOVED_SESSION_TYPES.has(s.type ?? ''));
    if (kept.length === project.sessions.length) continue;
    project.sessions = kept;
    const keptIds = new Set(kept.map((s) => s.id));
    if (project.activeSessionId && !keptIds.has(project.activeSessionId)) {
      project.activeSessionId = kept[0]?.id ?? null;
    }
    project.layout.splitPanes = project.layout.splitPanes.filter((id) => keptIds.has(id));
  }
}

/**
 * Strip transient fields that should never be persisted (in-flight prompts).
 */
export function serializeForSave(state: PersistedState): PersistedState {
  return {
    ...state,
    projects: state.projects.map((p: ProjectRecord) => ({
      ...p,
      sessions: p.sessions.map(({ pendingInitialPrompt, pendingSystemPrompt, ...rest }: SessionRecord) => rest as SessionRecord),
    })),
  };
}
