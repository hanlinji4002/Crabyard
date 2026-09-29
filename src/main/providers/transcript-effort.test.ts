import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { lastEffortInText, readLastTranscriptEffort } from './transcript-effort';

const assistant = (effort: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ parentUuid: 'p', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', input: { effort: 'low' } }] }, type: 'assistant', uuid: 'u', timestamp: '2026-09-26T16:22:46.000Z', effort, perTurnEffort: effort, ...extra });

describe('lastEffortInText', () => {
  it('returns the newest main-thread assistant effort', () => {
    const text = [assistant('xhigh'), JSON.stringify({ type: 'user', message: { content: 'hi' } }), assistant('max'), JSON.stringify({ type: 'permission-mode', permissionMode: 'bypassPermissions' })].join('\n');
    expect(lastEffortInText(text, false)).toBe('max');
  });

  it('skips sidechain, API-error, unknown and partial records', () => {
    const text = [assistant('medium'), assistant('high', { isSidechain: true }), assistant('max', { isApiErrorMessage: true }), assistant('auto'), assistant('xhigh').slice(0, 40)].join('\n');
    expect(lastEffortInText(text, false)).toBe('medium');
  });

  it('never reads the effort key of a tool input', () => {
    expect(lastEffortInText(assistant(undefined), false)).toBeUndefined();
  });

  it('drops a partial first line of a tail window', () => {
    expect(lastEffortInText(assistant('max'), true)).toBeUndefined();
  });
});

describe('readLastTranscriptEffort', () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  it('finds the last effort past a tail window', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'effort-'));
    const file = path.join(dir, 't.jsonl');
    const filler = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(300 * 1024) } });
    fs.writeFileSync(file, [assistant('max'), filler].join('\n') + '\n');
    expect(readLastTranscriptEffort(file)).toBe('max');
  });

  it('is undefined for a missing file', () => {
    expect(readLastTranscriptEffort('/no/such/file.jsonl')).toBeUndefined();
  });
});
