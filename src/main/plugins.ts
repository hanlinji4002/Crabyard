import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { resolveBinary } from './providers/resolve-binary';
import { getFullPath } from './pty-manager';
import type { PluginInfo } from '../shared/types';

// Claude Code plugins for the Skills pane, listed and switched through Claude
// Code's own `claude plugin list --json` / `enable` / `disable`, so each
// plugin's scope and settings are handled exactly as the CLI does it.

const TIMEOUT_MS = 20_000;
/** A plugin id as the CLI prints it: `name@marketplace`. */
const PLUGIN_ID = /^[\w.:-]+(@[\w.:-]+)?$/;

function runClaude(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const binary = resolveBinary('claude', { path: null });
    execFile(binary, args, { env: { ...process.env, PATH: getFullPath() }, timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = `${stderr ?? ''}`.trim().split('\n').pop();
        reject(new Error(detail || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

/** The plugin's own description, from its .claude-plugin/plugin.json when it has one. */
function describePlugin(installPath: unknown): string {
  if (typeof installPath !== 'string') return '';
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(installPath, '.claude-plugin', 'plugin.json'), 'utf8')) as { description?: unknown };
    return typeof manifest.description === 'string' ? manifest.description : '';
  } catch {
    return '';
  }
}

/** Parse `claude plugin list --json`. */
export function parsePluginList(json: string, describe: (installPath: unknown) => string = describePlugin): PluginInfo[] {
  const raw = JSON.parse(json) as unknown;
  if (!Array.isArray(raw)) return [];
  const out: PluginInfo[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const p = item as { id?: unknown; version?: unknown; scope?: unknown; enabled?: unknown; installPath?: unknown };
    if (typeof p.id !== 'string' || !PLUGIN_ID.test(p.id)) continue;
    const [name, marketplace = ''] = p.id.split('@');
    out.push({
      id: p.id,
      name,
      marketplace,
      version: typeof p.version === 'string' ? p.version : '',
      scope: typeof p.scope === 'string' ? p.scope : '',
      enabled: p.enabled === true,
      description: describe(p.installPath),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listPlugins(): Promise<PluginInfo[]> {
  return parsePluginList(await runClaude(['plugin', 'list', '--json']));
}

export async function setPluginEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  if (!PLUGIN_ID.test(id)) return { ok: false, error: 'invalid plugin id' };
  try {
    await runClaude(['plugin', enabled ? 'enable' : 'disable', id]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
