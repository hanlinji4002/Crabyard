// Shared type definitions used across main, preload, and renderer processes.

import type { TeamDomain } from './team-config.js';

export const ZOOM_MIN = 0.75;
export const ZOOM_MAX = 2.0;

// --- Provider ---

export type ProviderId = 'claude' | 'codex' | 'copilot' | 'gemini';
export type PendingPromptTrigger = 'session-start' | 'first-output' | 'startup-arg';

/**
 * UI language tag. Defined here (rather than imported from `renderer/i18n.ts`)
 * because `shared/` is the lowest common denominator between main and
 * renderer; the renderer is the source of truth for the actual catalog.
 */
export type Locale = 'en' | 'zh-CN';

export interface CliProviderCapabilities {
  sessionResume: boolean;
  costTracking: boolean;
  contextWindow: boolean;
  hookStatus: boolean;
  configReading: boolean;
  shiftEnterNewline: boolean;
  pendingPromptTrigger: PendingPromptTrigger;
  planModeArg?: string;
  systemPromptInjection: boolean;
}

export interface CliProviderMeta {
  id: ProviderId;
  displayName: string;
  binaryName: string;
  capabilities: CliProviderCapabilities;
  defaultContextWindowSize: number;
}

// --- Git ---

export interface GitWorktree {
  path: string;
  head: string;
  branch: string | null;
  isBare: boolean;
}

export interface GitFileEntry {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
  area: 'staged' | 'working' | 'untracked' | 'conflicted';
}

// --- Provider Config ---

export interface McpServer { name: string; url: string; status: string; scope: 'user' | 'project'; filePath: string }
export interface Agent { name: string; model: string; category: 'plugin' | 'built-in'; scope: 'user' | 'project'; filePath: string }
export interface Skill { name: string; description: string; scope: 'user' | 'project'; filePath: string }
export interface Command { name: string; description: string; scope: 'user' | 'project'; filePath: string }
export interface ProviderConfig { mcpServers: McpServer[]; agents: Agent[]; skills: Skill[]; commands: Command[] }
export type ClaudeConfig = ProviderConfig;

// --- Cost / Context (shared with renderer modules) ---

export interface CostInfo {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalDurationMs: number;
  totalApiDurationMs: number;
  model?: string;
}

export interface ContextWindowInfo {
  totalTokens: number;
  contextWindowSize: number;
  usedPercentage: number;
}

// --- Session / State ---

export type SessionType =
  | 'diff-viewer'
  | 'file-reader'
  | 'team';

export interface SessionRecord {
  id: string;
  name: string;
  type?: SessionType;
  providerId?: ProviderId;
  args?: string;
  /** Custom environment variables (raw `KEY=VALUE` lines) injected into the PTY on spawn. */
  envVars?: string;
  cliSessionId: string | null;
  diffFilePath?: string;
  diffArea?: string;
  worktreePath?: string;
  fileReaderPath?: string;
  fileReaderLine?: number;
  createdAt: string;
  userRenamed?: boolean;
  cost?: CostInfo;
  contextWindow?: ContextWindowInfo;
  /** Persisted: identifies which TeamMember spawned this session, if any. */
  teamMemberId?: string;
  /** Persisted, sticky: which Profile backs this session's CLI config dir. Resume must reuse it. */
  profileId?: string;
  /** Transient: initial prompt to inject on first spawn. Not persisted. */
  pendingInitialPrompt?: string;
  /** Transient: system prompt to attach on first spawn. Not persisted (resume must not re-inject). */
  pendingSystemPrompt?: string;
}

// --- Team ---

export interface TeamMember {
  id: string;
  name: string;
  role: string;
  description?: string;
  domain?: TeamDomain;
  systemPrompt: string;
  source: 'predefined' | 'custom';
  sourceUrl?: string;
  createdAt: number;
  updatedAt: number;
  /** When true, member is mirrored as a CLI-provider agent file at ~/.<cli>/agents/<slug>.md. */
  installAsAgent?: boolean;
  /** Sticky slug assigned on first install; preserved across renames so the right file is removed. */
  agentSlug?: string;
}

export interface TeamData {
  members: TeamMember[];
  predefinedCache?: { fetchedAt: number; suggestions: TeamMember[] };
}

// --- CLI Provider Profiles ---

