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
  const promptIdx = livePromptIndex(lines);
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

// Ultracode (xhigh effort plus standing dynamic-workflow orchestration) is
// switched with `/effort ultracode`; any other `/effort <level>` turns it off.
// The statusLine only reports the effort (xhigh), so the switch reads the CLI's
// own screen — but only rows the CLI owns, never conversation text:
// - while ultracode is in effect the prompt box's top rule carries an
//   "ultracode" tag;
// - a `/effort …` echo row, with the CLI's `⎿` reply right under it:
//   "Set effort level to ultracode (this session only): …", "Set effort level
//   to high …", "Effort level set to auto", or why ultracode can't run:
//   "Ultracode needs dynamic workflows enabled (see /config)…", "Ultracode runs
//   at xhigh effort, which …", "CLAUDE_CODE_EFFORT_LEVEL=… overrides effort this
//   session — clear it and ultracode takes over".

export type UltracodeReply = 'on' | 'off' | 'needsWorkflows' | 'capped' | 'unsupported' | 'envOverride';

const ULTRACODE_REPLIES: Array<[RegExp, UltracodeReply]> = [
  [/Ultracode needs dynamic workflows/i, 'needsWorkflows'],
  [/Ultracode runs at xhigh effort, which is above the effort cap/i, 'capped'],
  [/Ultracode runs at xhigh effort, which/i, 'unsupported'],
  [/clear it and ultracode takes over/i, 'envOverride'],
  [/Set effort level to ultracode\b/i, 'on'],
  [/Current effort level: ultracode\b/i, 'on'],
  [/Set effort level to (low|medium|high|xhigh|max)\b/i, 'off'],
  [/Current effort level: (low|medium|high|xhigh|max|auto)\b/i, 'off'],
  [/Effort (level )?set to auto\b/i, 'off'],
  [/clear it and (low|medium|high|xhigh|max) takes over/i, 'off'],
  [/exceeds the cap for .* set to '(low|medium|high|xhigh|max)' instead/i, 'off'],
];

/** What a reply to `/effort` says about ultracode, if anything. */
export function classifyUltracodeReply(text: string): UltracodeReply | null {
  for (const [re, reply] of ULTRACODE_REPLIES) if (re.test(text)) return reply;
  return null;
}

/** Index of the live prompt row (`❯` under a rule), or -1. */
function livePromptIndex(lines: ScreenLine[]): number {
  for (let i = lines.length - 1; i > 0; i--) {
    if (PROMPT_RE.test(lines[i].text) && isRule(lines[i - 1].text)) return i;
  }
  return -1;
}

/** Whether the live prompt box's top rule carries the "ultracode" tag; null when the box isn't showing. */
export function readUltracodeTag(lines: ScreenLine[]): boolean | null {
  const i = livePromptIndex(lines);
  return i === -1 ? null : /\bultracode\b/i.test(lines[i - 1].text);
}

/** A whole row that is just an `/effort …` command echo, not text that quotes one. */
const EFFORT_ECHO_RE = /^\s*[❯>]\s*\/effort(?:\s+([a-z]+))?\s*$/i;

export interface EffortExchange {
  /** Screen row of the echo. */
  row: number;
  /** The level the command asked for ('' for a bare `/effort`). */
  arg: string;
  /** The CLI's reply under it, when it has one this reader knows. */
  reply: UltracodeReply | null;
}

/** The conversation rows above the live prompt box, as one string, to notice when the CLI prints something. */
export function transcriptText(lines: ScreenLine[]): string {
  const live = livePromptIndex(lines);
  return lines.slice(0, live === -1 ? lines.length : live - 1).map((l) => l.text).join('\n');
}

/**
 * The newest `/effort …` on screen above the live prompt: its echo row and the
 * `⎿` reply right under it, read together with any rows it wrapped onto.
 */
export function readEffortExchange(lines: ScreenLine[]): EffortExchange | null {
  const live = livePromptIndex(lines);
  const top = live === -1 ? lines.length : live - 1;
  for (let i = top - 1; i >= 0; i--) {
    const echo = EFFORT_ECHO_RE.exec(lines[i].text);
    if (!echo) continue;
    const arg = (echo[1] ?? '').toLowerCase();
    let r = i + 1;
    while (r < top && lines[r].text.trim() === '') r++;
    if (r >= top || !lines[r].text.includes('⎿')) return { row: i, arg, reply: null };
    let text = lines[r].text;
    for (let j = r + 1; j < top && j <= r + 2; j++) {
      const next = lines[j].text;
      if (next.trim() === '' || next.includes('⎿') || isRule(next) || PROMPT_RE.test(next)) break;
      text += ` ${next}`;
    }
    return { row: i, arg, reply: classifyUltracodeReply(text.replace(/\s+/g, ' ')) };
  }
  return null;
}

/** "Opus 5.5 (1M context)" → "Opus 5.5". */
export function shortModelName(displayName: string | undefined): string {
  return (displayName ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}
