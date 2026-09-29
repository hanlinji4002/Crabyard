/** Effort levels `claude --effort` accepts (Claude Code 2.1.283: low, medium, high, xhigh, max). */
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];

export function isClaudeEffortLevel(value: unknown): value is ClaudeEffortLevel {
  return typeof value === 'string' && (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(value);
}