/**
 * A named CLI-provider profile backed by a separate config directory, injected
 * via the provider's config-dir env var (e.g. CLAUDE_CONFIG_DIR). Lets a user
 * isolate multiple licenses/logins (work vs personal). Currently only the
 * 'claude' provider injects it; the interface stays uniform for future providers.
 */
export interface Profile {
  id: string;
  name: string;
  providerId: ProviderId;
  /** Absolute, resolved config dir (managed under ~/.vibeyard/profiles/<id> or a custom path). */
  configDir: string;
  /** True when configDir is the auto-managed path; false when the user supplied a custom path. */
  managed: boolean;
  createdAt: number;
}

export interface ArchivedSession {
  id: string;
  name: string;
  providerId: ProviderId;
  cliSessionId: string | null;
  createdAt: string;
  closedAt: string;
  bookmarked?: boolean;
  teamMemberId?: string;
  /** Preserved so a resumed session reuses the same profile config dir (CLAUDE_CONFIG_DIR). */
  profileId?: string;
  cost: {
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalDurationMs: number;
  } | null;
}

export interface InitialContextSnapshot {
  sessionId: string;
  timestamp: string;
  totalTokens: number;
  contextWindowSize: number;
  usedPercentage: number;
}

export interface DeepSearchResult {
  providerId: ProviderId;
  cliSessionId: string;
  projectSlug: string;
  projectCwd: string;
  snippet: string;
  score: number;
  /** Title derived from the first user message — fallback when Vibeyard has no name for this session. */
  derivedName?: string;
  /** Profile whose config dir holds this transcript, so resume reopens under the right CLAUDE_CONFIG_DIR. */
  profileId?: string;
}

export interface ProjectInsightsData {
  initialContextSnapshots: InitialContextSnapshot[];
  dismissed: string[];
}

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  sessions: SessionRecord[];
  activeSessionId: string | null;
  layout: {
    mode: 'tabs' | 'split' | 'swarm';
    splitPanes: string[];
    splitDirection: 'horizontal' | 'vertical';
  };
  sessionHistory?: ArchivedSession[];
  insights?: ProjectInsightsData;
  defaultArgs?: string;
  /** Default profile applied to new sessions in this project (overridden per-session). */
  defaultProfileId?: string;
  defaultEnv?: string;
  terminalPanelOpen?: boolean;
  terminalPanelHeight?: number;
}

export interface Preferences {
  soundOnSessionWaiting: boolean;
  notificationsDesktop: boolean;
  debugMode: boolean;
  sessionHistoryEnabled: boolean;
  insightsEnabled: boolean;
  autoTitleEnabled: boolean;
  confirmCloseWorkingSession: boolean;
  zoomFactor?: number;
  defaultProvider?: ProviderId;
  /** UI language tag. See `Locale` for the supported set. */
  locale?: Locale;
  /** Global fallback profile applied when neither the session nor the project specifies one. */
  defaultProfileId?: string;
  statusLineConsent?: 'granted' | 'declined' | null;
  // The foreign statusLine command the user was asked about when they made
  // the consent decision. Used to detect new conflicts (different command)
  // vs the previously-acknowledged one.
  statusLineConsentCommand?: string | null;
  copyOnSelect?: boolean;
  keybindings?: Record<string, string>;
  theme?: 'dark' | 'light';
  sidebarViews?: {
    gitPanel: boolean;
    sessionHistory: boolean;
    discussions: boolean;
    fileTree: boolean;
    /** Show the global cross-project "Active Sessions" section in the sidebar. */
    activeSessions: boolean;
  };
  /**
   * Which live session statuses count as "active" for the global Active Sessions
   * sidebar section. Absent ⇒ the default set (working, input, completed).
   */
  activeSessionStatuses?: {
    working: boolean;
    waiting: boolean;
    input: boolean;
    completed: boolean;
  };
}

// --- Settings Validation ---

export interface SettingsValidationResult {
  statusLine: 'missing' | 'vibeyard' | 'foreign';
  hooks: 'missing' | 'complete' | 'partial';
  foreignStatusLineCommand?: string;
  hookDetails: Record<string, boolean>;
}

export interface SettingsWarningData {
  sessionId: string;
  statusLine: SettingsValidationResult['statusLine'];
  hooks: SettingsValidationResult['hooks'];
}

export interface StatusLineConflictData {
  foreignCommand: string;
}

