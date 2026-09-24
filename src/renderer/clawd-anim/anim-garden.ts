import { CREAM, FloatingDots, Particles, drawGrass, easeOut, lerp, seg, type ClawdAnimation, type Stage } from './engine.js';
import { drawBubble, drawClawd, walkLegs, type Eyes } from './sprites.js';

// Animation mode — 浇花: Clawd in a straw hat walks in with a watering can,
// waters a sprout that grows into a flower, a butterfly lands on it, and the
// scene fades out to start over.

const GW = 48;
const GH = 36;
const GROUND = 27;
const OY = 19;
const STEM_X = 34;

function drawCan(s: Stage, ox: number, tilted: boolean): void {
  const x = ox + 13;
  const y = OY + 2;
  s.rect(x, y, 4, 3, '#3FA66B');
  s.rect(x + 1, y - 1, 2, 1, '#2E7D4F');
  s.px(x, y + 1, '#5CC285');
  if (tilted) {
    s.px(x + 4, y + 1, '#3FA66B');
    s.px(x + 5, y + 2, '#3FA66B');
    s.px(x + 6, y + 3, '#2E7D4F');
  } else {
    s.px(x + 4, y + 1, '#3FA66B');
    s.px(x + 5, y, '#3FA66B');
    s.px(x + 6, y - 1, '#2E7D4F');
  }
}

function drawPlant(s: Stage, t: number, f: number): void {
  s.rect(STEM_X - 3, GROUND, 7, 1, '#8B5A2B');
  const grow = easeOut(seg(t, 0.46, 0.6));
  const h = Math.round(lerp(2, 9, grow));
  for (let k = 0; k < h; k++) s.px(STEM_X, GROUND - 1 - k, '#4CAF50');
  s.px(STEM_X - 1, GROUND - 2, '#6CCB70');
  if (h >= 4) {
    s.px(STEM_X - 1, GROUND - 4, '#5DBB63');
    s.px(STEM_X - 2, GROUND - 4, '#5DBB63');
  }
  if (h >= 7) {
    s.px(STEM_X + 1, GROUND - 7, '#5DBB63');
    s.px(STEM_X + 2, GROUND - 7, '#5DBB63');
  }
  const top = GROUND - 1 - h;
  const bloom = easeOut(seg(t, 0.6, 0.66));
  if (t >= 0.56 && bloom <= 0) {
    s.rect(STEM_X - 1, top - 1, 2, 2, '#E0608A');
  } else if (bloom > 0) {
    const r = bloom > 0.5 ? 2 : 1;
    const petal = '#FF88AA';
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) + Math.abs(dy) > r + (r > 1 ? 1 : 0)) continue;
        s.px(STEM_X + dx, top - 1 + dy, (dx + dy + Math.floor(f / 12)) % 3 === 0 ? '#FFB3C8' : petal);
      }
    }
    s.px(STEM_X, top - 1, '#FFD700');
  }
}

function drawButterfly(s: Stage, x: number, y: number, open: boolean): void {
  x = Math.round(x);
  y = Math.round(y);
  s.rect(x, y, 1, 2, '#443388');
  if (open) {
    s.rect(x - 2, y - 1, 2, 2, '#9977CC');
    s.rect(x + 1, y - 1, 2, 2, '#9977CC');
    s.px(x - 2, y + 1, '#FFDD33');
    s.px(x + 2, y + 1, '#FFDD33');
  } else {
    s.rect(x - 1, y - 1, 1, 2, '#9977CC');
    s.rect(x + 1, y - 1, 1, 2, '#9977CC');
  }
}

export const gardenAnimation: ClawdAnimation = {
  id: 'garden',
  mode: 'animation',
  gw: GW,
  gh: GH,
  seconds: 7,
  bg: CREAM,
  create() {
    const dots = new FloatingDots(GW, GH);
    const parts = new Particles();
    return {
      draw(s, f, total) {
        const t = f / total;
        if (f === 0) parts.clear();
        s.rect(0, 0, GW, GH, CREAM);
        dots.draw(s, f);
        drawGrass(s, GROUND);
        drawPlant(s, t, f);

        const walk = seg(t, 0.03, 0.2);
        const ox = lerp(-15, 11, easeOut(walk));
        const walking = walk > 0 && walk < 1;
        const watering = t >= 0.26 && t < 0.46;

        if (watering && f % 2 === 0) parts.add(ox + 19.5, OY + 5, '#6FA8DC', 0.12 + Math.random() * 0.1, 0.05, 0.05, 0.03, GROUND);
        if (f === Math.floor(0.62 * total)) parts.burst(STEM_X, GROUND - 12, ['#FFD700', '#FFFFFF', '#FF88AA'], 16, 0.7, 0.02);

        let eyes: Eyes = walking ? 'forward' : 'right';
        let armL = 0;
        let hop = 0;
        if (watering) eyes = 'down';
        if (t >= 0.62 && t < 0.92) {
          eyes = 'sparkle';
          const k = seg(t, 0.63, 0.72);
          hop = k > 0 && k < 1 ? Math.round(Math.abs(Math.sin(k * Math.PI * 2)) * 2) : 0;
          armL = k > 0 && k < 1 ? -3 : 0;
        }
        if (!walking && t < 0.26 && f % 70 >= 66) eyes = 'blink';
        drawClawd(s, ox, OY - hop, { eyes, armL, legs: walking ? walkLegs(f) : [0, 0, 0, 0], hat: 'straw' });
        drawCan(s, ox, watering);

        // a butterfly flutters in and settles on the flower
        const fly = seg(t, 0.66, 0.8);
        if (fly > 0) {
          const bx = lerp(50, STEM_X, easeOut(fly));
          const by = lerp(4, GROUND - 14, easeOut(fly)) + (fly < 1 ? Math.sin(f * 0.4) * 1.5 : 0);
          drawButterfly(s, bx, by, fly < 1 ? f % 6 < 3 : f % 24 < 12);
        }
        if (t >= 0.72 && t < 0.9) drawBubble(s, ox + 2, OY - 11 - hop, 'heart');
        parts.step(s);

        // fade through the background at the loop seam
        const fade = t < 0.04 ? 1 - t / 0.04 : t > 0.93 ? (t - 0.93) / 0.07 : 0;
        if (fade > 0) {
          s.alpha(Math.min(1, fade));
          s.rect(0, 0, GW, GH, CREAM);
          s.alpha(1);
        }
      },
    };
  },
};
