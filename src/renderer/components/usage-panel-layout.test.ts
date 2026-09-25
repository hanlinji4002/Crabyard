import { describe, it, expect } from 'vitest';
import { DOCK_MAX_WIDTH, DOCK_MIN_WIDTH, planPaneHeights, ringsThatFit, totalsShowFull, type PaneHeightInput } from './usage-panel-layout';

const base: PaneHeightInput = {
  avail: 840,
  panes: ['turn', 'session', 'live', 'totals'],
  stored: {},
  natural: { live: 180 },
  min: 72,
  fixedMaxShare: 0.45,
};

describe('planPaneHeights', () => {
  it('gives 当前用量 its natural height and splits the rest evenly with the last pane', () => {
    // (840 - 180) / 3 = 220 each for turn, session and (implicitly) the totals.
    expect(planPaneHeights(base)).toEqual({ turn: 220, session: 220, live: 180 });
  });

  it('keeps a height the user dragged to', () => {
    expect(planPaneHeights({ ...base, stored: { turn: 300 } })).toEqual({ turn: 300, session: 180, live: 180 });
  });

  it('caps a tall 当前用量 at its share of the column', () => {
    expect(planPaneHeights({ ...base, panes: ['live', 'totals'], natural: { live: 900 } }).live).toBe(378);
  });

  it('scales dragged heights down when the column shrinks, keeping the last pane its minimum', () => {
    const out = planPaneHeights({ ...base, stored: { turn: 600, session: 400 } });
    const total = (out.turn ?? 0) + (out.session ?? 0) + (out.live ?? 0);
    expect(total).toBeLessThanOrEqual(840 - 72);
    expect(out.turn! / out.session!).toBeCloseTo(1.5, 1);
  });

  it('never goes below the minimum', () => {
    const out = planPaneHeights({ ...base, avail: 200 });
    for (const h of Object.values(out)) expect(h).toBeGreaterThanOrEqual(72);
  });

  it('never resizes 当前用量, even with a stored height', () => {
    expect(planPaneHeights({ ...base, stored: { live: 400 } }).live).toBe(180);
  });

  it('with two panes splits the column in half', () => {
    expect(planPaneHeights({ ...base, panes: ['session', 'totals'] })).toEqual({ session: 420 });
  });

  it('keeps the totals their compact block: the resizable panes above give way', () => {
    // An even split would leave the totals 220; they need 300, so turn and session shrink.
    expect(planPaneHeights({ ...base, lastMin: 300 })).toEqual({ turn: 180, session: 180, live: 180 });
  });

  it('keeps the Clawd tub at its natural height too', () => {
    const out = planPaneHeights({ ...base, panes: ['clawd', 'turn', 'live', 'totals'], natural: { clawd: 150, live: 180 }, stored: { clawd: 400 } });
    expect(out.clawd).toBe(150);
    expect(out.live).toBe(180);
    // (840 - 150 - 180) / 2 = 255 for turn and (implicitly) the totals.
    expect(out.turn).toBe(255);
  });

  it('never shrinks 当前用量 to make room for the totals', () => {
    const out = planPaneHeights({ ...base, stored: { turn: 600, session: 400 }, lastMin: 300 });
    expect(out.live).toBe(180);
    expect(out.turn! + out.session!).toBeLessThanOrEqual(840 - 180 - 300);
  });
});

describe('totalsShowFull', () => {
  it('shows everything once the pane is taller than the compact block, or when alone', () => {
    expect(totalsShowFull(340, 330, false)).toBe(true);
    expect(totalsShowFull(338, 330, false)).toBe(false);
    expect(totalsShowFull(200, 330, false)).toBe(false);
    expect(totalsShowFull(100, 330, true)).toBe(true);
  });
});

describe('ringsThatFit', () => {
  it('shows three rings at full width, then drops Fable, then the weekly ring', () => {
    expect(ringsThatFit(DOCK_MAX_WIDTH)).toBe(2);
    expect(ringsThatFit(DOCK_MAX_WIDTH + 200)).toBe(2);
    expect(ringsThatFit(DOCK_MIN_WIDTH + 100)).toBe(2);
    expect(ringsThatFit(DOCK_MIN_WIDTH + 99)).toBe(1);
    expect(ringsThatFit(DOCK_MIN_WIDTH)).toBe(1);
    expect(ringsThatFit(10)).toBe(1);
  });
});

