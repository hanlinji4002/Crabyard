import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { isWin } from './platform';
import { _resetForTesting as resetJobs } from './claude-jobs';

const store = vi.hoisted(() => ({ state: { profiles: [] as unknown[], projects: [] as unknown[] } }));
vi.mock('./store', () => ({ loadState: () => store.state }));

import {
  _resetForTesting,
  applyTranscriptLine,
  cleanUserText,
  conversationBusy,
  readContinuedIn,
  transcriptHasMessages,
  conversationPathsForTrash,
  createDigest,
  forgetConversation,
  getClaudeUsage,
  listClaudeConversations,
} from './claude-history';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';

function user(text: unknown, extra: Record<string, unknown> = {}) {
  return { type: 'user', message: { role: 'user', content: text }, timestamp: '2026-09-20T10:00:00.000Z', ...extra };
}

function assistant(id: string, requestId: string, usage: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    type: 'assistant',
    requestId,
    message: { id, model: 'claude-opus-5', role: 'assistant', content: [], usage },
    timestamp: '2026-09-20T10:00:05.000Z',
    ...extra,
  };
}

describe('cleanUserText', () => {
  it('keeps a typed prompt on one line', () => {
    expect(cleanUserText('  fix the\n\nlogin   bug ')).toEqual({ kind: 'prompt', text: 'fix the login bug' });
  });

  it('turns slash commands into "/name args"', () => {
    const raw = '<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>src/auth</command-args>';
    expect(cleanUserText(raw)).toEqual({ kind: 'command', text: '/review src/auth' });
  });

  it('turns bash input into "!cmd"', () => {
    expect(cleanUserText('<bash-input>ls -la</bash-input>')).toEqual({ kind: 'command', text: '!ls -la' });
  });

  it('skips injected notifications, command output and interruptions', () => {
    expect(cleanUserText('<task-notification><task-id>x</task-id></task-notification>').kind).toBe('skip');
    expect(cleanUserText('<local-command-stdout>ok</local-command-stdout>').kind).toBe('skip');
    expect(cleanUserText('[Request interrupted by user]').kind).toBe('skip');
    expect(cleanUserText('   ').kind).toBe('skip');
  });

  it('strips system reminders and IDE context around the prompt', () => {
    const raw = '<ide_opened_file>a.ts</ide_opened_file>explain this<system-reminder>ignore</system-reminder>';
    expect(cleanUserText(raw)).toEqual({ kind: 'prompt', text: 'explain this' });
  });

  it('prefers typed text over pasted content, falling back to the paste', () => {
    expect(cleanUserText('<pasted_content id="1">log line</pasted_content> why?').text).toBe('why?');
    expect(cleanUserText('<pasted_content id="1">only the paste</pasted_content>').text).toBe('only the paste');
  });

  it('truncates long prompts', () => {
    const { text } = cleanUserText('x'.repeat(500));
    expect(text.length).toBe(160);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('applyTranscriptLine', () => {
  it('keeps the latest title of each kind', () => {
    const d = createDigest();
    applyTranscriptLine(d, JSON.stringify({ type: 'ai-title', aiTitle: 'first' }), 'k');
    applyTranscriptLine(d, JSON.stringify({ type: 'ai-title', aiTitle: 'second' }), 'k');
    applyTranscriptLine(d, JSON.stringify({ type: 'custom-title', customTitle: 'Mine' }), 'k');
    applyTranscriptLine(d, JSON.stringify({ type: 'agent-name', agentName: 'Agent' }), 'k');
    expect(d).toMatchObject({ aiTitle: 'second', customTitle: 'Mine', agentName: 'Agent' });
  });

  it('counts real turns only and records the first prompt and cwd', () => {
    const d = createDigest();
    applyTranscriptLine(d, JSON.stringify(user('hello', { cwd: '/work' })), 'k');
    applyTranscriptLine(d, JSON.stringify(user('meta', { isMeta: true })), 'k');
    applyTranscriptLine(d, JSON.stringify(user([{ type: 'tool_result', content: 'x' }])), 'k');
    applyTranscriptLine(d, JSON.stringify(user('side', { isSidechain: true })), 'k');
    applyTranscriptLine(d, JSON.stringify(user([{ type: 'text', text: 'second prompt' }])), 'k');
    applyTranscriptLine(d, '{"type":"user", truncated', 'k');
    expect(d.turns).toBe(2);
    expect(d.firstPrompt).toBe('hello');
    expect(d.cwd).toBe('/work');
  });

  it('extracts usage with the 1h cache-write split and ignores synthetic messages', () => {
    const d = createDigest();
    applyTranscriptLine(d, JSON.stringify(assistant('m1', 'r1', {
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 1000,
      cache_creation: { ephemeral_1h_input_tokens: 40, ephemeral_5m_input_tokens: 60 },
      speed: 'fast',
    })), 'k');
    const synthetic = assistant('m2', 'r2', { input_tokens: 0, output_tokens: 0 });
    synthetic.message.model = '<synthetic>';
    applyTranscriptLine(d, JSON.stringify(synthetic), 'k');
    expect(d.usage).toEqual([{
      key: 'm1:r1',
      ts: Date.parse('2026-09-20T10:00:05.000Z'),
      model: 'claude-opus-5',
      input: 10,
      output: 20,
      cacheWrite5m: 60,
      cacheWrite1h: 40,
      cacheRead: 1000,
      fast: true,
    }]);
    expect(d.lastModel).toBe('claude-opus-5');
  });
});

describe('listClaudeConversations / getClaudeUsage', () => {
  let tmp: string;
  let root: string;
  let workDir: string;

  function write(rel: string, entries: object[]): string {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    return file;
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vy-history-'));
    root = path.join(tmp, 'projects');
    workDir = path.join(tmp, 'work');
    fs.mkdirSync(workDir);
    _resetForTesting(new Map([[root, undefined]]));

    const partial = { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000 };
    const final = { ...partial, output_tokens: 50 };
    write(`slug/${UUID_A}.jsonl`, [
      { type: 'custom-title', customTitle: 'Titled chat' },
      user('first question', { cwd: workDir, timestamp: '2026-09-20T10:00:00.000Z' }),
      assistant('msg-1', 'req-1', partial, { cwd: workDir }),
      assistant('msg-1', 'req-1', final, { cwd: workDir }),
      user('follow up', { cwd: workDir, timestamp: '2026-09-20T11:00:00.000Z' }),
    ]);
    // Subagent transcript: usage only, never listed as a conversation.
    write(`slug/${UUID_A}/subagents/agent-x.jsonl`, [
      assistant('msg-sub', 'req-sub', { input_tokens: 1, output_tokens: 7 }, { cwd: workDir }),
    ]);
    // A resumed copy repeats msg-1 (must not double count) and adds one call.
    write(`slug/${UUID_B}.jsonl`, [
      user('resumed elsewhere', { cwd: '/gone/folder', timestamp: '2026-09-21T09:00:00.000Z' }),
      assistant('msg-1', 'req-1', final, { cwd: '/gone/folder' }),
      assistant('msg-2', 'req-2', { input_tokens: 2, output_tokens: 4 }, { cwd: '/gone/folder', timestamp: '2026-09-21T09:00:05.000Z' }),
    ]);
    // Aborted launch: no turns, no title, no usage.
    write(`slug/${UUID_C}.jsonl`, [{ type: 'mode', mode: 'default', sessionId: UUID_C }]);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    _resetForTesting();
  });

  it('lists top-level conversations newest first with titles and folder state', async () => {
    const { conversations } = await listClaudeConversations(true);
    expect(conversations.map((c) => c.cliSessionId)).toEqual([UUID_B, UUID_A]);
    const [b, a] = conversations;
    expect(a).toMatchObject({ title: 'Titled chat', titleSource: 'custom', firstPrompt: 'first question', turns: 2, projectCwd: workDir, cwdExists: true, projectSlug: 'slug' });
    expect(b).toMatchObject({ title: 'resumed elsewhere', titleSource: 'prompt', turns: 1, projectCwd: '/gone/folder', cwdExists: false });
    expect(a.updatedAt).toBe(Date.parse('2026-09-20T11:00:00.000Z'));
  });

  it('de-duplicates streamed chunks and copied history, keeping the final output count', async () => {
    const { rows, unpricedModels } = await getClaudeUsage(true);
    const requests = rows.reduce((n, r) => n + r.requests, 0);
    const output = rows.reduce((n, r) => n + r.outputTokens, 0);
    expect(requests).toBe(3);
    expect(output).toBe(50 + 7 + 4);
    expect(unpricedModels).toEqual([]);
    expect(rows.every((r) => r.model === 'claude-opus-5')).toBe(true);
    const cost = rows.reduce((n, r) => n + r.costUsd, 0);
    // claude-opus-5: $5 in / $25 out / $0.50 cache read per MTok.
    const expected = ((5 + 1 + 2) * 5 + (50 + 7 + 4) * 25 + 1000 * 0.5) / 1e6;
    expect(cost).toBeCloseTo(expected, 10);
  });

  it('names a conversation and its sidecar folder for the Trash, and nothing else', () => {
    const a = path.join(root, 'slug', `${UUID_A}.jsonl`);
    const b = path.join(root, 'slug', `${UUID_B}.jsonl`);
    expect(conversationPathsForTrash(a)).toEqual([a, path.join(root, 'slug', UUID_A)]);
    expect(conversationPathsForTrash(b)).toEqual([b]);

    // Outside a projects root, nested, non-id, missing or non-string: refused.
    const stray = path.join(tmp, 'slug', `${UUID_A}.jsonl`);
    fs.mkdirSync(path.dirname(stray), { recursive: true });
    fs.writeFileSync(stray, '{}\n');
    expect(conversationPathsForTrash(stray)).toBeNull();
    expect(conversationPathsForTrash(path.join(root, 'slug', UUID_A, 'subagents', 'agent-x.jsonl'))).toBeNull();
    fs.writeFileSync(path.join(root, 'slug', 'notes.jsonl'), '{}\n');
    expect(conversationPathsForTrash(path.join(root, 'slug', 'notes.jsonl'))).toBeNull();
    expect(conversationPathsForTrash(path.join(root, 'slug', '44444444-4444-4444-8444-444444444444.jsonl'))).toBeNull();
    expect(conversationPathsForTrash(42)).toBeNull();
  });

  it('forgets a trashed conversation and its subagent usage', async () => {
    await listClaudeConversations(true);
    const a = path.join(root, 'slug', `${UUID_A}.jsonl`);
    // What the Trash does to the files, then what the IPC handler does to the cache.
    fs.rmSync(a);
    fs.rmSync(path.join(root, 'slug', UUID_A), { recursive: true });
    forgetConversation(a);

    const { conversations } = await listClaudeConversations();
    expect(conversations.map((c) => c.cliSessionId)).toEqual([UUID_B]);
    const { rows } = await getClaudeUsage();
    // B still carries its copy of msg-1 (50) plus msg-2 (4); A's subagent (7) is gone.
    expect(rows.reduce((n, r) => n + r.outputTokens, 0)).toBe(50 + 4);
  });

  it('hides title-only stubs and files a transcript without a cwd under its folder', async () => {
    const UUID_D = '44444444-4444-4444-8444-444444444444';
    const UUID_E = '55555555-5555-4555-8555-555555555555';
    const UUID_F = '66666666-6666-4666-8666-666666666666';
    // What Claude Code leaves behind when it backgrounds a conversation: titles only.
    write(`slug/${UUID_D}.jsonl`, [
      { type: 'ai-title', aiTitle: 'Handed off', sessionId: UUID_D },
      { type: 'agent-name', agentName: 'Handed off', sessionId: UUID_D },
    ]);
    write(`other/${UUID_E}.jsonl`, [user('no cwd on this line', { timestamp: '2026-09-19T10:00:00.000Z' })]);
    write(`other/${UUID_F}.jsonl`, [user('here', { cwd: workDir, timestamp: '2026-09-18T10:00:00.000Z' })]);
    const { conversations } = await listClaudeConversations(true);
    expect(conversations.map((c) => c.cliSessionId)).not.toContain(UUID_D);
    expect(conversations.find((c) => c.cliSessionId === UUID_E)).toMatchObject({ projectCwd: workDir, cwdExists: true });
  });

  describe('background sessions', () => {
    const FORK = '77777777-7777-4777-8777-777777777777';
    const WAITING = '88888888-8888-4888-8888-888888888888';
    const procStart = (pid: number) => isWin ? '' : spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' }, encoding: 'utf8' }).stdout.trim();

    function job(short: string, state: Record<string, unknown>): void {
      fs.mkdirSync(path.join(tmp, 'jobs', short), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'jobs', short, 'state.json'), JSON.stringify(state));
    }

    beforeEach(() => {
      resetJobs();
      // A /fork of A that ran and finished...
      job('77777777', { state: 'done', sessionId: FORK, name: 'Titled chat ⑂', cwd: workDir, forkParentSessionId: UUID_A, createdAt: '2026-09-22T09:00:00.000Z', updatedAt: '2026-09-22T09:30:00.000Z' });
      write(`slug/${FORK}.jsonl`, [
        { type: 'ai-title', aiTitle: 'Titled chat ⑂', sessionId: FORK },
        user('go on', { cwd: workDir, timestamp: '2026-09-22T09:10:00.000Z' }),
      ]);
      // ...and one still waiting for its first prompt, with nothing written yet.
      job('88888888', { state: 'working', sessionId: WAITING, name: 'Titled chat ⑂ ⑂', cwd: workDir, forkParentSessionId: FORK, createdAt: '2026-09-22T10:00:00.000Z', updatedAt: '2026-09-22T10:00:01.000Z' });
      fs.mkdirSync(path.join(tmp, 'daemon'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'daemon', 'roster.json'), JSON.stringify({
        proto: 1,
        supervisorPid: process.pid,
        workers: { 88888888: { pid: process.pid, procStart: procStart(process.pid), sessionId: WAITING } },
      }));
    });

    it('marks forks with their parent and lists a live one before it has a transcript', async () => {
      const { conversations } = await listClaudeConversations(true);
      expect(conversations.map((c) => c.cliSessionId)).toEqual([WAITING, FORK, UUID_B, UUID_A]);
      expect(conversations[0]).toMatchObject({
        transcriptPath: '',
        title: 'Titled chat ⑂ ⑂',
        projectCwd: workDir,
        forkOf: FORK,
        background: { short: '88888888', live: true, state: 'working' },
      });
      expect(conversations[1]).toMatchObject({ title: 'Titled chat ⑂', forkOf: UUID_A, background: { short: '77777777', live: false, state: 'done' } });
      expect(conversations[2].background).toBeUndefined();
    });

    it('keeps a live background session whose transcript is still a stub', async () => {
      write(`slug/${WAITING}.jsonl`, [{ type: 'ai-title', aiTitle: 'Titled chat ⑂ ⑂', sessionId: WAITING }]);
      const { conversations } = await listClaudeConversations(true);
      const waiting = conversations.find((c) => c.cliSessionId === WAITING)!;
      expect(waiting).toMatchObject({ transcriptPath: path.join(root, 'slug', `${WAITING}.jsonl`), projectCwd: workDir, background: { live: true } });
      expect(conversations.filter((c) => c.cliSessionId === WAITING)).toHaveLength(1);
    });

    it('lists no row for a shell command run as a background job', async () => {
      const EXEC = '99999999-9999-4999-8999-999999999999';
      job('99999999', { state: 'working', template: 'exec', sessionId: EXEC, cwd: workDir, updatedAt: '2026-09-22T11:00:00.000Z' });
      const roster = JSON.parse(fs.readFileSync(path.join(tmp, 'daemon', 'roster.json'), 'utf8'));
      roster.workers['99999999'] = { pid: process.pid, procStart: procStart(process.pid), sessionId: EXEC };
      fs.writeFileSync(path.join(tmp, 'daemon', 'roster.json'), JSON.stringify(roster));
      const { conversations } = await listClaudeConversations(true);
      expect(conversations.map((c) => c.cliSessionId)).not.toContain(EXEC);
    });

    it('refuses to trash a live background session, an open one or one written a moment ago', () => {
      const a = path.join(root, 'slug', `${UUID_A}.jsonl`);
      const waiting = write(`slug/${WAITING}.jsonl`, [user('x', { cwd: workDir })]);
      const old = new Date(Date.now() - 5 * 60_000);
      fs.utimesSync(a, old, old);
      fs.utimesSync(waiting, old, old);
      expect(conversationBusy(a)).toBeNull();
      expect(conversationBusy(waiting)).toBe('background');
      store.state = { profiles: [], projects: [{ sessions: [{ cliSessionId: UUID_A }] }] };
      try {
        expect(conversationBusy(a)).toBe('open');
      } finally {
        store.state = { profiles: [], projects: [] };
      }
      fs.appendFileSync(a, '\n');
      expect(conversationBusy(a)).toBe('recent');
    });
  });

  describe('hand-offs to a background session', () => {
    const HANDED = '12121212-1212-4212-8212-121212121212';
    const CONT = '34343434-3434-4343-8343-343434343434';
    const handoff = { type: 'continued-in', timestamp: '2026-09-22T12:00:00.000Z', sessionId: HANDED, continuedInSessionId: CONT };
    const finished = (extra: Record<string, unknown> = {}) => assistant('msg-f', 'req-f', { input_tokens: 1, output_tokens: 1 }, { cwd: workDir, parentUuid: 'p', message: { id: 'msg-f', model: 'claude-opus-5', role: 'assistant', content: [], stop_reason: 'end_turn', usage: { output_tokens: 1 } }, ...extra });

    it('leaves out a conversation that goes on in a background session with content', async () => {
      write(`slug/${HANDED}.jsonl`, [user('start', { cwd: workDir, parentUuid: null }), handoff]);
      write(`slug/${CONT}.jsonl`, [user('start', { cwd: workDir, parentUuid: null })]);
      const { conversations } = await listClaudeConversations(true);
      expect(conversations.map((c) => c.cliSessionId)).toContain(CONT);
      expect(conversations.map((c) => c.cliSessionId)).not.toContain(HANDED);
      expect(readContinuedIn(path.join(root, 'slug', `${HANDED}.jsonl`))).toBe(CONT);
    });

    it('keeps it when the target never got going or it went on here afterwards', async () => {
      write(`slug/${HANDED}.jsonl`, [user('start', { cwd: workDir, parentUuid: null }), handoff]);
      write(`slug/${CONT}.jsonl`, [{ type: 'ai-title', aiTitle: 'X', sessionId: CONT }]); // titles only
      let { conversations } = await listClaudeConversations(true);
      expect(conversations.map((c) => c.cliSessionId)).toContain(HANDED);

      write(`slug/${CONT}.jsonl`, [user('start', { cwd: workDir, parentUuid: null })]);
      write(`slug/${HANDED}.jsonl`, [user('start', { cwd: workDir, parentUuid: null }), handoff, finished()]);
      ({ conversations } = await listClaudeConversations(true));
      expect(conversations.map((c) => c.cliSessionId)).toContain(HANDED);
      expect(readContinuedIn(path.join(root, 'slug', `${HANDED}.jsonl`))).toBeUndefined();
    });

    it('does not count an unfinished reply, an API error or a meta line as going on', () => {
      const file = write(`slug/${HANDED}.jsonl`, [
        user('start', { cwd: workDir }),
        handoff,
        finished({ isApiErrorMessage: true }),
        user('<local-command-stdout>ok</local-command-stdout>', { cwd: workDir }),
        user('reminder', { cwd: workDir, isMeta: true }),
        { type: 'cost-state', sessionId: HANDED },
      ]);
      expect(readContinuedIn(file)).toBe(CONT);
    });

    it('says which conversations a listed one carries on, and its CLI custom title', async () => {
      write(`slug/${HANDED}.jsonl`, [user('start', { cwd: workDir, parentUuid: null }), handoff]);
      write(`slug/${CONT}.jsonl`, [{ type: 'custom-title', customTitle: 'Renamed in CLI', sessionId: CONT }, user('start', { cwd: workDir, parentUuid: null })]);
      const { conversations } = await listClaudeConversations(true);
      expect(conversations.find((c) => c.cliSessionId === CONT)).toMatchObject({ continuedFrom: [HANDED], customTitle: 'Renamed in CLI' });
      expect(conversations.find((c) => c.cliSessionId === UUID_A)!.continuedFrom).toBeUndefined();
    });

    it('tells a transcript with messages from one with titles only', () => {
      expect(transcriptHasMessages(write(`slug/${CONT}.jsonl`, [{ type: 'ai-title', aiTitle: 'X' }]))).toBe(false);
      expect(transcriptHasMessages(write(`slug/${CONT}.jsonl`, [{ type: 'ai-title', aiTitle: 'X' }, user('hi', { parentUuid: null })]))).toBe(true);
      expect(transcriptHasMessages(path.join(root, 'slug', 'missing.jsonl'))).toBe(false);
    });
  });

  it('re-reads a transcript only after it changes', async () => {
    await listClaudeConversations(true);
    const file = path.join(root, 'slug', `${UUID_A}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(user('third', { cwd: workDir, timestamp: '2026-09-22T08:00:00.000Z' })) + '\n');
    const { conversations } = await listClaudeConversations(true);
    const a = conversations.find((c) => c.cliSessionId === UUID_A)!;
    expect(a.turns).toBe(3);
    expect(conversations[0].cliSessionId).toBe(UUID_A);
  });
});
