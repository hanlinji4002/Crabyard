import { hash, makeStage, pingpong, type ClawdAnimation, type Stage } from './engine.js';
import { crab, type CrabOpts } from './sprites.js';

// Scene mode — 海边沙滩: a top-down beach in the skill's scene style — the sea
// with rolling waves and foam, a pier, palms, umbrellas and towels, a
// sandcastle, a volleyball court and an ice-cream hut, with crabs surfing,
// floating, sunbathing, playing, building, fishing and beachcombing. Terrain is
// cached offscreen; every motion loops a whole number of times per loop.

const GW = 192;
const GH = 144;
const TAU = Math.PI * 2;

function shore(x: number): number {
  return 46 + 4 * Math.sin(x * 0.05) + 2 * Math.sin(x * 0.13 + 1);
}

const PALMS: [number, number][] = [[10, 124], [184, 104], [104, 142]];
const UMBRELLAS: { x: number; y: number; a: string; b: string }[] = [
  { x: 38, y: 78, a: '#E24B4B', b: '#FFFFFF' },
  { x: 66, y: 104, a: '#3A8DDE', b: '#FFDD33' },
  { x: 132, y: 70, a: '#44AA44', b: '#FFFFFF' },
];
const PIER = { x: 150, w: 8, top: 6 };
const COURT = { x: 78, y: 110, w: 44, h: 26 };

function buildTerrain(s: Stage): void {
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      const h = hash(x, y);
      const edge = shore(x);
      let c: string;
      if (y < edge - 9) c = y < 18 ? '#2E7FB8' : '#3494D0';
      else if (y < edge) c = '#5DB0E4';
      else if (y < edge + 5) c = h > 0.5 ? '#D8BD86' : '#D1B47C';
      else {
        c = h > 0.66 ? '#EED9A7' : h > 0.33 ? '#E8CF96' : '#F1DFB2';
        if (h > 0.992) c = '#F4A6B8';
        else if (h > 0.985) c = '#FFFFFF';
      }
      s.px(x, y, c);
    }
  }
  // pier: planks from the sand out over the sea
  for (let y = PIER.top; y < 60; y++) {
    s.rect(PIER.x, y, PIER.w, 1, y % 2 ? '#A0714A' : '#93653F');
    if (y % 6 === 0) {
      s.px(PIER.x - 1, y, '#6B4423');
      s.px(PIER.x + PIER.w, y, '#6B4423');
    }
  }
  // volleyball court and net
  s.rect(COURT.x, COURT.y, COURT.w, 1, '#FFFFFF');
  s.rect(COURT.x, COURT.y + COURT.h, COURT.w, 1, '#FFFFFF');
  s.rect(COURT.x, COURT.y, 1, COURT.h, '#FFFFFF');
  s.rect(COURT.x + COURT.w, COURT.y, 1, COURT.h + 1, '#FFFFFF');
  for (let y = COURT.y - 2; y <= COURT.y + COURT.h + 2; y++) s.px(COURT.x + COURT.w / 2, y, y % 2 ? '#555555' : '#777777');
  // sandcastle with a flag
  s.rect(88, 64, 12, 7, '#D4B071');
  s.rect(89, 61, 3, 3, '#C9A462');
  s.rect(96, 61, 3, 3, '#C9A462');
  for (const x of [89, 91, 96, 98]) s.px(x, 60, '#B8914F');
  s.rect(92, 66, 4, 5, '#B8914F');
  s.rect(94, 55, 1, 6, '#6B4423');
  s.rect(95, 55, 3, 2, '#DC2828');
  // towels beside the umbrellas
  s.rect(46, 80, 8, 13, '#FFDD33');
  for (let y = 80; y < 93; y += 3) s.rect(46, y, 8, 1, '#F29D38');
  s.rect(74, 106, 8, 13, '#88BBEE');
  for (let y = 106; y < 119; y += 3) s.rect(74, y, 8, 1, '#FFFFFF');
  s.rect(140, 72, 8, 13, '#FF88AA');
  for (let y = 72; y < 85; y += 3) s.rect(140, y, 8, 1, '#FFFFFF');
  // ice-cream hut: striped roof and counter
  for (let y = 0; y < 12; y++) for (let x = 0; x < 18; x++) s.px(156 + x, 124 + y, Math.floor(x / 3) % 2 ? '#FFFFFF' : '#FF88AA');
  s.rect(154, 136, 22, 3, '#A0714A');
  for (const [x, c] of [[157, '#FFB3C8'], [161, '#FFE08A'], [165, '#9ED7A8'], [169, '#C9A7E8']] as const) s.rect(x, 137, 2, 1, c);
  // umbrellas: round canopies in two colours, with a shadow
  for (const u of UMBRELLAS) {
    s.alpha(0.16);
    s.disc(u.x + 3, u.y + 3, 7, '#000');
    s.alpha(1);
    for (let dy = -7; dy <= 7; dy++) {
      for (let dx = -7; dx <= 7; dx++) {
        if (dx * dx + dy * dy > 49) continue;
        const seg = Math.floor(((Math.atan2(dy, dx) + Math.PI) / TAU) * 8);
        s.px(u.x + dx, u.y + dy, seg % 2 ? u.a : u.b);
      }
    }
    s.px(u.x, u.y, '#6B4423');
  }
  // palms: fronds radiating from a coconut cluster
  for (const [px, py] of PALMS) {
    s.alpha(0.14);
    s.disc(px + 3, py + 3, 10, '#000');
    s.alpha(1);
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * TAU + 0.3;
      for (let r = 2; r <= 11; r++) {
        const bend = Math.sin(r * 0.35) * 1.2;
        const x = Math.round(px + Math.cos(a) * r - Math.sin(a) * bend);
        const y = Math.round(py + Math.sin(a) * r + Math.cos(a) * bend);
        s.px(x, y, r % 3 === 0 ? '#3CB371' : '#2E8B57');
        if (r > 3 && r < 10) s.px(x + (Math.cos(a + 1.57) > 0 ? 1 : -1), y, '#3CB371');
      }
    }
    s.rect(px - 1, py - 1, 3, 3, '#8B5A2B');
    s.px(px, py, '#6B4423');
  }
}

