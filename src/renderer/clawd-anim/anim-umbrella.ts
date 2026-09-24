import { CREAM, FloatingDots, Particles, drawGrass, easeInOut, easeOut, lerp, seg, type ClawdAnimation, type Stage } from './engine.js';
import { drawBubble, drawClawd, type Eyes } from './sprites.js';

// Animation mode — 雨中撑伞: a cloud drifts over and rain starts, a drop hits
// Clawd, he opens his umbrella and waits it out, the sun comes back with a
// rainbow, he folds the umbrella and hops.

const GW = 48;
const GH = 36;
const GROUND = 28;
const OX = 15;
const OY = 20;
const RAINBOW = ['#E8423F', '#F08A24', '#F6C83E', '#5DBB63', '#3A8DDE', '#4B55B5', '#8E5CC2'];

function drawSun(s: Stage, f: number, a: number): void {
  if (a <= 0) return;
  s.alpha(a);
  s.disc(39.5, 6.5, 3, '#FFD34D');
  const rays: [number, number][] = [[39, 1], [39, 11], [34, 6], [44, 6], [35, 2], [43, 2], [35, 10], [43, 10]];
  rays.forEach(([x, y], i) => {
    if ((i + Math.floor(f / 8)) % 2 === 0) s.px(x, y, '#FFE58A');
  });
  s.alpha(1);
}

function drawCloud(s: Stage, cx: number, dark: number): void {
  const body = dark > 0.5 ? '#8E97A3' : '#A9B1BC';
  s.rect(cx - 6, 6, 12, 4, body);
  s.rect(cx - 8, 7, 16, 3, body);
  s.rect(cx - 4, 4, 6, 2, body);
  s.rect(cx + 2, 5, 4, 1, body);
  s.rect(cx - 3, 4, 3, 1, '#C3C9D1');
  s.rect(cx - 7, 9, 14, 1, '#7F8894');
}

function drawUmbrella(s: Stage, width: number): void {
  const cx = OX + 11;
  const half = Math.max(1, Math.round(width / 2));
  // A dome: narrow crown rows over the full-width rim, one row taller when open.
  const rows = (half >= 6 ? [half - 5, half - 3, half - 2, half - 1, half] : [half - 3, half - 2, half - 1, half]).map((w) => Math.max(0, w));
  const top = OY - 4 - rows.length;
  rows.forEach((w, i) => {
    for (let x = cx - w; x < cx + w; x++) {
      const stripe = Math.abs(x - cx + 0.5) > w * 0.33 && Math.abs(x - cx + 0.5) < w * 0.33 + 1;
      s.px(x, top + i, stripe ? '#F0F0F0' : '#DC2828');
    }
  });
  const rim = top + rows.length;
  if (half >= 3) for (let x = cx - half; x < cx + half; x += 2) s.px(x, rim, '#B81E1E');
  s.rect(cx, top - 1, 1, 1, '#8B5520');
  s.rect(cx, rim, 1, OY - rim, '#8B5520');
}

