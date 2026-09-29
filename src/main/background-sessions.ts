import { execFile } from 'child_process';
import { resolveBinary } from './providers/resolve-binary';
import { getFullPath } from './pty-manager';

// Stopping a Claude Code background session (a /fork, /background) from the
// sidebar. `claude stop <id>` ends it and keeps its conversation, which can be
// resumed with `claude -r` afterwards; the CLI marks the job stopped, and the
// history watcher refreshes the sidebar from that.

const TIMEOUT_MS = 20_000;
/** The id `claude stop` takes: the job folder's name. */
const SHORT_RE = /^[0-9a-f]{8}$/i;

export function stopBackgroundSession(short: string, configDir?: string): Promise<{ ok: boolean; error?: string }> {
  if (!SHORT_RE.test(short)) return Promise.resolve({ ok: false, error: 'invalid background session id' });
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: getFullPath() };
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  return new Promise((resolve) => {
    execFile(resolveBinary('claude', { path: null }), ['stop', short], { env, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, _stdout, stderr) => {
      if (!err) {
        resolve({ ok: true });
        return;
      }
      // The CLI says why on stderr (e.g. it couldn't confirm the stop).
      const detail = `${stderr ?? ''}`.trim().split('\n').pop();
      resolve({ ok: false, error: detail || err.message });
    });
  });
}
