import { hash, makeStage, pingpong, type ClawdAnimation, type Stage } from './engine.js';
import { crab, type CrabOpts } from './sprites.js';

// Scene mode — 春日公园: a top-down spring park in the skill's scene style —
// a pond with a rowing crab, a stream under a bridge, paths meeting at a
// fountain, cherry trees shedding petals, and crabs picnicking, playing ball,
// fishing, reading, dancing, walking and napping. Terrain is drawn once to an
// offscreen canvas; only the water, petals and crabs move. Every motion is a
// whole number of cycles per loop, so the loop is seamless.

const GW = 192;
const GH = 144;
const TAU = Math.PI * 2;

const POND = { x: 46, y: 40, rx: 30, ry: 19 };
const PLAZA = { x: 121, y: 89, r: 14 };
const TREES: { x: number; y: number; r: number; cherry: boolean }[] = [
  { x: 150, y: 22, r: 13, cherry: true },
  { x: 178, y: 44, r: 10, cherry: true },
  { x: 6, y: 112, r: 12, cherry: true },
  { x: 98, y: 136, r: 10, cherry: true },
  { x: 90, y: 10, r: 9, cherry: false },
  { x: 186, y: 130, r: 12, cherry: false },
  { x: 2, y: 16, r: 10, cherry: false },
  { x: 166, y: 96, r: 7, cherry: false },
  { x: 60, y: 138, r: 8, cherry: false },
];
const BEDS: { x: number; y: number; r: number }[] = [
  { x: 96, y: 58, r: 6 },
  { x: 152, y: 70, r: 5 },
  { x: 72, y: 110, r: 6 },
  { x: 16, y: 70, r: 5 },
];
const FLOWER_COLORS = ['#FF88AA', '#FFDD33', '#F8F0E8', '#AA77DD'];

function streamCenter(y: number): number {
  return 40 - (y - 56) * 0.18 + 3 * Math.sin((y - 56) * 0.09);
}

function inPond(x: number, y: number, grow = 0): boolean {
  const dx = (x - POND.x) / (POND.rx + grow);
  const dy = (y - POND.y) / (POND.ry + grow);
  return dx * dx + dy * dy <= 1;
}

function inStream(x: number, y: number, grow = 0): boolean {
  return y >= 52 && Math.abs(x - streamCenter(y)) <= 2.5 + grow;
}

function onPath(x: number, y: number): boolean {
  const px = x - PLAZA.x;
  const py = y - PLAZA.y;
  return (y >= 86 && y <= 92) || (x >= 118 && x <= 124) || px * px + py * py <= PLAZA.r * PLAZA.r;
}