export interface PersistedState {
  version: 1;
  projects: ProjectRecord[];
  activeProjectId: string | null;
  preferences: Preferences;
  sidebarWidth?: number;
  sidebarCollapsed?: boolean;
  lastSeenVersion?: string;
  appLaunchCount?: number;
  starPromptDismissed?: boolean;
  team?: TeamData;
  /** Global, provider-scoped CLI profiles (e.g. Claude work/personal config dirs). */
  profiles?: Profile[];
}

// --- Cost / Context ---

/** One usage window in Claude Code's statusLine `rate_limits` (subscribers only). */
export interface RateLimitWindowPayload {
  used_percentage?: number | null;
  /** Unix seconds. */
  resets_at?: number | null;
}

export interface RateLimitsPayload {
  five_hour?: RateLimitWindowPayload | null;
  seven_day?: RateLimitWindowPayload | null;
}

export interface CostData {
  cost: { total_cost_usd: number; total_duration_ms: number; total_api_duration_ms: number };
  model?: string;
  /** Claude statusLine extras: model id, effort level, thinking toggle, fast mode. */
  model_id?: string;
  effort?: string;
  thinking?: boolean;
  fast_mode?: boolean;
  /** Plan usage limits, account-wide; shown in the Current usage panel. */
  rate_limits?: RateLimitsPayload | null;
  context_window: {
    total_input_tokens: number;
    total_output_tokens: number;
    context_window_tokens?: number;
    context_window_size?: number;
    used_percentage?: number;
    current_usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    };
  };
}

// --- Tool Failure ---

/**
 * A tool signal from a CLI hook, dispatched by consumers on `tool_name`.
 *
 * Not strictly a *failure*: a `Read` truncated at the token cap is a successful
 * tool call that still arrives here, tagged with `TOKEN_TRUNCATION_SENTINEL`,
 * because it needs the same one-shot file → IPC delivery. Adding a parallel
 * channel would cost a KNOWN_EXTENSIONS entry, a second suffix-stripping branch
 * in `extractSessionId`, an IPC channel and a preload binding — to reach
 * consumers that would still filter by `tool_name` anyway.
 */
export interface ToolFailureData {
  tool_name: string;
  tool_input: Record<string, unknown>;
  error: string;
}

// --- Session Inspector ---

export type InspectorEventType =
  // Core 7 (status + inspector)
  | 'session_start' | 'user_prompt' | 'tool_use' | 'tool_failure'
  | 'stop' | 'stop_failure' | 'permission_request'
  // Inspector-only events
  | 'permission_denied'
  | 'pre_tool_use'
  | 'subagent_start' | 'subagent_stop'
  | 'notification'
  | 'pre_compact' | 'post_compact'
  | 'session_end'
  | 'task_created' | 'task_completed'
  | 'worktree_create' | 'worktree_remove'
  | 'cwd_changed' | 'file_changed' | 'config_change'
  | 'elicitation' | 'elicitation_result'
  | 'instructions_loaded'
  | 'teammate_idle'
  | 'status_update';

export interface InspectorEvent {
  type: InspectorEventType;
  timestamp: number;
  hookEvent: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  error?: string;
  cost_snapshot?: { total_cost_usd: number; total_duration_ms: number };
  context_snapshot?: { total_tokens: number; context_window_size: number; used_percentage: number };
  // Copied verbatim from the hook payload by INSPECTOR_FIELDS in claude-cli.ts.
  // Keep the two lists in step — a name here with no counterpart there is dead.
  tool_use_id?: string;
  duration_ms?: number;
  is_interrupt?: boolean;
  agent_id?: string;
  agent_type?: string;
  agent_transcript_path?: string;
  last_assistant_message?: string;
  prompt?: string;
  message?: string;
  title?: string;
  notification_type?: string;
  source?: string;
  model?: string;
  reason?: string;
  error_details?: string;
  trigger?: string;
  task_id?: string;
  task_subject?: string;
  task_description?: string;
  team_name?: string;
  teammate_name?: string;
  worktree_path?: string;
  file_path?: string;
  event?: string;
  new_cwd?: string;
  old_cwd?: string;
  load_reason?: string;
  memory_type?: string;
  mcp_server_name?: string;
  /** Elicitation discriminator: 'form' | 'url'. */
  mode?: string;
  action?: string;
  elicitation_id?: string;
  content?: string;
  url?: string;
}

export interface ToolUsageStats {
  tool_name: string;
  calls: number;
  failures: number;
  totalCost: number;
}

export interface ContextDataPoint {
  timestamp: number;
  usedPercentage: number;
  totalTokens: number;
}

