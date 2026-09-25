import { CREAM, FloatingDots, Particles, easeInOut, easeOut, lerp, seg, type ClawdAnimation, type Stage } from './engine.js';
import { drawBubble, drawClawd, type Eyes } from './sprites.js';

// Animation mode — 哈利波特 (the skill's preset: wizard hat, wand, glasses and
// scar): in the Great Hall under floating candles, Clawd does the swish and
// flick, the feather on the desk rises and dances in the air — Wingardium
// Leviosa — he hops for joy, and the feather drifts down onto his hat.

const GW = 48;
const GH = 36;
const FLOOR = 28;
const OX = 12;
const OY = 20;
const TAU = Math.PI * 2;
/** The feather at rest on the desk (top-left of its 6×3 sprite). */
const REST_X = 35;
const REST_Y = 18;
/** Where it settles at the end: on the tip of the wizard hat. */
const HAT_X = OX + 3;
const HAT_Y = OY - 10;

const CANDLES = [
  { x: 10, y: 5, ph: 0 },
  { x: 17, y: 3, ph: 1.7 },
  { x: 29, y: 6, ph: 3.1 },
  { x: 41, y: 4, ph: 4.4 },
];

function drawCandle(s: Stage, x: number, y: number, f: number, ph: number): void {
  const bob = Math.round(Math.sin(f * 0.08 + ph));
  y += bob;
  s.alpha(0.2 + 0.08 * Math.sin(f * 0.5 + ph));
  s.disc(x + 0.5, y - 1, 1.3, '#FFD36B');
  s.alpha(1);
  s.rect(x, y, 1, 3, '#F4EBD0');
  s.px(x, y + 2, '#DDD0AE');
  const tall = (f + Math.round(ph * 3)) % 6 < 3;
  s.px(x, y - 1, '#FFB23E');
  if (tall) s.px(x, y - 2, '#FFE08A');
}

/** A Gryffindor banner hanging from the top: red with gold trim and a gold crest. */
function drawBanner(s: Stage): void {
  const x = 1;
  s.rect(x, 0, 6, 1, '#E8B83A');
  s.rect(x, 1, 6, 9, '#9E2B2B');
  s.rect(x + 1, 10, 4, 1, '#9E2B2B');
  s.rect(x + 2, 11, 2, 1, '#9E2B2B');
  s.rect(x + 2, 3, 2, 1, '#E8B83A');
  s.rect(x + 1, 4, 4, 2, '#E8B83A');
  s.rect(x + 2, 6, 2, 1, '#E8B83A');
  s.px(x + 2, 4, '#B8862B');
}

function drawHall(s: Stage): void {
  s.rect(0, FLOOR, GW, GH - FLOOR, '#C9C1B4');
  s.rect(0, FLOOR, GW, 1, '#A89F91');
  for (const y of [31, 34]) s.rect(0, y, GW, 1, '#B3AA9C');
  for (let row = 0; row < 3; row++) {
    const y0 = FLOOR + 1 + row * 3;
    for (let x = row % 2 ? 3 : 0; x < GW; x += 6) s.rect(x, y0, 1, 2, '#B3AA9C');
  }
  // desk with a stack of books
  s.rect(34, 21, 12, 1, '#A0714A');
  s.rect(34, 22, 12, 1, '#7E5636');
  s.rect(35, 23, 1, 5, '#7E5636');
  s.rect(44, 23, 1, 5, '#7E5636');
  s.rect(41, 19, 4, 2, '#B3282D');
  s.rect(41, 18, 4, 1, '#2E7D4F');
  s.rect(44, 18, 1, 3, '#F4EFE6');
}

/**
 * The feather, 6×3: white vanes either side of a grey quill. `tilt` −1/0/1
 * leans it up-right, flat or down-right as it floats.
 */
function drawFeather(s: Stage, x: number, y: number, tilt: number): void {
  x = Math.round(x);
  y = Math.round(y);
  const quill = '#8E8E8E';
  const vane = '#FFFFFF';
  const edge = '#D2D2D2';
  if (tilt === 0) {
    s.rect(x + 1, y, 3, 1, vane);
    s.rect(x, y + 1, 5, 1, quill);
    s.px(x + 5, y + 1, vane);
    s.rect(x + 2, y + 2, 3, 1, vane);
    s.px(x + 4, y, edge);
    s.px(x + 1, y + 2, edge);
  } else {
    // a diagonal quill, vanes on both sides
    const dir = tilt < 0 ? -1 : 1;
    const row = (k: number) => y + 1 + Math.round((k - 2.5) * 0.5 * dir);
    for (let k = 0; k < 5; k++) {
      s.px(x + k, row(k), quill);
      if (k > 0) s.px(x + k, row(k) - 1, vane);
      if (k > 0 && k < 4) s.px(x + k, row(k) + 1, vane);
    }
    s.px(x + 5, row(5), vane);
  }
}

/** The wand from the right hand at `angle` (0 = pointing right, negative = up); returns its tip. */
function drawWand(s: Stage, hx: number, hy: number, angle: number, glow: boolean, f: number): [number, number] {
  const c = Math.cos(angle);
  const sn = Math.sin(angle);
  for (let k = 0; k < 5; k++) s.px(Math.round(hx + c * k), Math.round(hy + sn * k), k === 0 ? '#5E3A15' : '#8B5520');
  const tx = Math.round(hx + c * 5);
  const ty = Math.round(hy + sn * 5);
  if (glow) {
    s.px(tx, ty, '#FFD700');
    if (f % 4 < 2) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) s.px(tx + dx, ty + dy, '#FFF2A8');
    }
  }
  return [tx, ty];
}

