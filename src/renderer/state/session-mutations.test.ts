import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLoad = vi.fn();
const mockSave = vi.fn();

vi.stubGlobal('window', {
  vibeyard: {
    store: { load: mockLoad, save: mockSave },
    session: { transcriptExistsSync: vi.fn().mockReturnValue(true) },
  },
});

let uuidCounter = 0;
vi.stubGlobal('crypto', {
  randomUUID: () => `uuid-${++uuidCounter}`,
});

vi.mock('../session-cost.js', () => ({
  getCost: vi.fn().mockReturnValue(null),
  restoreCost: vi.fn(),
}));

vi.mock('../session-context.js', () => ({
  restoreContext: vi.fn(),
}));

vi.mock('../provider-availability.js', () => ({
  getProviderCapabilities: vi.fn(() => null),
  getProviderAvailabilitySnapshot: vi.fn(() => null),
  getTeamChatProviderMetas: vi.fn(() => []),
}));

import { appState, _resetForTesting, MAX_SESSION_NAME_LENGTH } from '../state';
import { getCost } from '../session-cost.js';
const mockGetCost = vi.mocked(getCost);

beforeEach(() => {
  vi.clearAllMocks();
  uuidCounter = 0;
  mockGetCost.mockReturnValue(null);
  _resetForTesting();
});

function addProject(name = 'Test', path = '/test') {
  return appState.addProject(name, path);
}

function addProjectWithSessions(count: number) {
  const project = addProject();
  const sessions = [];
  for (let i = 0; i < count; i++) {
    sessions.push(appState.addSession(project.id, `Session ${i + 1}`)!);
  }
  return { project, sessions };
}

function mockCostData() {
  mockGetCost.mockReturnValue({
    totalCostUsd: 0.42,
    totalInputTokens: 1000,
    totalOutputTokens: 500,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalDurationMs: 5000,
    totalApiDurationMs: 3000,
  });
}

describe('setActiveSession()', () => {
  it('updates activeSessionId and persists', () => {
    const { project, sessions } = addProjectWithSessions(2);
    mockSave.mockClear();
    appState.setActiveSession(project.id, sessions[0].id);
    expect(appState.activeProject!.activeSessionId).toBe(sessions[0].id);
    expect(mockSave).toHaveBeenCalled();
  });
});

