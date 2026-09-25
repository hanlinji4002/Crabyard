import { describe, it, expect } from 'vitest';
import { classifyUltracodeReply, detectMode, readEffortExchange, readPromptState, readUltracodeTag, shortModelName, transcriptText, type ScreenLine } from './claude-tui';

const RULE = '─'.repeat(98);

/** Screen rows as captured from Claude Code v2.1.280 (dimmed text blanked in `strongText`). */
function screen(rows: Array<string | [text: string, strongText: string]>): ScreenLine[] {
  return rows.map((r) => (typeof r === 'string' ? { text: r, strongText: r } : { text: r[0], strongText: r[1] }));
}

const placeholder: [string, string] = ['❯ Try "how does <filepath> work?"', '❯ '];

describe('readPromptState', () => {
  it('finds an empty prompt (dim placeholder) and the auto-mode footer', () => {
    const state = readPromptState(screen([
      ' ▐▛███▛█  Claude Code v2.1.280',
      '',
      '                                                               ◐ medium · /effort',
      RULE,
      placeholder,
      RULE,
      '  ⚠ Transcript saving is off',
      '',
      '  ⏵⏵ auto mode on (shift+tab to cycle)',
    ]));
    expect(state).toEqual({ found: true, empty: true, mode: 'auto' });
  });

  it('reports a typed draft as not empty', () => {
    const state = readPromptState(screen([RULE, '❯ hello draft', RULE, '  ⏸ plan mode on (shift+tab to cycle)']));
    expect(state).toEqual({ found: true, empty: false, mode: 'plan' });
  });

  it('treats a multi-line draft as not empty', () => {
    const state = readPromptState(screen([RULE, '❯ first line', '  second line', RULE]));
    expect(state.empty).toBe(false);
  });

  it('does not find the prompt while a dialog covers it', () => {
    const state = readPromptState(screen([
      ' Toggle thinking mode',
      ' Enable or disable thinking for this session.',
      ' ❯ 1. Enabled ✔  Claude will think before responding',
      '   2. Disabled   Claude will respond without extended thinking',
      ' Enter to confirm · Esc to cancel',
    ]));
    expect(state.found).toBe(false);
  });

  it('ignores earlier "❯" prompts in the scrollback and reads the live box', () => {
    const state = readPromptState(screen([
      '❯ an old message that mentions plan mode on',
      '⏺ reply',
      RULE,
      placeholder,
      RULE,
      '  ⏵⏵ accept edits on (shift+tab to cycle)',
    ]));
    expect(state).toEqual({ found: true, empty: true, mode: 'acceptEdits' });
  });

  it('accepts a top rule that carries the session name', () => {
    const state = readPromptState(screen([
      `${'─'.repeat(70)} Claude 项目安全审计 ─`,
      ['❯ ', '❯ '],
      RULE,
      '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
    ]));
    expect(state).toEqual({ found: true, empty: true, mode: 'auto' });
  });

  it('returns a null mode when the footer shows none', () => {
    expect(readPromptState(screen([RULE, placeholder, RULE, '  ? for shortcuts'])).mode).toBeNull();
  });
});

describe('detectMode', () => {
  it('maps every footer label', () => {
    expect(detectMode(screen(['  ⏸ manual mode on']))).toBe('default');
    expect(detectMode(screen(['  ⏵⏵ accept edits on (shift+tab to cycle)']))).toBe('acceptEdits');
    expect(detectMode(screen(['  ⏸ plan mode on (shift+tab to cycle)']))).toBe('plan');
    expect(detectMode(screen(['  ⏵⏵ auto mode on (shift+tab to cycle)']))).toBe('auto');
    expect(detectMode(screen(['  ⏵⏵ bypass permissions on']))).toBe('bypassPermissions');
  });
});

describe('shortModelName', () => {
  it('drops the context suffix', () => {
    expect(shortModelName('Opus 5.5 (1M context)')).toBe('Opus 5.5');
    expect(shortModelName('Sonnet 5')).toBe('Sonnet 5');
    expect(shortModelName(undefined)).toBe('');
  });
});

// Replies as Claude Code v2.1.281 prints them.
const SET_ON = '  ⎿  Set effort level to ultracode (this session only): xhigh + dynamic workflow orchestration';
const SET_XHIGH = '  ⎿  Set effort level to xhigh (saved as your default for new sessions): Extended reasoning';
const TAGGED_RULE = `${'─'.repeat(40)} ultracode ${'─'.repeat(40)}`;

