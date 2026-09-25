import { CREAM, FloatingDots, Particles, easeInOut, easeOut, hash, lerp, seg, type ClawdAnimation, type Stage } from './engine.js';
import { drawClawd, walkLegs, type Eyes } from './sprites.js';

// Animation mode — 晓组织 (the skill's preset: the Akatsuki kasa and the
// black cloak with red clouds): under a red moon on a windswept wasteland,
// Clawd walks in, a crow flies past, his eyes turn Sharingan red, and he
// bursts into a flock of crows that wheels across the sky and gathers into
// him again further on — then he walks off into the wind.

const GW = 48;
const GH = 36;
const GROUND = 28;
const OY = 20;
/** Where he stops, and where the crows put him back together. */
const X1 = 12;
const X2 = 27;
const TAU = Math.PI * 2;
const CROW = '#1E1E24';
const CROWS = 12;
const SHARINGAN = '#DC2828';

const STREAKS = [
  { x: 10, y: 5, len: 5, sp: 1.1 },
  { x: 30, y: 12, len: 4, sp: 1.4 },
  { x: 44, y: 17, len: 6, sp: 0.9 },
  { x: 20, y: 22, len: 4, sp: 1.2 },
  { x: 38, y: 3, len: 3, sp: 1.6 },
];

function drawMoon(s: Stage, glow: number): void {
  s.alpha(0.12 + 0.25 * glow);
  s.disc(39, 7, 7.5 + glow * 1.5, '#E0564F');
  s.alpha(1);
  s.disc(39, 7, 5.5, '#C9302C');
  s.disc(37.7, 5.7, 3, '#D8433A');
  s.alpha(0.5);
  s.disc(41, 9, 0.9, '#A82622');
  s.disc(36.8, 9.4, 0.6, '#A82622');
  s.alpha(1);
}

function drawWasteland(s: Stage, t: number, f: number): void {
  for (let y = GROUND; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      const h = hash(x, y);
      s.px(x, y, y === GROUND ? '#6F655D' : h > 0.66 ? '#978B80' : h > 0.33 ? '#8A7F76' : '#7D7269');
    }
  }
  // rocks and dry tufts bending in the wind
  s.rect(4, GROUND - 1, 3, 1, '#968C83');
  s.px(5, GROUND - 2, '#A39990');
  s.rect(44, GROUND - 1, 2, 1, '#968C83');
  for (const [x, ph] of [[9, 0], [24, 2], [41, 4]] as const) {
    const bend = Math.sin(f * 0.25 + ph) > 0 ? -1 : 0;
    s.px(x, GROUND - 1, '#A89266');
    s.px(x - 1 + bend, GROUND - 2, '#B8A378');
    s.px(x + 1 + bend, GROUND - 2, '#B8A378');
    s.px(x + bend, GROUND - 3, '#C2AE82');
  }
  // wind streaks rushing left
  s.alpha(0.55);
  for (const w of STREAKS) {
    const span = GW + 10;
    const x = ((((w.x - t * span * w.sp * 3) % span) + span) % span) - 5;
    s.rect(Math.round(x), w.y, w.len, 1, '#D9D3CA');
  }
  s.alpha(1);
}

/** A crow, 5×3: wings up or down, one red eye. */
function drawCrow(s: Stage, x: number, y: number, up: boolean, facing: number): void {
  x = Math.round(x);
  y = Math.round(y);
  if (up) {
    s.px(x, y, CROW);
    s.px(x + 4, y, CROW);
    s.rect(x + 1, y + 1, 3, 1, CROW);
    s.px(x + 2, y + 2, CROW);
  } else {
    s.px(x + 2, y, CROW);
    s.rect(x + 1, y + 1, 3, 1, CROW);
    s.px(x, y + 2, CROW);
    s.px(x + 4, y + 2, CROW);
  }
  s.px(x + (facing < 0 ? 1 : 3), y + 1, '#B81E1E');
}

/** Red eyes with dark pupils and a faint glow, over Clawd's eye cells. */
function drawSharingan(s: Stage, ox: number, oy: number, eyes: Eyes, strength: number): void {
  if (strength <= 0 || eyes === 'blink') return;
  const dy = eyes === 'up' ? -1 : eyes === 'down' ? 1 : 0;
  const dx = eyes === 'left' ? -1 : eyes === 'right' ? 1 : 0;
  for (const ex of [ox + 4 + dx, ox + 9 + dx]) {
    const ey = oy + 1 + dy;
    s.alpha(0.3 * strength);
    s.disc(ex + 0.5, ey + 0.5, 1.3, '#FF3B30');
    s.alpha(strength);
    s.px(ex, ey, SHARINGAN);
    s.fine(ex + 0.3, ey + 0.3, 0.4, 0.4, '#1A1A1A');
    s.alpha(1);
  }
}

