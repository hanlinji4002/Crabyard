import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { loadState } from './store';
import { UUID_RE } from './providers/transcript-utils';
import { listBackgroundJobs, liveBackgroundJob, type BackgroundJob } from './claude-jobs';
import { estimateCostUsd, normalizeModelId } from '../shared/claude-pricing';
import type {
  ClaudeConversation,
  ClaudeConversationList,
  ClaudeUsageReport,
  ClaudeUsageRow,
} from '../shared/types';

// Reads every Claude Code transcript (`<config>/projects/**/*.jsonl`) to back the
// sidebar's conversation tree and usage view. Top-level `<slug>/<uuid>.jsonl`
// files are conversations; nested files (subagents, workflows) only contribute
// usage. Each file is digested once and cached until its mtime/size changes, so
// a refresh after the first scan only re-reads transcripts that were written to.

const MAX_PROMPT_CHARS = 160;
/** Refresh requests arriving within this window reuse the previous scan. */
const SCAN_REUSE_MS = 3000;

interface UsageRecord {
  /** `message.id:requestId`, shared by every streamed chunk of one API response. */
  key: string;
  ts: number;
  model: string;
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  fast: boolean;
}

export interface TranscriptDigest {
  cwd: string;
  customTitle?: string;
  agentName?: string;
  aiTitle?: string;
  firstPrompt?: string;
  firstCommand?: string;
  turns: number;
  firstTs: number;
  lastTs: number;
  gitBranch?: string;
  lastModel?: string;
  usage: UsageRecord[];
  /** The background session this conversation was handed off to, unless it went on here afterwards. */
  continuedIn?: string;
  /** Holds at least one message record (a `"parentUuid":` line): more than titles and settings. */
  hasMessages?: boolean;
}

interface TranscriptFile {
  filePath: string;
  slug: string;
  profileId?: string;
  /** Set for top-level `<slug>/<uuid>.jsonl` conversation files. */
  cliSessionId?: string;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  digest: TranscriptDigest;
}

const cache = new Map<string, CacheEntry>();
let files: TranscriptFile[] = [];
let lastScanAt = 0;
let inFlight: Promise<void> | null = null;
let rootsOverride: Map<string, string | undefined> | null = null;

export function _resetForTesting(roots?: Map<string, string | undefined>): void {
  cache.clear();
  files = [];
  lastScanAt = 0;
  inFlight = null;
  rootsOverride = roots ?? null;
  transcriptPaths.clear();
}

export function createDigest(): TranscriptDigest {
  return { cwd: '', turns: 0, firstTs: 0, lastTs: 0, usage: [] };
}

// --- Prompt cleanup -------------------------------------------------------

/** Wrapper tags Claude Code injects around non-typed content; never a real prompt. */
const SKIP_PREFIX_RE =
  /^(?:<(?:task-notification|local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr|system-reminder|user-memory-input)\b|Caveat: The messages below|\[Request interrupted)/;
const STRIP_BLOCK_RE = /<(system-reminder|ide_[a-z_]+)\b[^>]*>[\s\S]*?<\/\1>/g;
const PASTED_RE = /<pasted_content\b[^>]*>([\s\S]*?)<\/pasted_content>/g;

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_PROMPT_CHARS ? flat.slice(0, MAX_PROMPT_CHARS - 1).trimEnd() + '…' : flat;
}

/**
 * Classify one user message's text: a typed prompt, a slash/bang command, or
 * injected content that should not count as a turn.
 */
export function cleanUserText(raw: string): { kind: 'prompt' | 'command' | 'skip'; text: string } {
  let text = raw.trim();
  if (!text || SKIP_PREFIX_RE.test(text)) return { kind: 'skip', text: '' };

  const commandName = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim();
  if (commandName) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
    const name = commandName.startsWith('/') ? commandName : `/${commandName}`;
    return { kind: 'command', text: oneLine(args ? `${name} ${args}` : name) };
  }
  const bash = /^<bash-input>([\s\S]*?)<\/bash-input>/.exec(text)?.[1]?.trim();
  if (bash) return { kind: 'command', text: oneLine(`!${bash}`) };

  text = text.replace(STRIP_BLOCK_RE, '').trim();
  if (!text) return { kind: 'skip', text: '' };

  if (text.includes('<pasted_content')) {
    const pasted: string[] = [];
    const rest = text.replace(PASTED_RE, (_m, inner: string) => {
      pasted.push(inner);
      return ' ';
    }).trim();
    if (rest) return { kind: 'prompt', text: oneLine(rest) };
    const first = pasted.join(' ').trim();
    return first ? { kind: 'prompt', text: oneLine(first) } : { kind: 'skip', text: '' };
  }
  return { kind: 'prompt', text: oneLine(text) };
}

