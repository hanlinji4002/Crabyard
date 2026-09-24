import type { InspectorEvent } from '../shared/types';
import type { SessionStatus } from './session-activity';

// What Clawd does for a conversation in the Clawd tub, after clawd-tank's
// daemon (github.com/marciogranzotto/clawd-tank): the tool Claude is running
// picks the animation, and the session's status covers the rest.

export type ClawdAnim =
  | 'idle'
  | 'sleeping'
  | 'happy'
  | 'notification'
  | 'confused'
  | 'walking'
  | 'going-away'
  | 'thinking'
  | 'typing'
  | 'debugger'
  | 'building'
  | 'conducting'
  | 'wizard'
  | 'beacon'
  | 'sweeping';

const TOOL_ANIMS: Record<string, ClawdAnim> = {
  Read: 'debugger',
  Grep: 'debugger',
  Glob: 'debugger',
  LS: 'debugger',
  NotebookRead: 'debugger',
  Edit: 'typing',
  MultiEdit: 'typing',
  Write: 'typing',
  NotebookEdit: 'typing',
  Bash: 'building',
  BashOutput: 'building',
  KillShell: 'building',
  KillBash: 'building',
  PowerShell: 'building',
  Monitor: 'building',
  Agent: 'conducting',
  Task: 'conducting',
  WebSearch: 'wizard',
  WebFetch: 'wizard',
  LSP: 'beacon',
  ToolSearch: 'beacon',
};

export function animForTool(tool: string): ClawdAnim {
  if (tool.startsWith('mcp__')) return 'beacon';
  return TOOL_ANIMS[tool] ?? 'thinking';
}

export interface ClawdActivity {
  /** The main agent's latest tool in this turn. */
  tool?: string;
  /** When that tool finished; unset while it runs. */
  toolEndedAt?: number;
  /** Compaction under way: a PreCompact with no PostCompact after it. */
  compactingSince?: number;
  /** Subagents started and not yet stopped in this turn. */
  subagents: number;
}

/** The current turn's activity, read back from a session's hook events (oldest first). */
export function deriveActivity(events: readonly InspectorEvent[]): ClawdActivity {
  const out: ClawdActivity = { subagents: 0 };
  let started = 0;
  let stopped = 0;
  let toolSeen = false;
  let compactSeen = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.hookEvent === 'UserPromptSubmit') break;
    switch (e.hookEvent) {
      case 'SubagentStart':
        started++;
        break;
      case 'SubagentStop':
        stopped++;
        break;
      case 'PreCompact':
        if (!compactSeen) out.compactingSince = e.timestamp;
        compactSeen = true;
        break;
      case 'PostCompact':
        compactSeen = true;
        break;
      case 'PreToolUse':
      case 'PostToolUse':
      case 'PostToolUseFailure':
        // Subagents' tools show as conducting, not as the main agent's tool.
        if (toolSeen || e.agent_id || !e.tool_name) break;
        toolSeen = true;
        out.tool = e.tool_name;
        if (e.hookEvent !== 'PreToolUse') out.toolEndedAt = e.timestamp;
        break;
    }
  }
  out.subagents = Math.max(0, started - stopped);
  return out;
}

/** Waiting on the user this long turns the alert into confusion. */
export const CONFUSED_AFTER_MS = 60_000;
/** Clawd celebrates a finished turn this long. */
export const HAPPY_FOR_MS = 4_000;
/** A conversation left alone this long puts Clawd to sleep. */
export const SLEEP_AFTER_MS = 10 * 60_000;
/** Tools often finish in milliseconds: keep showing one this long before thinking. */
export const TOOL_LINGER_MS = 2_500;
/** A compaction without a PostCompact (older CLIs) stops sweeping after this. */
export const COMPACT_MAX_MS = 120_000;

export function pickAnim(status: SessionStatus, statusSince: number, activity: ClawdActivity, now: number): ClawdAnim {
  if (activity.compactingSince !== undefined && now - activity.compactingSince < COMPACT_MAX_MS) return 'sweeping';
  if (status === 'input') return now - statusSince >= CONFUSED_AFTER_MS ? 'confused' : 'notification';
  if (status === 'working') {
    if (activity.subagents > 0) return 'conducting';
    if (activity.tool && (activity.toolEndedAt === undefined || now - activity.toolEndedAt < TOOL_LINGER_MS)) {
      return animForTool(activity.tool);
    }
    return 'thinking';
  }
  if (status === 'completed' && now - statusSince < HAPPY_FOR_MS) return 'happy';
  return now - statusSince >= SLEEP_AFTER_MS ? 'sleeping' : 'idle';
}
