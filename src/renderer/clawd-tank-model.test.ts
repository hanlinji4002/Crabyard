import { describe, it, expect } from 'vitest';
import type { InspectorEvent } from '../shared/types';
import {
  animForTool,
  deriveActivity,
  pickAnim,
  CONFUSED_AFTER_MS,
  HAPPY_FOR_MS,
  SLEEP_AFTER_MS,
  TOOL_LINGER_MS,
  COMPACT_MAX_MS,
} from './clawd-tank-model';

function ev(hookEvent: string, timestamp: number, extra: Partial<InspectorEvent> = {}): InspectorEvent {
  return { type: 'tool_use', hookEvent, timestamp, ...extra } as InspectorEvent;
}

describe('animForTool', () => {
  it('maps tools to their animations', () => {
    expect(animForTool('Read')).toBe('debugger');
    expect(animForTool('Grep')).toBe('debugger');
    expect(animForTool('Edit')).toBe('typing');
    expect(animForTool('Write')).toBe('typing');
    expect(animForTool('Bash')).toBe('building');
    expect(animForTool('Agent')).toBe('conducting');
    expect(animForTool('Task')).toBe('conducting');
    expect(animForTool('WebSearch')).toBe('wizard');
    expect(animForTool('mcp__github__create_issue')).toBe('beacon');
    expect(animForTool('TodoWrite')).toBe('thinking');
  });
});

describe('deriveActivity', () => {
  it('reads the main agent tool that is running', () => {
    const a = deriveActivity([ev('UserPromptSubmit', 1), ev('PreToolUse', 2, { tool_name: 'Read' }), ev('PostToolUse', 3, { tool_name: 'Read' }), ev('PreToolUse', 4, { tool_name: 'Edit' })]);
    expect(a).toEqual({ subagents: 0, tool: 'Edit' });
  });

  it('notes when the latest tool finished', () => {
    const a = deriveActivity([ev('PreToolUse', 2, { tool_name: 'Bash' }), ev('PostToolUse', 9, { tool_name: 'Bash' })]);
    expect(a.tool).toBe('Bash');
    expect(a.toolEndedAt).toBe(9);
  });

  it('ignores subagent tools and counts subagents in flight', () => {
    const a = deriveActivity([
      ev('UserPromptSubmit', 1),
      ev('PreToolUse', 2, { tool_name: 'Agent' }),
      ev('SubagentStart', 3),
      ev('SubagentStart', 4),
      ev('PreToolUse', 5, { tool_name: 'Grep', agent_id: 'a1' }),
      ev('SubagentStop', 6),
    ]);
    expect(a.subagents).toBe(1);
    expect(a.tool).toBe('Agent');
  });

  it('only looks at the current turn', () => {
    const a = deriveActivity([ev('PreToolUse', 1, { tool_name: 'Bash' }), ev('SubagentStart', 2), ev('UserPromptSubmit', 3)]);
    expect(a).toEqual({ subagents: 0 });
  });

  it('sees a compaction until it ends', () => {
    expect(deriveActivity([ev('PreCompact', 5)]).compactingSince).toBe(5);
    expect(deriveActivity([ev('PreCompact', 5), ev('PostCompact', 8)]).compactingSince).toBeUndefined();
  });
});

describe('pickAnim', () => {
  const now = 1_000_000;
  const quiet = { subagents: 0 };

  it('shows the running tool, lingers briefly after it, then thinks', () => {
    expect(pickAnim('working', 0, { subagents: 0, tool: 'Edit' }, now)).toBe('typing');
    expect(pickAnim('working', 0, { subagents: 0, tool: 'Edit', toolEndedAt: now - TOOL_LINGER_MS + 1 }, now)).toBe('typing');
    expect(pickAnim('working', 0, { subagents: 0, tool: 'Edit', toolEndedAt: now - TOOL_LINGER_MS }, now)).toBe('thinking');
    expect(pickAnim('working', 0, quiet, now)).toBe('thinking');
  });

  it('conducts while subagents run', () => {
    expect(pickAnim('working', 0, { subagents: 2, tool: 'Read' }, now)).toBe('conducting');
  });

  it('sweeps during a compaction, for a while at most', () => {
    expect(pickAnim('working', 0, { subagents: 0, compactingSince: now - 1000 }, now)).toBe('sweeping');
    expect(pickAnim('working', 0, { subagents: 0, compactingSince: now - COMPACT_MAX_MS }, now)).toBe('thinking');
  });

  it('alerts when the conversation needs the user, then gets confused', () => {
    expect(pickAnim('input', now - 1000, quiet, now)).toBe('notification');
    expect(pickAnim('input', now - CONFUSED_AFTER_MS, quiet, now)).toBe('confused');
  });

  it('celebrates a finished turn, then idles and falls asleep', () => {
    expect(pickAnim('completed', now - 1000, quiet, now)).toBe('happy');
    expect(pickAnim('completed', now - HAPPY_FOR_MS, quiet, now)).toBe('idle');
    expect(pickAnim('waiting', now - 1000, quiet, now)).toBe('idle');
    expect(pickAnim('idle', now - SLEEP_AFTER_MS, quiet, now)).toBe('sleeping');
  });
});