/**
 * Crow `i` of the flock at `k` (0 → 1): a ring of crows that bursts out of
 * Clawd at X1, wheels round as it sweeps up across the sky, and closes in on X2.
 */
function flockPoint(i: number, k: number): [number, number] {
  const sx = X1 + 7;
  const ex = X2 + 7;
  const y0 = OY + 2;
  const u = 1 - k;
  // the ring's centre: up over the sky and down again
  const cx = u * u * sx + 2 * u * k * ((sx + ex) / 2 - 2) + k * k * ex;
  const cy = u * u * y0 + 2 * u * k * 2 + k * k * y0;
  const r = Math.sin(Math.PI * k) * (9 + (i % 3) * 2.5);
  const a = (i / CROWS) * TAU + k * TAU * 1.25;
  return [cx + Math.cos(a) * r - 2, cy + Math.sin(a) * r * 0.6 - 1];
}

export const akatsukiAnimation: ClawdAnimation = {
  id: 'akatsuki',
  mode: 'animation',
  gw: GW,
  gh: GH,
  seconds: 7,
  bg: CREAM,
  create() {
    const dots = new FloatingDots(GW, GH, 22);
    const parts = new Particles();
    return {
      draw(s, f, total) {
        const t = f / total;
        if (f === 0) parts.clear();
        s.rect(0, 0, GW, GH, CREAM);
        dots.draw(s, f);
        const glow = t >= 0.3 && t < 0.62 ? Math.abs(Math.sin(seg(t, 0.3, 0.62) * Math.PI * 3)) : 0;
        drawMoon(s, glow);
        drawWasteland(s, t, f);

        // where he is, and how solid: walking in, gone as crows, back, walking off
        let ox = X1;
        let walking = false;
        if (t < 0.22) {
          ox = Math.round(lerp(-14, X1, easeOut(seg(t, 0.02, 0.22))));
          walking = t < 0.21;
        } else if (t >= 0.58 && t < 0.8) {
          ox = X2;
        } else if (t >= 0.8) {
          ox = Math.round(lerp(X2, 50, easeInOut(seg(t, 0.8, 0.96))));
          walking = true;
        } else if (t >= 0.42) {
          ox = X2;
        }
        const solid = t < 0.36 ? 1 : t < 0.42 ? 1 - seg(t, 0.36, 0.42) : t < 0.58 ? 0 : seg(t, 0.58, 0.64);

        let eyes: Eyes = 'forward';
        if (t >= 0.2 && t < 0.3) eyes = t < 0.26 ? 'up' : 'right';
        if (t >= 0.3 && t < 0.36) eyes = 'forward';
        if (t >= 0.8) eyes = 'right';
        if (t < 0.2 && f % 70 >= 66) eyes = 'blink';
        const red = t >= 0.3 && t < 0.72 ? (t < 0.33 ? seg(t, 0.3, 0.33) : t < 0.66 ? 1 : 1 - seg(t, 0.66, 0.72)) : 0;

        if (solid > 0) {
          s.alpha(solid);
          drawClawd(s, ox, OY, {
            eyes,
            legs: walking ? walkLegs(f, 5) : [0, 0, 0, 0],
            hat: 'akatsuki',
            outfit: 'cloak',
            flutter: f,
            wind: -1,
          });
          s.alpha(1);
          drawSharingan(s, ox, OY, eyes, red * solid);
        }
        // a red flash as the Sharingan wakes
        if (t >= 0.3 && t < 0.34) {
          s.alpha(0.12 * (1 - seg(t, 0.3, 0.34)));
          s.rect(0, 0, GW, GH, '#C9302C');
          s.alpha(1);
        }

        // a crow flies past overhead
        const pass = seg(t, 0.2, 0.32);
        if (pass > 0 && pass < 1) drawCrow(s, lerp(50, -6, pass), 8 + Math.sin(pass * TAU) * 1.5, f % 6 < 3, -1);

        // the flock: bursting out of him, wheeling across the sky, gathering at X2
        if (t >= 0.36 && t < 0.64) {
          for (let i = 0; i < CROWS; i++) {
            const k = easeInOut(seg(t, 0.36 + (i % 4) * 0.006, 0.6 + (i % 4) * 0.006));
            if (k >= 1) continue;
            const [x, y] = flockPoint(i, k);
            drawCrow(s, x, y, (f + i * 2) % 6 < 3, k < 0.5 ? (i % 2 ? 1 : -1) : 1);
          }
          if (f % 3 === 0 && t < 0.58) {
            const [x, y] = flockPoint(f % CROWS, seg(t, 0.36, 0.6));
            parts.add(x + 2, y + 2, '#2A2A30', (Math.random() - 0.5) * 0.15, 0.06, 0.004, 0.012, GROUND);
          }
        }
        if (f === Math.floor(0.36 * total)) parts.burst(X1 + 7, OY + 2, [CROW, '#2A2A30'], 14, 0.7, 0.02);
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
