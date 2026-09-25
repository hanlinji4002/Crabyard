import type { Stage } from './engine.js';

// Clawd as the clawd skill draws him: one colour (#CD6E58), no mouth, 1-cell
// black eyes whose direction carries the mood, 2×2 arms that move up and down,
// four legs whose feet can swing. Animation mode uses the 14×8 flat body; scene
// mode the original 16×9 body with 1×2 eyes and the skill's hats.

export const CLAWD = '#CD6E58';
const EYE = '#000000';
const SPARKLE = '#FFD700';

export type Eyes = 'forward' | 'right' | 'left' | 'down' | 'up' | 'blink' | 'sparkle';

/** Animation-mode hats: the skill's straw / party, and its anime set (ninja, akatsuki, wizard, sorting). */
export type Hat = 'straw' | 'party' | 'ninja' | 'akatsuki' | 'wizard' | 'sorting';

export interface Pose {
  eyes?: Eyes;
  /** −4 (raised) … +4 (lowered). */
  armL?: number;
  armR?: number;
  /** Horizontal swing of each foot, −1 … +1. */
  legs?: [number, number, number, number];
  color?: string;
  hat?: Hat;
  /** Worn over the body: Luffy's open red vest or the Akatsuki cloak. */
  outfit?: 'vest' | 'cloak';
  /** Round glasses; 'potter' adds the lightning scar. */
  face?: 'glasses' | 'potter';
  /** Eye colour instead of black (or gold for sparkle eyes), e.g. a Sharingan red. */
  eyeColor?: string;
  /** Frame number that sets the headband tails, kasa tassels and cloak hem fluttering. */
  flutter?: number;
  /** Which way the wind blows those, −1 left or +1 right (default). */
  wind?: number;
  /** A full belly after a big meal, 0–2. */
  belly?: number;
}

function eyeOffset(eyes: Eyes): [number, number] {
  switch (eyes) {
    case 'right': return [1, 0];
    case 'left': return [-1, 0];
    case 'down': return [0, 1];
    case 'up': return [0, -1];
    default: return [0, 0];
  }
}

/** A 0/1 ripple for cloth ends, travelling along them. */
function ripple(flutter: number | undefined, k: number): number {
  if (flutter === undefined) return 0;
  return Math.sin(flutter * 0.45 - k * 1.3) > 0.2 ? 1 : 0;
}

/** Animation-mode Clawd, 14×8, with (ox, oy) the top-left of his box. */
export function drawClawd(s: Stage, ox: number, oy: number, pose: Pose = {}): void {
  const c = pose.color ?? CLAWD;
  const eyes = pose.eyes ?? 'forward';
  ox = Math.round(ox);
  oy = Math.round(oy);
  s.rect(ox + 3, oy, 8, 6, c);
  const belly = Math.round(pose.belly ?? 0);
  if (belly >= 1) s.rect(ox + 2, oy + 3, 10, 3, c);
  if (belly >= 2) {
    s.rect(ox + 1, oy + 4, 12, 2, c);
    s.rect(ox + 3, oy + 6, 8, 1, c);
  }
  const legs = pose.legs ?? [0, 0, 0, 0];
  [3, 5, 8, 10].forEach((col, i) => {
    s.px(ox + col, oy + 6, c);
    s.px(ox + col + legs[i], oy + 7, c);
  });
  if (pose.outfit === 'vest') drawVest(s, ox, oy);
  else if (pose.outfit === 'cloak') drawCloak(s, ox, oy, pose.flutter, pose.wind ?? 1);
  s.rect(ox + 1, oy + 2 + Math.round(pose.armL ?? 0), 2, 2, c);
  s.rect(ox + 11, oy + 2 + Math.round(pose.armR ?? 0), 2, 2, c);
  if (pose.face) drawLenses(s, ox, oy);
  if (eyes !== 'blink') {
    const [dx, eyeDy] = eyeOffset(eyes);
    // a headband covers row 0, so eyes can't look up under it
    const dy = pose.hat === 'ninja' ? Math.max(0, eyeDy) : eyeDy;
    const col = pose.eyeColor ?? (eyes === 'sparkle' ? SPARKLE : EYE);
    if (pose.face) {
      // behind glasses the eyes move half a cell, so they stay inside the lenses
      s.fine(ox + 4 + dx * 0.5, oy + 1.5 + dy * 0.5, 1, 1, col);
      s.fine(ox + 9 + dx * 0.5, oy + 1.5 + dy * 0.5, 1, 1, col);
    } else {
      s.px(ox + 4 + dx, oy + 1 + dy, col);
      s.px(ox + 9 + dx, oy + 1 + dy, col);
    }
  }
  if (pose.face) drawGlassFrames(s, ox, oy, pose.face === 'potter');
  if (pose.hat) drawHat(s, ox, oy, pose.hat, pose.flutter, pose.wind ?? 1);
}