export function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const t = (block as { text?: unknown }).text;
      if (typeof t === 'string') text += (text ? '\n' : '') + t;
    }
  }
  return text;
}

// --- Hand-offs to background sessions ---------------------------------------

// Claude Code's "background this conversation" gesture (← on an empty prompt,
// clicking a /fork's name) moves a conversation to a new background session
// and appends {"type":"continued-in","continuedInSessionId":B} to the old
// transcript. The newest such record counts until a completed turn follows it
// (the conversation went on in the foreground after all); a user's prompt or a
// finished reply is one. The CLI reads the record the same way (2.1.283).

const CONTINUED_IN = '"type":"continued-in"';
const PARENT_UUID = '"parentUuid":';

/** How one line bears on a hand-off: where the conversation went, a completed turn, or neither. */
export function handoffLine(line: string): { continuedIn: string } | 'turn' | null {
  const continued = line.includes(CONTINUED_IN);
  if (!continued && !line.includes('"type":"user"') && !line.includes('"type":"assistant"')) return null;
  let e: Record<string, any>;
  try {
    e = JSON.parse(line);
  } catch {
    return null;
  }
  if (e.type === 'continued-in') {
    const to = e.continuedInSessionId;
    return typeof to === 'string' && UUID_RE.test(to) ? { continuedIn: to } : null;
  }
  if (e.isSidechain) return null;
  if (e.type === 'assistant') return e.isApiErrorMessage !== true && typeof e.message?.stop_reason === 'string' ? 'turn' : null;
  if (e.type === 'user' && !e.isMeta) return cleanUserText(extractUserText(e.message?.content)).kind !== 'skip' ? 'turn' : null;
  return null;
}

/** Where a conversation was handed off to, from the tail of its transcript (synchronous). */
export function readContinuedIn(transcriptPath: string, maxBytes = 8 * 1024 * 1024): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    for (let window = 256 * 1024; ; window *= 4) {
      const len = Math.min(window, size, maxBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= (len < size ? 1 : 0); i--) {
        const hit = handoffLine(lines[i]);
        if (hit === 'turn') return undefined;
        if (hit) return hit.continuedIn;
      }
      if (len >= size || len >= maxBytes) return undefined;
    }
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/** A transcript that holds messages, not just titles: what makes a hand-off's target real. */
export function transcriptHasMessages(transcriptPath: string, maxBytes = 16 * 1024 * 1024): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const chunk = Buffer.alloc(1024 * 1024);
    let carry = '';
    for (let pos = 0; pos < maxBytes; ) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
      if (n <= 0) return false;
      const text = carry + chunk.subarray(0, n).toString('latin1');
      if (text.includes(PARENT_UUID)) return true;
      carry = text.slice(-PARENT_UUID.length);
      pos += n;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

// --- Line digestion -------------------------------------------------------

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