describe('updateSessionCliId()', () => {
  it('updates cliSessionId and persists', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    mockSave.mockClear();
    appState.updateSessionCliId(project.id, session.id, 'claude-abc');
    expect(appState.activeSession!.cliSessionId).toBe('claude-abc');
    expect(mockSave).toHaveBeenCalled();
  });

  it('resets userRenamed when cliSessionId changes', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'claude-abc');
    appState.renameSession(project.id, session.id, 'Custom', true);
    expect(appState.activeSession!.userRenamed).toBe(true);
    // Simulate /clear: new cliSessionId
    appState.updateSessionCliId(project.id, session.id, 'claude-xyz');
    expect(appState.activeSession!.userRenamed).toBe(false);
  });

  it('rebinds quietly when the tab bounces back to the conversation it just left', () => {
    vi.useFakeTimers();
    try {
      const project = addProject();
      const session = appState.addSession(project.id, 'S1')!;
      appState.updateSessionCliId(project.id, session.id, 'claude-abc');
      appState.renameSession(project.id, session.id, 'Custom', true);
      const cleared = vi.fn();
      appState.on('cli-session-cleared', cleared);

      // Another Claude process reports under this tab for a moment, then the tab's own CLI again.
      appState.updateSessionCliId(project.id, session.id, 'claude-other');
      expect(cleared).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(5_000);
      appState.updateSessionCliId(project.id, session.id, 'claude-abc');

      expect(cleared).toHaveBeenCalledTimes(1); // no second /clear
      expect(appState.activeSession!.cliSessionId).toBe('claude-abc');
      // The name the user gave the conversation comes back with it.
      expect(appState.activeSession!.name).toBe('Custom');
      expect(appState.activeSession!.userRenamed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('comes back with the name it had on that conversation, not one picked up meanwhile', () => {
    vi.useFakeTimers();
    try {
      const project = addProject();
      const session = appState.addSession(project.id, 'S1')!;
      appState.updateSessionCliId(project.id, session.id, 'cli-x');
      appState.renameSession(project.id, session.id, 'My X', true);
      // Now on A, auto-titled by the CLI.
      appState.updateSessionCliId(project.id, session.id, 'cli-a');
      appState.renameSession(project.id, session.id, 'A title');
      vi.advanceTimersByTime(60_000);
      // `/resume cli-x` picks up X's name; back on A within moments.
      appState.updateSessionCliId(project.id, session.id, 'cli-x');
      expect(appState.activeSession).toMatchObject({ name: 'My X', userRenamed: true });
      vi.advanceTimersByTime(3_000);
      appState.updateSessionCliId(project.id, session.id, 'cli-a');
      expect(appState.activeSession).toMatchObject({ cliSessionId: 'cli-a', name: 'A title', userRenamed: false });
      expect(appState.getConversationTitle('cli-a')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('follows a conversation carried on under another id without a /clear', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-a');
    appState.renameSession(project.id, session.id, '行程整理', true);
    const cleared = vi.fn();
    appState.on('cli-session-cleared', cleared);

    appState.followConversation(session.id, 'cli-b', 'bbbbbbbb');
    expect(appState.activeSession).toMatchObject({ cliSessionId: 'cli-b', attachShort: 'bbbbbbbb', name: '行程整理', userRenamed: true });
    expect(appState.getConversationTitle('cli-b')).toBe('行程整理');
    expect(cleared).not.toHaveBeenCalled();
    expect(project.sessionHistory ?? []).toHaveLength(0);

    // The job ended: a plain tab on the conversation it was last on.
    appState.followConversation(session.id, 'cli-b', null);
    expect(appState.activeSession!.attachShort).toBeUndefined();
  });

  it('keeps a name typed while another process briefly held the tab, on the tab\'s own conversation', () => {
    vi.useFakeTimers();
    try {
      const project = addProject();
      const session = appState.addSession(project.id, 'S1')!;
      appState.updateSessionCliId(project.id, session.id, 'cli-a');
      appState.renameSession(project.id, session.id, 'Auto A');
      // A nested `claude -p` reports under the tab for a moment; the user renames meanwhile.
      vi.advanceTimersByTime(1_000);
      appState.updateSessionCliId(project.id, session.id, 'cli-nested');
      vi.advanceTimersByTime(1_000);
      appState.renameSession(project.id, session.id, '行程整理', true);
      vi.advanceTimersByTime(1_000);
      appState.updateSessionCliId(project.id, session.id, 'cli-a');
      expect(appState.activeSession).toMatchObject({ cliSessionId: 'cli-a', name: '行程整理', userRenamed: true });
      expect(appState.getConversationTitle('cli-a')).toBe('行程整理');
      expect(appState.getConversationTitle('cli-nested')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('when an attached job moved on, takes the new conversation\'s name or starts over', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-f');
    appState.renameSession(project.id, session.id, '行程整理', true);
    appState.followConversation(session.id, 'cli-f', 'f0f0f0f0');
    // /clear inside the attached job: a new conversation, not this name.
    appState.followConversation(session.id, 'cli-n', 'f0f0f0f0', 'job');
    expect(appState.activeSession).toMatchObject({ cliSessionId: 'cli-n', userRenamed: false });
    expect(appState.activeSession!.name).not.toBe('行程整理');
    expect(appState.getConversationTitle('cli-n')).toBeUndefined();
    expect(appState.getConversationTitle('cli-f')).toBe('行程整理');
  });

  it('carries a name across a hand-off without overwriting one the new id already has', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-x');
    appState.renameSession(project.id, session.id, 'Named X', true);
    appState.updateSessionCliId(project.id, session.id, 'cli-a');
    appState.renameSession(project.id, session.id, '行程整理', true);
    appState.followConversation(session.id, 'cli-x', null, 'handoff');
    expect(appState.getConversationTitle('cli-x')).toBe('Named X');
    expect(appState.activeSession!.name).toBe('Named X');
  });

  it('hands naming back to Claude Code on an empty rename', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-1');
    appState.renameSession(project.id, session.id, '行程整理', true);
    appState.clearConversationName(project.id, session.id, 'Transcript title');
    expect(appState.activeSession).toMatchObject({ name: 'Transcript title', userRenamed: false });
    expect(appState.getConversationTitle('cli-1')).toBeUndefined();
  });

  it('an empty rename also forgets the name carried to a conversation that continues it', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-old');
    appState.renameSession(project.id, session.id, '行程整理', true);
    appState.reconcileConversationTitles([{ cliSessionId: 'cli-new', continuedFrom: ['cli-old'], transcriptPath: '', projectCwd: '/p', projectSlug: '-p', cwdExists: true, title: 'Carrier', titleSource: 'ai', firstPrompt: '', turns: 1, startedAt: 1, updatedAt: 2 }]);
    expect(appState.getConversationTitle('cli-new')).toBe('行程整理');
    appState.clearConversationName(project.id, session.id, 'Carrier', ['cli-new']);
    expect(appState.getConversationTitle('cli-old')).toBeUndefined();
    expect(appState.getConversationTitle('cli-new')).toBeUndefined();
  });

  it('forgets the name of a conversation that never got a transcript when its tab closes', () => {
    const exists = vi.mocked((window as unknown as { vibeyard: { session: { transcriptExistsSync: ReturnType<typeof vi.fn> } } }).vibeyard.session.transcriptExistsSync);
    const project = addProject();
    const kept = appState.addSession(project.id, 'S1')!;
    const never = appState.addSession(project.id, 'S2')!;
    appState.updateSessionCliId(project.id, kept.id, 'cli-kept');
    appState.renameSession(project.id, kept.id, 'Kept', true);
    appState.updateSessionCliId(project.id, never.id, 'cli-never');
    appState.renameSession(project.id, never.id, 'Never', true);
    exists.mockReturnValue(true);
    appState.removeSession(project.id, kept.id);
    exists.mockReturnValue(false);
    appState.removeSession(project.id, never.id);
    exists.mockReturnValue(true);
    expect(appState.getConversationTitle('cli-kept')).toBe('Kept');
    expect(appState.getConversationTitle('cli-never')).toBeUndefined();
  });

  it('treats a return to an old conversation after a while as a real switch', () => {
    vi.useFakeTimers();
    try {
      const project = addProject();
      const session = appState.addSession(project.id, 'S1')!;
      appState.updateSessionCliId(project.id, session.id, 'claude-abc');
      appState.updateSessionCliId(project.id, session.id, 'claude-xyz');
      const cleared = vi.fn();
      appState.on('cli-session-cleared', cleared);
      vi.advanceTimersByTime(60_000);
      appState.updateSessionCliId(project.id, session.id, 'claude-abc');
      expect(cleared).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('updateSessionCost()', () => {
  const sampleCost = {
    totalCostUsd: 2.5,
    totalInputTokens: 1000,
    totalOutputTokens: 400,
    cacheReadTokens: 50,
    cacheCreationTokens: 25,
    totalDurationMs: 3000,
    totalApiDurationMs: 2000,
  };

  it('persists cost data on the session record', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    mockSave.mockClear();
    appState.updateSessionCost(session.id, sampleCost);
    const updated = appState.activeProject!.sessions.find(s => s.id === session.id)!;
    expect(updated.cost).toEqual(sampleCost);
    expect(mockSave).toHaveBeenCalled();
  });

  it('no-op for nonexistent session', () => {
    addProject();
    mockSave.mockClear();
    appState.updateSessionCost('nonexistent', sampleCost);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('updates cost across projects', () => {
    const p1 = addProject('P1', '/p1');
    const p2 = addProject('P2', '/p2');
    const s1 = appState.addSession(p1.id, 'S1')!;
    appState.addSession(p2.id, 'S2');
    appState.updateSessionCost(s1.id, sampleCost);
    const found = appState.projects.find(p => p.id === p1.id)!.sessions.find(s => s.id === s1.id)!;
    expect(found.cost).toEqual(sampleCost);
  });
});

describe('updateSessionContext()', () => {
  const sampleContext = { totalTokens: 5000, contextWindowSize: 200000, usedPercentage: 2.5 };

  it('persists context data on the session record', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    mockSave.mockClear();
    appState.updateSessionContext(session.id, sampleContext);
    const updated = appState.activeProject!.sessions.find(s => s.id === session.id)!;
    expect(updated.contextWindow).toEqual(sampleContext);
    expect(mockSave).toHaveBeenCalled();
  });

  it('no-op for nonexistent session', () => {
    addProject();
    mockSave.mockClear();
    appState.updateSessionContext('nonexistent', sampleContext);
    expect(mockSave).not.toHaveBeenCalled();
  });
});

describe('renameSession()', () => {
  it('updates session name and persists', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'Old')!;
    mockSave.mockClear();
    appState.renameSession(project.id, session.id, 'New');
    expect(appState.activeSession!.name).toBe('New');
    expect(mockSave).toHaveBeenCalled();
  });

  it('sets userRenamed when passed true', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'Old')!;
    appState.renameSession(project.id, session.id, 'Manual', true);
    expect(appState.activeSession!.userRenamed).toBe(true);
  });

  it('does not set userRenamed when param omitted', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'Old')!;
    appState.renameSession(project.id, session.id, 'Auto');
    expect(appState.activeSession!.userRenamed).toBeUndefined();
  });

  it('truncates name exceeding MAX_SESSION_NAME_LENGTH', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'Old')!;
    const longName = 'A'.repeat(MAX_SESSION_NAME_LENGTH + 40);
    appState.renameSession(project.id, session.id, longName);
    expect(appState.activeSession!.name).toBe('A'.repeat(MAX_SESSION_NAME_LENGTH));
  });
});


describe('conversation titles (tab rename)', () => {
  it('remembers a user rename for the conversation and notifies the sidebar', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-1');
    const cb = vi.fn();
    appState.on('conversation-titles-changed', cb);
    mockSave.mockClear();
    appState.renameSession(project.id, session.id, '行程整理', true);
    expect(appState.getConversationTitle('cli-1')).toBe('行程整理');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(mockSave.mock.calls.at(-1)![0].conversationTitles).toEqual({ 'cli-1': { title: '行程整理', at: expect.any(Number) } });
  });

  it('does not remember a CLI auto title', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-1');
    const cb = vi.fn();
    appState.on('conversation-titles-changed', cb);
    appState.renameSession(project.id, session.id, 'AI title');
    expect(appState.getConversationTitle('cli-1')).toBeUndefined();
    expect(cb).not.toHaveBeenCalled();
  });

  it('stores the truncated name', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-1');
    appState.renameSession(project.id, session.id, 'B'.repeat(MAX_SESSION_NAME_LENGTH + 5), true);
    expect(appState.getConversationTitle('cli-1')).toBe('B'.repeat(MAX_SESSION_NAME_LENGTH));
  });

  it('attaches a rename made before the CLI reported its id', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.renameSession(project.id, session.id, 'Early', true);
    const cb = vi.fn();
    appState.on('conversation-titles-changed', cb);
    appState.updateSessionCliId(project.id, session.id, 'cli-late');
    expect(appState.getConversationTitle('cli-late')).toBe('Early');
    expect(appState.activeSession!.name).toBe('Early');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('keeps the old conversation\'s name when the tab moves to a new conversation (/clear)', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-old');
    appState.renameSession(project.id, session.id, 'Named', true);
    appState.updateSessionCliId(project.id, session.id, 'cli-new');
    expect(appState.getConversationTitle('cli-old')).toBe('Named');
    expect(appState.getConversationTitle('cli-new')).toBeUndefined();
    expect(appState.activeSession!.name).not.toBe('Named');
    expect(appState.activeSession!.userRenamed).toBe(false);
  });

  it('names the tab when it switches to a conversation the user named earlier (/resume in the CLI)', () => {
    const project = addProject();
    const a = appState.addSession(project.id, 'A')!;
    appState.updateSessionCliId(project.id, a.id, 'cli-a');
    appState.renameSession(project.id, a.id, 'Named A', true);
    appState.removeSession(project.id, a.id);

    const b = appState.addSession(project.id, 'B')!;
    appState.updateSessionCliId(project.id, b.id, 'cli-b');
    appState.updateSessionCliId(project.id, b.id, 'cli-a');
    const tab = appState.activeProject!.sessions.find((s) => s.id === b.id)!;
    expect(tab.name).toBe('Named A');
    expect(tab.userRenamed).toBe(true);
  });

  it('survives closing the tab', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-1');
    appState.renameSession(project.id, session.id, 'Kept', true);
    appState.removeSession(project.id, session.id);
    expect(appState.getConversationTitle('cli-1')).toBe('Kept');
  });

  it('forgetConversationTitle removes it and notifies', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-1');
    appState.renameSession(project.id, session.id, 'Gone', true);
    const cb = vi.fn();
    appState.on('conversation-titles-changed', cb);
    appState.forgetConversationTitle('cli-1');
    appState.forgetConversationTitle('cli-1');
    expect(appState.getConversationTitle('cli-1')).toBeUndefined();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