/** Luffy's red vest, open down the front. */
function drawVest(s: Stage, ox: number, oy: number): void {
  s.rect(ox + 3, oy + 2, 3, 4, '#DC2828');
  s.rect(ox + 8, oy + 2, 3, 4, '#DC2828');
  s.rect(ox + 5, oy + 3, 1, 3, '#B81E1E');
  s.rect(ox + 8, oy + 3, 1, 3, '#B81E1E');
  s.px(ox + 4, oy + 3, '#FFDD33');
  s.px(ox + 4, oy + 5, '#FFDD33');
}

/** The Akatsuki cloak: black with red clouds edged in white, its hem over the legs. */
function drawCloak(s: Stage, ox: number, oy: number, flutter: number | undefined, wind: number): void {
  const k = '#26262B';
  s.rect(ox + 3, oy + 2, 8, 5, k);
  // high collar
  s.rect(ox + 3, oy + 2, 8, 1, '#34343A');
  // two red clouds edged in white
  for (const cx of [ox + 3, ox + 8]) {
    s.px(cx, oy + 4, '#F0F0F0');
    s.px(cx + 1, oy + 4, '#DC2828');
    s.px(cx + 2, oy + 4, '#F0F0F0');
    s.rect(cx, oy + 5, 3, 1, '#DC2828');
  }
  // hem: sways with the wind, the outer feet peek out below it
  const sway = flutter === undefined ? 0 : ripple(flutter, 0) * Math.sign(wind);
  s.rect(ox + 4 + sway, oy + 7, 6, 1, k);
}

/** Round glasses, drawn at half-cell detail and centred on the eyes: first the lenses' tint… */
function drawLenses(s: Stage, ox: number, oy: number): void {
  s.alpha(0.3);
  s.fine(ox + 3.5, oy + 1, 2, 2, '#FFFFFF');
  s.fine(ox + 8.5, oy + 1, 2, 2, '#FFFFFF');
  s.alpha(1);
}

/** …then, over the eyes, the frames; 'potter' adds the lightning scar. */
function drawGlassFrames(s: Stage, ox: number, oy: number, scar: boolean): void {
  const frame = '#2B2B30';
  const h = 0.5;
  for (const lx of [ox + 3, ox + 8]) {
    const top = oy + 0.5;
    s.fine(lx + h, top, 2, h, frame);
    s.fine(lx + h, top + 2.5, 2, h, frame);
    s.fine(lx, top + h, h, 2, frame);
    s.fine(lx + 2.5, top + h, h, 2, frame);
  }
  s.fine(ox + 6, oy + 1.5, 2, h, frame);
  if (scar) {
    // a gold lightning bolt on the forehead, between the lenses
    const g = '#FFD700';
    s.fine(ox + 7, oy, h, h, g);
    s.fine(ox + 6.5, oy + h, h, h, g);
    s.fine(ox + 7, oy + h, h, h, g);
    s.fine(ox + 6.5, oy + 1, h, h, g);
  }
}

/** Rows of the headband's long tail at its 2nd and 3rd cell, one step of its ripple each. */
const TAIL_WAVE: [number, number][] = [[0, 0], [0, 1], [1, 1], [1, 0]];

function hatRows(s: Stage, ox: number, oy: number, rows: [number, number, number, string][]): void {
  for (const [dy, from, to, color] of rows) s.rect(ox + from, oy + dy, to - from + 1, 1, color);
}

