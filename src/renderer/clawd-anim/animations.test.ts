import { describe, it, expect, beforeAll, vi } from 'vitest';
import { FPS, makeStage, pingpong, seg } from './engine';
import { CLAWD_ANIMATIONS } from './player';
import en from '../locales/en.json';
import zh from '../locales/zh-CN.json';

// A 2D context that records nothing: enough for the animations to draw into.
function fakeContext(width: number, height: number): CanvasRenderingContext2D {
  const canvas = { width, height };
  return {
    canvas,
    fillStyle: '',
    globalAlpha: 1,
    fillRect: () => undefined,
    beginPath: () => undefined,
    arc: () => undefined,
    fill: () => undefined,
    drawImage: () => undefined,
  } as unknown as CanvasRenderingContext2D;
}

beforeAll(() => {
  // Scenes cache their terrain on an offscreen canvas.
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => fakeContext(0, 0) }),
  });
});

describe('Clawd animations', () => {
  it('has eight animation-mode pieces and two scenes, all 4:3', () => {
    expect(CLAWD_ANIMATIONS.filter((a) => a.mode === 'animation')).toHaveLength(8);
    expect(CLAWD_ANIMATIONS.filter((a) => a.mode === 'scene')).toHaveLength(2);
    for (const a of CLAWD_ANIMATIONS) expect(a.gw * 3).toBe(a.gh * 4);
    expect(new Set(CLAWD_ANIMATIONS.map((a) => a.id)).size).toBe(CLAWD_ANIMATIONS.length);
  });

  it('has a title for every animation in both languages', () => {
    for (const locale of [en, zh]) {
      const titles = locale.clawdShow.anim as Record<string, string>;
      for (const a of CLAWD_ANIMATIONS) expect(titles[a.id], `${a.id}`).toBeTruthy();
    }
  });

  it.each(CLAWD_ANIMATIONS.map((a) => [a.id, a] as const))('%s draws every frame of two loops', (_id, anim) => {
    const ctx = fakeContext(anim.gw * 4, anim.gh * 4);
    const stage = makeStage(ctx, anim.gw, anim.gh, 4);
    const run = anim.create();
    const total = Math.round(anim.seconds * FPS);
    for (let loop = 0; loop < 2; loop++) {
      for (let f = 0; f < total; f++) run.draw(stage, f, total);
    }
    expect(ctx.globalAlpha).toBe(1);
  });
});

describe('timing helpers', () => {
  it('seg and pingpong', () => {
    expect(seg(0.5, 0.4, 0.6)).toBeCloseTo(0.5);
    expect(seg(0.1, 0.4, 0.6)).toBe(0);
    expect(pingpong(0.25)).toBeCloseTo(0.5);
    expect(pingpong(0.75)).toBeCloseTo(0.5);
    expect(pingpong(1)).toBe(0);
  });
});
