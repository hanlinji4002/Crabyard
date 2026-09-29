import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { BrowserWindow } from 'electron';
import type { CliProvider, TranscriptDescriptor } from './provider';
import type { CliProviderMeta, ProviderConfig, SettingsValidationResult } from '../../shared/types';
import { getFullPath } from '../pty-manager';
import { installStatusLineScript, cleanupAll as cleanupHookStatus } from '../hook-status';
import { startConfigWatcher as startConfigWatch, stopConfigWatcher as stopConfigWatch } from '../config-watcher';
import { installHooksOnly, installStatusLine, getClaudeConfig } from '../claude-cli';
import { guardedInstall, validateSettings, reinstallSettings } from '../settings-guard';
import { resolveBinary, validateBinaryExists } from './resolve-binary';
import { MAX_INDEX_CHARS_PER_SESSION, TRANSCRIPT_TEXT_SEPARATOR, UUID_RE } from './transcript-utils';
import { writeAgentFile, deleteAgentFile } from './agent-files';
import { loadState } from '../store';
import { readLastTranscriptEffort } from './transcript-effort';
import { backgroundJob, liveBackgroundJob } from '../claude-jobs';
import { readContinuedIn, transcriptHasMessages } from '../claude-history';
import type { ResolvedConversation } from './provider';
import { isClaudeEffortLevel } from '../../shared/effort';

const binaryCache = { path: null as string | null };

/** Enumerate every on-disk transcript under one `.../projects` root, tagged with its profile. */
async function scanProjectsRoot(root: string, profileId?: string): Promise<TranscriptDescriptor[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: TranscriptDescriptor[] = [];
  for (const slugEntry of entries) {
    if (!slugEntry.isDirectory()) continue;
    const slug = slugEntry.name;
    const slugPath = path.join(root, slug);
    let files: string[];
    try {
      files = await fs.promises.readdir(slugPath);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const cliSessionId = file.slice(0, -6);
      if (!UUID_RE.test(cliSessionId)) continue;
      out.push({ cliSessionId, transcriptPath: path.join(slugPath, file), projectSlug: slug, profileId });
    }
  }
  return out;
}

export class ClaudeProvider implements CliProvider {
  readonly meta: CliProviderMeta = {
    id: 'claude',
    displayName: 'Claude Code',
    binaryName: 'claude',
    capabilities: {
      sessionResume: true,
      costTracking: true,
      contextWindow: true,
      hookStatus: true,
      configReading: true,
      shiftEnterNewline: true,
      pendingPromptTrigger: 'startup-arg',
      planModeArg: '--permission-mode plan',
      systemPromptInjection: true,
    },
    defaultContextWindowSize: 200_000,
  };

  resolveBinaryPath(): string {
    return resolveBinary('claude', binaryCache);
  }

  validatePrerequisites(): boolean {
    return validateBinaryExists('claude');
  }

  buildEnv(sessionId: string, baseEnv: Record<string, string>, opts?: { configDir?: string }): Record<string, string> {
    const env = { ...baseEnv };
    delete env.CLAUDE_CODE; // avoid subprocess detection conflicts
    // Markers of a Claude Code background session: the hook scripts stay silent
    // under them (see PY_SKIP_BACKGROUND_SESSION), so a Crabyard started from
    // such a session must not hand them to its own tabs.
    for (const key of ['CLAUDE_JOB_DIR', 'CLAUDE_CODE_SESSION_KIND', 'CLAUDE_BG_BACKEND', 'CLAUDE_BG_SOURCE']) delete env[key];
    env.CLAUDE_IDE_SESSION_ID = sessionId;
    env.PATH = getFullPath();
    // Profile support: point Claude Code at an isolated config dir (separate
    // credentials/license, settings, hooks, transcripts). Absent = default ~/.claude.
    if (opts?.configDir) env.CLAUDE_CONFIG_DIR = opts.configDir;
    return env;
  }

