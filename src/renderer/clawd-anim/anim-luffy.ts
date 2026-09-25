import { CREAM, FloatingDots, Particles, easeInOut, easeOut, lerp, seg, type ClawdAnimation, type Stage } from './engine.js';
import { drawBubble, drawClawd, CLAWD, type Eyes } from './sprites.js';

// Animation mode — 路飞 (the skill's preset: straw hat, red vest): on the deck
// of a ship under the Straw Hat jolly roger, Clawd smells a roast on a barrel,
// shoots out a Gum-Gum Pistol to grab it, the rubber arm snaps back, he eats
// the lot and his belly swells up, tosses the bone, laughs, and deflates while
// a new roast turns up on the barrel.

const GW = 48;
const GH = 36;
const DECK = 28;
const OX = 9;
const OY = 20;
const TAU = Math.PI * 2;
/** Where the roast sits on the barrel (top-left of its 8×4 box). */
const MEAT_X = 36;
const MEAT_Y = 18;
/** How far the fist flies: its left edge at the roast. */
const FIST_FAR = MEAT_X - 2;

const MEAT = '#9C4A26';
const MEAT_HI = '#C9713F';
const MEAT_DK = '#7A3518';
const BONE = '#F4EFE6';

/** The Straw Hat jolly roger, 9×6: skull in a straw hat over crossed bones. */
const FLAG = ['KKKYYYKKK', 'KWYRRRYWK', 'KKWWWWWKK', 'KKWKWKWKK', 'KWKWWWKWK', 'KKKKKKKKK'];
const FLAG_COLORS: Record<string, string> = { K: '#26262B', W: '#F4F4F4', Y: '#E8C35A', R: '#DC2828' };

/**
 * A roast on the bone, 8×4: meat on the left, the bone's end on the right.
 * `eaten` columns of meat are gone from the left.
 */
function drawMeat(s: Stage, x: number, y: number, eaten = 0): void {
  x = Math.round(x);
  y = Math.round(y);
  // the bone runs through the meat and shows where it's been eaten
  s.rect(x + 1, y + 2, 5, 1, BONE);
  s.rect(x + 6, y + 1, 2, 3, BONE);
  s.px(x + 7, y + 2, '#DCD4C6');
  const meat: [number, number, string][] = [
    [1, 0, MEAT], [2, 0, MEAT], [3, 0, MEAT],
    [0, 1, MEAT], [1, 1, MEAT], [2, 1, MEAT_HI], [3, 1, MEAT_HI], [4, 1, MEAT],
    [0, 2, MEAT], [1, 2, MEAT], [2, 2, MEAT], [3, 2, MEAT], [4, 2, MEAT_DK],
    [1, 3, MEAT_DK], [2, 3, MEAT_DK], [3, 3, MEAT_DK],
  ];
  for (const [dx, dy, c] of meat) if (dx >= eaten) s.px(x + dx, y + dy, c);
}

/** The bare bone, flying: horizontal or upright as it spins (a shade darker, to show on the sky). */
function drawBone(s: Stage, x: number, y: number, upright: boolean): void {
  const c = '#D9CBB2';
  if (upright) {
    s.rect(x, y - 1, 1, 3, c);
    s.rect(x - 1, y - 2, 3, 1, c);
    s.rect(x - 1, y + 2, 3, 1, c);
  } else {
    s.rect(x - 1, y, 3, 1, c);
    s.rect(x - 2, y - 1, 1, 3, c);
    s.rect(x + 2, y - 1, 1, 3, c);
  }
}

function drawShip(s: Stage, t: number): void {
  // sea behind the bulwark, waves drifting left
  s.rect(0, 19, GW, 1, '#5FA9D6');
  s.rect(0, 20, GW, 4, '#7FC4E8');
  const drift = Math.floor(t * 24);
  for (let r = 20; r < 24; r++) {
    for (let x = -12; x < GW + 12; x += 12) {
      const wx = x + ((r * 5 - drift) % 12 + 12) % 12;
      s.rect(wx, r, 2, 1, '#CFEAF7');
    }
  }
  // bulwark
  s.rect(0, 24, GW, 4, '#A8743F');
  s.rect(0, 24, GW, 1, '#7A4E25');
  for (let x = 5; x < GW; x += 8) s.rect(x, 25, 1, 3, '#8C5B2E');
  // deck boards
  s.rect(0, DECK, GW, GH - DECK, '#C8955A');
  s.rect(0, DECK, GW, 1, '#9C6B3C');
  for (let y = DECK + 1; y < GH; y++) {
    for (let x = 0; x < GW; x++) if ((x + y * 3) % 9 === 0) s.px(x, y, '#B07E47');
  }
  // mast
  s.rect(2, 0, 2, DECK, '#7A4E25');
  s.rect(3, 0, 1, DECK, '#8C5B2E');
}

