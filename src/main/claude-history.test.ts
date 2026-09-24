import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('./store', () => ({ loadState: () => ({ profiles: [] }) }));

import {
  _resetForTesting,
  applyTranscriptLine,
  cleanUserText,
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