  buildArgs(opts: { cliSessionId: string | null; isResume: boolean; extraArgs: string; initialPrompt?: string; systemPrompt?: string; effort?: string }): string[] {
    const args: string[] = [];
    if (opts.cliSessionId) {
      if (opts.isResume) {
        args.push('-r', opts.cliSessionId);
      } else {
        args.push('--session-id', opts.cliSessionId);
      }
    }
    if (opts.systemPrompt) {
      args.push('--append-system-prompt', opts.systemPrompt);
    }
    if (opts.initialPrompt) {
      args.push(opts.initialPrompt);
    }
    const resuming = opts.isResume && !!opts.cliSessionId;
    let extra = opts.extraArgs ? opts.extraArgs.split(/\s+/).filter(Boolean) : [];
    // A resumed conversation keeps the effort it last actually ran at, as its
    // transcript records it: Claude Code restores effort only from --effort or
    // settings, never from the transcript. That beats an --effort the tab was
    // created with, except `--effort ultracode`, which runs at xhigh — all a
    // transcript can tell of it.
    let lastRun = resuming && isClaudeEffortLevel(opts.effort) ? opts.effort : undefined;
    if (lastRun === 'xhigh' && flagValue(extra, '--effort')?.toLowerCase() === 'ultracode') lastRun = undefined;
    if (lastRun) extra = withoutFlag(extra, '--effort');
    args.push(...extra);
    // Crabyard's defaults: sessions start in bypassPermissions mode at xhigh
    // effort (Claude Code silently lowers it for models without it), unless
    // the session's own arguments choose otherwise.
    const has = (flag: string) => extra.some((a) => a === flag || a.startsWith(`${flag}=`));
    if (!has('--permission-mode') && !has('--dangerously-skip-permissions')) args.push('--permission-mode', 'bypassPermissions');
    if (lastRun) args.push('--effort', lastRun);
    else if (!has('--effort')) args.push('--effort', 'xhigh');
    return args;
  }

  lastConversationEffort(cliSessionId: string, projectPath: string, configDir?: string): string | undefined {
    const transcript = this.getTranscriptPath(cliSessionId, projectPath, configDir);
    return transcript ? readLastTranscriptEffort(transcript) : undefined;
  }

  /**
   * A tab opened on a background job follows the job: attached again while it
   * runs, else resumed on the conversation it was last on. A conversation
   * handed off to a background session (← on an empty prompt) goes on there,
   * once that session runs or has content. And a conversation a live
   * background session holds is attached to: the CLI refuses `-r` for it.
   */
  resolveConversation(cliSessionId: string, projectPath: string, configDir?: string, attachShort?: string): ResolvedConversation {
    const root = configDir ?? path.join(os.homedir(), '.claude');
    let target = cliSessionId;
    let reason: ResolvedConversation['reason'];
    if (attachShort) {
      const job = backgroundJob(attachShort, root);
      if (job && job.sessionId !== cliSessionId) reason = 'job';
      if (job?.live) return { cliSessionId: job.sessionId, attachShort, ...(reason ? { reason } : {}) };
      if (job) target = job.sessionId;
    }
    const transcript = this.getTranscriptPath(target, projectPath, configDir);
    const next = transcript ? readContinuedIn(transcript) : undefined;
    if (next && (liveBackgroundJob(next, root) || transcriptHasMessages(path.join(path.dirname(transcript!), `${next}.jsonl`)))) {
      target = next;
      reason = 'handoff';
    }
    return { cliSessionId: target, attachShort: liveBackgroundJob(target, root), ...(reason ? { reason } : {}) };
  }

  async installHooks(win?: BrowserWindow | null, _projectPath?: string): Promise<void> {
    await guardedInstall(win ?? null);
  }

  installStatusScripts(): void {
    installStatusLineScript();
  }

  cleanup(): void {
    stopConfigWatch();
    cleanupHookStatus();
  }

  startConfigWatcher(win: BrowserWindow, projectPath: string): void {
    startConfigWatch(win, projectPath, 'claude');
  }

  stopConfigWatcher(): void {
    stopConfigWatch();
  }

  async getConfig(projectPath: string): Promise<ProviderConfig> {
    return getClaudeConfig(projectPath);
  }