function drawFlag(s: Stage, t: number): void {
  for (let c = 0; c < 9; c++) {
    const dy = Math.round(Math.sin(TAU * 2 * t - c * 0.55) * 0.9 * (c / 8));
    for (let r = 0; r < 6; r++) s.px(4 + c, 2 + r + dy, FLAG_COLORS[FLAG[r][c]]);
  }
}

function drawBarrel(s: Stage): void {
  const x = 37;
  const y = 22;
  s.rect(x + 1, y, 4, 1, '#B07E4A');
  s.rect(x, y + 1, 6, 4, '#9C6B3C');
  s.rect(x + 1, y + 5, 4, 1, '#9C6B3C');
  s.rect(x + 1, y + 1, 1, 5, '#7A4E25');
  s.rect(x + 4, y + 1, 1, 5, '#7A4E25');
  s.rect(x, y + 1, 6, 1, '#7D7D7D');
  s.rect(x, y + 4, 6, 1, '#7D7D7D');
}

/** A gull far off: a "v" with its wings up, a "^" with them down. */
function drawGull(s: Stage, x: number, y: number, up: boolean): void {
  x = Math.round(x);
  y = Math.round(y);
  const c = '#8A8A8A';
  s.px(x, y + (up ? 0 : 1), c);
  s.px(x + 1, y + (up ? 1 : 0), c);
  s.px(x + 2, y + (up ? 0 : 1), c);
}

/** The rubber arm out from the right shoulder to a fist at `fistX`, rippling by `wobble`. */
function drawStretchArm(s: Stage, ox: number, row: number, fistX: number, wobble: number, f: number): void {
  const from = ox + 13;
  for (let x = from; x < fistX; x++) {
    const dy = Math.round(Math.sin((x - from) * 0.9 - f * 0.9) * wobble);
    s.rect(x, row + dy, 1, 2, CLAWD);
  }
  const fy = row + Math.round(Math.sin((fistX - from) * 0.9 - f * 0.9) * wobble);
  s.rect(fistX, fy - 1, 3, 3, CLAWD);
  s.px(fistX + 2, fy, '#A8543F');
  s.px(fistX + 2, fy + 1, '#A8543F');
}

