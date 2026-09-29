import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { isWin } from './platform';

// Background sessions of Claude Code (2.1.283: /fork, /background, `claude
// --bg`, the agents view) run in a per-user daemon, not in any terminal. Each
// has a job folder, `<config>/jobs/<short id>/state.json`. Which of them a
// process is running right now is read the way the CLI itself decides whether
// `claude -r` must refuse a session: its registry `<config>/sessions/<pid>.json`
// (a record whose kind isn't "interactive", with a live pid that has the start
// time it recorded). The daemon's `<config>/daemon/roster.json` backs that up
// for jobs whose registry record can't be found; it also holds auth tokens, so
// only its pid, start-time and session-id fields are read, and nothing else
// from it is kept. The registry's `<pid>.<hash>.key` files are never read.
//
// A session a live background process holds can't be resumed with `claude -r`
// (the CLI refuses and exits); `claude attach <short id>` opens it instead.

export interface BackgroundJob {
  /** The id `claude attach` takes: the job folder's name. */
  short: string;
  /** The conversation the job is on now (it moves on /clear, /resume, /branch inside the job). */
  sessionId: string;
  name: string;
  cwd: string;
  /** working, needs_reply, needs_approval, done, failed or stopped. */
  state: string;
  /** Set for a /fork still on its own conversation: the conversation it was forked from. */
  forkParentSessionId?: string;
  createdAt: number;
  updatedAt: number;
  /** A background process is running it right now. */
  live: boolean;
}

/** Verified processes, for a moment: a pid can be reused once its process ends. */
const VERIFY_TTL_MS = 10_000;
const verified = new Map<string, { at: number; ok: boolean }>();
const SHORT_RE = /^[0-9a-f]{8}$/i;
const REGISTRY_FILE_RE = /^\d+\.json$/;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function time(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: unknown): pid is number {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The process is the one that was recorded, not a later one that got its pid:
 * the CLI records `ps -o lstart` of each process, in UTC. Can't be checked on
 * Windows, where this is always true.
 */
function sameProcess(pid: number, procStart: string): boolean {
  if (isWin || !procStart) return true;
  const key = `${pid}|${procStart}`;
  const hit = verified.get(key);
  if (hit && Date.now() - hit.at < VERIFY_TTL_MS) return hit.ok;
  const res = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
    encoding: 'utf8',
    timeout: 2000,
  });
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ');
  const ok = res.status === 0 && norm(res.stdout) === norm(procStart);
  verified.set(key, { at: Date.now(), ok });
  return ok;
}

function liveProcess(pid: unknown, procStart: unknown): boolean {
  return pidAlive(pid) && sameProcess(pid, str(procStart));
}

interface LiveRegistry {
  /** Session id -> the job running it ('' when the record names no job). */
  bySession: Map<string, string>;
  /** Job short id -> the conversation it is on right now. */
  byJob: Map<string, string>;
}

/**
 * Background sessions running now, from the CLI's session registry. A record
 * follows its process to a new conversation at once; a job's state.json only
 * catches up later.
 */
function liveRegistry(configDir: string): LiveRegistry {
  const out: LiveRegistry = { bySession: new Map(), byJob: new Map() };
  const dir = path.join(configDir, 'sessions');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!REGISTRY_FILE_RE.test(name)) continue;
    const rec = readJson(path.join(dir, name));
    if (!rec) continue;
    const kind = str(rec.kind);
    const sessionId = str(rec.sessionId);
    if (!kind || kind === 'interactive' || !sessionId) continue;
    if (!liveProcess(rec.pid, rec.procStart)) continue;
    const jobId = SHORT_RE.test(str(rec.jobId)) ? str(rec.jobId) : '';
    out.bySession.set(sessionId, jobId);
    if (jobId) out.byJob.set(jobId, sessionId);
  }
  return out;
}

/**
 * Short ids of the jobs whose worker process is alive, from the daemon's
 * roster. The worker outlives a dead daemon for a while, so the daemon itself
 * needn't be alive — except on Windows, where a reused pid can't be told apart.
 */
function liveRosterShorts(configDir: string): Set<string> {
  const out = new Set<string>();
  const roster = readJson(path.join(configDir, 'daemon', 'roster.json'));
  if (!roster) return out;
  if (isWin && !pidAlive(roster.supervisorPid)) return out;
  const workers = roster.workers;
  if (!workers || typeof workers !== 'object') return out;
  for (const [short, raw] of Object.entries(workers as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const w = raw as Record<string, unknown>;
    if (liveProcess(w.pid, w.procStart)) out.add(short);
  }
  return out;
}

/** Every background conversation Claude Code keeps under `configDir`, newest first. */
export function listBackgroundJobs(configDir: string): BackgroundJob[] {
  const jobsDir = path.join(configDir, 'jobs');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(jobsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const registry = liveRegistry(configDir);
  const roster = liveRosterShorts(configDir);
  const jobs: BackgroundJob[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const s = readJson(path.join(jobsDir, entry.name, 'state.json'));
    // A shell command run from the agents view: no conversation, nothing to resume.
    if (!s || str((s.template as Record<string, unknown> | undefined)?.name ?? s.template) === 'exec') continue;
    const original = str(s.sessionId);
    // Which conversation the job is on: its live registry record, else the
    // CLI's own rule for state.json (resumeSessionId, else sessionId).
    const sessionId = registry.byJob.get(entry.name) || str(s.resumeSessionId) || original;
    if (!sessionId) continue;
    // Its name and fork parent belong to the conversation it started with.
    const own = sessionId === (str(s.forkSessionId) || original);
    const parent = own ? str(s.forkParentSessionId) : '';
    jobs.push({
      short: entry.name,
      sessionId,
      name: own ? str(s.name).trim() : '',
      cwd: str(s.cwd),
      state: str(s.state),
      ...(parent ? { forkParentSessionId: parent } : {}),
      createdAt: time(s.createdAt),
      updatedAt: time(s.updatedAt),
      live: registry.bySession.has(sessionId) || registry.byJob.has(entry.name) || roster.has(entry.name),
    });
  }
  return jobs.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** One job by its short id: the conversation it is on now, and whether it runs. */
export function backgroundJob(short: string, configDir: string): { sessionId: string; live: boolean } | null {
  const job = listBackgroundJobs(configDir).find((j) => j.short === short);
  return job ? { sessionId: job.sessionId, live: job.live } : null;
}

/** The `claude attach` id of the live background session holding `cliSessionId`, if any. */
export function liveBackgroundJob(cliSessionId: string, configDir: string): string | null {
  const fromRegistry = liveRegistry(configDir).bySession.get(cliSessionId);
  if (fromRegistry) return fromRegistry;
  const job = listBackgroundJobs(configDir).find((j) => j.sessionId === cliSessionId && j.live);
  return job ? job.short : null;
}

/** @internal Test-only. */
export function _resetForTesting(): void {
  verified.clear();
}
