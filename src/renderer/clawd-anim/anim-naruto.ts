import { CREAM, FloatingDots, Particles, drawGrass, easeInOut, easeOut, lerp, seg, type ClawdAnimation, type Stage } from './engine.js';
import { drawBubble, drawClawd, walkLegs, type Eyes } from './sprites.js';

// Animation mode — 鸣人 (the skill's preset: orange, ninja headband, rasengan
// in the raised right hand): at the training ground with leaves blowing past,
// Clawd makes a shadow clone, the two of them spin up a Rasengan between their
// hands, the clone vanishes in smoke, and Clawd charges the training post and
// blasts it apart, then jumps for joy.

const GW = 48;
const GH = 36;
const GROUND = 28;
const OX = 10;
const OY = 20;
/** Where the shadow clone stands, beside Clawd's raised right hand. */
const CLONE_X = OX + 14;
/** Where the charge ends, the Rasengan against the post. */
const DASH_X = 23;
const POST_X = 38;
const ORANGE = '#FFA500';
const TAU = Math.PI * 2;

const LEAVES = [
  { x: 6, y: 5, sp: 1, ph: 0 },
  { x: 20, y: 11, sp: 1.3, ph: 2 },
  { x: 33, y: 3, sp: 0.8, ph: 4 },
  { x: 44, y: 14, sp: 1.1, ph: 1 },
  { x: 14, y: 16, sp: 0.9, ph: 3 },
];

/** A spinning ball of chakra: a white core, swirling blues, a dark rim, wind orbiting it. */
function drawRasengan(s: Stage, cx: number, cy: number, r: number, spin: number): void {
  if (r <= 0) return;
  for (let k = 0; k < 2; k++) {
    for (let j = 0; j < 4; j++) {
      const a = spin * 0.45 + k * Math.PI + j * 0.3;
      s.px(Math.floor(cx + Math.cos(a) * (r + 1.3)), Math.floor(cy + Math.sin(a) * (r + 1.3) * 0.85), '#9ED8FA');
    }
  }
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.hypot(dx, dy);
      if (d > r) continue;
      const a = Math.atan2(dy, dx);
      let c: string;
      if (d < Math.max(0.8, r * 0.38)) c = '#FFFFFF';
      else if (d > r - 0.75) c = '#2288DD';
      else c = Math.sin(2 * a + d * 2.2 - spin) > 0 ? '#BFE6FF' : '#5BB8F5';
      s.px(x, y, c);
    }
  }
}

/** Shadow-clone smoke: puffs swelling out from (cx, cy) and fading as `k` goes 0 → 1. */
function drawPoof(s: Stage, cx: number, cy: number, k: number): void {
  if (k <= 0 || k >= 1) return;
  s.alpha(1 - k);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + 0.4;
    const d = 1.5 + k * 3.5;
    s.disc(cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.8, 1.4 + k * 1.2, i % 2 ? '#E4E4E4' : '#F2F2F2');
  }
  s.disc(cx, cy, 2.6 + k, '#FAFAFA');
  s.alpha(1);
}

function drawTrees(s: Stage): void {
  s.alpha(0.45);
  for (const [x, y, r] of [[5, 21, 5], [22, 20, 4], [45, 21, 5]] as const) {
    s.rect(x, y + r - 1, 1, GROUND - y - r + 1, '#C9B08E');
    s.disc(x + 0.5, y, r, '#BFDCA8');
    s.disc(x - 1.5, y + 1.5, r * 0.7, '#B2D39A');
  }
  s.alpha(1);
}

/** The training post: a log with a rope round it. Its top half can be knocked off. */
function drawPost(s: Stage, topDx: number, topDy: number, shake: number): void {
  const x = POST_X + shake;
  // stump
  s.rect(x, 23, 4, 5, '#8B5A2B');
  s.rect(x + 1, 23, 1, 5, '#A06A36');
  s.rect(x + 3, 24, 1, 4, '#6E4520');
  // top half
  const tx = Math.round(x + topDx);
  const ty = Math.round(topDy);
  s.rect(tx, 17 + ty, 4, 6, '#8B5A2B');
  s.rect(tx + 1, 17 + ty, 1, 6, '#A06A36');
  s.rect(tx + 3, 18 + ty, 1, 5, '#6E4520');
  s.rect(tx, 17 + ty, 4, 1, '#C49A6C');
  s.rect(tx, 20 + ty, 4, 1, '#D8B878');
  s.px(tx + 2, 20 + ty, '#B89A5E');
}

