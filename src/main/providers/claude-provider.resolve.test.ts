import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Heavy main-process deps imported by claude-provider that these tests don't exercise.
vi.mock('../pty-manager', () => ({ getFullPath: () => '' }));
vi.mock('../hook-status', () => ({ installStatusLineScript: () => {}, cleanupAll: () => {} }));
vi.mock('../config-watcher', () => ({ startConfigWatcher: () => {}, stopConfigWatcher: () => {} }));
vi.mock('../claude-cli', () => ({ installHooksOnly: () => {}, installStatusLine: () => {}, getClaudeConfig: async () => ({}) }));
vi.mock('../settings-guard', () => ({ guardedInstall: async () => {}, validateSettings: () => ({}), reinstallSettings: () => {} }));
vi.mock('./resolve-binary', () => ({ resolveBinary: () => '', validateBinaryExists: () => true }));
vi.mock('../store', () => ({ loadState: vi.fn(() => ({ profiles: [] })) }));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { ClaudeProvider } from './claude-provider';
import { _resetForTesting as resetJobs } from '../claude-jobs';
import { isWin } from '../platform';

const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const F = 'f0f0f0f0-0000-4000-8000-0000000000f0';
const N = 'c0c0c0c0-0000-4000-8000-00000000000c';
const PROJECT = '/work/bob';

const procStart = (pid: number) => isWin ? '' : spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' }, encoding: 'utf8' }).stdout.trim();
const line = (o: object) => JSON.stringify(o);
const user = (sid: string, text = 'hi') => line({ parentUuid: null, type: 'user', message: { role: 'user', content: text }, sessionId: sid, cwd: PROJECT });
const reply = (sid: string) => line({ parentUuid: 'u', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }, sessionId: sid });
const handoff = (sid: string, to: string) => line({ type: 'continued-in', timestamp: '2026-09-26T15:35:06.367Z', sessionId: sid, continuedInSessionId: to });

describe('ClaudeProvider.resolveConversation', () => {
  const provider = new ClaudeProvider();
  let configDir: string;
  let folder: string;

  const transcript = (sid: string, lines: string[]) => fs.writeFileSync(path.join(folder, `${sid}.jsonl`), lines.join('\n') + '\n');
  const job = (short: string, state: Record<string, unknown>) => {
    fs.mkdirSync(path.join(configDir, 'jobs', short), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'jobs', short, 'state.json'), JSON.stringify({ state: 'working', cwd: PROJECT, ...state }));
  };
  /** A background session running now, in the CLI's session registry. */
  const running = (sessionId: string, jobId: string) => {
    fs.mkdirSync(path.join(configDir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId, kind: 'bg', jobId, procStart: procStart(process.pid) }));
  };
  const resolve = (sid: string, attachShort?: string) => provider.resolveConversation(sid, PROJECT, configDir, attachShort);

  beforeEach(() => {
    resetJobs();
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vy-resolve-'));
    folder = path.join(configDir, 'projects', '-work-bob');
    fs.mkdirSync(folder, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('resumes an ordinary conversation as it is', () => {
    transcript(A, [user(A), reply(A)]);
    expect(resolve(A)).toEqual({ cliSessionId: A, attachShort: null });
  });

  it('follows a conversation handed off to a background session that has content', () => {
    transcript(A, [user(A), reply(A), handoff(A, B), line({ type: 'cost-state', sessionId: A })]);
    transcript(B, [user(B), reply(B)]);
    expect(resolve(A)).toEqual({ cliSessionId: B, attachShort: null, reason: 'handoff' });
  });

  it('stays on the conversation when its hand-off target never got going', () => {
    transcript(A, [user(A), reply(A), handoff(A, B)]);
    transcript(B, [line({ type: 'ai-title', aiTitle: 'X', sessionId: B })]); // titles only
    expect(resolve(A)).toEqual({ cliSessionId: A, attachShort: null });
  });

  it('stays on the conversation when it went on in the foreground after the hand-off', () => {
    transcript(A, [user(A), reply(A), handoff(A, B), user(A, 'back here'), reply(A)]);
    transcript(B, [user(B), reply(B)]);
    expect(resolve(A)).toEqual({ cliSessionId: A, attachShort: null });
  });

  it.runIf(!isWin)('attaches to the background session a conversation was handed off to while it runs', () => {
    transcript(A, [user(A), reply(A), handoff(A, B)]);
    job('bbbbbbbb', { sessionId: B });
    running(B, 'bbbbbbbb');
    expect(resolve(A)).toEqual({ cliSessionId: B, attachShort: 'bbbbbbbb', reason: 'handoff' });
  });

  it.runIf(!isWin)('attaches to a conversation a live background session holds', () => {
    transcript(F, [user(F), reply(F)]);
    job('f0f0f0f0', { sessionId: F });
    running(F, 'f0f0f0f0');
    expect(resolve(F)).toEqual({ cliSessionId: F, attachShort: 'f0f0f0f0' });
  });

  it.runIf(!isWin)('re-attaches a tab to its job, on the conversation the job is on now', () => {
    job('f0f0f0f0', { sessionId: F, resumeSessionId: N });
    running(N, 'f0f0f0f0');
    expect(resolve(F, 'f0f0f0f0')).toEqual({ cliSessionId: N, attachShort: 'f0f0f0f0', reason: 'job' });
    // Still on its first conversation: just attached again, nothing moved.
    running(F, 'f0f0f0f0');
    job('f0f0f0f0', { sessionId: F });
    expect(resolve(F, 'f0f0f0f0')).toEqual({ cliSessionId: F, attachShort: 'f0f0f0f0' });
  });

  it('resumes the conversation a finished job was last on', () => {
    job('f0f0f0f0', { state: 'done', sessionId: F, resumeSessionId: N });
    transcript(N, [user(N), reply(N)]);
    expect(resolve(F, 'f0f0f0f0')).toEqual({ cliSessionId: N, attachShort: null, reason: 'job' });
  });
});
