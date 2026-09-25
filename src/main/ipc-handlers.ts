import { ipcMain, BrowserWindow, app, dialog, shell, clipboard, nativeTheme } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { spawnPty, spawnShellPty, writePty, resizePty, killPty, isSilencedExit, getPtyCwd } from './pty-manager';
import { loadState, saveState, PersistedState } from './store';
import { startWatching, cleanupSessionStatus, resyncAllSessions } from './hook-status';
import { startCodexSessionWatcher, registerPendingCodexSession, unregisterCodexSession } from './codex-session-watcher';
import { getGitStatus, getGitFiles, getGitDiff, getGitWorktrees, gitStageFile, gitUnstageFile, gitDiscardFile, getGitRemoteUrl, listGitBranches, checkoutGitBranch, createGitBranch } from './git-status';
import { startGitWatcher, stopGitWatcher, notifyGitChanged } from './git-watcher';
import { watchDir, unwatchDir, setFileWatcherWindow } from './file-watcher';
import { checkForUpdates, quitAndInstall } from './auto-updater';
import { createAppMenu } from './menu';
import { getProvider, getProviderMeta, getAllProviderMetas, getAllProviders } from './providers/registry';
import { buildHandoffPrompt } from './providers/resume-handoff';
import { searchSessions } from './session-deep-search';
import { conversationPathsForTrash, forgetConversation, getClaudeUsage, listClaudeConversations } from './claude-history';
import { getConversationChanges } from './conversation-changes';
import { listSkills, setSkillEnabled } from './skills';
import { listPlugins, setPluginEnabled } from './plugins';
import { windowBackground } from './window-theme';
import type { ProviderId, GitFileEntry, SettingsValidationResult, ReadFileResult, FileStatResult } from '../shared/types';
import { expandUserPath, isLikelyBinaryFile, isMacPackagePath } from './fs-utils';
import { isLinux, isMac, isWin } from './platform';
import type { ClipboardSource } from '../shared/types';
import { shouldWarnStatusLine } from './settings-guard';
import { setCloseConfirmed } from './close-state';
import { provisionProfileDir } from './profiles';
import { getKeychainIsolationStatus } from './claude-keychain';

/**
 * Check if a resolved path is within one of the known project directories.
 */
function isWithinKnownProject(resolvedPath: string): boolean {
  const state = loadState();
  return state.projects.some(p => resolvedPath.startsWith(p.path + path.sep) || resolvedPath === p.path);
}

/**
 * Envelope for fs handlers that act on a path: resolve it, refuse anything
 * outside a known project (stricter than isAllowedReadPath — never config dirs
 * like ~/.claude or ~/.codex), and turn a throw into `{ ok: false, error }`.
 * `act` may return a non-empty error string to report a failure of its own.
 */
async function withProjectPath(
  channel: string,
  targetPath: string,
  act: (resolved: string) => Promise<string | void>
): Promise<{ ok: boolean; error?: string }> {
  try {
    const resolved = path.resolve(targetPath);
    if (!isWithinKnownProject(resolved)) {
      console.warn(`${channel} blocked: ${resolved} is not within a known project`);
      return { ok: false, error: 'Path is not within a known project' };
    }
    const error = await act(resolved);
    return error ? { ok: false, error } : { ok: true };
  } catch (err) {
    console.warn(`${channel} failed:`, err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Check if a resolved path is allowed for reading:
 * within a known project directory OR a known config location.
 */
function isAllowedReadPath(resolvedPath: string): boolean {
  // Allow files within known project directories
  if (isWithinKnownProject(resolvedPath)) {
    return true;
  }

  // Allow known config files/directories used by supported CLIs
  const home = os.homedir();
  const allowedPaths = [
    path.join(home, '.claude.json'),
    path.join(home, '.mcp.json'),
    path.join(home, '.claude') + path.sep,
    path.join(home, '.codex') + path.sep,
    path.join(home, '.gemini') + path.sep,
    path.join(home, '.copilot') + path.sep,
  ];

  if (isMac) {
    allowedPaths.push('/Library/Application Support/ClaudeCode/');
  } else if (isWin) {
    allowedPaths.push('C:\\Program Files\\ClaudeCode\\');
  } else {
    allowedPaths.push('/etc/claude-code/');
  }

  return allowedPaths.some(allowed => resolvedPath === allowed || resolvedPath.startsWith(allowed));
}

/**
 * Enumerate files in a project root. Prefers `git ls-files` (respects .gitignore);
 * falls back to a depth- and count-limited recursive walk when not a git repo.
 * Returns repo-relative paths.
 */
function enumerateProjectFiles(resolvedCwd: string): string[] {
  try {
    const output = execSync('git ls-files --cached --others --exclude-standard', {
      cwd: resolvedCwd,
      encoding: 'utf-8',
      timeout: 5000,
    });
    return output.split('\n').filter(Boolean);
  } catch {
    const files: string[] = [];
    const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '__pycache__']);
    const MAX_DEPTH = 5;
    const MAX_FILES = 5000;
    function walk(dir: string, depth: number): void {
      if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (files.length >= MAX_FILES) return;
        if (IGNORE.has(entry.name) || entry.name.startsWith('.')) continue;
        const rel = path.relative(resolvedCwd, path.join(dir, entry.name));
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), depth + 1);
        } else {
          files.push(rel);
        }
      }
    }
    walk(resolvedCwd, 0);
    return files;
  }
}