export const luffyAnimation: ClawdAnimation = {
  id: 'luffy',
  mode: 'animation',
  gw: GW,
  gh: GH,
  seconds: 7,
  bg: CREAM,
  create() {
    const dots = new FloatingDots(GW, GH, 22);
    const parts = new Particles();
    let lastBite = -1;
    return {
      draw(s, f, total) {
        const t = f / total;
        if (f === 0) {
          parts.clear();
          lastBite = -1;
        }
        s.rect(0, 0, GW, GH, CREAM);
        dots.draw(s, f);
        drawGull(s, ((8 + t * (GW + 8)) % (GW + 8)) - 4, 6, f % 16 < 8);
        drawGull(s, ((30 + t * (GW + 8)) % (GW + 8)) - 4, 10, (f + 5) % 16 < 8);
        drawShip(s, t);
        drawFlag(s, t);
        drawBarrel(s);

        // the roast: on the barrel, then in the fist, then eaten
        const onBarrel = t < 0.38 || t >= 0.84;
        if (onBarrel) drawMeat(s, MEAT_X, MEAT_Y);
        if (t >= 0.84 && t < 0.845) parts.burst(MEAT_X + 3, MEAT_Y + 1, ['#FFD700', '#FFFFFF', MEAT_HI], 14, 0.6, 0.02);
        // its smell drifts up in two wisps
        if (onBarrel && (t < 0.3 || t >= 0.88)) {
          s.alpha(0.4);
          for (const sx of [38, 42]) {
            for (let k = 0; k < 4; k++) s.px(sx + Math.round(Math.sin(TAU * 3 * t + k * 1.1) * 0.8), MEAT_Y - 2 - k, '#A89F94');
          }
          s.alpha(1);
        }

        // Luffy
        let eyes: Eyes = 'forward';
        let armL = 0;
        let armR = 0;
        let hop = 0;
        let lean = 0;
        let belly = 0;
        let legs: [number, number, number, number] = [0, 0, 0, 0];
        if (t < 0.06) eyes = 'left';
        if (t >= 0.12 && t < 0.16) eyes = 'right';
        if (t >= 0.16 && t < 0.26) {
          eyes = 'sparkle';
          const k = seg(t, 0.17, 0.25);
          hop = k > 0 && k < 1 ? Math.round(Math.abs(Math.sin(k * TAU)) * 2) : 0;
        }
        // Gomu Gomu no… wind up, then the Pistol
        let fistX: number | null = null;
        let wobble = 0;
        if (t >= 0.26 && t < 0.32) {
          eyes = 'right';
          lean = -1;
          armR = 2;
          legs = [-1, -1, 0, 0];
        } else if (t >= 0.32 && t < 0.42) {
          eyes = 'right';
          armR = -2;
          legs = [-1, 0, 0, 1];
          fistX = Math.round(lerp(OX + 13, FIST_FAR, easeOut(seg(t, 0.32, 0.37))));
        } else if (t >= 0.42 && t < 0.52) {
          eyes = 'right';
          armR = -2;
          const k = seg(t, 0.42, 0.51);
          fistX = Math.round(lerp(FIST_FAR, OX + 11, easeInOut(k)));
          wobble = 1.2 * (1 - k);
        }
        if (t >= 0.52 && t < 0.58) {
          // the snap back knocks him a step back
          lean = -Math.round(2 * Math.sin(Math.PI * seg(t, 0.52, 0.58)));
          eyes = 'blink';
          armR = -1;
          legs = [-1, -1, 1, 1];
        }
        if (t >= 0.38 && t < 0.4 && f % 2 === 0) parts.burst(FIST_FAR + 3, MEAT_Y + 2, ['#FFFFFF', '#FFD34D'], 6, 0.7, 0.02);
        if (fistX !== null && t < 0.37 && f % 2 === 0) {
          for (const dy of [-2, 3]) parts.add(fistX - 2, OY + dy, '#BDB6AC', -0.9, 0, 0, 0.18);
        }

        // eating: five bites, one every 7 frames, the belly filling up
        const eatFrom = Math.round(0.58 * total);
        const eating = t >= 0.58 && t < 0.74;
        const bites = t >= 0.58 ? Math.min(5, Math.floor((f - eatFrom) / 7) + 1) : 0;
        const chomp = eating && bites < 5 && (f - eatFrom) % 7 < 2 ? 1 : 0;
        if (eating) {
          eyes = 'blink';
          if (bites !== lastBite) {
            lastBite = bites;
            parts.burst(OX + 13, OY + 1, [MEAT, MEAT_HI, MEAT_DK], 5, 0.5);
          }
        }
        if (t >= 0.62) belly = 1;
        if (t >= 0.68) belly = 2;
        if (t >= 0.88) belly = 1;
        if (t >= 0.91) belly = 0;
        // shishishi: sparkle, then a laugh that bounces the full belly
        if (t >= 0.74 && t < 0.8) eyes = 'sparkle';
        if (t >= 0.8 && t < 0.88) {
          eyes = 'blink';
          hop = f % 8 < 4 ? 1 : 0;
        }
        if (t >= 0.88 && t < 0.92 && f % 3 === 0) parts.add(OX + 13, OY + 1, '#D6D0C6', 0.3, -0.2, 0, 0.06);
        if (t < 0.12 && f % 70 >= 66) eyes = 'blink';

        const ox = OX + lean;
        drawClawd(s, ox, OY - hop, { eyes, armL, armR, legs, hat: 'straw', outfit: 'vest', belly });
        if (fistX !== null && fistX > OX + 13) drawStretchArm(s, ox, OY + 2 + armR, fistX, wobble, f);

        // the roast travels with the fist, then gets eaten from the hand
        if (t >= 0.38 && t < 0.52 && fistX !== null) {
          drawMeat(s, fistX + 2, MEAT_Y);
        } else if (t >= 0.52 && t < 0.74) {
          drawMeat(s, ox + 13 - bites - chomp * 2, OY, bites);
        }
        // …and the bone goes over the side
        if (t >= 0.74 && t < 0.84) {
          const k = seg(t, 0.74, 0.84);
          drawBone(s, Math.round(lerp(ox + 17, 50, k)), Math.round(OY - 30 * k + 30 * k * k), f % 6 < 3);
        }

        if (t >= 0.16 && t < 0.26) drawBubble(s, OX + 2, OY - 11 - hop, '!');
        if (t >= 0.76 && t < 0.88) drawBubble(s, OX + 2, OY - 11 - hop, 'note');
        parts.step(s);
      },
    };
  },
};
