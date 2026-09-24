import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('./store', () => ({ loadState: () => ({ profiles: [] }) }));

import { _resetForTesting as resetHistory } from './claude-history';
import { _resetForTesting, editFromToolResult, getConversationChanges } from './conversation-changes';

const ID = '11111111-1111-4111-8111-111111111111';

function prompt(text: string, ts: string, extra: Record<string, unknown> = {}) {
  return { type: 'user', message: { role: 'user', content: text }, timestamp: ts, cwd: '/w', ...extra };
}

function result(toolUseResult: unknown, ts: string) {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
    toolUseResult,
    timestamp: ts,
    cwd: '/w',
  };
}

function edit(filePath: string, lines: string[]) {
  return { filePath, oldString: 'x', newString: 'y', originalFile: '', replaceAll: false, userModified: false, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines }] };
}

describe('editFromToolResult', () => {
  it('counts + and - lines of an Edit patch', () => {
    expect(editFromToolResult(edit('/w/a.ts', [' ctx', '-old', '+new', '+more']))).toMatchObject({ path: '/w/a.ts', added: 2, removed: 1, created: false });
  });

  it('counts a created file by its content', () => {
    const e = editFromToolResult({ type: 'create', filePath: '/w/b.ts', content: 'one\ntwo\nthree\n', structuredPatch: [], originalFile: null });
    expect(e).toMatchObject({ path: '/w/b.ts', added: 3, removed: 0, created: true });
    expect(e?.hunks[0].lines).toEqual(['+one', '+two', '+three']);
  });

  it('ignores results that are not edits', () => {
    expect(editFromToolResult({ type: 'text', file: { filePath: '/w/a.ts', content: 'x' } })).toBeNull();
    expect(editFromToolResult({ filenames: ['/w/a.ts'] })).toBeNull();
    expect(editFromToolResult('Error: file not found')).toBeNull();
    expect(editFromToolResult(null)).toBeNull();
  });
});

describe('getConversationChanges', () => {
  let tmp: string;
  let transcript: string;

  function append(entries: object[], file = transcript) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vy-changes-'));
    const root = path.join(tmp, 'projects');
    transcript = path.join(root, '-w', `${ID}.jsonl`);
    resetHistory(new Map([[root, undefined]]));
    _resetForTesting();
    append([
      prompt('first', '2026-09-24T10:00:00.000Z'),
      result(edit('/w/a.ts', ['-y', '+z', '+w']), '2026-09-24T10:00:05.000Z'),
      { type: 'user', isMeta: true, message: { role: 'user', content: 'caveat' }, timestamp: '2026-09-24T10:00:06.000Z' },
      prompt('second', '2026-09-24T11:00:00.000Z'),
      result({ type: 'create', filePath: '/w/b.ts', content: '1\n2\n3\n', structuredPatch: [], originalFile: null }, '2026-09-24T11:00:05.000Z'),
      result(edit('/w/a.ts', ['-z', '+q']), '2026-09-24T11:00:06.000Z'),
      result({ type: 'text', file: { filePath: '/w/c.ts', content: 'read only' } }, '2026-09-24T11:00:07.000Z'),
    ]);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    resetHistory();
    _resetForTesting();
  });

  it('splits the latest turn from the whole conversation', async () => {
    const changes = (await getConversationChanges(ID))!;
    expect(changes.turns).toBe(2);
    expect(changes.cwd).toBe('/w');
    expect(changes.lastTurn).toMatchObject({ index: 2, prompt: 'second' });
    expect(changes.lastTurn!.files.map((f) => [f.path, f.added, f.removed, f.created])).toEqual([
      ['/w/b.ts', 3, 0, true],
      ['/w/a.ts', 1, 1, false],
    ]);
    expect(changes.total.map((f) => [f.path, f.added, f.removed, f.edits])).toEqual([
      ['/w/a.ts', 3, 2, 2],
      ['/w/b.ts', 3, 0, 1],
    ]);
  });

  it('reads only what was appended, and a new prompt starts a new turn', async () => {
    await getConversationChanges(ID);
    append([
      prompt('third', '2026-09-24T12:00:00.000Z'),
      result(edit('/w/d.ts', ['+x']), '2026-09-24T12:00:05.000Z'),
    ]);
    const changes = (await getConversationChanges(ID))!;
    expect(changes.lastTurn).toMatchObject({ index: 3, prompt: 'third' });
    expect(changes.lastTurn!.files.map((f) => f.path)).toEqual(['/w/d.ts']);
    expect(changes.total.map((f) => f.path)).toEqual(['/w/a.ts', '/w/b.ts', '/w/d.ts']);
  });

  it('credits subagent edits to the turn they happened in', async () => {
    append([
      result(edit('/w/early.ts', ['+a']), '2026-09-24T10:30:00.000Z'),
      result(edit('/w/late.ts', ['+b', '+c']), '2026-09-24T11:30:00.000Z'),
    ], path.join(path.dirname(transcript), ID, 'subagents', 'agent-x.jsonl'));
    const changes = (await getConversationChanges(ID))!;
    expect(changes.lastTurn!.files.map((f) => f.path)).toEqual(['/w/b.ts', '/w/a.ts', '/w/late.ts']);
    expect(changes.total.map((f) => f.path)).toEqual(['/w/a.ts', '/w/b.ts', '/w/early.ts', '/w/late.ts']);
  });

  it('starts over when the transcript is replaced', async () => {
    await getConversationChanges(ID);
    fs.rmSync(transcript);
    append([prompt('fresh', '2026-09-24T13:00:00.000Z')]);
    const changes = (await getConversationChanges(ID))!;
    expect(changes.turns).toBe(1);
    expect(changes.total).toEqual([]);
  });

  it('returns null for a conversation without a transcript', async () => {
    expect(await getConversationChanges('22222222-2222-4222-8222-222222222222')).toBeNull();
    expect(await getConversationChanges('not-an-id')).toBeNull();
  });
});
