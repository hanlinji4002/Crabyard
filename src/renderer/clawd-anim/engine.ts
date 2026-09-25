// Pixel-art canvas engine for the Clawd animations, drawn after the clawd
// avatar skill (github.com/YANZHANLIN/clawd-avatar-skill): its animation mode
// (one big Clawd on a 36-cell stage, cream background with floating dots) and
// its scene mode (a top-down map full of small Clawds). Everything is drawn on
// a logical grid; each cell covers whole device pixels, with cell edges
// rounded so the grid fills the canvas exactly without gaps.

export type Mode = 'animation' | 'scene';

export interface Stage {
  readonly ctx: CanvasRenderingContext2D;
  /** Logical grid size in cells. */
  readonly gw: number;
  readonly gh: number;
  /** Device pixels per cell (may be fractional). */
  readonly cell: number;
  px(x: number, y: number, color: string): void;
  rect(x: number, y: number, w: number, h: number, color: string): void;
  /** A filled circle in grid units, for soft round things (dots, ripples). */
  disc(x: number, y: number, r: number, color: string): void;
  /** A rectangle at fractional cells, for details finer than one cell (glasses, sparks). */
  fine(x: number, y: number, w: number, h: number, color: string): void;
  alpha(a: number): void;
}

/** One playing instance of an animation; holds its own particles and caches. */
export interface AnimationRun {
  /** Draw frame `f` of `total` (frames are drawn in order, so state may carry over). */
  draw(stage: Stage, f: number, total: number): void;
}

export interface ClawdAnimation {
  id: string;
  mode: Mode;
  /** Logical grid, 4:3. */
  gw: number;
  gh: number;
  /** Seconds per loop. */
  seconds: number;
  /** Shown behind the canvas and while switching animations. */
  bg: string;
  create(): AnimationRun;
}

export const FPS = 30;

export function makeStage(ctx: CanvasRenderingContext2D, gw: number, gh: number, cell: number): Stage {
  const edge = (v: number) => Math.round(v * cell);
  return {
    ctx,
    gw,
    gh,
    cell,
    px(x, y, color) {
      const cx = Math.floor(x);
      const cy = Math.floor(y);
      const x0 = edge(cx);
      const y0 = edge(cy);
      ctx.fillStyle = color;
      ctx.fillRect(x0, y0, edge(cx + 1) - x0, edge(cy + 1) - y0);
    },
    rect(x, y, w, h, color) {
      const cx = Math.floor(x);
      const cy = Math.floor(y);
      const x0 = edge(cx);
      const y0 = edge(cy);
      ctx.fillStyle = color;
      ctx.fillRect(x0, y0, edge(cx + Math.round(w)) - x0, edge(cy + Math.round(h)) - y0);
    },
    disc(x, y, r, color) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x * cell, y * cell, r * cell, 0, Math.PI * 2);
      ctx.fill();
    },
    fine(x, y, w, h, color) {
      const x0 = edge(x);
      const y0 = edge(y);
      ctx.fillStyle = color;
      ctx.fillRect(x0, y0, Math.max(1, edge(x + w) - x0), Math.max(1, edge(y + h) - y0));
    },
    alpha(a) {
      ctx.globalAlpha = a;
    },
  };
}

// ─── Timing helpers ─────────────────────────────────────────────────

export function clamp(v: number, lo = 0, hi = 1): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Progress of `t` through [a, b], clamped to 0–1. */
export function seg(t: number, a: number, b: number): number {
  return clamp((t - a) / (b - a));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** 0 → 1 → 0 over one period. */
export function pingpong(t: number): number {
  const m = ((t % 1) + 1) % 1;
  return m < 0.5 ? m * 2 : 2 - m * 2;
}

/** Stable pseudo-random 0–1 for a cell, for textures. */
export function hash(x: number, y: number): number {
  return ((Math.sin(x * 127.1 + y * 311.7) * 43758.5453) % 1 + 1) % 1;
}

// ─── Particles ──────────────────────────────────────────────────────

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  g: number;
  life: number;
  decay: number;
  color: string;
  /** Row where the particle lands and disappears. */
  floor: number;
}

export class Particles {
  private list: Particle[] = [];

  add(x: number, y: number, color: string, vx: number, vy: number, g = 0.04, decay = 0.025, floor = Infinity): void {
    this.list.push({ x, y, vx, vy, g, life: 1, decay, color, floor });
  }

  /** A burst of `n` particles flying out from (x, y). */
  burst(x: number, y: number, colors: string[], n: number, speed = 0.8, g = 0.04): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.4 + Math.random() * 0.6);
      this.add(x, y, colors[i % colors.length], Math.cos(a) * v, Math.sin(a) * v - speed * 0.6, g);
    }
  }

  step(s: Stage): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.g;
      p.life -= p.decay;
      if (p.life <= 0 || p.y > s.gh + 2 || p.y >= p.floor) {
        this.list.splice(i, 1);
        continue;
      }
      if (p.life > 0.12) s.px(Math.round(p.x), Math.round(p.y), p.color);
    }
  }

  clear(): void {
    this.list.length = 0;
  }
}

// ─── Animation-mode background ──────────────────────────────────────

export const CREAM = '#F9F7F4';

/** The skill's drawFloatingDots: faint round dots drifting slowly upward. */
export class FloatingDots {
  private dots: { x: number; y: number; r: number; vy: number; vx: number; phase: number; alpha: number }[] = [];

  constructor(private gw: number, private gh: number, count = 34) {
    for (let i = 0; i < count; i++) {
      this.dots.push({
        x: Math.random() * gw,
        y: Math.random() * gh,
        r: 0.08 + Math.random() * 0.16,
        vy: -(0.008 + Math.random() * 0.018),
        vx: (Math.random() - 0.5) * 0.01,
        phase: Math.random() * Math.PI * 2,
        alpha: 0.08 + Math.random() * 0.18,
      });
    }
  }

  draw(s: Stage, f: number): void {
    for (const d of this.dots) {
      d.y += d.vy;
      d.x += d.vx + Math.sin(f * 0.02 + d.phase) * 0.008;
      if (d.y < -1) {
        d.y = this.gh + 1;
        d.x = Math.random() * this.gw;
      }
      s.alpha(d.alpha * (0.7 + 0.3 * Math.sin(f * 0.04 + d.phase)));
      s.disc(d.x, d.y, d.r, '#000');
    }
    s.alpha(1);
  }
}

/** Grass with the skill's three greens, from row `top` down. */
export function drawGrass(s: Stage, top: number): void {
  for (let y = top; y < s.gh; y++) {
    for (let x = 0; x < s.gw; x++) {
      const h = hash(x, y);
      s.px(x, y, h > 0.6 ? '#7BAE56' : h > 0.3 ? '#6B9E4A' : '#5B8C3E');
    }
  }
}
