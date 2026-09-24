import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  _resetForTesting,
  getPlanUsage,
  limitLevel,
  onPlanUsageChange,
  parseRateLimits,
  pickModelWindow,
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
  it('reads the 5-hour, weekly and per-model windows', () => {
    const usage = parseRateLimits({
      five_hour: { used_percentage: 57.4, resets_at: 1_790_000_000 },
      seven_day: { used_percentage: 10, resets_at: 1_790_300_000 },
      model_scoped: [{ display_name: 'Fable', utilization: 0, resets_at: '2026-09-30T00:00:00Z' }],
    }, NOW);
    expect(usage).toEqual({
      fiveHour: { percent: 57.4, resetsAt: 1_790_000_000_000 },
      sevenDay: { percent: 10, resetsAt: 1_790_300_000_000 },
      scoped: [{ label: 'Fable', percent: 0, resetsAt: Date.parse('2026-09-30T00:00:00Z') }],
      updatedAt: NOW,
    });
  });

  it('clamps percentages and accepts epoch-ms reset times', () => {
    const usage = parseRateLimits({ five_hour: { used_percentage: 140, resets_at: 1_790_000_000_000 } }, NOW);
    expect(usage?.fiveHour).toEqual({ percent: 100, resetsAt: 1_790_000_000_000 });
    expect(usage?.sevenDay).toBeNull();
  });

  it('drops malformed per-model entries and caps how many it keeps', () => {
    const usage = parseRateLimits({
      model_scoped: [
        null,
        { utilization: 5 },
        { display_name: '  ', utilization: 5 },
        { display_name: 'A', utilization: 1 },
        { display_name: 'B', utilization: 2 },
        { display_name: 'C', utilization: 3 },
        { display_name: 'D', utilization: 4 },
        { display_name: 'E', utilization: 5 },
      ],
    }, NOW);
    expect(usage?.scoped.map((w) => w.label)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('returns null when nothing usable is present', () => {
    expect(parseRateLimits(undefined, NOW)).toBeNull();
    expect(parseRateLimits('x', NOW)).toBeNull();
    expect(parseRateLimits({ five_hour: {}, seven_day: null, model_scoped: [] }, NOW)).toBeNull();
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

describe('pickModelWindow', () => {
  it('prefers the Fable window', () => {
    const a = { label: 'Opus', percent: 1, resetsAt: null };
    const b = { label: 'Claude Fable', percent: 2, resetsAt: null };
    expect(pickModelWindow([a, b])).toBe(b);
    expect(pickModelWindow([a])).toBe(a);
    expect(pickModelWindow([])).toBeNull();
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

  it('works without storage', () => {
    vi.stubGlobal('localStorage', undefined);
    updatePlanUsage({ five_hour: { used_percentage: 5 } }, NOW);
    expect(getPlanUsage()?.fiveHour?.percent).toBe(5);
  });
});
