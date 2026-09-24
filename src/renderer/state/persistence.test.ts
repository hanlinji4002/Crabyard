import { describe, it, expect, vi } from 'vitest';

vi.mock('../session-cost.js', () => ({ restoreCost: vi.fn() }));
vi.mock('../session-context.js', () => ({ restoreContext: vi.fn() }));

import { ensureProjectDefaults, hydrateLoadedState, serializeForSave } from './persistence.js';
import type { PersistedState, SessionRecord } from '../../shared/types.js';

function baseState(session: Partial<SessionRecord>): PersistedState {
  return {
    version: 1,
    activeProjectId: 'p1',
    preferences: {} as PersistedState['preferences'],
    projects: [
      {
        id: 'p1',
        name: 'Proj',
        path: '/p',
        activeSessionId: 's1',
        layout: { mode: 'tabs', splitPanes: [], splitDirection: 'horizontal' },
        sessions: [{ id: 's1', name: 'S', cliSessionId: null, createdAt: '0', ...session }],
      },
    ],
  };
}

describe('serializeForSave', () => {
  it('preserves the sticky profileId on sessions (resume must reuse the config dir)', () => {
    const out = serializeForSave(baseState({ profileId: 'work' }));
    expect(out.projects[0].sessions[0].profileId).toBe('work');
  });

  it('strips the transient pending prompts', () => {
    const out = serializeForSave(baseState({ profileId: 'work', pendingInitialPrompt: 'hi', pendingSystemPrompt: 'sys' }));
    const s = out.projects[0].sessions[0];
    expect(s.profileId).toBe('work');
    expect(s.pendingInitialPrompt).toBeUndefined();
    expect(s.pendingSystemPrompt).toBeUndefined();
  });

  it('passes the top-level profiles array through unchanged', () => {
    const state = baseState({});
    state.profiles = [{ id: 'work', name: 'Work', providerId: 'claude', configDir: '/cfg/work', managed: true, createdAt: 0 }];
    const out = serializeForSave(state);
    expect(out.profiles).toEqual(state.profiles);
  });
});

describe('ensureProjectDefaults', () => {
  function legacyState(): PersistedState {
    const state = baseState({});
    const project = state.projects[0];
    project.sessions = [
      { id: 'overview', name: 'Proj - Overview', type: 'project-tab' as SessionRecord['type'], cliSessionId: null, createdAt: '0' },
      { id: 's1', name: 'S', cliSessionId: null, createdAt: '0' },
      { id: 'board', name: 'Proj - Kanban', type: 'kanban' as SessionRecord['type'], cliSessionId: null, createdAt: '0' },
      { id: 'web', name: 'Browser', type: 'browser-tab' as SessionRecord['type'], cliSessionId: null, createdAt: '0' },
      { id: 'mcp', name: 'Inspector 1', type: 'mcp-inspector' as SessionRecord['type'], cliSessionId: null, createdAt: '0' },
      { id: 'p2p', name: 'Remote: x', type: 'remote-terminal' as SessionRecord['type'], cliSessionId: null, createdAt: '0' },
    ];
    project.activeSessionId = 'board';
    project.layout = { mode: 'board' as 'tabs', splitPanes: ['overview', 's1', 'board'], splitDirection: 'horizontal' };
    Object.assign(project, {
      board: { columns: [], tasks: [] },
      overviewLayout: { gridVersion: 1, widgets: [] },
      readiness: { overallScore: 80, categories: [], scannedAt: '0' },
      readinessHistory: [],
      githubLastSeen: { prs: '0' },
    });
    return state;
  }

  it('drops Overview, Kanban, Browser, MCP inspector and joined remote tabs left in saved state', () => {
    const state = legacyState();
    ensureProjectDefaults(state);
    const project = state.projects[0];
    expect(project.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(project.activeSessionId).toBe('s1');
    expect(project.layout.splitPanes).toEqual(['s1']);
  });

  it('migrates the legacy board layout mode to tabs', () => {
    const state = legacyState();
    ensureProjectDefaults(state);
    expect(state.projects[0].layout.mode).toBe('tabs');
  });

  it('removes the per-project data only those features used', () => {
    const state = legacyState();
    ensureProjectDefaults(state);
    const project = state.projects[0] as unknown as Record<string, unknown>;
    for (const field of ['board', 'overviewLayout', 'readiness', 'readinessHistory', 'githubLastSeen']) {
      expect(project[field]).toBeUndefined();
    }
  });

  it('keeps the active session when it survives', () => {
    const state = legacyState();
    state.projects[0].activeSessionId = 's1';
    ensureProjectDefaults(state);
    expect(state.projects[0].activeSessionId).toBe('s1');
  });
});

describe('hydrateLoadedState', () => {
  it('drops preferences only the removed features read', () => {
    const state = baseState({});
    state.preferences = { readinessExcludedProviders: ['codex'], boardCardMetrics: true } as unknown as PersistedState['preferences'];
    hydrateLoadedState(state, { debugMode: false } as PersistedState['preferences']);
    const prefs = state.preferences as unknown as Record<string, unknown>;
    expect(prefs.readinessExcludedProviders).toBeUndefined();
    expect(prefs.boardCardMetrics).toBeUndefined();
    expect(prefs.debugMode).toBe(false);
  });
});
