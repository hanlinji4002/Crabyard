import { describe, it, expect } from 'vitest';
import { darkTerminalTheme, lightTerminalTheme, getTerminalTheme } from './terminal-theme';

describe('darkTerminalTheme', () => {
  it('has the correct background', () => {
    expect(darkTerminalTheme.background).toBe('#262624');
  });

  it('has the correct foreground', () => {
    expect(darkTerminalTheme.foreground).toBe('#faf9f5');
  });
});

describe('lightTerminalTheme', () => {
  it('has the correct background', () => {
    expect(lightTerminalTheme.background).toBe('#faf9f5');
  });

  it('has the correct foreground', () => {
    expect(lightTerminalTheme.foreground).toBe('#141413');
  });

  it('keeps ansi white visible against the background', () => {
    expect(lightTerminalTheme.white).toBe('#6b6a64');
    expect(lightTerminalTheme.white).not.toBe(lightTerminalTheme.background);
    expect(lightTerminalTheme.brightWhite).toBe('#2b2a27');
  });
});

describe('getTerminalTheme()', () => {
  it('returns darkTerminalTheme for "dark"', () => {
    expect(getTerminalTheme('dark')).toBe(darkTerminalTheme);
  });

  it('returns lightTerminalTheme for "light"', () => {
    expect(getTerminalTheme('light')).toBe(lightTerminalTheme);
  });
});

describe('cursor color', () => {
  it('uses the clay accent per theme', () => {
    expect(darkTerminalTheme.cursor).toBe('#d97757');
    expect(lightTerminalTheme.cursor).toBe('#c15f3c');
  });
});
