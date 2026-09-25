import { CREAM, FloatingDots, Particles, clamp, easeInOut, easeOut, lerp, seg, type ClawdAnimation, type Stage } from './engine.js';
import { drawBubble, drawClawd, type Eyes } from './sprites.js';

// Animation mode — 魁地奇 (the skill's preset: gold Clawd, Sorting Hat,
// glasses, the Golden Snitch): over the Quidditch pitch, the Snitch zips in
// and darts about, Clawd chases it on his broom — swerving, diving at the
// stands — snatches it out of the air, flies a victory lap while the crowd
// cheers, then lets it go and races off after it.

const GW = 48;
const GH = 36;
const GOLD = '#FFD700';
const TAU = Math.PI * 2;
/** How far behind the Snitch Clawd flies, in loop time. */
const LAG = 0.035;

/** The Snitch's flight: [t, x, y] stops it darts between, with a pause at most. */
const SNITCH: [number, number, number][] = [
  [0, 52, 12], [0.06, 38, 9], [0.1, 38, 9], [0.13, 29, 5], [0.17, 29, 5], [0.2, 20, 13], [0.24, 20, 13],
  [0.27, 35, 17], [0.3, 35, 17], [0.33, 26, 4], [0.37, 26, 4], [0.4, 40, 12], [0.43, 40, 12],
  [0.47, 27, 21], [0.51, 20, 17], [0.56, 20, 17],
];

const HOUSES: [string, string][] = [['#B3282D', '#E8B83A'], ['#2E7D4F', '#B8BCC6'], ['#2E5AAC', '#B0793A'], ['#E8C33A', '#333333']];
const HEADS = ['#F2C9A0', '#8D5524', '#E0AC69', '#C68642', '#5A3825', '#F5D0B5'];

function snitchAt(t: number): [number, number] {
  for (let i = 0; i < SNITCH.length - 1; i++) {
    const [t0, x0, y0] = SNITCH[i];
    const [t1, x1, y1] = SNITCH[i + 1];
    if (t <= t1) {
      const k = easeInOut(clamp((t - t0) / (t1 - t0)));
      return [lerp(x0, x1, k), lerp(y0, y1, k)];
    }
  }
  const last = SNITCH[SNITCH.length - 1];
  return [last[1], last[2]];
}

/** Clawd's box while he chases: his right hand just behind the Snitch, kept above the stands. */
function chaseAt(t: number): [number, number] {
  const [x, y] = snitchAt(Math.max(0, t - LAG));
  return [x - 13, clamp(y - 1, 7, 18)];
}

/** The Snitch: a gold ball with a glint and a shaded side, silver-white wings beating. */
function drawSnitch(s: Stage, x: number, y: number, up: boolean): void {
  x = Math.round(x);
  y = Math.round(y);
  const wing = '#F4F4F4';
  const tip = up ? y - 1 : y + 2;
  const mid = up ? y - 1 : y + 1;
  s.px(x - 3, tip, wing);
  s.px(x - 2, mid, wing);
  s.px(x - 1, y, wing);
  s.px(x + 4, tip, wing);
  s.px(x + 3, mid, wing);
  s.px(x + 2, y, wing);
  s.rect(x, y, 2, 2, GOLD);
  s.px(x, y, '#FFF6B8');
  s.px(x + 1, y + 1, '#A87900');
}

/** The broom under Clawd, flying toward `dir`, the front end tilted by `tilt` rows. */
function drawBroom(s: Stage, ox: number, oy: number, dir: number, tilt: number): void {
  const y = oy + 6;
  const back = dir > 0 ? ox - 4 : ox + 17;
  for (let k = 0; k <= 21; k++) s.px(back + dir * k, y + (k > 14 ? tilt : 0), '#8B5520');
  // bristles fanning out behind, bound with a band
  for (let j = 1; j <= 4; j++) {
    const x = back - dir * j;
    const spread = j >= 3 ? 2 : 1;
    for (let dy = -spread; dy <= spread; dy++) s.px(x, y + dy, (x + dy) % 3 === 0 ? '#D8B878' : '#FFDD33');
  }
  s.rect(back, y - 1, 1, 3, '#6B4318');
}

function drawPitch(s: Stage, t: number, cheer: boolean, f: number): void {
  // pale clouds drifting
  s.alpha(0.8);
  for (const [x0, y, r] of [[8, 5, 3], [30, 3, 2.5], [44, 7, 2]] as const) {
    const x = ((x0 + t * 10) % (GW + 10)) - 3;
    s.disc(x, y, r, '#ECE8E2');
    s.disc(x + r, y + 0.6, r * 0.8, '#ECE8E2');
    s.disc(x - r * 0.9, y + 0.8, r * 0.7, '#ECE8E2');
  }
  s.alpha(1);
  // three goal hoops far off
  s.alpha(0.4);
  for (const [cx, cy, r] of [[36, 9, 2.5], [41, 6, 3], [46, 10, 2.5]] as const) {
    for (let a = 0; a < 360; a += 20) {
      const rad = (a * Math.PI) / 180;
      s.px(Math.round(cx + Math.cos(rad) * r), Math.round(cy + Math.sin(rad) * r), '#C9B282');
    }
    s.rect(cx, Math.round(cy + r) + 1, 1, 26 - Math.round(cy + r), '#C9B282');
  }
  s.alpha(1);
  // the stands: spectators, a rail, house drapes, timber
  for (let x = 0; x < GW; x += 2) {
    const bob = cheer && (x + Math.floor(f / 4)) % 4 === 0 ? 1 : 0;
    s.px(x + 1, 26 - bob, HEADS[(x * 7) % HEADS.length]);
  }
  s.rect(0, 27, GW, 1, '#7E6244');
  HOUSES.forEach(([a, b], i) => {
    for (let x = i * 12; x < i * 12 + 12; x++) s.rect(x, 28, 1, 4, Math.floor(x / 2) % 2 === 0 ? a : b);
  });
  s.rect(0, 32, GW, GH - 32, '#9C7B57');
  for (let x = 3; x < GW; x += 6) s.rect(x, 32, 1, GH - 32, '#7E6244');
}

