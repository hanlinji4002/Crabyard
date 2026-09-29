import * as fs from 'fs';
import * as path from 'path';
import { BrowserWindow } from 'electron';

// Tells the renderer to refresh the sidebar's conversation list as soon as
// Claude Code creates or removes a conversation (a tab's first message,
// /clear, /branch, a /fork) or a background session starts or ends, instead of
// leaving it to the 30 s poll. Transcripts also grow on every message; that
// alone doesn't count, since the poll keeps the ordering fresh.

const DEBOUNCE_MS = 1000;
/**
 * macOS and Windows watch a folder tree natively. Elsewhere (Linux) Node's
 * recursive watch puts an inotify watch on every file below and re-reads a
 * folder on every write, which a big history exhausts; only the folders
 * directly under a root are watched there, and only this many.
 */
let nativeRecursive = process.platform === 'darwin' || process.platform === 'win32';
const MAX_FOLDER_WATCHES = 1000;
/** `<project folder>/<session id>.jsonl`, relative to a projects root. */
const TRANSCRIPT_RE = /^[^/\\]+[/\\][0-9a-f-]{36}\.jsonl$/i;
/** `<job>/state.json` (or a temp file the CLI renames onto it), relative to a jobs folder. */
const JOB_STATE_RE = /^([^/\\]+)[/\\]state\.json/;

let watchers: fs.FSWatcher[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
/** Last seen `state|sessionId` per job folder, so a job's routine rewrites don't count. */
const jobStates = new Map<string, string>();
/**
 * Transcripts seen so far. macOS reports writes to a file created a moment ago
 * as 'rename' too, so only a file that appeared or disappeared counts.
 */
const transcripts = new Set<string>();

function notify(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('claudeHistory:changed');
    }
  }, DEBOUNCE_MS);
}

function transcriptAppearedOrWent(projectsDir: string, rel: string): boolean {
  const file = path.join(projectsDir, rel);
  const exists = fs.existsSync(file);
  if (exists === transcripts.has(file)) return false;
  if (exists) transcripts.add(file);
  else transcripts.delete(file);
  return true;
}

function jobSignature(jobDir: string): string {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(jobDir, 'state.json'), 'utf8')) as Record<string, unknown>;
    return `${String(s.state)}|${String(s.resumeSessionId ?? s.sessionId)}`;
  } catch {
    return 'gone'; // mid-write or removed; either way until the next event
  }
}

function jobStateChanged(jobsDir: string, rel: string): boolean {
  const m = JOB_STATE_RE.exec(rel);
  if (!m) return false;
  const jobDir = path.join(jobsDir, m[1]);
  const sig = jobSignature(jobDir);
  if (jobStates.get(jobDir) === sig) return false;
  jobStates.set(jobDir, sig);
  return true;
}

function subdirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/** What is there before watching starts is not news. */
function seed(projectsDir: string, jobsDir: string): void {
  for (const slugDir of subdirs(projectsDir)) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(slugDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (TRANSCRIPT_RE.test(`x/${name}`)) transcripts.add(path.join(slugDir, name));
    }
  }
  for (const jobDir of subdirs(jobsDir)) jobStates.set(jobDir, jobSignature(jobDir));
}

function watch(dir: string, recursive: boolean, onEvent: (event: string, rel: string) => void): boolean {
  try {
    const w = fs.watch(dir, { recursive }, (event, filename) => {
      if (filename) onEvent(event, filename.toString());
    });
    // The folder went away: the poll still covers it.
    w.on('error', () => w.close());
    watchers.push(w);
    return true;
  } catch {
    return false;
  }
}

/**
 * Watch `root` and the folders directly in it (all this needs: transcripts sit
 * in `projects/<folder>/`, job states in `jobs/<short>/`), with paths reported
 * relative to `root`.
 */
function watchTwoLevels(root: string, onEvent: (event: string, rel: string) => void): boolean {
  if (nativeRecursive) return watch(root, true, onEvent);
  const watched = new Set<string>();
  const watchFolder = (name: string): void => {
    if (watched.has(name) || watched.size >= MAX_FOLDER_WATCHES) return;
    if (watch(path.join(root, name), false, (event, rel) => onEvent(event, path.join(name, rel)))) watched.add(name);
  };
  const ok = watch(root, false, (event, rel) => {
    onEvent(event, rel);
    let isDir = false;
    try {
      isDir = fs.statSync(path.join(root, rel)).isDirectory();
    } catch {
      watched.delete(rel); // gone; its watch errors out and closes
    }
    if (isDir) watchFolder(rel);
  });
  if (!ok) return false;
  for (const dir of subdirs(root)) watchFolder(path.basename(dir));
  return true;
}

function watchJobs(jobsDir: string): boolean {
  return watchTwoLevels(jobsDir, (_event, rel) => {
    if (jobStateChanged(jobsDir, rel)) notify();
  });
}

/** Config dirs being watched: ~/.claude and every Claude profile's. */
const configDirs = new Set<string>();

function watchProjects(projectsDir: string): boolean {
  return watchTwoLevels(projectsDir, (event, rel) => {
    if (event === 'rename' && TRANSCRIPT_RE.test(rel) && transcriptAppearedOrWent(projectsDir, rel)) notify();
  });
}

/**
 * Watch one Claude config dir's projects and jobs folders. Idempotent. A
 * folder the CLI hasn't made yet (a new profile, no background session so far)
 * is watched once it appears; whatever arrived with it is news.
 */
export function watchClaudeConfigDir(configDir: string): void {
  if (configDirs.has(configDir)) return;
  configDirs.add(configDir);
  const projectsDir = path.join(configDir, 'projects');
  const jobsDir = path.join(configDir, 'jobs');
  seed(projectsDir, jobsDir);
  let projectsWatched = watchProjects(projectsDir);
  let jobsWatched = watchJobs(jobsDir);
  if (projectsWatched && jobsWatched) return;
  watch(configDir, false, (_event, rel) => {
    if (rel === 'projects' && !projectsWatched) {
      projectsWatched = watchProjects(projectsDir);
      if (projectsWatched) {
        seed(projectsDir, jobsDir);
        notify();
      }
    } else if (rel === 'jobs' && !jobsWatched) {
      jobsWatched = watchJobs(jobsDir);
      if (jobsWatched) {
        for (const jobDir of subdirs(jobsDir)) jobStates.set(jobDir, jobSignature(jobDir));
        notify();
      }
    }
  });
}

/** Watch ~/.claude and the given profile config dirs; profiles added later call watchClaudeConfigDir. */
export function startClaudeHistoryWatch(dirs: string[]): void {
  stopClaudeHistoryWatch();
  for (const dir of dirs) watchClaudeConfigDir(dir);
}

export function stopClaudeHistoryWatch(): void {
  for (const w of watchers) w.close();
  watchers = [];
  configDirs.clear();
  jobStates.clear();
  transcripts.clear();
  if (timer) clearTimeout(timer);
  timer = null;
}

/** @internal Test-only: use the per-folder watches Linux gets. */
export function _setNativeRecursiveForTesting(on: boolean): void {
  nativeRecursive = on;
}
