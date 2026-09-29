import { describe, it, expect } from 'vitest';
import {
  TITLE_RETENTION_MS,
  getConversationTitle,
  hydrateConversationTitles,
  reconcileConversationTitles,
  removeConversationTitle,
  setConversationTitle,
  titleFor,
} from './conversation-titles.js';
import type { ClaudeConversation, PersistedState, SessionRecord } from '../../shared/types.js';

function stateWith(sessions: Partial<SessionRecord>[] = [], titles?: unknown): PersistedState {
  return {
    version: 1,
    activeProjectId: 'p1',
    preferences: {} as PersistedState['preferences'],
    projects: [{
      id: 'p1',
      name: 'P',
      path: '/p',
      activeSessionId: null,
      layout: { mode: 'tabs', splitPanes: [], splitDirection: 'horizontal' },
      sessions: sessions.map((s, i) => ({ id: `s${i}`, name: `Session ${i + 1}`, cliSessionId: null, createdAt: '0', ...s })),
    }],
    ...(titles !== undefined ? { conversationTitles: titles as PersistedState['conversationTitles'] } : {}),
  };
}

function conv(cliSessionId: string, extra: Partial<ClaudeConversation> = {}): ClaudeConversation {
  return {
    cliSessionId, transcriptPath: `/t/${cliSessionId}.jsonl`, projectCwd: '/p', projectSlug: '-p', cwdExists: true,
    title: 'Transcript title', titleSource: 'ai', firstPrompt: '', turns: 1, startedAt: 1, updatedAt: 2, ...extra,
  };
}

describe('conversation titles', () => {
  it('sets, reads and removes a title', () => {
    const state = stateWith();
    expect(getConversationTitle(state, 'cli-1')).toBeUndefined();
    expect(setConversationTitle(state, 'cli-1', '行程整理', { at: 5 })).toBe(true);
    expect(getConversationTitle(state, 'cli-1')).toBe('行程整理');
    expect(state.conversationTitles!['cli-1']).toEqual({ title: '行程整理', at: 5 });
    expect(setConversationTitle(state, 'cli-1', '行程整理')).toBe(false);
    expect(removeConversationTitle(state, 'cli-1')).toBe(true);
    expect(removeConversationTitle(state, 'cli-1')).toBe(false);
    expect(getConversationTitle(state, 'cli-1')).toBeUndefined();
  });

  it('has no title for a missing id', () => {
    const state = stateWith([], { 'cli-1': { title: 'x', at: 1 } });
    expect(getConversationTitle(state, null)).toBeUndefined();
    expect(getConversationTitle(state, undefined)).toBeUndefined();
  });

  it('hydrate adopts open tabs the user renamed before the map existed', () => {
    const state = stateWith([
      { name: '行程整理', userRenamed: true, cliSessionId: 'cli-renamed' },
      { name: '周末旅行计划', cliSessionId: 'cli-auto' },
      { name: 'Early name', userRenamed: true, cliSessionId: null },
    ]);
    hydrateConversationTitles(state, 100);
    expect(state.conversationTitles).toEqual({ 'cli-renamed': { title: '行程整理', at: 100 } });
  });

  it('hydrate keeps an existing entry over a tab name, and upgrades plain strings', () => {
    const state = stateWith([{ name: 'Tab', userRenamed: true, cliSessionId: 'cli-1' }], { 'cli-1': 'Stored', 'cli-2': { title: 'Kept', at: 7, base: null } });
    hydrateConversationTitles(state, 100);
    expect(state.conversationTitles).toEqual({ 'cli-1': { title: 'Stored', at: 100 }, 'cli-2': { title: 'Kept', at: 7, base: null } });
  });

  it('hydrate drops malformed entries and non-object maps', () => {
    const state = stateWith([], { ok: 'Name', blank: '  ', num: 3, nil: null, noTitle: { at: 1 }, emptyTitle: { title: ' ', at: 1 } });
    hydrateConversationTitles(state, 100);
    expect(state.conversationTitles).toEqual({ ok: { title: 'Name', at: 100 } });

    const broken = stateWith([], ['not', 'a', 'map']);
    hydrateConversationTitles(broken);
    expect(broken.conversationTitles).toEqual({});
  });

  it('hydrate leaves an old state without the field untouched when nothing is renamed', () => {
    const state = stateWith([{ name: 'Session 1', cliSessionId: 'cli-1' }]);
    hydrateConversationTitles(state);
    expect(state.conversationTitles).toBeUndefined();
  });
});

describe('titleFor', () => {
  it('shows the user name, or the one given to the conversation it carries on', () => {
    const state = stateWith([], { a: { title: 'Mine', at: 1 } });
    expect(titleFor(state, conv('a'))).toBe('Mine');
    expect(titleFor(state, conv('b', { continuedFrom: ['a'] }))).toBe('Mine');
    expect(titleFor(state, conv('c'))).toBeUndefined();
  });

  it('gives way to a /rename typed in the CLI after it', () => {
    const state = stateWith([], { a: { title: 'Mine', at: 1, base: null } });
    expect(titleFor(state, conv('a'))).toBe('Mine');
    expect(titleFor(state, conv('a', { customTitle: 'From CLI' }))).toBeUndefined();
    // Named in Crabyard after the CLI rename: that one counts.
    const later = stateWith([], { a: { title: 'Mine', at: 1, base: 'From CLI' } });
    expect(titleFor(later, conv('a', { customTitle: 'From CLI' }))).toBe('Mine');
  });
});

describe('reconcileConversationTitles', () => {
  it('carries a name across a hand-off, and a later rename of the old id too', () => {
    const state = stateWith([], { a: { title: '行程整理', at: 10 } });
    let r = reconcileConversationTitles(state, [conv('b', { continuedFrom: ['a'] })], new Set(), 20);
    expect(r.changed).toBe(true);
    expect(state.conversationTitles!.b).toEqual({ title: '行程整理', at: 10, base: null });
    // The tab still holds A; renaming it writes A, and B follows.
    setConversationTitle(state, 'a', '行程二', { at: 30 });
    r = reconcileConversationTitles(state, [conv('b', { continuedFrom: ['a'] })], new Set(), 40);
    expect(getConversationTitle(state, 'b')).toBe('行程二');
  });

  it('notes the transcript title once, then lets a later CLI /rename win', () => {
    const state = stateWith([], { a: { title: 'Mine', at: 10 } });
    reconcileConversationTitles(state, [conv('a')], new Set(), 20);
    expect(state.conversationTitles!.a.base).toBeNull();
    const r = reconcileConversationTitles(state, [conv('a', { customTitle: 'From CLI' })], new Set(), 30);
    expect(r.renamedInCli).toEqual([{ cliSessionId: 'a', title: 'From CLI' }]);
    expect(getConversationTitle(state, 'a')).toBeUndefined();
  });

  it('drops names of conversations gone for a while, but not open or listed ones', () => {
    const old = 1;
    const state = stateWith([], {
      gone: { title: 'x', at: old },
      open: { title: 'y', at: old },
      listed: { title: 'z', at: old },
      recent: { title: 'w', at: TITLE_RETENTION_MS },
    });
    reconcileConversationTitles(state, [conv('listed')], new Set(['open']), TITLE_RETENTION_MS + 10);
    expect(Object.keys(state.conversationTitles!).sort()).toEqual(['listed', 'open', 'recent']);
  });
});