let hookWatcherStarted = false;

export function resetHookWatcher(): void {
  hookWatcherStarted = false;
}

export function registerIpcHandlers(): void {
  ipcMain.handle('pty:create', async (_event, sessionId: string, cwd: string, cliSessionId: string | null, isResume: boolean, extraArgs: string, providerId: ProviderId = 'claude', initialPrompt?: string, systemPrompt?: string, envVars: string = '', configDir?: string) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;

    // Start hook status watcher on first PTY creation (window is guaranteed to exist)
    if (!hookWatcherStarted) {
      startWatching(win);
      hookWatcherStarted = true;
    }

    const provider = getProvider(providerId);

    // For Codex sessions without a cliSessionId, start watching history.jsonl
    if (providerId === 'codex' && !cliSessionId) {
      startCodexSessionWatcher(win);
      registerPendingCodexSession(sessionId);
    }

    await spawnPty(
      sessionId,
      cwd,
      cliSessionId,
      isResume,
      extraArgs,
      providerId,
      initialPrompt,
      systemPrompt,
      envVars,
      (data) => {
        const w = BrowserWindow.getAllWindows()[0];
        if (w && !w.isDestroyed()) {
          w.webContents.send('pty:data', sessionId, data);
        }
      },
      (exitCode, signal) => {
        cleanupSessionStatus(sessionId);
        unregisterCodexSession(sessionId);
        if (isSilencedExit(sessionId)) return; // old PTY killed for re-spawn
        const w = BrowserWindow.getAllWindows()[0];
        if (w && !w.isDestroyed()) {
          w.webContents.send('pty:exit', sessionId, exitCode, signal);
        }
      },
      configDir
    );

    // Validate after spawnPty — Copilot installs per-project hooks there, so
    // validating earlier would see an empty config on a project's first spawn.
    if (provider.meta.capabilities.hookStatus) {
      const validation = provider.validateSettings(cwd, configDir);
      const prefs = loadState().preferences;
      const statusLineIssue = shouldWarnStatusLine(
        validation.statusLine,
        prefs.statusLineConsent,
        prefs.statusLineConsentCommand,
        validation.foreignStatusLineCommand,
      );
      const hooksIssue = validation.hooks !== 'complete';
      if (statusLineIssue || hooksIssue) {
        win.webContents.send('settings:warning', {
          sessionId,
          statusLine: statusLineIssue ? validation.statusLine : 'vibeyard',
          hooks: validation.hooks,
        });
      }
    }
  });

  ipcMain.handle('pty:createShell', (_event, sessionId: string, cwd: string) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;

    spawnShellPty(
      sessionId,
      cwd,
      (data) => {
        const w = BrowserWindow.getAllWindows()[0];
        if (w && !w.isDestroyed()) {
          w.webContents.send('pty:data', sessionId, data);
        }
      },
      (exitCode, signal) => {
        const w = BrowserWindow.getAllWindows()[0];
        if (w && !w.isDestroyed()) {
          w.webContents.send('pty:exit', sessionId, exitCode, signal);
        }
      }
    );
  });

  ipcMain.on('pty:write', (_event, sessionId: string, data: string) => {
    writePty(sessionId, data);
  });

  ipcMain.on('pty:resize', (_event, sessionId: string, cols: number, rows: number) => {
    resizePty(sessionId, cols, rows);
  });

  ipcMain.handle('pty:kill', (_event, sessionId: string) => {
    killPty(sessionId);
  });

  ipcMain.handle('fs:isDirectory', (_event, filePath: string) => {
    try {
      return fs.statSync(expandUserPath(filePath)).isDirectory();
    } catch {
      return false;
    }
  });

  ipcMain.handle('fs:expandPath', (_event, filePath: string): string => {
    return expandUserPath(filePath);
  });

  ipcMain.handle('fs:listDirs', (_event, dirPath: string, prefix?: string) => {
    try {
      const expanded = expandUserPath(dirPath);
      const entries = fs.readdirSync(expanded, { withFileTypes: true });
      const lowerPrefix = prefix?.toLowerCase();
      return entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.') && (!lowerPrefix || e.name.toLowerCase().startsWith(lowerPrefix)))
        .map(e => path.join(expanded, e.name))
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 20);
    } catch {
      return [];
    }
  });

  ipcMain.handle('fs:listDir', (_event, dirPath: string) => {
    try {
      const expanded = expandUserPath(dirPath);
      if (!isAllowedReadPath(expanded)) return [];
      const entries = fs.readdirSync(expanded, { withFileTypes: true });
      // Renderer sorts via sortEntries(); keep main process cheap.
      return entries.map(e => ({
        name: e.name,
        path: path.join(expanded, e.name),
        isDirectory: e.isDirectory(),
      }));
    } catch {
      return [];
    }
  });

  ipcMain.handle('store:load', () => {
    return loadState();
  });

  ipcMain.handle('store:save', (_event, state: PersistedState) => {
    saveState(state);
  });

  // Provision (create) a profile's config dir. Returns the resolved absolute
  // path and whether it is the auto-managed location.
  ipcMain.handle('profiles:provision', (_event, profileId: string, customPath?: string) => {
    const configDir = provisionProfileDir(profileId, customPath);
    return { configDir, managed: !customPath?.trim() };
  });

  // Report whether the installed Claude Code build can isolate per-profile
  // logins on this platform (macOS keychain namespacing). Drives the profile
  // guardrail in the UI.
  ipcMain.handle('profiles:keychainStatus', () => {
    return getKeychainIsolationStatus();
  });

  ipcMain.handle('menu:rebuild', (_event, debugMode: boolean) => {
    createAppMenu(debugMode);
  });

  ipcMain.handle('clipboard:write', (_event, text: string, source?: ClipboardSource) => {
    clipboard.writeText(text);
    // On Linux a selection-driven copy also populates the X11 PRIMARY selection
    // so middle-click paste works. An explicit copy must not — it would clobber
    // whatever the user has selected in another window.
    if (source === 'selection' && isLinux) clipboard.writeText(text, 'selection');
  });

  ipcMain.handle('provider:getConfig', async (_event, providerId: ProviderId, projectPath: string) => {
    const provider = getProvider(providerId);
    return provider.getConfig(projectPath);
  });

  // Backward compatibility alias
  ipcMain.handle('claude:getConfig', async (_event, projectPath: string) => {
    const provider = getProvider('claude');
    return provider.getConfig(projectPath);
  });

  ipcMain.on('config:watchProject', (_event, providerId: ProviderId, projectPath: string) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    const provider = getProvider(providerId);
    provider.startConfigWatcher?.(win, projectPath);
  });

  ipcMain.handle('provider:getMeta', (_event, providerId: ProviderId) => {
    return getProviderMeta(providerId);
  });

  ipcMain.handle('provider:listProviders', () => {
    return getAllProviderMetas();
  });

  ipcMain.handle('session:buildResumeWithPrompt', async (
    _event,
    sourceProviderId: ProviderId,
    sourceCliSessionId: string | null,
    projectPath: string,
    sessionName: string,
    configDir?: string,
  ) => {
    const sourceProvider = getProvider(sourceProviderId);
    const fromProviderLabel = sourceProvider.meta.displayName;
    let transcriptPath: string | null = null;
    if (sourceCliSessionId && sourceProvider.getTranscriptPath) {
      try {
        transcriptPath = sourceProvider.getTranscriptPath(sourceCliSessionId, projectPath, configDir);
      } catch (err) {
        console.warn('getTranscriptPath failed:', err);
      }
    }
    return buildHandoffPrompt({ fromProviderLabel, sessionName, transcriptPath });
  });

  // Whether a resumable transcript actually exists on disk for a given CLI session.
  // Fail-open (return true) when we cannot determine it, so resume/archive is never
  // wrongly blocked for providers we can't introspect.
  const transcriptExists = (
    providerId: ProviderId,
    cliSessionId: string | null,
    projectPath: string,
    configDir?: string,
  ): boolean => {
    if (!cliSessionId) return true;
    try {
      const provider = getProvider(providerId);
      if (!provider.getTranscriptPath) return true;
      // getTranscriptPath returns null when the transcript is absent (every provider
      // verifies existence on disk), so a non-null path means the transcript exists.
      return provider.getTranscriptPath(cliSessionId, projectPath, configDir) !== null;
    } catch (err) {
      console.warn('transcriptExists check failed:', err);
      return true;
    }
  };
  ipcMain.handle('session:transcriptExists', (_event, providerId: ProviderId, cliSessionId: string | null, projectPath: string, configDir?: string) =>
    transcriptExists(providerId, cliSessionId, projectPath, configDir));
  // Synchronous variant: the renderer gates session archiving on this at close time,
  // where the surrounding remove/persist/emit logic must stay synchronous.
  ipcMain.on('session:transcriptExistsSync', (event, providerId: ProviderId, cliSessionId: string | null, projectPath: string, configDir?: string) => {
    event.returnValue = transcriptExists(providerId, cliSessionId, projectPath, configDir);
  });

  ipcMain.handle('session:deepSearch', (_event, query: string) => {
    return searchSessions(query);
  });

  ipcMain.handle('claudeHistory:list', (_event, force?: boolean) => listClaudeConversations(!!force));
  ipcMain.handle('claudeHistory:usage', (_event, force?: boolean) => getClaudeUsage(!!force));
  ipcMain.handle('claudeHistory:changes', (_event, cliSessionId: unknown) =>
    typeof cliSessionId === 'string' ? getConversationChanges(cliSessionId) : null);
  // Deleting a conversation moves its transcript (and sidecar folder) to the
  // system Trash, so it can be restored; only real transcripts are accepted.
  ipcMain.handle('claudeHistory:trash', async (_event, transcriptPath: unknown) => {
    const paths = conversationPathsForTrash(transcriptPath);
    if (!paths) return { ok: false, error: 'Not a Claude Code conversation transcript' };
    try {
      for (const p of paths) await shell.trashItem(p);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    forgetConversation(paths[0]);
    return { ok: true };
  });

  // Skills pane: project skills are only read or switched for a project the app knows.
  const knownProject = (projectPath: unknown): string | undefined =>
    typeof projectPath === 'string' && (loadState()?.projects ?? []).some((p) => p.path === projectPath) ? projectPath : undefined;
  ipcMain.handle('skills:list', (_event, projectPath: unknown) => listSkills(knownProject(projectPath)));
  ipcMain.handle('skills:setEnabled', (_event, name: unknown, scope: unknown, projectPath: unknown, enabled: unknown) => {
    if (typeof name !== 'string' || !name || (scope !== 'user' && scope !== 'project') || typeof enabled !== 'boolean') {
      return { ok: false, error: 'invalid request' };
    }
    const project = scope === 'project' ? knownProject(projectPath) : undefined;
    if (scope === 'project' && !project) return { ok: false, error: 'unknown project' };
    return setSkillEnabled(name, scope, project, enabled);
  });
  ipcMain.handle('plugins:list', () => listPlugins());
  ipcMain.handle('plugins:setEnabled', (_event, id: unknown, enabled: unknown) =>
    typeof id === 'string' && typeof enabled === 'boolean' ? setPluginEnabled(id, enabled) : { ok: false, error: 'invalid request' });

  ipcMain.handle('provider:checkBinary', (_event, providerId: ProviderId = 'claude') => {
    const provider = getProvider(providerId);
    return provider.validatePrerequisites();
  });

  ipcMain.handle('provider:installAgent', async (_event, slug: string, content: string) => {
    const targets = getAllProviders().filter((p) => p.installAgent && p.validatePrerequisites());
    return Promise.all(targets.map(async (p) => {
      try {
        const r = await p.installAgent!(slug, content);
        return { providerId: p.meta.id, ok: true, filePath: r.filePath };
      } catch (err) {
        return { providerId: p.meta.id, ok: false, error: String((err as Error)?.message ?? err) };
      }
    }));
  });

  ipcMain.handle('provider:removeAgent', async (_event, slug: string) => {
    const targets = getAllProviders().filter((p) => p.removeAgent);
    await Promise.all(targets.map((p) => p.removeAgent!(slug).catch(() => undefined)));
  });

  ipcMain.handle('fs:browseDirectory', async () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // Replay every status file. The hook scripts write only on change, so a
  // title already on disk produces no further fs event — without this, turning
  // "Auto-name sessions" back on would leave existing tabs unnamed until their
  // title happened to change.
  ipcMain.on('session:resyncStatus', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) resyncAllSessions(w);
  });

  ipcMain.on('app:focus', () => {
    app.focus({ steal: true });
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  ipcMain.on('app:closeConfirmed', () => {
    setCloseConfirmed(true);
    app.quit();
  });

  // The macOS title bar follows the system appearance unless told otherwise;
  // pin it to the app theme so a dark app never sits under a white title bar.
  ipcMain.on('app:setNativeTheme', (_event, theme: unknown) => {
    if (theme !== 'dark' && theme !== 'light') return;
    nativeTheme.themeSource = theme;
    for (const win of BrowserWindow.getAllWindows()) win.setBackgroundColor(windowBackground(theme));
  });

  ipcMain.handle('app:getVersion', () => app.getVersion());
  ipcMain.handle('app:openExternal', (_event, url: string) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Only HTTP(S) URLs are allowed');
    }
    return shell.openExternal(url);
  });

  ipcMain.handle('git:getStatus', (_event, projectPath: string) => getGitStatus(projectPath));

  ipcMain.handle('git:getRemoteUrl', (_event, projectPath: string) => getGitRemoteUrl(projectPath));

  ipcMain.handle('git:getFiles', (_event, projectPath: string) => getGitFiles(projectPath));

  ipcMain.handle('git:getDiff', (_event, projectPath: string, filePath: string, area: string) => getGitDiff(projectPath, filePath, area));

  ipcMain.handle('git:getWorktrees', (_event, projectPath: string) => getGitWorktrees(projectPath));

  ipcMain.handle('git:stageFile', async (_event, projectPath: string, filePath: string) => {
    await gitStageFile(projectPath, filePath);
    notifyGitChanged();
  });

  ipcMain.handle('git:unstageFile', async (_event, projectPath: string, filePath: string) => {
    await gitUnstageFile(projectPath, filePath);
    notifyGitChanged();
  });

  ipcMain.handle('git:discardFile', async (_event, projectPath: string, filePath: string, area: string) => {
    await gitDiscardFile(projectPath, filePath, area as GitFileEntry['area']);
    notifyGitChanged();
  });

  ipcMain.on('git:watchProject', (_event, projectPath: string) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    startGitWatcher(win, projectPath);
  });

  ipcMain.handle('git:listBranches', (_event, projectPath: string) => listGitBranches(projectPath));

  ipcMain.handle('git:checkoutBranch', async (_event, projectPath: string, branch: string) => {
    await checkoutGitBranch(projectPath, branch);
    notifyGitChanged();
  });

  ipcMain.handle('git:createBranch', async (_event, projectPath: string, branch: string) => {
    await createGitBranch(projectPath, branch);
    notifyGitChanged();
  });

  ipcMain.handle('git:openInEditor', (_event, projectPath: string, filePath: string) => {
    const fullPath = path.join(projectPath, filePath);
    return shell.openPath(fullPath);
  });

  ipcMain.handle('pty:getCwd', (_event, sessionId: string) => getPtyCwd(sessionId));

  ipcMain.handle('fs:listFiles', (_event, cwd: string, query: string) => {
    try {
      const resolvedCwd = path.resolve(cwd);
      if (!isWithinKnownProject(resolvedCwd)) {
        return [];
      }
      let files = enumerateProjectFiles(resolvedCwd);

      if (query) {
        const lower = query.toLowerCase();
        const exact: string[] = [];
        const startsWith: string[] = [];
        const nameContains: string[] = [];
        const pathContains: string[] = [];
        for (const f of files) {
          const fileName = path.basename(f).toLowerCase();
          if (fileName === lower) exact.push(f);
          else if (fileName.startsWith(lower)) startsWith.push(f);
          else if (fileName.includes(lower)) nameContains.push(f);
          else if (f.toLowerCase().includes(lower)) pathContains.push(f);
        }
        files = [...exact, ...startsWith, ...nameContains, ...pathContains];
      }
      return files.slice(0, 50);
    } catch (err) {
      console.warn('fs:listFiles failed:', err);
      return [];
    }
  });

  ipcMain.handle('fs:exists', (_event, filePath: string): boolean => {
    try {
      const resolved = path.resolve(filePath);
      if (!isAllowedReadPath(resolved)) return false;
      return fs.existsSync(resolved);
    } catch {
      return false;
    }
  });

  ipcMain.handle('fs:stat', (_event, filePath: string): FileStatResult => {
    try {
      const resolved = path.resolve(filePath);
      if (!isAllowedReadPath(resolved)) {
        return { ok: false };
      }
      const s = fs.statSync(resolved);
      return { ok: true, size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle('fs:readFile', (_event, filePath: string): ReadFileResult => {
    try {
      // Security: resolve to absolute and check it's within a known project directory
      const resolved = path.resolve(filePath);
      if (!isAllowedReadPath(resolved)) {
        console.warn(`fs:readFile blocked: ${resolved} is not within an allowed path`);
        return { ok: false, reason: 'error' };
      }
      // Sniff the head before slurping the whole file so a multi-MB binary
      // (e.g. build artifacts in build/) doesn't get allocated just to be discarded.
      if (isLikelyBinaryFile(resolved)) {
        return { ok: false, reason: 'binary' };
      }
      return { ok: true, content: fs.readFileSync(resolved, 'utf-8') };
    } catch (err) {
      console.warn('fs:readFile failed:', err);
      return { ok: false, reason: 'error' };
    }
  });

  const IMAGE_MIME_BY_EXT: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
  };
  const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

  ipcMain.handle('fs:readImage', (_event, filePath: string) => {
    try {
      const resolved = path.resolve(filePath);
      if (!isAllowedReadPath(resolved)) {
        console.warn(`fs:readImage blocked: ${resolved} is not within an allowed path`);
        return null;
      }
      const mime = IMAGE_MIME_BY_EXT[path.extname(resolved).toLowerCase()];
      if (!mime) return null;
      const stat = fs.statSync(resolved);
      if (stat.size > MAX_IMAGE_BYTES) {
        console.warn(`fs:readImage rejected: ${resolved} exceeds ${MAX_IMAGE_BYTES} bytes`);
        return null;
      }
      const buf = fs.readFileSync(resolved);
      return { dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
    } catch (err) {
      console.warn('fs:readImage failed:', err);
      return null;
    }
  });

  ipcMain.handle('fs:trashItem', (_event, filePath: string) =>
    withProjectPath('fs:trashItem', filePath, (resolved) => shell.trashItem(resolved)));

  ipcMain.handle('fs:showInFolder', (_event, targetPath: string) =>
    withProjectPath('fs:showInFolder', targetPath, async (resolved) => {
      // lstat, not stat: a symlink must never be followed here. isWithinKnownProject
      // is a string-prefix check on the link's own path, so opening its target would
      // walk straight out of the project (workspace node_modules links, a link into
      // ~/.claude). Revealing the link itself in its parent is always in-bounds.
      const stats = await fs.promises.lstat(resolved);
      if (stats.isDirectory() && !(isMac && isMacPackagePath(resolved))) {
        // Open the folder itself so the file manager shows its contents.
        // openPath resolves to '' on success, or a message on failure.
        return shell.openPath(resolved);
      }
      // Files, symlinks and macOS packages: reveal in the parent, selected.
      shell.showItemInFolder(resolved);
    }));

  ipcMain.on('fs:watchDir', (event, dirPath: string) => {
    const resolved = path.resolve(dirPath);
    if (!isAllowedReadPath(resolved)) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) setFileWatcherWindow(win);
    watchDir(resolved);
  });

  ipcMain.on('fs:unwatchDir', (_event, dirPath: string) => {
    const resolved = path.resolve(dirPath);
    unwatchDir(resolved);
  });

  ipcMain.handle('update:checkNow', () => checkForUpdates());
  ipcMain.handle('update:install', () => quitAndInstall());

  ipcMain.handle('settings:reinstall', (_event, providerId: ProviderId = 'claude') => {
    try {
      const provider = getProvider(providerId);
      provider.reinstallSettings();
      return { success: true };
    } catch (err) {
      console.error('settings:reinstall failed:', err);
      return { success: false };
    }
  });

  ipcMain.handle('settings:validate', (_event, providerId: ProviderId = 'claude'): SettingsValidationResult => {
    const provider = getProvider(providerId);
    return provider.validateSettings();
  });
}