interface Crab extends CrabOpts {
  x: number;
  y: number;
}

export const beachScene: ClawdAnimation = {
  id: 'beach',
  mode: 'scene',
  gw: GW,
  gh: GH,
  seconds: 8,
  bg: '#EED9A7',
  create() {
    let cache: HTMLCanvasElement | null = null;
    let cacheKey = '';
    const gulls = [0, 1, 2].map((i) => ({ y: 8 + i * 9, off: i * 0.37, speed: i === 1 ? 2 : 1 }));

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

        // rolling wave crests, two passes per loop
        for (let y = 2; y < 40; y += 6) {
          for (let x = 0; x < GW; x++) {
            if (x >= PIER.x - 1 && x <= PIER.x + PIER.w) continue;
            const w = Math.sin(x * 0.18 + y * 0.9 - TAU * 2 * t);
            if (w > 0.8 && y < shore(x) - 10) s.px(x, y + Math.round(Math.sin(x * 0.3) * 1), '#A9D8F5');
          }
        }
        // foam rushing up the sand and back, once per loop
        const reach = 2 + Math.round((1 - Math.cos(TAU * t)) * 2);
        for (let x = 0; x < GW; x++) {
          if (x >= PIER.x - 1 && x <= PIER.x + PIER.w) continue;
          const y = Math.round(shore(x)) + reach + Math.round(Math.sin(x * 0.4 + TAU * t) * 0.6);
          s.px(x, y, '#FFFFFF');
          if ((x + Math.floor(t * 40)) % 5 === 0) s.px(x, y - 1, '#EAF6FF');
        }

        const crabs: Crab[] = [];
        const step = (Math.floor(f / 4) % 2) as 0 | 1;
        const wave = (k: number, ph = 0) => Math.sin(TAU * k * t + ph);

        // surfers riding across the waves
        const surf1 = ((t * 230) % 230) - 20;
        const surf2 = 210 - ((t * 230 + 115) % 230);
        for (const [sx, sy] of [[surf1, 24], [surf2, 12]] as const) {
          const bob = Math.round(Math.sin(TAU * 4 * t + sx * 0.05));
          s.rect(sx - 8, sy + 6 + bob, 17, 3, '#2288DD');
          s.rect(sx - 8, sy + 7 + bob, 2, 1, '#22BB66');
          s.rect(sx + 7, sy + 7 + bob, 2, 1, '#22BB66');
          s.alpha(0.6);
          s.rect(sx - 12, sy + 8 + bob, 4, 1, '#FFFFFF');
          s.alpha(1);
        }
        crabs.push({ x: surf1, y: 24 + Math.round(Math.sin(TAU * 4 * t + surf1 * 0.05)) - 2, eyes: 'right', hat: 'bandana', armL: -1, armR: -1 });
        crabs.push({ x: surf2, y: 12 + Math.round(Math.sin(TAU * 4 * t + surf2 * 0.05)) - 2, eyes: 'sparkle', hat: 'headband', armL: -1, armR: -1 });

        // floating in a ring buoy
        const fx = 60 + Math.round(Math.sin(TAU * t) * 6);
        const fy = 30 + Math.round(Math.sin(TAU * 2 * t) * 1);
        for (let a = 0; a < 16; a++) {
          const ang = (a / 16) * TAU;
          s.rect(Math.round(fx + 0.5 + Math.cos(ang) * 8), Math.round(fy + 4 + Math.sin(ang) * 5), 2, 2, a % 4 < 2 ? '#DC2828' : '#FFFFFF');
        }
        crabs.push({ x: fx, y: fy, eyes: 'blink', hat: 'sunhat' });

        // sunbathers on the towels
        crabs.push({ x: 50, y: 83, eyes: 'blink', shades: true, hat: 'straw' });
        crabs.push({ x: 144, y: 75, eyes: 'up', shades: true, armR: wave(1) > 0.6 ? -1 : 0, dress: '#FF88AA' });
        crabs.push({ x: 78, y: 108, eyes: 'blink', hat: 'tiara' });

        // volleyball: two a side, the ball flying over the net twice a loop
        const vp = pingpong(t * 2);
        const vx = COURT.x + 8 + vp * (COURT.w - 16);
        const vy = COURT.y + 11 + Math.sin(vp * Math.PI) * 2;
        const lift = Math.round(Math.sin(vp * Math.PI) * 9);
        crabs.push({ x: COURT.x + 8, y: COURT.y + 4, eyes: 'right', hat: 'cap', armL: vp < 0.12 ? -2 : 0, armR: vp < 0.12 ? -2 : 0 });
        crabs.push({ x: COURT.x + 10, y: COURT.y + 16, eyes: 'right', hat: 'beanie' });
        crabs.push({ x: COURT.x + COURT.w - 8, y: COURT.y + 5, eyes: 'left', hat: 'headband', armL: vp > 0.88 ? -2 : 0, armR: vp > 0.88 ? -2 : 0 });
        crabs.push({ x: COURT.x + COURT.w - 10, y: COURT.y + 15, eyes: 'left', hat: 'party' });

        // building the sandcastle; fishing off the pier; beachcombing along the shore
        const dig = Math.floor(f / 5) % 2;
        crabs.push({ x: 82, y: 70, eyes: 'right', hat: 'straw', armL: dig ? -1 : 1, armR: dig ? 1 : -1 });
        const bite = t > 0.3 && t < 0.4;
        crabs.push({ x: PIER.x + 4, y: PIER.top + 2, eyes: bite ? 'sparkle' : 'up', hat: 'tophat', armL: bite ? -2 : -1 });
        const combX = -10 + t * 212;
        crabs.push({ x: combX, y: Math.round(shore(combX)) + 7, eyes: 'down', hat: 'flower', step });

        // ice-cream hut: the vendor and a customer licking a cone
        crabs.push({ x: 165, y: 115, eyes: 'down', hat: 'chef' });
        const lick = wave(3) > 0.4;
        crabs.push({ x: 140, y: 118, eyes: lick ? 'sparkle' : 'right', hat: 'ribbon', armR: -1 });

        crabs.sort((a, b) => a.y - b.y);
        for (const c of crabs) crab(s, c.x, c.y, c);

        // details on top: the ball, the cone, the fishing line, gulls
        s.alpha(0.2);
        s.rect(vx, vy + 3, 2, 1, '#000');
        s.alpha(1);
        s.rect(vx, vy - lift, 2, 2, '#FFFFFF');
        s.px(vx + 1, vy - lift, '#FFDD33');
        s.rect(148, 117, 2, 2, lick ? '#FFB3C8' : '#FFE08A');
        s.px(148, 119, '#C98A3E');
        s.px(149, 119, '#C98A3E');
        for (let i = 1; i <= 6; i++) s.px(PIER.x - 2 - i, PIER.top + 3 - Math.round(i * 0.4) + (bite && i === 6 ? 1 : 0), '#EDEDED');
        s.px(PIER.x - 9, PIER.top + 1 + (bite ? 1 : 0), '#DC2828');
        for (const g of gulls) {
          const gx = ((t * g.speed + g.off) % 1) * (GW + 20) - 10;
          const gy = g.y + Math.round(Math.sin(TAU * 2 * t + g.off * 9) * 1.5);
          const up = Math.floor(f / 5 + g.y) % 2 === 0;
          s.px(gx - 2, gy + (up ? -1 : 0), '#FFFFFF');
          s.px(gx - 1, gy, '#FFFFFF');
          s.px(gx, gy + 1, '#E8E8E8');
          s.px(gx + 1, gy, '#FFFFFF');
          s.px(gx + 2, gy + (up ? -1 : 0), '#FFFFFF');
        }
      },
    };
  },
};