export const narutoAnimation: ClawdAnimation = {
  id: 'naruto',
  mode: 'animation',
  gw: GW,
  gh: GH,
  seconds: 7,
  bg: CREAM,
  create() {
    const dots = new FloatingDots(GW, GH, 24);
    const parts = new Particles();
    return {
      draw(s, f, total) {
        const t = f / total;
        if (f === 0) parts.clear();
        s.rect(0, 0, GW, GH, CREAM);
        dots.draw(s, f);
        drawTrees(s);
        drawGrass(s, GROUND);

        // leaves of the Hidden Leaf, blowing past
        for (const l of LEAVES) {
          const span = GW + 10;
          const x = ((((l.x - t * span * l.sp * 2) % span) + span) % span) - 5;
          const y = l.y + Math.sin(TAU * 3 * t + l.ph) * 1.5;
          const flip = Math.floor(f / 5 + l.ph) % 2 === 0;
          s.px(Math.round(x), Math.round(y), '#5DBB63');
          s.px(Math.round(x) + 1, Math.round(y) + (flip ? 0 : 1), '#46A24E');
        }

        // the post: knocked apart at the impact
        const hit = seg(t, 0.64, 0.8);
        const shake = t >= 0.64 && t < 0.68 ? (f % 2 === 0 ? 1 : -1) : 0;
        drawPost(s, hit * 12, -hit * 10 + hit * hit * 30, shake);

        const cloneIn = t >= 0.2 && t < 0.52;
        const charge = seg(t, 0.26, 0.5);
        const dash = seg(t, 0.56, 0.64);
        let ox = OX;
        if (t >= 0.56) ox = Math.round(lerp(OX, DASH_X, easeInOut(dash)));

        // Clawd's pose
        let eyes: Eyes = 'forward';
        let armL = 0;
        let armR = 0;
        let hop = 0;
        let legs: [number, number, number, number] = [0, 0, 0, 0];
        if (t >= 0.08 && t < 0.14) eyes = 'right';
        if (t >= 0.14 && t < 0.2) {
          // hand sign
          armL = -1;
          armR = -1;
        }
        if (t >= 0.2 && t < 0.26) eyes = 'right';
        if (t >= 0.24 && t < 0.52) armR = -3;
        if (t >= 0.26 && t < 0.52) eyes = f % 50 < 40 ? 'right' : 'forward';
        if (t >= 0.52 && t < 0.56) {
          eyes = 'right';
          armR = lerp(-3, -1, seg(t, 0.52, 0.56));
        }
        if (t >= 0.56 && t < 0.66) {
          eyes = 'right';
          armR = -1;
          legs = dash < 1 ? walkLegs(f, 2) : [-1, 0, 0, 1];
        }
        if (t >= 0.66 && t < 0.72) eyes = 'right';
        if (t >= 0.72 && t < 0.9) {
          eyes = 'sparkle';
          armL = -3;
          armR = -3;
          const k = seg(t, 0.72, 0.86);
          hop = k > 0 && k < 1 ? Math.round(Math.abs(Math.sin(k * Math.PI * 3)) * 3) : 0;
        }
        if (t >= 0.9) armR = -2;
        if (t < 0.08 && f % 70 >= 66) eyes = 'blink';

        // dust behind the charge
        if (dash > 0 && dash < 1 && f % 2 === 0) {
          parts.add(ox + 2, GROUND - 1, '#CDBB98', -0.4, -0.15, 0.02, 0.07);
          parts.add(ox + 1, OY + 1, '#D9D2C6', -1.2, 0, 0, 0.15);
          parts.add(ox + 1, OY + 4, '#D9D2C6', -1.2, 0, 0, 0.15);
        }

        drawClawd(s, ox, OY - hop, { eyes, armL, armR, legs, color: ORANGE, hat: 'ninja', flutter: f, wind: -1 });

        // the shadow clone
        const poofIn = seg(t, 0.17, 0.25);
        const poofOut = seg(t, 0.5, 0.58);
        if (cloneIn) {
          const jiggle = t >= 0.26 && f % 4 < 2 ? -1 : 0;
          drawClawd(s, CLONE_X, OY, {
            eyes: 'left',
            armL: t >= 0.24 ? -3 + jiggle : 0,
            color: ORANGE,
            hat: 'ninja',
            flutter: f + 6,
            wind: -1,
          });
        }
        drawPoof(s, CLONE_X + 7, OY + 3, poofIn);
        drawPoof(s, CLONE_X + 7, OY + 3, poofOut);

        // the Rasengan: spun up between the two raised hands, then carried into the post
        const spin = f * 0.9;
        let ball: [number, number, number] | null = null;
        if (t >= 0.26 && t < 0.52) {
          ball = [OX + 14, OY - 3.5, lerp(0.8, 3, easeOut(charge))];
          if (f % 2 === 0) {
            const a = Math.random() * TAU;
            parts.add(OX + 14 + Math.cos(a) * 6, OY - 3.5 + Math.sin(a) * 5, '#7FC8F8', -Math.cos(a) * 0.45, -Math.sin(a) * 0.4, 0, 0.09);
          }
        } else if (t >= 0.52 && t < 0.64) {
          const k = seg(t, 0.52, 0.56);
          ball = [ox + 14.5, lerp(OY - 3.5, OY + 1.5, easeInOut(k)), 2.8];
        }
        if (ball) drawRasengan(s, ball[0], ball[1], ball[2], spin);

        // impact: a ring of wind, splinters, the ball bursting
        if (f === Math.floor(0.64 * total)) {
          parts.burst(POST_X + 1, 20, ['#8B5A2B', '#A06A36', '#C49A6C', '#6E4520'], 16, 1.1);
          parts.burst(POST_X - 1, OY + 1, ['#FFFFFF', '#BFE6FF', '#5BB8F5'], 18, 0.9, 0.01);
        }
        const ring = seg(t, 0.64, 0.74);
        if (ring > 0 && ring < 1) {
          const R = 2 + ring * 11;
          s.alpha(1 - ring);
          for (let a = 0; a < 360; a += 10) {
            const rad = (a * Math.PI) / 180;
            s.px(Math.round(POST_X - 1 + Math.cos(rad) * R), Math.round(OY + 1.5 + Math.sin(rad) * R * 0.8), '#9ED8FA');
          }
          s.alpha(1);
        }

        if (t >= 0.74 && t < 0.9) drawBubble(s, ox + 2, OY - 9 - hop, '!');
        parts.step(s);

        // fade through the background at the loop seam
        const fade = t < 0.04 ? 1 - t / 0.04 : t > 0.94 ? (t - 0.94) / 0.06 : 0;
        if (fade > 0) {
          s.alpha(Math.min(1, fade));
          s.rect(0, 0, GW, GH, CREAM);
          s.alpha(1);
        }
      },
    };
  },
};