export const potterAnimation: ClawdAnimation = {
  id: 'potter',
  mode: 'animation',
  gw: GW,
  gh: GH,
  seconds: 7,
  bg: CREAM,
  create() {
    const dots = new FloatingDots(GW, GH, 26);
    const parts = new Particles();
    return {
      draw(s, f, total) {
        const t = f / total;
        if (f === 0) parts.clear();
        s.rect(0, 0, GW, GH, CREAM);
        dots.draw(s, f);
        drawBanner(s);
        for (const c of CANDLES) drawCandle(s, c.x, c.y, f, c.ph);
        drawHall(s);

        // the feather: on the desk, levitated, hovering, then drifting down onto the hat
        let fx = REST_X;
        let fy = REST_Y;
        let tilt = 0;
        if (t >= 0.34 && t < 0.62) {
          const k = seg(t, 0.34, 0.62);
          fx = lerp(REST_X, 34, easeInOut(k)) + Math.sin(k * TAU * 1.5) * 3 * k;
          fy = lerp(REST_Y, 7, easeOut(k)) + Math.sin(k * TAU * 2) * 1.2;
          tilt = Math.round(Math.sin(k * TAU * 3));
        } else if (t >= 0.62 && t < 0.76) {
          const k = seg(t, 0.62, 0.76);
          fx = 34 + Math.sin(k * TAU) * 3;
          fy = 7 + Math.sin(k * TAU * 2) * 1.2;
          tilt = Math.round(Math.cos(k * TAU));
        } else if (t >= 0.76 && t < 0.9) {
          const k = seg(t, 0.76, 0.9);
          fx = lerp(34, HAT_X, easeInOut(k)) + Math.sin(k * Math.PI * 3) * 3 * (1 - k);
          fy = lerp(7, HAT_Y, easeInOut(k));
          tilt = k < 1 ? (Math.sin(k * Math.PI * 3) > 0 ? -1 : 1) : 0;
        } else if (t >= 0.9) {
          fx = HAT_X;
          fy = HAT_Y;
        }
        const lifted = t >= 0.34 && t < 0.9;
        if (lifted && f % 3 === 0) parts.add(fx + 2.5 + (Math.random() - 0.5) * 4, fy + 1.5 + (Math.random() - 0.5) * 3, Math.random() < 0.5 ? '#FFD700' : '#BBAAEE', 0, 0.05, 0, 0.05);

        // Harry's pose and the wand
        let eyes: Eyes = 'forward';
        let armR = 0;
        let hop = 0;
        let angle = -1.2;
        let casting = false;
        if (t >= 0.04 && t < 0.18) eyes = 'right';
        if (t >= 0.12 && t < 0.18) armR = lerp(0, -2, seg(t, 0.12, 0.16));
        if (t >= 0.18 && t < 0.34) {
          // swish and flick: a long swing down to the right, then a quick flick up
          eyes = 'right';
          const k = seg(t, 0.18, 0.34);
          angle = k < 0.7 ? lerp(-1.6, 0.5, easeInOut(k / 0.7)) : lerp(0.5, -0.9, easeOut((k - 0.7) / 0.3));
          armR = k < 0.7 ? lerp(-2, 0, k / 0.7) : -2;
          casting = true;
        }
        if (t >= 0.34 && t < 0.62) {
          // the wand follows the feather
          armR = -2;
          casting = true;
          eyes = fy < OY - 6 ? 'up' : 'right';
          angle = Math.atan2(fy + 1.5 - (OY + armR), fx + 2.5 - (OX + 13)) + Math.sin(f * 0.3) * 0.08;
        }
        if (t >= 0.62 && t < 0.76) {
          eyes = 'sparkle';
          armR = -2;
          angle = -1.3;
          const k = seg(t, 0.63, 0.73);
          hop = k > 0 && k < 1 ? Math.round(Math.abs(Math.sin(k * TAU)) * 2) : 0;
        }
        if (t >= 0.76 && t < 0.9) {
          eyes = 'up';
          armR = lerp(-2, 0, seg(t, 0.76, 0.82));
          angle = lerp(-1.3, -1.2, seg(t, 0.76, 0.82));
        }
        if (t >= 0.9) eyes = 'blink';
        if (t < 0.04 && f % 70 >= 66) eyes = 'blink';

        drawClawd(s, OX, OY - hop, { eyes, armR, hat: 'wizard', face: 'potter' });
        const [tx, ty] = drawWand(s, OX + 13, OY + Math.round(armR) - hop, angle, casting || (t >= 0.62 && t < 0.76), f);

        // sparkles: a trail off the wand tip while casting, a stream toward the feather
        if (t >= 0.18 && t < 0.34) parts.add(tx, ty, f % 2 ? '#FFD700' : '#BBAAEE', (Math.random() - 0.5) * 0.2, (Math.random() - 0.5) * 0.2, 0, 0.035);
        if (t >= 0.34 && t < 0.62 && f % 4 === 0) {
          const dx = fx + 2.5 - tx;
          const dy = fy + 1.5 - ty;
          const d = Math.max(1, Math.hypot(dx, dy));
          parts.add(tx, ty, '#FFF2A8', (dx / d) * 0.9, (dy / d) * 0.9, 0, 0.06);
        }
        if (f === Math.floor(0.62 * total)) parts.burst(OX + 7, OY - 9, ['#FFD700', '#BBAAEE', '#FFFFFF', '#E0457B'], 18, 0.8, 0.02);
        if (f === Math.floor(0.9 * total)) parts.burst(HAT_X + 3, HAT_Y + 1, ['#FFD700', '#FFFFFF'], 8, 0.5, 0.02);

        drawFeather(s, fx, fy - (t >= 0.9 ? hop : 0), tilt);
        if (t >= 0.64 && t < 0.76) drawBubble(s, OX + 11, OY - 16 - hop, 'heart');
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