  validateSettings(_projectPath?: string, configDir?: string): SettingsValidationResult {
    // For a profile session, validate the profile's config dir (where spawnPty
    // installed hooks + statusLine), not the default ~/.claude.
    return validateSettings(configDir);
  }

  reinstallSettings(): void {
    reinstallSettings();
    installStatusLineScript();
  }

  getShiftEnterSequence(): string | null {
    return '\x1b[13;2u';
  }

  getTranscriptPath(cliSessionId: string, projectPath: string, configDir?: string): string | null {
    // Claude encodes the project path by replacing any non-alphanumeric char with '-'
    const slug = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
    const root = configDir ?? path.join(os.homedir(), '.claude');
    const filePath = path.join(root, 'projects', slug, `${cliSessionId}.jsonl`);
    return fs.existsSync(filePath) ? filePath : null;
  }

  async discoverTranscripts(): Promise<TranscriptDescriptor[]> {
    // Search the default config dir plus every claude profile's config dir, so
    // global session search surfaces transcripts created under an isolated profile.
    // Each root carries its profileId (undefined = default ~/.claude) so resume
    // can reopen against the right config dir.
    const defaultRoot = path.join(os.homedir(), '.claude', 'projects');
    const roots = new Map<string, string | undefined>([[defaultRoot, undefined]]);
    try {
      for (const profile of loadState().profiles ?? []) {
        if (profile.providerId === 'claude') {
          const root = path.join(profile.configDir, 'projects');
          if (!roots.has(root)) roots.set(root, profile.id);
        }
      }
    } catch {
      // Profiles unavailable — fall back to the default root only.
    }
    const out: TranscriptDescriptor[] = [];
    for (const [root, profileId] of roots) {
      out.push(...await scanProjectsRoot(root, profileId));
    }
    return out;
  }

  async indexTranscript(transcriptPath: string): Promise<{ text: string; cwd: string }> {
    const content = await fs.promises.readFile(transcriptPath, 'utf8');
    const texts: string[] = [];
    let cwd = '';
    let totalChars = 0;
    for (const line of content.split('\n')) {
      if (!line.trim() || totalChars >= MAX_INDEX_CHARS_PER_SESSION) continue;
      try {
        const entry = JSON.parse(line);
        if (!cwd && entry.cwd) cwd = entry.cwd;
        if (entry.type !== 'user' || !entry.message?.content) continue;
        const c = entry.message.content;
        let text = '';
        if (typeof c === 'string') {
          text = c;
        } else if (Array.isArray(c)) {
          for (const block of c) {
            if (block.type === 'text') text += block.text + '\n';
          }
        }
        if (text) {
          texts.push(text.trim());
          totalChars += text.length;
        }
      } catch {
        // partial-write tolerance: skip malformed lines
      }
    }
    return { text: texts.join(TRANSCRIPT_TEXT_SEPARATOR), cwd };
  }

  agentsDir(): string {
    return path.join(os.homedir(), '.claude', 'agents');
  }

  async installAgent(slug: string, content: string): Promise<{ filePath: string }> {
    return writeAgentFile(this.agentsDir(), slug, content);
  }

  async removeAgent(slug: string): Promise<void> {
    return deleteAgentFile(this.agentsDir(), slug);
  }

  parseCostFromOutput(rawText: string): { totalCostUsd: number } | null {
    const COST_RE = /\$(\d+\.\d{2,})/g;
    let match: RegExpExecArray | null;
    let lastCost: string | null = null;
    while ((match = COST_RE.exec(rawText)) !== null) {
      lastCost = match[0];
    }
    if (lastCost) {
      return { totalCostUsd: parseFloat(lastCost.replace('$', '')) };
    }
    return null;
  }
}

/** The value of `flag` in `args` (`flag value` or `flag=value`), if present. */
function flagValue(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) return args[i + 1];
    if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1);
  }
  return undefined;
}

/** `args` without `flag` (either `flag value` or `flag=value`). */
function withoutFlag(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) { i++; continue; }
    if (args[i].startsWith(`${flag}=`)) continue;
    out.push(args[i]);
  }
  return out;
}

/** @internal Test-only: reset cached binary path */
export function _resetCachedPath(): void {
  binaryCache.path = null;
}