export const quidditchAnimation: ClawdAnimation = {
  id: 'quidditch',
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
        const cheer = t >= 0.56 && t < 0.84;
        drawPitch(s, t, cheer, f);

        // where Clawd flies: in from the left, on the Snitch's tail, a victory lap, off after it
        let ox: number;
        let oy: number;
        const [cx, cy] = chaseAt(t);
        if (t < 0.16) {
          const k = easeOut(seg(t, 0.03, 0.16));
          ox = lerp(-22, cx, k);
          oy = lerp(14, cy, k);
        } else if (t < 0.56) {
          ox = cx;
          oy = cy;
        } else if (t < 0.82) {
          // a loop round the sky with the Snitch held high
          const k = easeInOut(seg(t, 0.56, 0.82));
          const a = k * TAU;
          ox = 7 + 10 * (1 - Math.cos(a)) * 0.9 + k * 4;
          oy = 16 - Math.sin(a) * 6 - (1 - Math.cos(a)) * 2;
        } else {
          const k = easeInOut(seg(t, 0.84, 0.95));
          ox = lerp(11, 54, k);
          oy = lerp(16, 8, k);
        }
        const [nx, ny] = t < 0.56 && t >= 0.16 ? chaseAt(t + 0.01) : [ox, oy];
        const dir = t >= 0.16 && t < 0.56 && nx < ox - 0.2 ? -1 : 1;
        const tilt = t >= 0.16 && t < 0.56 ? Math.round(clamp((ny - oy) * 1.5, -1, 1)) : 0;
        ox = Math.round(ox);
        oy = Math.round(oy);

        // the Snitch: free, in his hand, then away again
        const caught = t >= 0.55 && t < 0.83;
        let sx: number;
        let sy: number;
        let armR = 0;
        if (caught) {
          armR = -2;
          sx = ox + 12;
          sy = oy - 1;
        } else if (t >= 0.83) {
          const k = easeOut(seg(t, 0.83, 0.9));
          sx = lerp(ox + 12, 56, k);
          sy = lerp(oy - 1, 3, k);
        } else {
          [sx, sy] = snitchAt(t);
          sy += Math.sin(f * 0.7) * 0.6;
          // a glittering trail while it darts
          const [px, py] = snitchAt(Math.max(0, t - 0.01));
          if (Math.hypot(sx - px, sy - py) > 0.8 && f % 2 === 0) parts.add(sx + 1, sy + 1, '#FFE680', 0, 0, 0, 0.1);
        }

        let eyes: Eyes = dir > 0 ? 'right' : 'left';
        if (t >= 0.16 && t < 0.55 && sy < oy - 2) eyes = 'up';
        if (caught) eyes = t < 0.62 ? 'up' : 'blink';
        const armL = caught && t >= 0.6 ? -2 : 0;

        // speed streaks off the bristles
        if (t >= 0.08 && t < 0.56 && f % 2 === 0) parts.add(dir > 0 ? ox - 9 : ox + 22, oy + 6 + (Math.random() - 0.5) * 2, '#D9D2C6', -dir * 0.9, 0, 0, 0.12);
        if (f === Math.floor(0.55 * total)) parts.burst(ox + 13, oy, [GOLD, '#FFF1A0', '#FFFFFF'], 20, 0.9, 0.02);
        if (cheer && f % 2 === 0) parts.add(4 + ((f * 7) % 40), 27, f % 4 === 0 ? '#B3282D' : '#E8B83A', (Math.random() - 0.5) * 0.3, -0.7 - Math.random() * 0.3, 0.025, 0.015);

        drawClawd(s, ox, oy, { eyes, armL, armR, color: GOLD, hat: 'sorting', face: 'glasses' });
        drawBroom(s, ox, oy, dir, tilt);
        drawSnitch(s, sx, sy, f % 4 < 2);

        // a flash where the hand closes on it
        const flash = seg(t, 0.55, 0.59);
        if (flash > 0 && flash < 1) {
          s.alpha(0.7 * (1 - flash));
          s.disc(ox + 13, oy, 2 + flash * 4, '#FFFFFF');
          s.alpha(1);
        }
        if (t >= 0.62 && t < 0.8) drawBubble(s, ox + 14, oy - 8, 'heart');
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
