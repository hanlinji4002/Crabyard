// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeConversation } from '../../shared/types';

const { titles, project } = vi.hoisted(() => ({
  titles: {} as Record<string, string>,
  project: {
    id: 'p1',
    name: 'Bob',
    path: '/work/bob',
    sessions: [],
    activeSessionId: null,
    layout: { mode: 'tabs', splitPanes: [], splitDirection: 'horizontal' },
  },
}));

vi.mock('../state.js', () => ({
  appState: {
    projects: [project],
    activeProjectId: 'p1',
    getConversationTitle: (id: string | null | undefined) => (id ? titles[id] : undefined),
    conversationTitleFor: (c: { cliSessionId: string; continuedFrom?: string[] }) =>
      titles[c.cliSessionId] ?? (c.continuedFrom ?? []).map((id) => titles[id]).find(Boolean),
    setActiveProject: vi.fn(),
    setActiveSession: vi.fn(),
    getTeamMembers: () => [],
    openCliSession: vi.fn(),
    addProject: vi.fn(),
  },
}));
vi.mock('../claude-history-store.js', () => ({
  conversationsFailed: () => false,
  getConversations: vi.fn(),
  isConversationsLoading: () => false,
  refreshConversations: vi.fn(),
}));
vi.mock('../open-file-reader.js', () => ({ openConversationView: vi.fn(), openFileReaderChecked: vi.fn() }));
vi.mock('./hover-card.js', () => ({ attachHoverCard: vi.fn() }));
vi.mock('./context-menu.js', () => ({ showContextMenu: vi.fn() }));
vi.mock('./modal.js', () => ({ showConfirmDialog: vi.fn() }));
vi.mock('../session-activity.js', () => ({ getStatus: () => 'idle' }));
vi.mock('../session-unread.js', () => ({ hasUnreadInProject: () => false }));
vi.mock('../project-status.js', () => ({ getProjectStatus: () => 'idle', projectInitial: (n: string) => n[0] }));

import { renderConversationTree, setConversationFilter, conversationTitle, refreshConversationTitles } from './conversation-tree.js';
import { showConfirmDialog } from './modal.js';
import { getConversations } from '../claude-history-store.js';
import { appState } from '../state.js';

function conv(cliSessionId: string, title: string): ClaudeConversation {
  return {
    cliSessionId,
    transcriptPath: `/home/.claude/projects/-work-bob/${cliSessionId}.jsonl`,
    projectCwd: '/work/bob',
    projectSlug: '-work-bob',
    cwdExists: true,
    title,
    titleSource: 'ai',
    firstPrompt: 'first prompt',
    turns: 3,
    startedAt: 1,
    updatedAt: 2,
  };
}

function rowTitles(): string[] {
  const container = document.createElement('div');
  renderConversationTree(container, { buildActiveExtras: () => [], showProjectContextMenu: () => {} }, () => {});
  return [...container.querySelectorAll('.conv-title')].map((el) => el.textContent ?? '');
}

beforeEach(() => {
  for (const key of Object.keys(titles)) delete titles[key];
  setConversationFilter('');
  vi.mocked(getConversations).mockReturnValue([conv('cli-fork', '周末旅行计划 ⑂'), conv('cli-other', 'Other chat')]);
});

describe('conversation tree titles', () => {
  it('shows the transcript title when the user never renamed the conversation', () => {
    expect(rowTitles()).toEqual(['周末旅行计划 ⑂', 'Other chat']);
  });

  it('shows the name given in Crabyard over the transcript title', () => {
    titles['cli-fork'] = '行程整理';
    expect(rowTitles()).toEqual(['行程整理', 'Other chat']);
    expect(conversationTitle(conv('cli-fork', 'x'))).toBe('行程整理');
  });

  it('search finds a renamed conversation by either name', () => {
    titles['cli-fork'] = '行程整理';
    setConversationFilter('行程');
    expect(rowTitles()).toEqual(['行程整理']);
    setConversationFilter('旅行');
    expect(rowTitles()).toEqual(['行程整理']);
  });

  it('reopening a row passes the custom name', () => {
    titles['cli-fork'] = '行程整理';
    const container = document.createElement('div');
    renderConversationTree(container, { buildActiveExtras: () => [], showProjectContextMenu: () => {} }, () => {});
    (container.querySelector('.conv-item') as HTMLElement).click();
    expect(appState.openCliSession).toHaveBeenCalledWith('p1', 'cli-fork', '行程整理', 'claude', undefined);
  });
});