function drawHat(s: Stage, ox: number, oy: number, hat: Hat, flutter: number | undefined, wind: number): void {
  switch (hat) {
    case 'straw':
      s.rect(ox + 1, oy - 1, 12, 1, '#D8B878');
      s.rect(ox + 3, oy - 2, 8, 1, '#DC2828');
      s.rect(ox + 4, oy - 3, 6, 1, '#D8B878');
      break;
    case 'party':
      s.rect(ox + 4, oy - 1, 6, 1, '#FF88AA');
      s.rect(ox + 5, oy - 2, 4, 1, '#FF88AA');
      s.px(ox + 5, oy - 2, '#FFDD33');
      s.px(ox + 8, oy - 2, '#FFDD33');
      s.rect(ox + 6, oy - 3, 2, 1, '#FF88AA');
      s.rect(ox + 6, oy - 4, 2, 1, '#FFDD33');
      break;
    case 'ninja': {
      // Konoha forehead protector: blue band, metal plate with the leaf mark, tails behind
      s.rect(ox + 3, oy, 8, 1, '#3366CC');
      s.rect(ox + 5, oy, 4, 1, '#9AA3AD');
      s.px(ox + 5, oy, '#C9D1DA');
      s.rect(ox + 6, oy, 2, 1, '#3B3F46');
      // two tails off the knot, rippling when there's wind
      const dir = wind < 0 ? -1 : 1;
      const knot = dir > 0 ? ox + 10 : ox + 3;
      const phase = flutter === undefined ? 0 : Math.floor(flutter / 4) % 4;
      const [a2, a3] = TAIL_WAVE[phase];
      s.px(knot + dir, oy, '#3366CC');
      s.px(knot + dir * 2, oy + a2, '#3366CC');
      s.px(knot + dir * 3, oy + a3, '#3366CC');
      s.px(knot + dir, oy + 1, '#2A55AD');
      s.px(knot + dir * 2, oy + (phase === 0 ? 1 : 2), '#2A55AD');
      break;
    }
    case 'akatsuki': {
      // the wide conical kasa, red at the brim's ends, paper tassels hanging off it
      const straw = '#FFDD33';
      const weave = '#E3BD22';
      hatRows(s, ox, oy, [[-1, 0, 13, straw], [-2, 2, 11, straw], [-3, 4, 9, straw], [-4, 5, 8, straw], [-5, 6, 7, straw]]);
      hatRows(s, ox, oy, [[-2, 4, 4, weave], [-2, 9, 9, weave], [-3, 6, 6, weave], [-1, 3, 3, weave], [-1, 10, 10, weave], [-1, 7, 7, weave]]);
      s.px(ox, oy - 1, '#DC2828');
      s.px(ox + 13, oy - 1, '#DC2828');
      for (const [tx, k] of [[1, 0], [12, 1]] as const) {
        s.px(ox + tx, oy, '#F0F0F0');
        s.px(ox + tx, oy + 1, '#F0F0F0');
        s.px(ox + tx + (flutter === undefined ? 0 : ripple(flutter, k) * Math.sign(wind)), oy + 2, '#F0F0F0');
      }
      break;
    }
    case 'wizard':
      hatRows(s, ox, oy, [[-1, 2, 11, '#443388'], [-2, 3, 10, '#443388'], [-3, 4, 9, '#443388'], [-4, 5, 8, '#443388'], [-5, 5, 8, '#443388'], [-6, 6, 7, '#443388'], [-7, 6, 6, '#443388']]);
      for (const [dx, dy] of [[7, -2], [5, -3], [8, -4], [6, -5]]) s.px(ox + dx, oy + dy, '#BBAAEE');
      break;
    case 'sorting':
      // the Sorting Hat: patched brown felt, a crease for a mouth, its tip flopped over
      hatRows(s, ox, oy, [[-1, 1, 12, '#8B5520'], [-2, 3, 10, '#8B5520'], [-3, 4, 9, '#8B5520'], [-4, 5, 8, '#8B5520'], [-5, 8, 9, '#8B5520'], [-6, 10, 10, '#8B5520']]);
      s.px(ox + 5, oy - 3, '#996633');
      s.px(ox + 6, oy - 4, '#996633');
      s.rect(ox + 5, oy - 2, 4, 1, '#5E3A15');
      break;
  }
}

/** Walking feet: alternate swings every few frames. */
export function walkLegs(f: number, every = 4): [number, number, number, number] {
  return Math.floor(f / every) % 2 === 0 ? [-1, 0, 0, 1] : [1, 0, 0, -1];
}

// ─── Speech bubbles with pixel glyphs (readable at any size) ─────────

const GLYPHS: Record<string, string[]> = {
  '!': ['.#.', '.#.', '.#.', '...', '.#.'],
  '?': ['##.', '..#', '.#.', '...', '.#.'],
  heart: ['#.#', '###', '###', '.#.', '...'],
  check: ['...', '..#', '#.#', '.#.', '...'],
  note: ['.##', '.#.', '.#.', '##.', '##.'],
};
const GLYPH_COLORS: Record<string, string> = { '!': '#DC2828', '?': '#3366CC', heart: '#E0457B', check: '#2E9E4F', note: '#443388' };

