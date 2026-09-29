import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send } }] },
}));

import { startClaudeHistoryWatch, stopClaudeHistoryWatch, watchClaudeConfigDir, _setNativeRecursiveForTesting } from './claude-history-watch';

const ID = '11111111-1111-4111-8111-111111111111';

async function waitFor(check: () => boolean, ms = 6000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

const changed = () => send.mock.calls.filter(([channel]) => channel === 'claudeHistory:changed').length;

for (const mode of ['native recursive', 'per folder (Linux)'] as const) {
describe(`claude-history-watch, ${mode}`, () => {
  beforeEach(() => _setNativeRecursiveForTesting(mode === 'native recursive'));
  afterEach(() => _setNativeRecursiveForTesting(process.platform === 'darwin' || process.platform === 'win32'));
  let configDir: string;

  beforeEach(() => {
    send.mockClear();
    configDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vy-watch-')));
    fs.mkdirSync(path.join(configDir, 'projects', '-work-bob'), { recursive: true });
  });

  afterEach(() => {
    stopClaudeHistoryWatch();
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('announces a new conversation, not every line appended to one', async () => {
    startClaudeHistoryWatch([configDir]);
    await new Promise((r) => setTimeout(r, 300)); // let the watcher settle
    const file = path.join(configDir, 'projects', '-work-bob', `${ID}.jsonl`);
    fs.writeFileSync(file, '{}\n');
    expect(await waitFor(() => changed() === 1)).toBe(true);

    await new Promise((r) => setTimeout(r, 1500)); // past the debounce
    send.mockClear();
    fs.appendFileSync(file, '{}\n');
    fs.writeFileSync(path.join(configDir, 'projects', '-work-bob', 'notes.txt'), 'x');
    await new Promise((r) => setTimeout(r, 2000));
    expect(changed()).toBe(0);
  }, 12_000);

  it('picks up a profile added later, and its projects folder once the CLI makes it', async () => {
    startClaudeHistoryWatch([]);
    const profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vy-watch-profile-')));
    try {
      watchClaudeConfigDir(profile);
      watchClaudeConfigDir(profile); // idempotent
      await new Promise((r) => setTimeout(r, 300));
      fs.mkdirSync(path.join(profile, 'projects', '-work-bob'), { recursive: true });
      fs.writeFileSync(path.join(profile, 'projects', '-work-bob', `${ID}.jsonl`), '{}\n');
      expect(await waitFor(() => changed() >= 1)).toBe(true);
    } finally {
      fs.rmSync(profile, { recursive: true, force: true });
    }
  }, 12_000);

  it('announces a background session starting and ending, even before the jobs folder exists', async () => {
    startClaudeHistoryWatch([configDir]);
    await new Promise((r) => setTimeout(r, 300));
    const dir = path.join(configDir, 'jobs', 'b54b5bdc');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ state: 'working', sessionId: 'x' }));
    expect(await waitFor(() => changed() >= 1)).toBe(true);

    await new Promise((r) => setTimeout(r, 2500)); // the folder's and the job's announcements, past the debounce
    send.mockClear();
    // A routine rewrite with the same state doesn't count; a finished job does.
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ state: 'working', sessionId: 'x', tempo: 'idle' }));
    await new Promise((r) => setTimeout(r, 1500));
    expect(changed()).toBe(0);
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ state: 'done', sessionId: 'x' }));
    expect(await waitFor(() => changed() === 1)).toBe(true);
  }, 15_000);
});
}
