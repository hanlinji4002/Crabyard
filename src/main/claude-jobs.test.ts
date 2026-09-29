import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { _resetForTesting, listBackgroundJobs, liveBackgroundJob } from './claude-jobs';
import { isWin } from './platform';

const FORK = 'b54b5bdc-1111-4111-8111-111111111111';
const PARENT = '71fd993e-2222-4222-8222-222222222222';
const DONE = '8e593858-3333-4333-8333-333333333333';
/** No process has this pid, so kill(pid, 0) fails with ESRCH. */
const DEAD_PID = 2 ** 22 + 12345;

/** This test process's start time as the daemon's roster records it (`ps -o lstart`, UTC). */
function procStart(pid: number): string {
  if (isWin) return '';
  return spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' }, encoding: 'utf8' }).stdout.trim();
}

describe('claude-jobs', () => {
  let configDir: string;

  function job(short: string, state: Record<string, unknown>): void {
    fs.mkdirSync(path.join(configDir, 'jobs', short), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'jobs', short, 'state.json'), JSON.stringify(state));
  }

  function roster(supervisorPid: number, workers: Record<string, Record<string, unknown>>): void {
    fs.mkdirSync(path.join(configDir, 'daemon'), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'daemon', 'roster.json'), JSON.stringify({ proto: 1, supervisorPid, updatedAt: 1, workers }));
  }

  beforeEach(() => {
    _resetForTesting();
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vy-jobs-'));
    job('b54b5bdc', { state: 'working', sessionId: FORK, name: 'Chat ⑂', cwd: '/work/bob', forkParentSessionId: PARENT, createdAt: '2026-09-26T15:35:01.356Z', updatedAt: '2026-09-26T16:11:57.298Z' });
    job('8e593858', { state: 'done', sessionId: DONE, name: 'Chat', cwd: '/work/bob', createdAt: '2026-09-26T15:35:06.000Z', updatedAt: '2026-09-26T15:36:00.000Z' });
    fs.writeFileSync(path.join(configDir, 'jobs', 'pins.json'), '{}');
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('lists every job, newest first, live only when a daemon worker runs it', () => {
    roster(process.pid, { b54b5bdc: { pid: process.pid, procStart: procStart(process.pid), sessionId: FORK } });
    const jobs = listBackgroundJobs(configDir);
    expect(jobs.map((j) => j.short)).toEqual(['b54b5bdc', '8e593858']);
    expect(jobs[0]).toMatchObject({ sessionId: FORK, name: 'Chat ⑂', cwd: '/work/bob', state: 'working', forkParentSessionId: PARENT, live: true });
    expect(jobs[0].updatedAt).toBe(Date.parse('2026-09-26T16:11:57.298Z'));
    expect(jobs[1]).toMatchObject({ sessionId: DONE, live: false });
    expect(jobs[1].forkParentSessionId).toBeUndefined();
    expect(liveBackgroundJob(FORK, configDir)).toBe('b54b5bdc');
    expect(liveBackgroundJob(DONE, configDir)).toBeNull();
  });

  it('stays live while its worker runs on after the daemon died (the CLI still refuses -r then)', () => {
    roster(DEAD_PID, { b54b5bdc: { pid: process.pid, procStart: procStart(process.pid), sessionId: FORK } });
    // Where a reused pid can't be told apart (Windows), the daemon must be alive too.
    expect(liveBackgroundJob(FORK, configDir)).toBe(isWin ? null : 'b54b5bdc');
  });

  function registry(pid: number, record: Record<string, unknown>): void {
    fs.mkdirSync(path.join(configDir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'sessions', `${pid}.json`), JSON.stringify({ pid, ...record }));
  }

  it('reads the CLI session registry, as the CLI does before refusing -r', () => {
    registry(process.pid, { sessionId: FORK, kind: 'bg', jobId: 'b54b5bdc', procStart: procStart(process.pid) });
    // Never read: the registry's key files.
    fs.writeFileSync(path.join(configDir, 'sessions', `${process.pid}.deadbeef.key`), 'secret');
    expect(liveBackgroundJob(FORK, configDir)).toBe('b54b5bdc');
    expect(listBackgroundJobs(configDir).find((j) => j.short === 'b54b5bdc')!.live).toBe(true);
  });

  it('ignores interactive sessions and records of processes that are gone or were replaced', () => {
    registry(process.pid, { sessionId: FORK, kind: 'interactive', procStart: procStart(process.pid) });
    registry(DEAD_PID, { sessionId: DONE, kind: 'bg', jobId: '8e593858', procStart: 'Sat Sep 26 15:35:01 2026' });
    expect(liveBackgroundJob(FORK, configDir)).toBeNull();
    expect(liveBackgroundJob(DONE, configDir)).toBeNull();
    if (!isWin) {
      registry(process.pid, { sessionId: FORK, kind: 'bg', jobId: 'b54b5bdc', procStart: 'Sat Jan  3 04:05:06 2026' });
      expect(liveBackgroundJob(FORK, configDir)).toBeNull();
    }
  });

  it('follows a job to the conversation it moved on to (/clear inside it)', () => {
    const NEXT = 'c0c0c0c0-0000-4000-8000-00000000000c';
    job('b54b5bdc', { state: 'working', sessionId: FORK, resumeSessionId: NEXT, forkSessionId: FORK, name: 'Chat ⑂', cwd: '/work/bob', forkParentSessionId: PARENT, updatedAt: '2026-09-26T16:11:57.298Z' });
    roster(process.pid, { b54b5bdc: { pid: process.pid, procStart: procStart(process.pid), sessionId: FORK } });
    const moved = listBackgroundJobs(configDir).find((j) => j.short === 'b54b5bdc')!;
    // The fork's name and parent stay with the fork, not the new conversation.
    expect(moved).toMatchObject({ sessionId: NEXT, name: '', live: true });
    expect(moved.forkParentSessionId).toBeUndefined();
    expect(liveBackgroundJob(NEXT, configDir)).toBe('b54b5bdc');
    expect(liveBackgroundJob(FORK, configDir)).toBeNull();
  });

  it('takes the conversation from a live registry record before state.json catches up', () => {
    const NEXT = 'c0c0c0c0-0000-4000-8000-00000000000c';
    registry(process.pid, { sessionId: NEXT, kind: 'bg', jobId: 'b54b5bdc', procStart: procStart(process.pid) });
    const moved = listBackgroundJobs(configDir).find((j) => j.short === 'b54b5bdc')!;
    expect(moved).toMatchObject({ sessionId: NEXT, live: true });
  });

  it('skips shell commands run as background jobs: they have no conversation', () => {
    job('e0e0e0e0', { state: 'working', template: 'exec', sessionId: 'e0e0e0e0-0000-4000-8000-00000000000e', cwd: '/work/bob', updatedAt: '2026-09-27T00:00:00.000Z' });
    expect(listBackgroundJobs(configDir).map((j) => j.short)).not.toContain('e0e0e0e0');
  });

  it('is not live when the worker died', () => {
    roster(process.pid, { b54b5bdc: { pid: DEAD_PID, procStart: 'Sat Sep 26 15:35:01 2026', sessionId: FORK } });
    expect(liveBackgroundJob(FORK, configDir)).toBeNull();
  });

  it.runIf(!isWin)('does not take a later process that reused the worker pid for the worker', () => {
    roster(process.pid, { b54b5bdc: { pid: process.pid, procStart: 'Sat Jan  3 04:05:06 2026', sessionId: FORK } });
    expect(liveBackgroundJob(FORK, configDir)).toBeNull();
  });

  it('copes with no jobs, no roster and malformed files', () => {
    expect(listBackgroundJobs(path.join(configDir, 'nope'))).toEqual([]);
    expect(liveBackgroundJob(FORK, configDir)).toBeNull();
    fs.writeFileSync(path.join(configDir, 'jobs', 'b54b5bdc', 'state.json'), '{not json');
    fs.mkdirSync(path.join(configDir, 'daemon'), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'daemon', 'roster.json'), '[]');
    expect(listBackgroundJobs(configDir).map((j) => j.short)).toEqual(['8e593858']);
  });
});