describe('classifyUltracodeReply', () => {
  it('reads the replies that turn ultracode on or off', () => {
    expect(classifyUltracodeReply(SET_ON)).toBe('on');
    expect(classifyUltracodeReply('  ⎿  Current effort level: ultracode (xhigh + dynamic workflow orchestration; this session only)')).toBe('on');
    expect(classifyUltracodeReply(SET_XHIGH)).toBe('off');
    expect(classifyUltracodeReply('  ⎿  Effort level set to auto')).toBe('off');
    expect(classifyUltracodeReply("  ⎿  Effort 'max' exceeds the cap for claude-sonnet-5 set by your settings or organization; set to 'xhigh' instead (this session only): Extended reasoning")).toBe('off');
  });

  it('names why ultracode could not take effect', () => {
    expect(classifyUltracodeReply('  ⎿  Ultracode needs dynamic workflows enabled (see /config). Valid options are: low, medium, high, xhigh, max, auto')).toBe('needsWorkflows');
    expect(classifyUltracodeReply('  ⎿  Ultracode runs at xhigh effort, which is above the effort cap for claude-sonnet-5 set by your settings or organization. Valid options are: low, medium, high')).toBe('capped');
    expect(classifyUltracodeReply("  ⎿  Ultracode runs at xhigh effort, which claude-haiku-4-5 doesn't support — switch to an xhigh-capable model (/model). Valid options are: low, medium, high")).toBe('unsupported');
    expect(classifyUltracodeReply('  ⎿  CLAUDE_CODE_EFFORT_LEVEL=high overrides effort this session — clear it and ultracode takes over')).toBe('envOverride');
    expect(classifyUltracodeReply('  ⎿  CLAUDE_CODE_EFFORT_LEVEL=high overrides this session — clear it and medium takes over')).toBe('off');
  });

  it('ignores unrelated text', () => {
    expect(classifyUltracodeReply('❯ /effort ultracode')).toBeNull();
    expect(classifyUltracodeReply('  ⏵⏵ auto mode on (shift+tab to cycle)')).toBeNull();
  });
});

describe('readUltracodeTag', () => {
  it('reads the "ultracode" tag on the live prompt box', () => {
    expect(readUltracodeTag(screen([SET_ON, TAGGED_RULE, placeholder, RULE]))).toBe(true);
    expect(readUltracodeTag(screen([SET_ON, RULE, placeholder, RULE]))).toBe(false);
    expect(readUltracodeTag(screen(['Do you want to proceed?', '❯ 1. Yes']))).toBeNull();
  });
});

describe('readEffortExchange', () => {
  it('reads the reply under the newest /effort echo', () => {
    const lines = screen(['❯ /effort xhigh', SET_XHIGH, '', '❯ /effort ultracode', SET_ON, '', RULE, placeholder, RULE]);
    expect(readEffortExchange(lines)).toEqual({ row: 3, arg: 'ultracode', reply: 'on' });
  });

  it('reads a reply wrapped onto a second row', () => {
    const lines = screen([
      '❯ /effort ultracode',
      '  ⎿  Ultracode runs at xhigh effort, which',
      '     is above the effort cap for claude-sonnet-5 set by your settings or organization.',
      RULE,
      placeholder,
      RULE,
    ]);
    expect(readEffortExchange(lines)?.reply).toBe('capped');
  });

  it("ignores conversation text and diffs that quote the CLI's replies", () => {
    const lines = screen([
      '❯ /effort xhigh',
      SET_XHIGH,
      '',
      '● The switch reads "Set effort level to ultracode (this session only)" off the screen.',
      "      12 +const SET_ON = '  ⎿  Set effort level to ultracode (this session only): …';",
      "      13 +const ECHO = '❯ /effort ultracode';",
      RULE,
      placeholder,
      RULE,
    ]);
    expect(readEffortExchange(lines)).toEqual({ row: 0, arg: 'xhigh', reply: 'off' });
  });

  it('ignores a command still sitting in the prompt box', () => {
    expect(readEffortExchange(screen([RULE, '❯ /effort ultracode', RULE]))).toBeNull();
  });
});

describe('transcriptText', () => {
  it('is the conversation above the live prompt box, which changes when the CLI replies', () => {
    const before = screen(['', '❯ /effort ultracode', SET_ON, RULE, placeholder, RULE]);
    // a full-screen redraw puts the next exchange where the last one was
    const after = screen(['❯ /effort ultracode', SET_ON, '❯ /effort xhigh', RULE, placeholder, RULE]);
    expect(transcriptText(before)).toBe(`\n❯ /effort ultracode\n${SET_ON}`);
    expect(transcriptText(after)).not.toBe(transcriptText(before));
  });
});
