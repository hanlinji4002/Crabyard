import * as fs from 'fs';
import * as path from 'path';
import { cleanUserText, extractUserText, findTranscriptPath } from './claude-history';
import type { ConversationChanges, DiffHunk, FileChange } from '../shared/types';

// Which files a Claude Code conversation changed, for the right column's
// 本轮修改 (latest turn) and 本对话修改 (whole conversation) panes. Every
// Edit / MultiEdit / Write result in the transcript carries a structured patch
// (a created file carries its content), so the +/- counts are exact for edits
// made through those tools; shell commands that touch files are not seen.
// Subagents (Team members run as agents) keep their own transcripts beside the
// main one; their edits are folded in and credited to a turn by timestamp.
// Transcripts only ever grow, so each file is read incrementally.

/** Hunk lines kept per file and scope, so a huge rewrite cannot bloat memory. */
const MAX_HUNK_LINES = 400;
/** Conversations whose parse state is kept warm. */
const MAX_TRACKED = 8;

interface Edit {
  path: string;
  added: number;
  removed: number;
  created: boolean;
  hunks: DiffHunk[];
}

interface Cursor {
  offset: number;
  ino: number;
  partial: Buffer;
}

interface TranscriptState {
  cursor: Cursor;
  cwd: string;
  turns: number;
  lastTurn: { index: number; prompt: string; startedAt: number } | null;
  lastTurnFiles: Map<string, FileChange>;
  total: Map<string, FileChange>;
  subagents: Map<string, { cursor: Cursor; edits: Array<{ ts: number; edit: Edit }> }>;
}

const states = new Map<string, TranscriptState>();

function newCursor(): Cursor {
  return { offset: 0, ino: 0, partial: Buffer.alloc(0) };
}

/** Complete new lines appended since the last read; 'reset' when the file was replaced or shrank. */
async function readNewLines(file: string, cursor: Cursor): Promise<string[] | 'reset' | null> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    return null;
  }
  if (cursor.ino && (stat.ino !== cursor.ino || stat.size < cursor.offset)) return 'reset';
  cursor.ino = stat.ino;
  if (stat.size === cursor.offset) return [];
  const handle = await fs.promises.open(file, 'r');
  try {
    const length = stat.size - cursor.offset;
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, cursor.offset);
    cursor.offset = stat.size;
    // Split on the last newline byte so a partly written multi-byte character
    // is never decoded on its own.
    const data = cursor.partial.length ? Buffer.concat([cursor.partial, buf]) : buf;
    const cut = data.lastIndexOf(0x0a);
    if (cut === -1) {
      cursor.partial = data;
      return [];
    }
    cursor.partial = data.subarray(cut + 1);
    return data.subarray(0, cut).toString('utf8').split('\n');
  } finally {
    await handle.close();
  }
}

function splitContentLines(content: string): string[] {
  const lines = content.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The file change in one tool result, or null when it is not an edit. */
export function editFromToolResult(result: unknown): Edit | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as { filePath?: unknown; type?: unknown; content?: unknown; structuredPatch?: unknown };
  if (typeof r.filePath !== 'string' || !r.filePath) return null;
  const patch = Array.isArray(r.structuredPatch) ? r.structuredPatch : null;
  const created = r.type === 'create';
  if (!patch && !created && r.type !== 'update') return null;

  if ((!patch || patch.length === 0) && created && typeof r.content === 'string') {
    const lines = splitContentLines(r.content);
    return { path: r.filePath, added: lines.length, removed: 0, created: true, hunks: [{ oldStart: 0, newStart: 1, lines: lines.map((l) => `+${l}`) }] };
  }
  if (!patch) return null;

  let added = 0;
  let removed = 0;
  const hunks: DiffHunk[] = [];
  for (const raw of patch) {
    if (!raw || typeof raw !== 'object') continue;
    const h = raw as { oldStart?: unknown; newStart?: unknown; lines?: unknown };
    const lines = Array.isArray(h.lines) ? h.lines.filter((l): l is string => typeof l === 'string') : [];
    for (const line of lines) {
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
    }
    hunks.push({
      oldStart: typeof h.oldStart === 'number' ? h.oldStart : 0,
      newStart: typeof h.newStart === 'number' ? h.newStart : 0,
      lines,
    });
  }
  return { path: r.filePath, added, removed, created, hunks };
}