// --- Filesystem IPC ---

/** A single filesystem change emitted by the directory watcher (chokidar-backed). */
export type FsChangeType = 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir';

export interface FsChange {
  /** Absolute path of the entry that changed. */
  path: string;
  /** Absolute path of the parent directory (the watched dir the change belongs to). */
  dir: string;
  type: FsChangeType;
}

export type ReadFileResult =
  | { ok: true; content: string }
  | { ok: false; reason: 'binary' | 'error' };

export type FileStatResult =
  | { ok: true; size: number; mtimeMs: number }
  | { ok: false };

/**
 * Why a clipboard write happened. The renderer reports intent; the main process
 * owns what each one means per platform (on Linux a 'selection' copy also
 * populates the X11 PRIMARY selection so middle-click paste works).
 */
export type ClipboardSource = 'selection' | 'explicit';

// --- Claude transcript history & usage (sidebar 对话 / Usage views) ---

/** One top-level Claude Code conversation found under a `.../projects/<slug>/` dir. */
export interface ClaudeConversation {
  cliSessionId: string;
  transcriptPath: string;
  /** Working directory recorded in the transcript; '' when the file has none. */
  projectCwd: string;
  projectSlug: string;
  /** Claude profile whose config dir holds this transcript (undefined = ~/.claude). */
  profileId?: string;
  /** False when `projectCwd` no longer exists on disk (resume would fail). */
  cwdExists: boolean;
  title: string;
  titleSource: 'custom' | 'ai' | 'prompt' | 'command' | 'none';
  firstPrompt: string;
  /** Real user turns (prompts + slash/bang commands), excluding tool results and meta messages. */
  turns: number;
  startedAt: number;
  updatedAt: number;
  gitBranch?: string;
  model?: string;
}

/** A folder in the sidebar's 文件 view: its previewable files and the subfolders that hold some. */
export interface PreviewTreeNode {
  name: string;
  path: string;
  dirs: PreviewTreeNode[];
  files: Array<{ name: string; path: string; mtimeMs: number }>;
  /** The walk stopped early (too deep or too many entries), so some files may be missing. */
  truncated?: boolean;
}

export interface ClaudeConversationList {
  conversations: ClaudeConversation[];
  scannedAt: number;
}

/** Token + cost totals for one (local date, model, project) cell. */
/** One diff hunk from a Claude edit, lines prefixed '+', '-' or ' '. */
export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: string[];
}

/** What a conversation did to one file (right-column 本轮修改 / 本对话修改). */
export interface FileChange {
  /** Absolute path as Claude wrote it. */
  path: string;
  added: number;
  removed: number;
  /** A Write created the file. */
  created: boolean;
  /** Edit / Write operations folded into this entry. */
  edits: number;
  /** The edits' hunks, capped; `truncated` when some were dropped. */
  hunks: DiffHunk[];
  truncated: boolean;
}

/** Where a Claude Code skill lives: ~/.claude/skills or the project's .claude/skills. */
export type SkillScope = 'user' | 'project';

export interface SkillInfo {
  name: string;
  description: string;
  scope: SkillScope;
  /** The skill's folder. */
  dir: string;
  /** False when a `skillOverrides` entry turns it off. */
  enabled: boolean;
  /** The raw `skillOverrides` value, if any ("off", "name-only", …). */
  override: string | null;
}

/** A Claude Code plugin, as `claude plugin list --json` reports it. */
export interface PluginInfo {
  /** `name@marketplace`. */
  id: string;
  name: string;
  marketplace: string;
  version: string;
  scope: string;
  enabled: boolean;
  description: string;
}

export interface ConversationChanges {
  cliSessionId: string;
  /** Working directory recorded in the transcript ('' when unknown). */
  cwd: string;
  /** Real user turns so far. */
  turns: number;
  /** The latest turn and the files it changed; null before the first prompt. */
  lastTurn: { index: number; prompt: string; startedAt: number; files: FileChange[] } | null;
  /** Every file the conversation changed, in first-edited order. */
  total: FileChange[];
}

export interface ClaudeUsageRow {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  model: string;
  /** Working directory the usage is attributed to ('' when unknown). */
  project: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  requests: number;
}

export interface ClaudeUsageReport {
  generatedAt: number;
  rows: ClaudeUsageRow[];
  /** Models seen in transcripts with no known price (their cost counts as 0). */
  unpricedModels: string[];
}