/** A 5×7 bubble whose tail points down-left to (x, y + 7). */
export function drawBubble(s: Stage, x: number, y: number, glyph: keyof typeof GLYPHS): void {
  x = Math.round(x);
  y = Math.round(y);
  const edge = '#888888';
  s.rect(x + 1, y, 5, 1, edge);
  s.rect(x + 1, y + 6, 5, 1, edge);
  s.rect(x, y + 1, 1, 5, edge);
  s.rect(x + 6, y + 1, 1, 5, edge);
  s.rect(x + 1, y + 1, 5, 5, '#FFFFFF');
  s.px(x + 1, y + 7, edge);
  const rows = GLYPHS[glyph];
  rows.forEach((row, r) => {
    for (let c = 0; c < 3; c++) if (row[c] === '#') s.px(x + 2 + c, y + 1 + r, GLYPH_COLORS[glyph]);
  });
}

// ─── Scene-mode crab (16×9 original body) ───────────────────────────

export type SceneHat =
  | 'flower' | 'sunhat' | 'straw' | 'cap' | 'party' | 'crown' | 'chef' | 'beanie'
  | 'tophat' | 'bandana' | 'wizard' | 'headband' | 'beret' | 'ribbon' | 'tiara';

export interface CrabOpts {
  color?: string;
  eyes?: Eyes;
  /** −2 … +2; each step moves the arm two cells, as in the skill. */
  armL?: number;
  armR?: number;
  hat?: SceneHat | null;
  dress?: string | null;
  /** Walking: alternate which feet swing out. */
  step?: 0 | 1 | null;
  /** Dark glasses over the eyes. */
  shades?: boolean;
}

/**
 * A scene crab centred on column `cx`, head at row `cy`: body 16 wide (cx−7 …
 * cx+8) and 9 tall including the legs, eyes 1×2, arms beside rows 3–4.
 */
export function crab(s: Stage, cx: number, cy: number, o: CrabOpts = {}): void {
  cx = Math.round(cx);
  cy = Math.round(cy);
  const co = o.color ?? CLAWD;
  const eyes = o.eyes ?? 'forward';
  s.alpha(0.1);
  s.rect(cx - 5, cy + 8, 14, 2, '#000');
  s.alpha(1);
  s.rect(cx - 4, cy, 10, 7, co);
  const aL = Math.round(o.armL ?? 0) * 2;
  const aR = Math.round(o.armR ?? 0) * 2;
  s.rect(cx - 6, cy + 3 + aL, 2, 2, co);
  s.rect(cx + 6, cy + 3 + aR, 2, 2, co);
  [4, 6, 9, 11].forEach((c, i) => {
    const swing = o.step == null ? 0 : (i % 2 === o.step ? -1 : 1);
    s.px(cx - 7 + c, cy + 7, co);
    s.px(cx - 7 + c + swing, cy + 8, co);
  });
  if (o.dress) {
    s.rect(cx - 4, cy + 5, 10, 2, o.dress);
    s.rect(cx - 5, cy + 7, 12, 1, o.dress);
  }
  if (eyes !== 'blink') {
    const col = eyes === 'sparkle' ? SPARKLE : EYE;
    const [dx, dy] = eyeOffset(eyes);
    s.rect(cx - 2 + dx, cy + 1 + dy, 1, 2, col);
    s.rect(cx + 3 + dx, cy + 1 + dy, 1, 2, col);
  } else {
    s.rect(cx - 2, cy + 2, 1, 1, '#8A4535');
    s.rect(cx + 3, cy + 2, 1, 1, '#8A4535');
  }
  if (o.shades) {
    s.rect(cx - 3, cy + 1, 3, 2, '#222222');
    s.rect(cx + 2, cy + 1, 3, 2, '#222222');
    s.rect(cx, cy + 1, 2, 1, '#222222');
  }
  if (o.hat) drawSceneHat(s, cx, cy, o.hat);
}

function row(s: Stage, cx: number, y: number, from: number, to: number, color: string): void {
  s.rect(cx + from, y, to - from + 1, 1, color);
}