function inFountain(x: number, y: number): number {
  const dx = x - PLAZA.x;
  const dy = y - PLAZA.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function isWater(x: number, y: number): boolean {
  return inPond(x, y) || (inStream(x, y) && !(y >= 85 && y <= 93)) || inFountain(x, y) < 8.5;
}

function buildTerrain(s: Stage): void {
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      const h = hash(x, y);
      let c = h > 0.66 ? '#7FB45A' : h > 0.33 ? '#74A852' : '#6A9C4A';
      if (h > 0.985) c = '#8FC46A';
      if (inPond(x, y, 1.6) || inStream(x, y, 1)) c = h > 0.5 ? '#D9C79A' : '#CDB98A';
      if (onPath(x, y)) {
        const edge = y === 86 || y === 92 || x === 118 || x === 124;
        c = h > 0.93 ? '#C4A874' : edge ? '#C9AE7A' : '#D7BF8E';
      }
      const fd = inFountain(x, y);
      if (fd < 10.5 && fd >= 8.5) c = h > 0.5 ? '#BDB5A6' : '#B0A898';
      if (isWater(x, y)) c = '#4A9FD0';
      if (fd < 2) c = '#E3DCCF';
      s.px(x, y, c);
    }
  }
  // bridge where the path crosses the stream
  for (let y = 85; y <= 93; y++) {
    const c = streamCenter(y);
    for (let x = Math.floor(c - 5); x <= Math.ceil(c + 5); x++) s.px(x, y, y === 85 || y === 93 ? '#7A5230' : y % 2 ? '#A0714A' : '#93653F');
  }
  // lily pads
  for (const [x, y] of [[32, 34], [58, 46], [40, 50], [64, 32]]) {
    s.disc(x + 0.5, y + 0.5, 1.7, '#4E9A4E');
    s.px(x, y, '#FF9EBB');
  }
  // flower beds
  for (const b of BEDS) {
    for (let i = 0; i < b.r * 9; i++) {
      const a = hash(b.x + i, b.y) * TAU;
      const d = hash(b.y + i, b.x) * b.r;
      s.px(Math.round(b.x + Math.cos(a) * d), Math.round(b.y + Math.sin(a) * d), FLOWER_COLORS[i % 4]);
    }
  }
  // picnic blanket with a basket and snacks
  for (let y = 0; y < 14; y++) for (let x = 0; x < 20; x++) s.px(138 + x, 104 + y, (Math.floor(x / 2) + Math.floor(y / 2)) % 2 ? '#FFFFFF' : '#E24B4B');
  s.rect(150, 112, 5, 4, '#A0714A');
  s.rect(151, 111, 3, 1, '#7A5230');
  s.rect(143, 110, 2, 2, '#F2D16B');
  s.rect(146, 113, 2, 2, '#DC2828');
  // bench
  s.rect(96, 76, 14, 1, '#7A5230');
  s.rect(96, 77, 14, 2, '#A0714A');
  // trees: shadow, then a round canopy
  for (const tr of TREES) {
    s.alpha(0.16);
    s.disc(tr.x + 2.5, tr.y + 2.5, tr.r, '#000');
    s.alpha(1);
    const tones = tr.cherry ? ['#FFB0C4', '#E8849E', '#FFCDD8'] : ['#4FA34A', '#3F8F3F', '#5DB356'];
    for (let dy = -tr.r - 1; dy <= tr.r + 1; dy++) {
      for (let dx = -tr.r - 1; dx <= tr.r + 1; dx++) {
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > tr.r + Math.sin(dx * 0.8 + dy * 0.5) * 1.1) continue;
        const h = hash(tr.x + dx, tr.y + dy);
        const lit = dx + dy < -tr.r * 0.6;
        s.px(tr.x + dx, tr.y + dy, lit && h > 0.3 ? tones[2] : h > 0.5 ? tones[0] : tones[1]);
      }
    }
  }
}

interface Crab extends CrabOpts {
  x: number;
  y: number;
}