export const umbrellaAnimation: ClawdAnimation = {
  id: 'umbrella',
  mode: 'animation',
  gw: GW,
  gh: GH,
  seconds: 7,
  bg: CREAM,
  create() {
    const dots = new FloatingDots(GW, GH);
    const parts = new Particles();
    let drops: { x: number; y: number }[] = [];
    let hitHead = false;
    return {
      draw(s, f, total) {
        const t = f / total;
        if (f === 0) {
          parts.clear();
          drops = [];
          hitHead = false;
        }
        s.rect(0, 0, GW, GH, CREAM);
        dots.draw(s, f);

        const rainOn = t >= 0.18 && t < 0.68;
        const gloom = seg(t, 0.12, 0.2) * (1 - seg(t, 0.66, 0.76));
        if (gloom > 0) {
          s.alpha(0.14 * gloom);
          s.rect(0, 0, GW, GROUND, '#5A6475');
          s.alpha(1);
        }
        drawSun(s, f, (1 - seg(t, 0.04, 0.12)) + seg(t, 0.7, 0.8));

        const bow = seg(t, 0.74, 0.8) * (1 - seg(t, 0.88, 0.96));
        if (bow > 0) {
          s.alpha(bow);
          RAINBOW.forEach((c, i) => {
            const r = 26 - i;
            for (let a = 0; a <= 180; a += 2) {
              const rad = (a * Math.PI) / 180;
              s.px(Math.round(24 + Math.cos(rad) * r), Math.round(GROUND + 1 - Math.sin(rad) * r), c);
            }
          });
          s.alpha(1);
        }

        let cloudX: number | null = null;
        if (t >= 0.06 && t < 0.8) {
          cloudX = t < 0.2 ? lerp(60, 24, easeOut(seg(t, 0.06, 0.2))) : t < 0.66 ? 24 : lerp(24, -14, easeInOut(seg(t, 0.66, 0.8)));
          drawCloud(s, cloudX, gloom);
        }

        drawGrass(s, GROUND);
        const puddle = seg(t, 0.3, 0.6) * (1 - seg(t, 0.76, 0.96));
        if (puddle > 0) {
          const w = Math.round(2 + puddle * 8);
          s.rect(30 - Math.floor(w / 2), GROUND, w, 1, '#8FC1E3');
          if (w > 5) s.rect(31 - Math.floor(w / 4), GROUND, 2, 1, '#C4E1F4');
        }

        const openness = t < 0.3 ? 0 : t < 0.38 ? easeOut(seg(t, 0.3, 0.38)) : t < 0.8 ? 1 : 1 - seg(t, 0.8, 0.86);
        const umbrellaW = 2 + openness * 16;
        const canopyTop = OY - 9;
        const canopyHalf = umbrellaW / 2;
        const canopyCx = OX + 11;

        // rain: falls from the cloud, splashes on the umbrella, Clawd or the grass
        if (rainOn && cloudX !== null) {
          for (let k = 0; k < 2; k++) drops.push({ x: Math.round(cloudX - 7 + Math.random() * 14), y: 10 });
        }
        drops = drops.filter((d) => {
          d.y += 0.9;
          const onCanopy = openness > 0.6 && Math.abs(d.x - canopyCx + 0.5) < canopyHalf && d.y >= canopyTop;
          const onHead = d.x >= OX + 3 && d.x <= OX + 10 && d.y >= OY;
          if (onCanopy) {
            parts.add(d.x, canopyTop - 1, '#9CC9EA', (Math.random() - 0.5) * 0.4, -0.3, 0.05, 0.08);
            return false;
          }
          if (onHead) {
            if (!hitHead && t < 0.3) hitHead = true;
            parts.add(d.x, OY - 1, '#9CC9EA', (Math.random() - 0.5) * 0.4, -0.3, 0.05, 0.08);
            return false;
          }
          if (d.y >= GROUND) {
            parts.add(d.x, GROUND - 1, '#9CC9EA', (Math.random() - 0.5) * 0.3, -0.2, 0.05, 0.1);
            return false;
          }
          s.rect(d.x, Math.floor(d.y), 1, 2, '#6FA8DC');
          return true;
        });

        // Clawd
        let eyes: Eyes = 'forward';
        let armR = 0;
        let hop = 0;
        let jitter = 0;
        if (t >= 0.08 && t < 0.2) eyes = 'right';
        if (t >= 0.2 && t < 0.3) {
          eyes = 'up';
          if (hitHead && t < 0.25) jitter = f % 4 < 2 ? 1 : 0;
        }
        if (t >= 0.28 && t < 0.86) armR = lerp(0, -2, easeOut(seg(t, 0.28, 0.34)));
        if (t >= 0.4 && t < 0.66) eyes = f % 60 < 30 ? 'up' : 'forward';
        if (t >= 0.7 && t < 0.76) eyes = 'up';
        if (t >= 0.76 && t < 0.95) eyes = 'sparkle';
        let armL = 0;
        if (t >= 0.86 && t < 0.95) {
          const k = seg(t, 0.86, 0.94);
          hop = Math.round(Math.abs(Math.sin(k * Math.PI * 2)) * 2);
          armL = -3;
          armR = -3;
        }
        if (t < 0.08 && f % 70 >= 66) eyes = 'blink';
        if (openness > 0) drawUmbrella(s, umbrellaW);
        drawClawd(s, OX + jitter, OY - hop, { eyes, armL, armR });

        if (t >= 0.21 && t < 0.3) drawBubble(s, OX + 2, OY - 9, '!');
        if (t >= 0.86 && t < 0.97) drawBubble(s, OX + 2, OY - 9 - hop, 'heart');
        parts.step(s);
      },
    };
  },
};