/** The skill's scene hats, drawn on the head of a crab at (cx, cy). */
function drawSceneHat(s: Stage, cx: number, cy: number, hat: SceneHat): void {
  switch (hat) {
    case 'flower':
      row(s, cx, cy - 1, -4, 5, '#44AA44');
      for (const [dx, c] of [[-3, '#FF88AA'], [-2, '#FF88AA'], [0, '#FFD700'], [1, '#FFD700'], [3, '#FF88AA'], [4, '#FF88AA']] as const) s.px(cx + dx, cy - 2, c);
      for (const dx of [-2, 1, 4]) s.px(cx + dx, cy - 3, '#F8F0E8');
      break;
    case 'chef':
      row(s, cx, cy - 1, -4, 5, '#F5F5F0');
      row(s, cx, cy - 2, -3, 4, '#F5F5F0');
      row(s, cx, cy - 3, -3, 4, '#F5F5F0');
      row(s, cx, cy - 4, -2, 3, '#F5F5F0');
      row(s, cx, cy - 5, -2, 3, '#F5F5F0');
      break;
    case 'party':
      row(s, cx, cy - 1, -3, 4, '#FF88AA');
      row(s, cx, cy - 2, -2, 3, '#FF88AA');
      s.px(cx - 1, cy - 2, '#FFDD33');
      s.px(cx + 2, cy - 2, '#FFDD33');
      row(s, cx, cy - 3, 0, 1, '#FF88AA');
      row(s, cx, cy - 4, 0, 1, '#FFDD33');
      break;
    case 'cap':
      row(s, cx, cy - 1, -4, 5, '#3366CC');
      row(s, cx, cy, -4, 8, '#3366CC');
      break;
    case 'crown':
      row(s, cx, cy - 1, -3, 4, '#FFDD33');
      row(s, cx, cy - 2, -3, 4, '#FFDD33');
      for (const dx of [-3, 0, 1, 4]) s.px(cx + dx, cy - 3, '#FFDD33');
      s.px(cx - 1, cy - 2, '#DC2828');
      s.px(cx + 2, cy - 2, '#DC2828');
      break;
    case 'headband':
      row(s, cx, cy, -4, 5, '#DC2828');
      break;
    case 'straw':
      row(s, cx, cy - 1, -5, 6, '#C4A46C');
      row(s, cx, cy - 2, -4, 5, '#B8975E');
      row(s, cx, cy - 3, -3, 4, '#C4A46C');
      row(s, cx, cy - 2, 0, 1, '#DC2828');
      break;
    case 'sunhat':
      row(s, cx, cy - 1, -5, 6, '#F0F0F0');
      row(s, cx, cy - 2, -4, 5, '#F0F0F0');
      row(s, cx, cy - 2, 1, 2, '#FF88AA');
      break;
    case 'beret':
      row(s, cx, cy - 1, -5, 4, '#DC2828');
      row(s, cx, cy - 2, -3, 3, '#DC2828');
      break;
    case 'tophat':
      row(s, cx, cy - 1, -4, 5, '#333333');
      for (let y = 2; y <= 5; y++) row(s, cx, cy - y, -2, 3, '#333333');
      row(s, cx, cy - 2, -2, 3, '#DC2828');
      break;
    case 'beanie':
      row(s, cx, cy - 1, -3, 4, '#FF88AA');
      row(s, cx, cy - 2, -2, 3, '#FF88AA');
      row(s, cx, cy - 2, 2, 3, '#F0F0F0');
      break;
    case 'bandana':
      row(s, cx, cy - 1, -4, 5, '#4488DD');
      s.px(cx + 6, cy, '#4488DD');
      s.px(cx + 6, cy + 1, '#4488DD');
      s.px(cx + 7, cy + 1, '#4488DD');
      break;
    case 'wizard':
      row(s, cx, cy - 1, -4, 5, '#443388');
      row(s, cx, cy - 2, -3, 4, '#443388');
      row(s, cx, cy - 3, -2, 3, '#443388');
      row(s, cx, cy - 4, -2, 3, '#443388');
      row(s, cx, cy - 5, 0, 1, '#443388');
      s.px(cx, cy - 6, '#443388');
      s.px(cx + 2, cy - 3, '#BBAAEE');
      s.px(cx - 1, cy - 4, '#BBAAEE');
      break;
    case 'ribbon':
      for (const [dx, dy] of [[6, 0], [7, 0], [8, 0], [7, -1], [8, 1]]) s.px(cx + dx, cy + dy, '#FF88AA');
      break;
    case 'tiara':
      row(s, cx, cy - 1, -3, 4, '#FFD700');
      s.px(cx, cy - 2, '#FFD700');
      s.px(cx + 1, cy - 2, '#87CEEB');
      s.px(cx + 2, cy - 2, '#FFD700');
      break;
  }
}