function readTitle(line: string, field: string): string | undefined {
  try {
    const value = JSON.parse(line)[field];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fold one JSONL line into the digest. Only user/assistant/title lines are
 * parsed; attachments, file snapshots and queue records are skipped by a cheap
 * substring check (JSON.stringify never emits whitespace around `:`).
 */
export function applyTranscriptLine(d: TranscriptDigest, line: string, fallbackKey: string): void {
  if (line.length < 2) return;
  if (!d.hasMessages && line.includes(PARENT_UUID)) d.hasMessages = true;
  if (line.startsWith('{"type":"continued-in"')) {
    const hit = handoffLine(line);
    if (hit && hit !== 'turn') d.continuedIn = hit.continuedIn;
    return;
  }
  if (line.startsWith('{"type":"custom-title"')) { d.customTitle = readTitle(line, 'customTitle') ?? d.customTitle; return; }
  if (line.startsWith('{"type":"agent-name"')) { d.agentName = readTitle(line, 'agentName') ?? d.agentName; return; }
  if (line.startsWith('{"type":"ai-title"')) { d.aiTitle = readTitle(line, 'aiTitle') ?? d.aiTitle; return; }
  if (line.startsWith('{"type":"summary"')) { d.aiTitle = d.aiTitle ?? readTitle(line, 'summary'); return; }

  const maybeAssistant = line.includes('"type":"assistant"');
  if (!maybeAssistant && !line.includes('"type":"user"')) return;

  let e: Record<string, any>;
  try {
    e = JSON.parse(line);
  } catch {
    return; // partial write at the tail of a live transcript
  }
  if (e.type !== 'user' && e.type !== 'assistant') return;

  const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
  if (!Number.isNaN(ts)) {
    if (!d.firstTs || ts < d.firstTs) d.firstTs = ts;
    if (ts > d.lastTs) d.lastTs = ts;
  }
  if (!d.cwd && typeof e.cwd === 'string') d.cwd = e.cwd;
  if (typeof e.gitBranch === 'string' && e.gitBranch && e.gitBranch !== 'HEAD') d.gitBranch = e.gitBranch;

  if (e.type === 'assistant') {
    const message = e.message;
    // A finished reply after a hand-off: the conversation went on here.
    if (d.continuedIn && !e.isSidechain && e.isApiErrorMessage !== true && typeof message?.stop_reason === 'string') d.continuedIn = undefined;
    const model = typeof message?.model === 'string' ? message.model : '';
    if (!model || model === '<synthetic>') return;
    d.lastModel = model;
    const u = message.usage;
    if (!u || typeof u !== 'object') return;
    const cacheWriteTotal = num(u.cache_creation_input_tokens);
    const cacheWrite1h = Math.min(num(u.cache_creation?.ephemeral_1h_input_tokens), cacheWriteTotal);
    const key = typeof message.id === 'string' && typeof e.requestId === 'string'
      ? `${message.id}:${e.requestId}`
      : fallbackKey;
    d.usage.push({
      key,
      ts: Number.isNaN(ts) ? d.lastTs : ts,
      model,
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      cacheWrite5m: cacheWriteTotal - cacheWrite1h,
      cacheWrite1h,
      cacheRead: num(u.cache_read_input_tokens),
      fast: u.speed === 'fast',
    });
    return;
  }

  if (e.isMeta || e.isSidechain) return;
  const { kind, text } = cleanUserText(extractUserText(e.message?.content));
  if (kind === 'skip') return;
  d.turns++;
  d.continuedIn = undefined;
  if (kind === 'command') d.firstCommand = d.firstCommand ?? text;
  else d.firstPrompt = d.firstPrompt ?? text;
}

async function digestFile(filePath: string): Promise<TranscriptDigest> {
  const d = createDigest();
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNo = 0;
  try {
    for await (const line of rl) {
      lineNo++;
      applyTranscriptLine(d, line, `${filePath}#${lineNo}`);
    }
  } finally {
    rl.close();
    input.destroy();
  }
  return d;
}

// --- Discovery ------------------------------------------------------------

function projectRoots(): Map<string, string | undefined> {
  if (rootsOverride) return rootsOverride;
  const roots = new Map<string, string | undefined>([[path.join(os.homedir(), '.claude', 'projects'), undefined]]);
  try {
    for (const profile of loadState().profiles ?? []) {
      if (profile.providerId !== 'claude') continue;
      const root = path.join(profile.configDir, 'projects');
      if (!roots.has(root)) roots.set(root, profile.id);
    }
  } catch {
    // Profiles unavailable — default root only.
  }
  return roots;
}

async function walkJsonl(dir: string, out: string[], depth: number): Promise<void> {
  if (depth > 6) return;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkJsonl(full, out, depth + 1);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
}

async function discoverFiles(): Promise<TranscriptFile[]> {
  const out: TranscriptFile[] = [];
  for (const [root, profileId] of projectRoots()) {
    let slugs: fs.Dirent[];
    try {
      slugs = await fs.promises.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const slugEntry of slugs) {
      if (!slugEntry.isDirectory()) continue;
      const slugDir = path.join(root, slugEntry.name);
      const found: string[] = [];
      await walkJsonl(slugDir, found, 0);
      for (const filePath of found) {
        const isTopLevel = path.dirname(filePath) === slugDir;
        const base = path.basename(filePath, '.jsonl');
        out.push({
          filePath,
          slug: slugEntry.name,
          profileId,
          cliSessionId: isTopLevel && UUID_RE.test(base) ? base : undefined,
        });
      }
    }
  }
  return out;
}

async function scan(): Promise<void> {
  const discovered = await discoverFiles();
  const live = new Set<string>();
  for (const file of discovered) {
    live.add(file.filePath);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(file.filePath);
    } catch {
      continue;
    }
    const cached = cache.get(file.filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) continue;
    try {
      cache.set(file.filePath, { mtimeMs: stat.mtimeMs, size: stat.size, digest: await digestFile(file.filePath) });
    } catch {
      // Unreadable right now; keep any previous digest.
    }
  }
  for (const key of cache.keys()) {
    if (!live.has(key)) cache.delete(key);
  }
  files = discovered;
  lastScanAt = Date.now();
}

async function ensureScanned(force = false): Promise<void> {
  if (inFlight) return inFlight;
  if (!force && Date.now() - lastScanAt < SCAN_REUSE_MS) return;
  inFlight = scan().finally(() => { inFlight = null; });
  return inFlight;
}

// --- Public API -----------------------------------------------------------

function resolveTitle(d: TranscriptDigest): { title: string; titleSource: ClaudeConversation['titleSource'] } {
  if (d.customTitle) return { title: d.customTitle, titleSource: 'custom' };
  if (d.agentName) return { title: d.agentName, titleSource: 'custom' };
  if (d.aiTitle) return { title: d.aiTitle, titleSource: 'ai' };
  if (d.firstPrompt) return { title: d.firstPrompt, titleSource: 'prompt' };
  if (d.firstCommand) return { title: d.firstCommand, titleSource: 'command' };
  return { title: '', titleSource: 'none' };
}

const transcriptPaths = new Map<string, string>();

/** Where a conversation's transcript lives, looked up across every projects root. */
export function findTranscriptPath(cliSessionId: string): string | null {
  if (!UUID_RE.test(cliSessionId)) return null;
  const cached = transcriptPaths.get(cliSessionId);
  if (cached && fs.existsSync(cached)) return cached;
  for (const root of projectRoots().keys()) {
    let dirs: string[];
    try {
      dirs = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const dir of dirs) {
      const candidate = path.join(root, dir, `${cliSessionId}.jsonl`);
      if (fs.existsSync(candidate)) {
        transcriptPaths.set(cliSessionId, candidate);
        return candidate;
      }
    }
  }
  return null;
}

/**
 * The paths that make up one conversation, for moving it to the Trash: the
 * transcript plus the sidecar folder Claude Code keeps beside it (subagent
 * transcripts, large tool results). Null unless `transcriptPath` is a
 * top-level `<projects root>/<project>/<session id>.jsonl` file — the renderer
 * never gets to name arbitrary files.
 */
export function conversationPathsForTrash(transcriptPath: unknown): string[] | null {
  if (typeof transcriptPath !== 'string' || !transcriptPath.endsWith('.jsonl')) return null;
  const resolved = path.resolve(transcriptPath);
  const root = path.dirname(path.dirname(resolved));
  if (![...projectRoots().keys()].some((r) => path.resolve(r) === root)) return null;
  if (!UUID_RE.test(path.basename(resolved, '.jsonl'))) return null;
  try {
    if (!fs.statSync(resolved).isFile()) return null;
  } catch {
    return null;
  }
  const out = [resolved];
  const sidecar = resolved.slice(0, -'.jsonl'.length);
  try {
    if (fs.statSync(sidecar).isDirectory()) out.push(sidecar);
  } catch {
    // no sidecar folder
  }
  return out;
}

/** How recently a transcript may have been written to and still be trashed. */
const TRASH_QUIET_MS = 60_000;

/**
 * Why a conversation's transcript must not go to the Trash right now: a tab
 * has it open, Claude Code runs it as a live background session (/fork), or
 * something wrote to it a moment ago. Trashing a transcript that is still
 * being written only makes the CLI start a new file without the history.
 * `transcriptPath` is one conversationPathsForTrash accepted.
 */
export function conversationBusy(transcriptPath: string): 'open' | 'background' | 'recent' | null {
  const cliSessionId = path.basename(transcriptPath, '.jsonl');
  let openIds: string[] = [];
  try {
    openIds = (loadState().projects ?? []).flatMap((p) => p.sessions.map((s) => s.cliSessionId ?? ''));
  } catch {
    // no saved state: nothing is open
  }
  if (openIds.includes(cliSessionId)) return 'open';
  // <config dir>/projects/<project folder>/<session id>.jsonl
  const configDir = path.dirname(path.dirname(path.dirname(transcriptPath)));
  if (liveBackgroundJob(cliSessionId, configDir)) return 'background';
  try {
    if (Date.now() - fs.statSync(transcriptPath).mtimeMs < TRASH_QUIET_MS) return 'recent';
  } catch {
    // gone already: let the trash call report it
  }
  return null;
}

/** Drop a trashed conversation (and its sidecar files) from the scan cache. */
export function forgetConversation(transcriptPath: string): void {
  const resolved = path.resolve(transcriptPath);
  const sidecar = resolved.slice(0, -'.jsonl'.length) + path.sep;
  const gone = (f: string) => f === resolved || f.startsWith(sidecar);
  files = files.filter((f) => !gone(f.filePath));
  for (const key of [...cache.keys()]) if (gone(key)) cache.delete(key);
}

/** Background sessions (/fork, /background) under every projects root, by session id. */
function backgroundJobs(): Map<string, BackgroundJob & { profileId?: string }> {
  const out = new Map<string, BackgroundJob & { profileId?: string }>();
  for (const [root, profileId] of projectRoots()) {
    for (const job of listBackgroundJobs(path.dirname(root))) {
      if (!out.has(job.sessionId)) out.set(job.sessionId, { ...job, profileId });
    }
  }
  return out;
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

function backgroundFields(job: BackgroundJob | undefined): Pick<ClaudeConversation, 'background' | 'forkOf'> {
  if (!job) return {};
  return {
    background: { short: job.short, live: job.live, state: job.state },
    ...(job.forkParentSessionId ? { forkOf: job.forkParentSessionId } : {}),
  };
}

export async function listClaudeConversations(force = false): Promise<ClaudeConversationList> {
  await ensureScanned(force);
  const jobs = backgroundJobs();
  const cwdExists = new Map<string, boolean>();
  const exists = (cwd: string): boolean => {
    let hit = cwdExists.get(cwd);
    if (hit === undefined) {
      hit = !!cwd && fs.existsSync(cwd);
      cwdExists.set(cwd, hit);
    }
    return hit;
  };
  // A transcript with no prompt or reply yet has no cwd of its own; its folder's
  // other transcripts tell where it belongs.
  const folderCwd = new Map<string, string>();
  for (const file of files) {
    const cwd = cache.get(file.filePath)?.digest.cwd;
    if (cwd) folderCwd.set(`${file.profileId ?? ''}\0${file.slug}`, cwd);
  }
  // Handed off to a background session that is running or has content: the
  // conversation goes on there, so this copy is left out, as Claude Code's
  // own /resume leaves it out.
  const superseded = (file: TranscriptFile, d: TranscriptDigest): boolean => {
    if (!d.continuedIn) return false;
    if (jobs.get(d.continuedIn)?.live) return true;
    return !!cache.get(path.join(path.dirname(file.filePath), `${d.continuedIn}.jsonl`))?.digest.hasMessages;
  };
  // Which conversations each one carries on, so names given to those can follow.
  const handedOff = new Map<string, string[]>();
  for (const file of files) {
    const d = file.cliSessionId ? cache.get(file.filePath)?.digest : undefined;
    if (!d?.continuedIn || !superseded(file, d)) continue;
    const from = handedOff.get(d.continuedIn) ?? [];
    from.push(file.cliSessionId!);
    handedOff.set(d.continuedIn, from);
  }
  const continuedFrom = (id: string): string[] | undefined => {
    const chain: string[] = [];
    const seen = new Set([id]);
    for (let level = handedOff.get(id) ?? []; level.length; ) {
      const next: string[] = [];
      for (const prev of level) {
        if (seen.has(prev)) continue;
        seen.add(prev);
        chain.push(prev);
        next.push(...(handedOff.get(prev) ?? []));
      }
      level = next;
    }
    return chain.length ? chain : undefined;
  };
  const conversations: ClaudeConversation[] = [];
  const listed = new Set<string>();
  for (const file of files) {
    if (!file.cliSessionId) continue;
    const entry = cache.get(file.filePath);
    if (!entry) continue;
    const d = entry.digest;
    if (superseded(file, d)) continue;
    const job = jobs.get(file.cliSessionId);
    // A file without a single prompt or reply is an aborted launch, or a stub
    // Claude Code left while backgrounding a conversation — unless a background
    // session is running in it right now.
    if (d.turns === 0 && d.usage.length === 0 && !job?.live) continue;
    let { title, titleSource } = resolveTitle(d);
    if (!title && job?.name) ({ title, titleSource } = { title: job.name, titleSource: 'custom' });
    const cwd = d.cwd || job?.cwd || folderCwd.get(`${file.profileId ?? ''}\0${file.slug}`) || '';
    conversations.push({
      cliSessionId: file.cliSessionId,
      transcriptPath: file.filePath,
      projectCwd: cwd,
      projectSlug: file.slug,
      profileId: file.profileId,
      cwdExists: exists(cwd),
      title,
      titleSource,
      firstPrompt: d.firstPrompt ?? d.firstCommand ?? '',
      turns: d.turns,
      startedAt: d.firstTs || entry.mtimeMs,
      updatedAt: Math.max(d.lastTs, 0) || entry.mtimeMs,
      gitBranch: d.gitBranch,
      model: d.lastModel,
      ...(d.customTitle ? { customTitle: d.customTitle } : {}),
      ...optional('continuedFrom', continuedFrom(file.cliSessionId)),
      ...backgroundFields(job),
    });
    listed.add(file.cliSessionId);
  }
  // A background session that hasn't written its transcript yet, e.g. a /fork
  // still waiting for its first prompt.
  for (const job of jobs.values()) {
    if (!job.live || listed.has(job.sessionId) || !job.cwd) continue;
    conversations.push({
      cliSessionId: job.sessionId,
      transcriptPath: '',
      projectCwd: job.cwd,
      projectSlug: job.cwd.replace(/[^a-zA-Z0-9]/g, '-'),
      profileId: job.profileId,
      cwdExists: exists(job.cwd),
      title: job.name,
      titleSource: job.name ? 'custom' : 'none',
      firstPrompt: '',
      turns: 0,
      startedAt: job.createdAt,
      updatedAt: job.updatedAt || job.createdAt,
      ...optional('continuedFrom', continuedFrom(job.sessionId)),
      ...backgroundFields(job),
    });
  }
  conversations.sort((a, b) => b.updatedAt - a.updatedAt);
  return { conversations, scannedAt: lastScanAt };
}

function localDate(ts: number): string {
  const dt = new Date(ts);
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${dt.getFullYear()}-${m}-${day}`;
}

/**
 * Aggregate usage across all transcripts. Streamed responses write one line
 * per content block with the same `message.id:requestId`, and resumed sessions
 * copy earlier history into a new file, so records are de-duplicated globally;
 * the copy with the largest output count wins (earlier chunks carry partial counts).
 */
export async function getClaudeUsage(force = false): Promise<ClaudeUsageReport> {
  await ensureScanned(force);
  const best = new Map<string, { rec: UsageRecord; project: string }>();
  for (const file of files) {
    const entry = cache.get(file.filePath);
    if (!entry) continue;
    const project = entry.digest.cwd;
    for (const rec of entry.digest.usage) {
      const prev = best.get(rec.key);
      if (!prev || rec.output > prev.rec.output) best.set(rec.key, { rec, project: prev?.project ?? project });
    }
  }

  const rows = new Map<string, ClaudeUsageRow>();
  const unpriced = new Set<string>();
  for (const { rec, project } of best.values()) {
    if (!rec.ts) continue;
    const model = normalizeModelId(rec.model);
    const date = localDate(rec.ts);
    const rowKey = `${date}\u0000${model}\u0000${project}`;
    let row = rows.get(rowKey);
    if (!row) {
      row = { date, model, project, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, costUsd: 0, requests: 0 };
      rows.set(rowKey, row);
    }
    row.inputTokens += rec.input;
    row.outputTokens += rec.output;
    row.cacheWriteTokens += rec.cacheWrite5m + rec.cacheWrite1h;
    row.cacheReadTokens += rec.cacheRead;
    row.requests++;
    const cost = estimateCostUsd(rec.model, rec);
    if (cost === undefined) unpriced.add(model);
    else row.costUsd += cost;
  }

  return {
    generatedAt: lastScanAt,
    rows: [...rows.values()].sort((a, b) => a.date.localeCompare(b.date)),
    unpricedModels: [...unpriced].sort(),
  };
}
