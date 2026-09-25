import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  _resetForTesting,
  getPlanUsage,
  limitLevel,
  mergeWindow,
  onPlanUsageChange,
  parseRateLimits,
  updatePlanUsage,
  windowAt,
} from './plan-usage';

const NOW = Date.UTC(2026, 8, 24, 12, 0);

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() { return data.size; },
  } as Storage;
}

describe('parseRateLimits', () => {
  it('reads the 5-hour and weekly windows', () => {
    const usage = parseRateLimits({
      five_hour: { used_percentage: 57.4, resets_at: 1_790_000_000 },
      seven_day: { used_percentage: 10, resets_at: 1_790_300_000 },
    }, NOW);
    expect(usage).toEqual({
      fiveHour: { percent: 57.4, resetsAt: 1_790_000_000_000 },
      sevenDay: { percent: 10, resetsAt: 1_790_300_000_000 },
      updatedAt: NOW,
    });
  });

  it('clamps percentages and accepts epoch-ms reset times', () => {
    const usage = parseRateLimits({ five_hour: { used_percentage: 140, resets_at: 1_790_000_000_000 } }, NOW);
    expect(usage?.fiveHour).toEqual({ percent: 100, resetsAt: 1_790_000_000_000 });
    expect(usage?.sevenDay).toBeNull();
  });

  it('returns null when nothing usable is present', () => {
    expect(parseRateLimits(undefined, NOW)).toBeNull();
    expect(parseRateLimits('x', NOW)).toBeNull();
    expect(parseRateLimits({ five_hour: {}, seven_day: null }, NOW)).toBeNull();
  });
});

describe('windowAt', () => {
  it('passes a live window through', () => {
    expect(windowAt({ percent: 40, resetsAt: NOW + 1000 }, NOW)).toEqual({ percent: 40, resetsAt: NOW + 1000, reset: false });
  });

  it('reads 0% once the reset time has passed', () => {
    expect(windowAt({ percent: 90, resetsAt: NOW - 1 }, NOW)).toEqual({ percent: 0, resetsAt: null, reset: true });
  });

  it('keeps an unknown reset time as-is', () => {
    expect(windowAt({ percent: 12, resetsAt: null }, NOW)).toEqual({ percent: 12, resetsAt: null, reset: false });
    expect(windowAt(null, NOW)).toBeNull();
  });
});

describe('limitLevel', () => {
  it('is blue up to 60%, yellow above, red from 85%', () => {
    expect(limitLevel(0)).toBe('ok');
    expect(limitLevel(60)).toBe('ok');
    expect(limitLevel(60.4)).toBe('warn');
    expect(limitLevel(84.9)).toBe('warn');
    expect(limitLevel(85)).toBe('crit');
    expect(limitLevel(100)).toBe('crit');
  });
});

describe('plan usage store', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    _resetForTesting();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the latest report and notifies only on change', () => {
    const cb = vi.fn();
    onPlanUsageChange(cb);
    updatePlanUsage({ five_hour: { used_percentage: 10, resets_at: 1_790_000_000 } }, NOW);
    updatePlanUsage({ five_hour: { used_percentage: 10, resets_at: 1_790_000_000 } }, NOW + 5000);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(getPlanUsage()?.updatedAt).toBe(NOW + 5000);
    updatePlanUsage({ five_hour: { used_percentage: 11, resets_at: 1_790_000_000 } }, NOW + 9000);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(getPlanUsage()?.fiveHour?.percent).toBe(11);
  });

  it('ignores payloads without usable windows', () => {
    const cb = vi.fn();
    onPlanUsageChange(cb);
    updatePlanUsage(null, NOW);
    expect(cb).not.toHaveBeenCalled();
    expect(getPlanUsage()).toBeNull();
  });

  it('restores the last snapshot after a restart', () => {
    updatePlanUsage({ seven_day: { used_percentage: 33, resets_at: 1_790_300_000 } }, NOW);
    _resetForTesting();
    expect(getPlanUsage()?.sevenDay).toEqual({ percent: 33, resetsAt: 1_790_300_000_000 });
  });

  it('keeps the fresher report when sessions disagree', () => {
    // an active session in the current window
    updatePlanUsage({ five_hour: { used_percentage: 40, resets_at: 1_790_010_000 }, seven_day: { used_percentage: 20, resets_at: 1_790_300_000 } }, NOW);
    // an idle session still reporting the previous 5-hour window, and a lower weekly figure
    updatePlanUsage({ five_hour: { used_percentage: 90, resets_at: 1_789_990_000 }, seven_day: { used_percentage: 12, resets_at: 1_790_300_000 } }, NOW + 1000);
    expect(getPlanUsage()?.fiveHour?.percent).toBe(40);
    expect(getPlanUsage()?.sevenDay?.percent).toBe(20);
    // the next window starts over
    updatePlanUsage({ five_hour: { used_percentage: 3, resets_at: 1_790_028_000 } }, NOW + 2000);
    expect(getPlanUsage()?.fiveHour?.percent).toBe(3);
  });

  it('works without storage', () => {
    vi.stubGlobal('localStorage', undefined);
    updatePlanUsage({ five_hour: { used_percentage: 5 } }, NOW);
    expect(getPlanUsage()?.fiveHour?.percent).toBe(5);
  });
});

describe('mergeWindow', () => {
  it('prefers a later window, and more usage within the same one', () => {
    const a = { percent: 50, resetsAt: 1_000_000 };
    expect(mergeWindow(a, { percent: 5, resetsAt: 20_000_000 })).toEqual({ percent: 5, resetsAt: 20_000_000 });
    expect(mergeWindow(a, { percent: 90, resetsAt: -5_000_000 })).toBe(a);
    expect(mergeWindow(a, { percent: 55, resetsAt: 1_030_000 })).toEqual({ percent: 55, resetsAt: 1_030_000 });
    expect(mergeWindow(a, { percent: 45, resetsAt: 1_000_000 })).toBe(a);
    expect(mergeWindow(null, a)).toBe(a);
    expect(mergeWindow(a, null)).toBe(a);
  });
});
