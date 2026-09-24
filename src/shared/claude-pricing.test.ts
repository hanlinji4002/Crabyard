import { describe, it, expect } from 'vitest';
import { estimateCostUsd, normalizeModelId, priceForModel } from './claude-pricing';

const MTOK = 1_000_000;

describe('normalizeModelId', () => {
  it('strips snapshot dates, platform prefixes and context suffixes', () => {
    expect(normalizeModelId('claude-opus-4-1-20250805')).toBe('claude-opus-4-1');
    expect(normalizeModelId('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('claude-sonnet-4-5');
    expect(normalizeModelId('claude-haiku-4-5@20251001')).toBe('claude-haiku-4-5');
    expect(normalizeModelId('claude-opus-5[1m]')).toBe('claude-opus-5');
    expect(normalizeModelId('claude-opus-5-5')).toBe('claude-opus-5-5');
  });
});

describe('estimateCostUsd', () => {
  it('prices each token class at its own rate', () => {
    // Opus 5.5: $4 in, $20 out, 5m write 1.25x in, 1h write 2x in, $0.20 cache read.
    const cost = estimateCostUsd('claude-opus-5-5', { input: MTOK, output: MTOK, cacheWrite5m: MTOK, cacheWrite1h: MTOK, cacheRead: MTOK });
    expect(cost).toBeCloseTo(4 + 20 + 5 + 8 + 0.2, 10);
  });

  it('uses the per-model cache-read rate (Fable 5.1 reads at $0.25, Fable 5 at $1)', () => {
    const reads = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: MTOK };
    expect(estimateCostUsd('claude-fable-5-1', reads)).toBeCloseTo(0.25, 10);
    expect(estimateCostUsd('claude-fable-5', reads)).toBeCloseTo(1, 10);
  });

  it('doubles fast-mode traffic', () => {
    const usage = { input: MTOK, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
    expect(estimateCostUsd('claude-opus-5', { ...usage, fast: true })).toBeCloseTo(10, 10);
  });

  it('returns undefined for unknown models', () => {
    expect(estimateCostUsd('gpt-5.4', { input: 1, output: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 })).toBeUndefined();
    expect(priceForModel('claude-sonnet-5')).toEqual({ input: 2, output: 10, cacheRead: 0.2 });
  });
});