export const parkScene: ClawdAnimation = {
  id: 'park',
  mode: 'scene',
  gw: GW,
  gh: GH,
  seconds: 8,
  bg: '#74A852',
  create() {
    let cache: HTMLCanvasElement | null = null;
    let cacheKey = '';
    const water: [number, number][] = [];
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) if (isWater(x, y)) water.push([x, y]);
    const petals = Array.from({ length: 36 }, (_, i) => ({ x0: hash(i, 1) * GW, y0: hash(i, 2) * GH, phase: hash(i, 3) * TAU }));

    return {
      draw(s, f, total) {
        const t = f / total;
        const key = `${s.ctx.canvas.width}x${s.ctx.canvas.height}`;
        if (!cache || cacheKey !== key) {
          cache = document.createElement('canvas');
          cache.width = s.ctx.canvas.width;
          cache.height = s.ctx.canvas.height;
          buildTerrain(makeStage(cache.getContext('2d')!, GW, GH, s.cell));
          cacheKey = key;
        }
        s.ctx.drawImage(cache, 0, 0);

        // water shimmer: three cycles per loop
        for (const [x, y] of water) {
          const w = Math.sin(x * 0.5 + y * 0.3 + TAU * 3 * t) * 0.7 + Math.sin(x * 0.17 - y * 0.41 - TAU * 2 * t) * 0.3;
          if (w > 0.62) s.px(x, y, '#7CC6EC');
          else if (w < -0.72) s.px(x, y, '#3B8DBD');
        }
        // fountain spray
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * TAU + TAU * t;
          const r = 2.5 + Math.abs(Math.sin(TAU * 4 * t + i)) * 3;
          s.px(Math.round(PLAZA.x + Math.cos(a) * r), Math.round(PLAZA.y + Math.sin(a) * r), '#CFEAF8');
        }
        s.px(PLAZA.x, PLAZA.y - 1 - Math.round(Math.abs(Math.sin(TAU * 4 * t)) * 2), '#FFFFFF');

        const crabs: Crab[] = [];
        const step = (Math.floor(f / 4) % 2) as 0 | 1;
        const wave = (k: number, ph = 0) => Math.sin(TAU * k * t + ph);

        // rowing crab on the pond
        const bx = POND.x + Math.cos(TAU * t) * 17;
        const by = POND.y + Math.sin(TAU * t) * 8;
        s.rect(bx - 9, by + 1, 18, 7, '#8B5A2B');
        s.rect(bx - 8, by + 2, 16, 5, '#A0714A');
        s.rect(bx - 11, by + 3 + (step ? 0 : 1), 2, 1, '#7A5230');
        s.rect(bx + 9, by + 3 + (step ? 1 : 0), 2, 1, '#7A5230');
        crabs.push({ x: bx, y: by - 3, eyes: Math.sin(TAU * t) > 0 ? 'right' : 'left', hat: 'straw', armL: step ? -1 : 0, armR: step ? 0 : -1 });

        // picnic
        crabs.push({ x: 143, y: 97, eyes: wave(2) > 0.3 ? 'sparkle' : 'down', hat: 'flower', armR: wave(2) > 0.3 ? -1 : 0 });
        crabs.push({ x: 153, y: 103, eyes: 'left', hat: 'sunhat', dress: '#FF88AA', armL: wave(3, 1) > 0.5 ? -1 : 0 });
        crabs.push({ x: 133, y: 108, eyes: 'right', hat: 'bandana' });

        // ball game
        const p = pingpong(t * 2);
        const ballX = 166 + p * 16;
        const ballY = 66 + p * 6;
        const lift = Math.sin(((t * 2) % 0.5) * 2 * Math.PI) * 6;
        crabs.push({ x: 160, y: 58, eyes: 'right', hat: 'cap', armL: p < 0.15 ? -2 : 0, armR: p < 0.15 ? -2 : 0 });
        crabs.push({ x: 188, y: 68, eyes: 'left', hat: 'headband', armL: p > 0.85 ? -2 : 0, armR: p > 0.85 ? -2 : 0 });

        // fisher on the east shore, with a bobber that bites once a loop
        const bite = t > 0.5 && t < 0.62;
        crabs.push({ x: 84, y: 30, eyes: bite ? 'sparkle' : 'left', hat: 'tophat', armL: bite ? -2 : -1, armR: bite ? -2 : 0 });

        // walkers on the paths, stepping around the fountain
        const around = (x: number) => Math.max(0, 14 - Math.abs(x - PLAZA.x));
        const eastX = -10 + t * 212;
        const westX = 202 - ((t * 212 + 106) % 212);
        crabs.push({ x: eastX, y: 81 - around(eastX), eyes: 'right', hat: 'beret', step });
        crabs.push({ x: westX, y: 86 + around(westX), eyes: 'left', hat: 'beanie', step: (1 - step) as 0 | 1, dress: '#88BBEE' });
        const down = (t % 1) < 0.5;
        crabs.push({ x: 121, y: -12 + pingpong(t) * 76, eyes: down ? 'down' : 'up', hat: 'cap', step });

        // reader on the bench, admirer under the cherry tree, dancer by the fountain
        crabs.push({ x: 103, y: 70, eyes: 'down', hat: 'beret', armL: 1, armR: 1 });
        crabs.push({ x: 150, y: 37, eyes: 'up', hat: 'flower', armL: wave(1) > 0 ? -1 : 0, armR: wave(1) > 0 ? -1 : 0 });
        const beat = Math.floor(f / 6) % 2;
        crabs.push({ x: 134, y: 100, eyes: 'sparkle', hat: 'party', armL: beat ? -2 : 1, armR: beat ? 1 : -2, step: beat as 0 | 1 });

        // on the bridge, watching a fish jump; chatting pair; napping crab
        const fishK = (t * 2) % 1;
        crabs.push({ x: 34, y: 77, eyes: fishK > 0.3 && fishK < 0.5 ? 'sparkle' : 'down', hat: 'crown' });
        crabs.push({ x: 92, y: 118, eyes: 'right', hat: 'wizard', armR: wave(4) > 0.6 ? -1 : 0 });
        crabs.push({ x: 110, y: 120, eyes: 'left', hat: 'ribbon', dress: '#AA77DD', armL: wave(4, Math.PI) > 0.6 ? -1 : 0 });
        crabs.push({ x: 28, y: 126, eyes: 'blink', hat: 'beanie' });

        crabs.sort((a, b) => a.y - b.y);
        for (const c of crabs) crab(s, c.x, c.y, c);

        // details on top: ball and its shadow, fishing line, fish, Zzz, petals
        s.alpha(0.18);
        s.rect(ballX, ballY + 2, 2, 1, '#000');
        s.alpha(1);
        s.rect(ballX, ballY - Math.abs(lift), 2, 2, '#FFFFFF');
        s.px(ballX + 1, ballY - Math.abs(lift), '#3366CC');

        // rod from the fisher's claw, line down to a bobber
        for (let i = 0; i < 5; i++) s.px(77 - i, 31 - i, '#8B5520');
        const bobY = 38 + (bite ? 1 : 0) + Math.round(wave(4) * 0.5);
        for (let i = 1; i < 6; i++) s.px(Math.round(72 - i), Math.round(27 + ((bobY - 27) * i) / 6), '#EDEDED');
        s.px(67, bobY, '#DC2828');
        s.px(67, bobY + 1, '#FFFFFF');
        // the reader's book
        s.rect(100, 75, 6, 2, '#F4F1E8');
        s.rect(102, 75, 1, 2, '#3366CC');
        if ((t * 4) % 1 < 0.12) s.px(104, 75, '#FFFFFF');
        if (bite) {
          s.alpha(0.5);
          const r = 1 + ((t - 0.5) / 0.12) * 4;
          for (let a = 0; a < TAU; a += 0.5) s.px(Math.round(67 + Math.cos(a) * r), Math.round(38 + Math.sin(a) * r * 0.6), '#CFEAF8');
          s.alpha(1);
        }
        if (fishK > 0.2 && fishK < 0.55) {
          const k = (fishK - 0.2) / 0.35;
          const fx = Math.round(streamCenter(104) - 3 + k * 6);
          const fy = Math.round(104 - Math.sin(k * Math.PI) * 5);
          s.rect(fx, fy, 2, 1, '#F2A33A');
          s.px(fx - 1, fy, '#E0862A');
        }
        const z = (t * 2) % 1;
        s.alpha(1 - z);
        s.rect(33 + Math.round(z * 4), 122 - Math.round(z * 8), 2, 1, '#FFFFFF');
        s.px(34 + Math.round(z * 4), 123 - Math.round(z * 8), '#FFFFFF');
        s.rect(33 + Math.round(z * 4), 124 - Math.round(z * 8), 2, 1, '#FFFFFF');
        s.alpha(1);
        // the chatting pair's "…"
        const dotsShown = Math.floor(t * 12) % 3 + 1;
        for (let i = 0; i < dotsShown; i++) s.px(99 + i * 2, 114, '#FFFFFF');

        for (const pt of petals) {
          const x = (((pt.x0 - t * GW) % GW) + GW) % GW;
          const y = (pt.y0 + t * GH) % GH;
          s.alpha(0.75);
          s.px(Math.round(x + Math.sin(TAU * 2 * t + pt.phase) * 2), Math.round(y), '#FFB6C8');
          s.alpha(1);
        }
      },
    };
  },
};