function fold(into: Map<string, FileChange>, edit: Edit): void {
  let entry = into.get(edit.path);
  if (!entry) {
    entry = { path: edit.path, added: 0, removed: 0, created: false, edits: 0, hunks: [], truncated: false };
    into.set(edit.path, entry);
  }
  entry.added += edit.added;
  entry.removed += edit.removed;
  entry.created ||= edit.created;
  entry.edits++;
  let kept = entry.hunks.reduce((n, h) => n + h.lines.length, 0);
  for (const hunk of edit.hunks) {
    if (kept + hunk.lines.length > MAX_HUNK_LINES) {
      entry.truncated = true;
      break;
    }
    entry.hunks.push(hunk);
    kept += hunk.lines.length;
  }
}

function newState(): TranscriptState {
  return { cursor: newCursor(), cwd: '', turns: 0, lastTurn: null, lastTurnFiles: new Map(), total: new Map(), subagents: new Map() };
}

/** Fold one main-transcript line: a real prompt opens a turn, an edit result lands in it. */
function applyChangeLine(state: TranscriptState, line: string): void {
  if (!line.includes('"type":"user"')) return;
  let e: Record<string, any>;
  try {
    e = JSON.parse(line);
  } catch {
    return;
  }
  if (e.type !== 'user') return;
  if (!state.cwd && typeof e.cwd === 'string') state.cwd = e.cwd;
  if (e.toolUseResult !== undefined) {
    const edit = editFromToolResult(e.toolUseResult);
    if (!edit) return;
    fold(state.total, edit);
    if (state.lastTurn) fold(state.lastTurnFiles, edit);
    return;
  }
  if (e.isMeta || e.isSidechain) return;
  const { kind, text } = cleanUserText(extractUserText(e.message?.content));
  if (kind === 'skip') return;
  state.turns++;
  const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
  state.lastTurn = { index: state.turns, prompt: text, startedAt: Number.isNaN(ts) ? 0 : ts };
  state.lastTurnFiles = new Map();
}

async function syncSubagents(state: TranscriptState, transcript: string): Promise<void> {
  const dir = path.join(transcript.slice(0, -'.jsonl'.length), 'subagents');
  let names: string[];
  try {
    names = (await fs.promises.readdir(dir)).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    let sub = state.subagents.get(file);
    if (!sub) {
      sub = { cursor: newCursor(), edits: [] };
      state.subagents.set(file, sub);
    }
    let lines = await readNewLines(file, sub.cursor);
    if (lines === 'reset') {
      sub.cursor = newCursor();
      sub.edits = [];
      lines = await readNewLines(file, sub.cursor);
    }
    if (!Array.isArray(lines)) continue;
    for (const line of lines) {
      if (!line.includes('"toolUseResult"')) continue;
      let e: Record<string, any>;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const edit = editFromToolResult(e.toolUseResult);
      if (!edit) continue;
      const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
      sub.edits.push({ ts: Number.isNaN(ts) ? 0 : ts, edit });
    }
  }
}

function snapshot(cliSessionId: string, state: TranscriptState): ConversationChanges {
  const lastTurnFiles = new Map<string, FileChange>();
  const total = new Map<string, FileChange>();
  const copy = (from: Map<string, FileChange>, into: Map<string, FileChange>) => {
    for (const [key, value] of from) into.set(key, { ...value, hunks: [...value.hunks] });
  };
  copy(state.lastTurnFiles, lastTurnFiles);
  copy(state.total, total);
  const since = state.lastTurn?.startedAt ?? Infinity;
  const subEdits = [...state.subagents.values()].flatMap((s) => s.edits).sort((a, b) => a.ts - b.ts);
  for (const { ts, edit } of subEdits) {
    fold(total, edit);
    if (ts >= since) fold(lastTurnFiles, edit);
  }
  return {
    cliSessionId,
    cwd: state.cwd,
    turns: state.turns,
    lastTurn: state.lastTurn ? { ...state.lastTurn, files: [...lastTurnFiles.values()] } : null,
    total: [...total.values()],
  };
}

/** The files a conversation changed, or null when its transcript is not found. */
export async function getConversationChanges(cliSessionId: string): Promise<ConversationChanges | null> {
  const transcript = findTranscriptPath(cliSessionId);
  if (!transcript) return null;
  let state = states.get(transcript);
  if (!state) {
    state = newState();
    states.set(transcript, state);
    while (states.size > MAX_TRACKED) states.delete(states.keys().next().value!);
  }
  let lines = await readNewLines(transcript, state.cursor);
  if (lines === 'reset') {
    state = newState();
    states.set(transcript, state);
    lines = await readNewLines(transcript, state.cursor);
  }
  if (lines === null) return null;
  for (const line of lines) applyChangeLine(state, line);
  await syncSubagents(state, transcript);
  return snapshot(cliSessionId, state);
}

/** @internal Test-only: forget all parse state */
export function _resetForTesting(): void {
  states.clear();
}
