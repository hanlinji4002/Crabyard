import { describe, it, expect } from 'vitest';
import { detectMode, readPromptState, shortModelName, type ScreenLine } from './claude-tui';

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
