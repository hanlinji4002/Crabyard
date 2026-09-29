export type { McpServer, Agent, Skill, Command, ProviderConfig, ClaudeConfig, GitWorktree, GitFileEntry, CostData, ProviderId, CliProviderMeta, CliProviderCapabilities, ClipboardSource } from '../shared/types.js';
import type { CostData, ProviderConfig, GitWorktree, ProviderId, CliProviderMeta, FsChange, ClaudeConversationList, ClaudeUsageReport, ConversationChanges, ClipboardSource, SkillInfo, SkillScope, PluginInfo, PreviewTreeNode, ReadFileResult } from '../shared/types.js';

export interface VibeyardApi {
  pty: {
    create(sessionId: string, cwd: string, cliSessionId: string | null, isResume: boolean, extraArgs?: string, providerId?: ProviderId, initialPrompt?: string, systemPrompt?: string, envVars?: string, configDir?: string, attachShort?: string): Promise<void>;
    createShell(sessionId: string, cwd: string): Promise<void>;
    write(sessionId: string, data: string): void;
    resize(sessionId: string, cols: number, rows: number): void;
    kill(sessionId: string): Promise<void>;
    getCwd(sessionId: string): Promise<string | null>;
    onData(callback: (sessionId: string, data: string) => void): () => void;
    onExit(callback: (sessionId: string, exitCode: number, signal?: number) => void): () => void;
  };
  session: {
    transcriptExists(providerId: ProviderId, cliSessionId: string | null, projectPath: string, configDir?: string): Promise<boolean>;
    transcriptExistsSync(providerId: ProviderId, cliSessionId: string | null, projectPath: string, configDir?: string): boolean;
    onHookStatus(callback: (sessionId: string, status: 'working' | 'waiting' | 'completed' | 'input', hookName: string) => void): () => void;
    onCliSessionId(callback: (sessionId: string, cliSessionId: string) => void): () => void;
    /** @deprecated Use onCliSessionId */
    onClaudeSessionId(callback: (sessionId: string, claudeSessionId: string) => void): () => void;
    onCostData(callback: (sessionId: string, costData: CostData) => void): () => void;
    onSessionName(callback: (sessionId: string, name: string, cliSessionId: string) => void): () => void;
    /** The conversation a resumed tab actually opened (a background session it followed), when not the one asked for. */
    onConversationResolved(callback: (sessionId: string, cliSessionId: string, attachShort: string | null, reason: 'handoff' | 'job' | null) => void): () => void;
    resyncStatus(): void;
  };
  fs: {
    isDirectory(path: string): Promise<boolean>;
    expandPath(path: string): Promise<string>;
    listDirs(dirPath: string, prefix?: string): Promise<string[]>;
    browseDirectory(): Promise<string | null>;
    listFiles(cwd: string, query: string): Promise<string[]>;
    exists(filePath: string): Promise<boolean>;
    readFile(filePath: string): Promise<ReadFileResult>;
    readImage(filePath: string): Promise<{ dataUrl: string } | null>;
    showInFolder(targetPath: string): Promise<{ ok: boolean; error?: string }>;
    watchDir(dirPath: string): void;
    unwatchDir(dirPath: string): void;
    onFsChange(callback: (changes: FsChange[]) => void): () => void;
    previewTree(dirPath: string): Promise<PreviewTreeNode | null>;
  };
  store: {
    load(): Promise<unknown>;
    save(state: unknown): Promise<void>;
  };
  profiles: {
    provision(profileId: string, customPath?: string): Promise<{ configDir: string; managed: boolean }>;
  };
  provider: {
    getConfig(providerId: ProviderId, projectPath: string): Promise<ProviderConfig>;
    getMeta(providerId: ProviderId): Promise<CliProviderMeta>;
    listProviders(): Promise<CliProviderMeta[]>;
    watchProject(providerId: ProviderId, projectPath: string): void;
    onConfigChanged(callback: () => void): () => void;
  };
  /** @deprecated Use provider namespace */
  claude: {
    getConfig(projectPath: string): Promise<ProviderConfig>;
  };
  git: {
    getStatus(path: string): Promise<unknown>;
    getFiles(path: string): Promise<unknown>;
    getDiff(path: string, file: string, area: string): Promise<string>;
    getWorktrees(path: string): Promise<GitWorktree[]>;
    watchProject(path: string): void;
    onChanged(callback: () => void): () => void;
  };
  update: {
    checkNow(): Promise<void>;
    install(): Promise<void>;
    onAvailable(cb: (info: { version: string }) => void): () => void;
    onDownloadProgress(cb: (info: { percent: number }) => void): () => void;
    onDownloaded(cb: (info: { version: string }) => void): () => void;
    onError(cb: (info: { message: string }) => void): () => void;
  };
  app: {
    focus(): void;
    getVersion(): Promise<string>;
    openExternal(url: string): Promise<void>;
    onQuitting(callback: () => void): () => void;
    /** Match the native window chrome (title bar) to the app theme. */
    setNativeTheme(theme: 'dark' | 'light'): void;
  };
  skills: {
    list(projectPath?: string): Promise<SkillInfo[]>;
    setEnabled(name: string, scope: SkillScope, projectPath: string | undefined, enabled: boolean): Promise<{ ok: boolean; error?: string }>;
  };
  plugins: {
    list(): Promise<PluginInfo[]>;
    setEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }>;
  };
  claudeHistory: {
    list(force?: boolean): Promise<ClaudeConversationList>;
    usage(force?: boolean): Promise<ClaudeUsageReport>;
    trash(transcriptPath: string): Promise<{ ok: boolean; error?: string; reason?: 'open' | 'background' | 'recent' }>;
    changes(cliSessionId: string): Promise<ConversationChanges | null>;
    transcriptPath(cliSessionId: string): Promise<string | null>;
    onChanged(callback: () => void): () => void;
    stopBackground(short: string, profileId?: string): Promise<{ ok: boolean; error?: string }>;
  };
  clipboard: {
    write(text: string, source?: ClipboardSource): Promise<void>;
  };
  menu: {
    onNewProject(callback: () => void): () => void;
    onNewSession(callback: () => void): () => void;
    onToggleSplit(callback: () => void): () => void;
    onNextSession(callback: () => void): () => void;
    onPrevSession(callback: () => void): () => void;
    onGotoSession(callback: (index: number) => void): () => void;
    onToggleDebug(callback: () => void): () => void;
    onToggleInspector(callback: () => void): () => void;
    onCloseSession(callback: () => void): () => void;
  };
}
