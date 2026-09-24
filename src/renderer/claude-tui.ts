// Reading Claude Code's terminal UI (v2.1.x) from the rendered screen, so the
// session controls can tell whether it is safe to type into the prompt and
// which permission mode is active (the statusLine payload carries model and
// effort, but not the mode).
//
// The prompt box renders as a `❯` line between two `─` rules; an empty prompt
// shows its placeholder dimmed. The footer under the box names the mode:
// "⏸ manual mode on", "⏵⏵ accept edits on", "⏸ plan mode on", "⏵⏵ auto mode on".

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions' | 'dontAsk';

export const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];

export const EFFORT_LEVELS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export const MODEL_CHOICES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

/** One screen row: the full text, and the text with dimmed cells blanked out. */
export interface ScreenLine {
  text: string;
  strongText: string;
}

export interface PromptState {
  /** The live prompt box is on screen (no dialog or picker is covering it). */
  found: boolean;
  /** The prompt holds no typed text (only the dimmed placeholder, if any). */
  empty: boolean;
  /** Mode named in the footer, or null when the footer shows none. */
  mode: PermissionMode | null;
}

/** A box rule: a run of `─`, possibly carrying the session name (`──── my chat ─`). */
function isRule(text: string): boolean {
  return /─{8,}/.test(text) && !text.includes('❯');
}

const PROMPT_RE = /^\s*❯[\s ]?/;
const FOOTER_LINES = 6;

const MODE_LABELS: Array<[RegExp, PermissionMode]> = [
  [/accept edits on/i, 'acceptEdits'],
  [/plan mode on/i, 'plan'],
  [/auto mode on/i, 'auto'],
  [/bypass(ing)? permissions/i, 'bypassPermissions'],
  [/don'?t ask mode on/i, 'dontAsk'],
  [/manual mode on/i, 'default'],
];

/** Mode label found in `lines` (searched bottom-up), or null. */
export function detectMode(lines: ScreenLine[]): PermissionMode | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    for (const [re, mode] of MODE_LABELS) {
      if (re.test(lines[i].text)) return mode;
    }
  }
  return null;
}

export function readPromptState(lines: ScreenLine[]): PromptState {
  let promptIdx = -1;
  for (let i = lines.length - 1; i > 0; i--) {
    if (PROMPT_RE.test(lines[i].text) && isRule(lines[i - 1].text)) {
      promptIdx = i;
      break;
    }
  }
  if (promptIdx === -1) {
    return { found: false, empty: false, mode: detectMode(lines.slice(-FOOTER_LINES)) };
  }
  const typed = lines[promptIdx].strongText.replace(PROMPT_RE, '').trim();
  const next = lines[promptIdx + 1];
  // A multi-line draft continues on the next row instead of closing the box.
  const singleLine = next !== undefined && isRule(next.text);
  const footer = lines.slice(promptIdx + 1, promptIdx + 1 + FOOTER_LINES);
  return { found: true, empty: typed === '' && singleLine, mode: detectMode(footer) };
}

/** "Opus 5.5 (1M context)" → "Opus 5.5". */
export function shortModelName(displayName: string | undefined): string {
  return (displayName ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}
