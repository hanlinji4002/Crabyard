import { CREAM, FloatingDots, Particles, easeOut, seg, lerp, type ClawdAnimation, type Stage } from './engine.js';
import { drawBubble, drawClawd, type Eyes } from './sprites.js';

// Animation mode — 写代码: Clawd types on a laptop, a bug crawls onto the
// screen, Clawd squashes it, the tests pass and he cheers, then back to typing.

const GW = 48;
const GH = 36;

/** Code lines: indent, then [colour, length] runs (One Dark–ish syntax colours). */
const CODE: [number, [string, number][]][] = [
  [0, [['#C678DD', 2], ['#61AFEF', 3], ['#ABB2BF', 2]]],
  [1, [['#E06C75', 2], ['#ABB2BF', 1], ['#98C379', 4]]],
  [1, [['#C678DD', 2], ['#E5C07B', 3]]],
  [2, [['#61AFEF', 4], ['#ABB2BF', 2]]],
  [2, [['#98C379', 5]]],
  [1, [['#ABB2BF', 1]]],
  [0, [['#ABB2BF', 1]]],
];
const CODE_CELLS: { x: number; y: number; c: string }[] = [];
CODE.forEach(([indent, runs], i) => {
  let x = 28 + indent;
  for (const [c, n] of runs) {
    for (let k = 0; k < n; k++) CODE_CELLS.push({ x: x + k, y: 11 + i, c });
    x += n + 1;
  }
});

const CHECK: [number, number][] = [[29, 14], [30, 15], [31, 16], [32, 15], [33, 14], [34, 13], [35, 12], [36, 11]];

function drawRoom(s: Stage): void {
  s.rect(0, 30, GW, 6, '#E9DFD0');
  for (let x = 3; x < GW; x += 9) s.rect(x, 30, 1, 6, '#DCCFBC');
  s.rect(0, 30, GW, 1, '#D8CAB5');
  // desk
  s.rect(24, 21, 22, 2, '#A0714A');
  s.rect(24, 23, 22, 1, '#7E5636');
  s.rect(25, 24, 1, 6, '#7E5636');
  s.rect(44, 24, 1, 6, '#7E5636');
  // stool
  s.rect(13, 22, 11, 1, '#8B5A2B');
  s.rect(14, 23, 1, 7, '#7A4E25');
  s.rect(22, 23, 1, 7, '#7A4E25');
  // mug
  s.rect(41, 18, 2, 3, '#F0F0F0');
  s.px(43, 19, '#F0F0F0');
  s.px(41, 18, '#6B4423');
  s.px(42, 18, '#6B4423');
}

export const codingAnimation: ClawdAnimation = {
  id: 'coding',
  mode: 'animation',
  gw: GW,
  gh: GH,
  seconds: 6,
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
        drawRoom(s);

        // steam from the mug
        if (f % 20 < 10) s.px(42, 16 - ((f % 20) >> 2), '#D0CCC6');

        const bugIn = seg(t, 0.42, 0.52);
        const squashed = t >= 0.6;
        const passed = t >= 0.62 && t < 0.92;
        const shake = f === Math.floor(0.6 * total) || f === Math.floor(0.6 * total) + 1 ? 1 : 0;

        // laptop
        const lx = shake;
        s.rect(26 + lx, 9, 14, 11, '#3A3F4B');
        const screen = passed ? (t < 0.84 ? '#173B26' : '#1E2230') : '#1E2230';
        s.rect(27 + lx, 10, 12, 9, screen);
        s.rect(25, 20, 16, 1, '#B8BCC6');
        s.rect(27, 20, 12, 1, '#9EA3AE');

        if (!passed) {
          const typed = Math.floor(seg(t, 0.03, 0.4) * CODE_CELLS.length);
          const fade = t >= 0.92 ? 0 : 1;
          if (fade) {
            for (let i = 0; i < typed; i++) s.px(CODE_CELLS[i].x + lx, CODE_CELLS[i].y, CODE_CELLS[i].c);
            if (typed < CODE_CELLS.length && f % 10 < 6) {
              const next = CODE_CELLS[typed];
              s.px(next.x + lx, next.y, '#FFFFFF');
            }
          }
          // a bug crawls in from the right edge of the screen
          if (bugIn > 0 && !squashed) {
            const bx = Math.round(lerp(39, 33, easeOut(bugIn)));
            const legs = f % 6 < 3;
            s.rect(bx, 14, 2, 2, '#DC2828');
            s.px(bx, 13, '#222');
            s.px(bx + 1, 12 + (legs ? 0 : 1), '#222');
            s.px(bx - 1, legs ? 14 : 15, '#222');
            s.px(bx + 2, legs ? 15 : 14, '#222');
          }
        } else {
          const a = t < 0.84 ? 1 : 1 - seg(t, 0.84, 0.9);
          s.alpha(a);
          for (const [x, y] of CHECK) s.rect(x + lx, y, 1, 2, '#FFFFFF');
          s.alpha(1);
        }

        if (f === Math.floor(0.6 * total)) parts.burst(34, 14, ['#DC2828', '#F08A24', '#FFD700'], 14, 0.7);
        if (f === Math.floor(0.62 * total)) parts.burst(19, 13, ['#DC2828', '#FFD700', '#3366CC', '#44AA44', '#FF88AA'], 24, 1.1);
        if (t < 0.4 && f % 6 === 0) parts.add(26 + (f % 5), 19, '#9EA3AE', 0, -0.25, 0.02, 0.08);

        // Clawd on the stool
        let eyes: Eyes = 'right';
        let armL = 1;
        let armR = f % 6 < 3 ? 2 : 1;
        let hop = 0;
        if (t >= 0.4 && t < 0.54) {
          armR = 1;
          eyes = f % 8 < 6 ? 'right' : 'forward';
        } else if (t >= 0.54 && t < 0.6) {
          armR = lerp(1, -3, easeOut(seg(t, 0.54, 0.58)));
          if (t >= 0.58) armR = 2;
        } else if (t >= 0.6 && t < 0.62) {
          armR = 2;
        } else if (t >= 0.62 && t < 0.84) {
          eyes = 'sparkle';
          armL = -3;
          armR = -3;
          const k = seg(t, 0.62, 0.8);
          hop = k < 1 ? Math.round(Math.abs(Math.sin(k * Math.PI * 3)) * 2) : 0;
        } else if (t >= 0.84) {
          armR = f % 6 < 3 ? 2 : 1;
        }
        if (t < 0.4 && f % 70 >= 66) eyes = 'blink';
        drawClawd(s, 12, 14 - hop, { eyes, armL, armR });

        if (t >= 0.45 && t < 0.56) drawBubble(s, 14, 5, '!');
        if (t >= 0.67 && t < 0.84) drawBubble(s, 14, 4 - hop, 'check');
        parts.step(s);
      },
    };
  },
};
