import { describe, it, expect } from 'vitest';
import { formatRelativeTime, formatResetTime, formatTokens, formatUsd, lastNDays, localDateKey, samePath, tildePath } from './claude-history-format';

describe('formatTokens', () => {
  it('abbreviates with K / M / B', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(1000)).toBe('1K');
    expect(formatTokens(12_300)).toBe('12.3K');
    expect(formatTokens(123_456)).toBe('123K');
    expect(formatTokens(4_500_000)).toBe('4.5M');
    expect(formatTokens(3_419_136_434)).toBe('3.4B');
  });
});

describe('formatUsd', () => {
  it('shows cents below $1,000 and whole dollars above', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.004)).toBe('<$0.01');
    expect(formatUsd(12.3)).toBe('$12.30');
    expect(formatUsd(3774.41)).toBe('$3,774');
  });
});

describe('date helpers', () => {
  it('lists the last N local days, oldest first, across a month boundary', () => {
    const now = new Date(2026, 9, 2, 15, 0).getTime(); // Oct 2, local time
    expect(lastNDays(3, now)).toEqual(['2026-09-30', '2026-10-01', '2026-10-02']);
    expect(localDateKey(now)).toBe('2026-10-02');
  });

  it('labels very recent activity as just now', () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 10_000, now, 'zh-CN')).toBe('刚刚');
    expect(formatRelativeTime(now - 10_000, now, 'en')).toBe('just now');
  });
});

describe('samePath', () => {
  it('ignores a trailing separator', () => {
    expect(samePath('/Users/me/proj/', '/Users/me/proj')).toBe(true);
    expect(samePath('/Users/me/proj', '/Users/me/project')).toBe(false);
    expect(samePath('/', '/')).toBe(true);
  });
});

describe('tildePath', () => {
  it('replaces the macOS and Linux home prefix', () => {
    expect(tildePath('/Users/ada/Desktop/proj')).toBe('~/Desktop/proj');
    expect(tildePath('/home/ada/src')).toBe('~/src');
    expect(tildePath('/Users/ada')).toBe('~');
  });

  it('replaces the Windows profile prefix', () => {
    expect(tildePath('C:\\Users\\ada\\code')).toBe('~\\code');
  });

  it('leaves other paths alone', () => {
    expect(tildePath('/opt/tools')).toBe('/opt/tools');
    expect(tildePath('/Users')).toBe('/Users');
    expect(tildePath('/Usersx/ada/a')).toBe('/Usersx/ada/a');
  });
});

describe('formatResetTime', () => {
  const now = new Date(2026, 8, 24, 12, 0).getTime();
  const at = (h: number, m = 0) => now + h * 3_600_000 + m * 60_000;

  it('counts down inside a day', () => {
    expect(formatResetTime(at(2, 52), now, 'zh-CN')).toBe('2小时52分后重置');
    expect(formatResetTime(at(0, 45), now, 'zh-CN')).toBe('45分钟后重置');
    expect(formatResetTime(at(3), now, 'zh-CN')).toBe('3小时后重置');
    expect(formatResetTime(at(2, 52), now, 'en')).toBe('Resets in 2h 52m');
    expect(formatResetTime(now + 20_000, now, 'en')).toBe('Resets in 1m');
  });

  it('names the weekday and time further out', () => {
    const wed8 = new Date(2026, 8, 30, 8, 0).getTime();
    expect(formatResetTime(wed8, now, 'zh-CN')).toBe('周三 08:00 重置');
    expect(formatResetTime(wed8, now, 'en-US')).toBe('Resets Wed 8:00 AM');
  });

  it('says reset once the time has passed', () => {
    expect(formatResetTime(now - 1, now, 'zh-CN')).toBe('已重置');
    expect(formatResetTime(now, now, 'en')).toBe('Reset');
  });
});