describe('conversation tree background sessions', () => {
  function render(): HTMLElement {
    const container = document.createElement('div');
    renderConversationTree(container, { buildActiveExtras: () => [], showProjectContextMenu: () => {} }, () => {});
    return container;
  }

  it('marks a /fork with its parent, and one running in the background as such', () => {
    const parent = conv('cli-parent', '周末旅行计划');
    const done = { ...conv('cli-done', '周末旅行计划 ⑂'), forkOf: 'cli-parent', background: { short: 'aaaa1111', live: false, state: 'done' } };
    const live = { ...conv('cli-live', '周末旅行计划 ⑂ ⑂'), transcriptPath: '', forkOf: 'cli-done', background: { short: 'bbbb2222', live: true, state: 'working' } };
    vi.mocked(getConversations).mockReturnValue([live, done, parent]);
    const rows = [...render().querySelectorAll<HTMLElement>('.conv-item')];

    const [liveRow, doneRow, parentRow] = rows;
    expect(liveRow.classList.contains('background')).toBe(true);
    expect(liveRow.querySelector('.conv-meta')!.textContent).toContain('Running in the background');
    expect(liveRow.querySelector('.conv-meta')!.textContent).toContain('⑂ forked from “周末旅行计划 ⑂”');
    // Still running: no delete, no typeset view before there is a transcript, and it opens with `claude attach`.
    expect(liveRow.querySelector('.conv-delete')).toBeNull();
    expect(liveRow.querySelector('.conv-typeset')).toBeNull();
    expect(liveRow.title).toContain('claude attach bbbb2222');

    expect(doneRow.classList.contains('background')).toBe(false);
    expect(doneRow.querySelector('.conv-delete')).not.toBeNull();
    expect(doneRow.querySelector('.conv-typeset')).not.toBeNull();
    expect(doneRow.title).toContain('claude -r cli-done');
    expect(doneRow.querySelector('.conv-meta')!.textContent).toContain('⑂ forked from “周末旅行计划”');
    expect(doneRow.querySelector('.conv-meta')!.textContent).not.toContain('Running in the background');
    expect(parentRow.querySelector('.conv-meta')!.textContent).not.toContain('forked from');
  });
});

describe('conversation tree after a hand-off', () => {
  it('counts a tab still on the handed-off conversation as open on the one carrying it on', () => {
    (project.sessions as unknown[]).push({ id: 'tab-1', name: '行程整理', cliSessionId: 'cli-old', createdAt: '0' });
    vi.mocked(appState.openCliSession).mockClear();
    try {
      titles['cli-old'] = '行程整理';
      vi.mocked(getConversations).mockReturnValue([{ ...conv('cli-new', '周末旅行计划'), continuedFrom: ['cli-old'] }]);
      const container = document.createElement('div');
      renderConversationTree(container, { buildActiveExtras: () => [], showProjectContextMenu: () => {} }, () => {});
      const row = container.querySelector<HTMLElement>('.conv-item')!;
      expect(row.querySelector('.conv-title')!.textContent).toBe('行程整理');
      expect(row.classList.contains('open')).toBe(true);
      row.click();
      // Focuses that tab rather than attaching a second one.
      expect(appState.setActiveSession).toHaveBeenCalledWith('p1', 'tab-1');
      expect(appState.openCliSession).not.toHaveBeenCalled();
    } finally {
      (project.sessions as unknown[]).length = 0;
    }
  });

  it('updates names in place, keeping the rows a pending click is on', () => {
    const container = document.createElement('div');
    renderConversationTree(container, { buildActiveExtras: () => [], showProjectContextMenu: () => {} }, () => {});
    const row = container.querySelector<HTMLElement>('.conv-item[data-cli-session-id="cli-fork"]')!;
    titles['cli-fork'] = '改名一';
    refreshConversationTitles(container);
    expect(container.querySelector('.conv-item[data-cli-session-id="cli-fork"]')).toBe(row);
    expect(row.querySelector('.conv-title')!.textContent).toBe('改名一');
  });
});

describe('stopping a background session', () => {
  it('asks first, then runs claude stop for that job', async () => {
    const stopBackground = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('vibeyard', { claudeHistory: { stopBackground } });
    (window as unknown as { vibeyard: unknown }).vibeyard = { claudeHistory: { stopBackground } };
    vi.mocked(showConfirmDialog).mockClear();
    const live = { ...conv('cli-live', '周末旅行计划 ⑂'), transcriptPath: '', background: { short: 'bbbb2222', live: true, state: 'working' } };
    vi.mocked(getConversations).mockReturnValue([live, conv('cli-other', 'Other chat')]);
    const container = document.createElement('div');
    renderConversationTree(container, { buildActiveExtras: () => [], showProjectContextMenu: () => {} }, () => {});
    const rows = [...container.querySelectorAll<HTMLElement>('.conv-item')];
    expect(rows[1].querySelector('.conv-stop')).toBeNull(); // only live background rows
    rows[0].querySelector<HTMLButtonElement>('.conv-stop')!.click();

    expect(showConfirmDialog).toHaveBeenCalledTimes(1);
    expect(stopBackground).not.toHaveBeenCalled();
    const [, message, opts] = vi.mocked(showConfirmDialog).mock.calls[0];
    expect(message).toContain('周末旅行计划 ⑂');
    (opts as { onConfirm: () => void }).onConfirm();
    expect(stopBackground).toHaveBeenCalledWith('bbbb2222', undefined);
  });
});

