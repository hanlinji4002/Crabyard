import { FPS, makeStage, type AnimationRun, type ClawdAnimation } from './engine.js';
import { codingAnimation } from './anim-coding.js';
import { umbrellaAnimation } from './anim-umbrella.js';
import { gardenAnimation } from './anim-garden.js';
import { parkScene } from './scene-park.js';
import { beachScene } from './scene-beach.js';

/** The five Clawd animations, alternating animation mode and scene mode. */
export const CLAWD_ANIMATIONS: ClawdAnimation[] = [codingAnimation, parkScene, umbrellaAnimation, beachScene, gardenAnimation];

export interface PlayerOptions {
  /** Loops of each animation before moving on to the next. */
  loopsEach: number;
  start?: number;
  onChange?: (index: number, playing: boolean) => void;
}

/** Frames spent fading out of one animation and into the next. */
const FADE_FRAMES = 8;
/** After a long pause (hidden window, throttled timers) don't replay the gap. */
const MAX_CATCH_UP = 3;

/**
 * Plays the Clawd animations on a canvas that fills `host` (which keeps a 4:3
 * box). Runs at 30 fps while the canvas is on screen and the window visible,
 * cycles through the animations, and stops for good once the canvas leaves
 * the document.
 */
export class ClawdPlayer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private index: number;
  private run: AnimationRun;
  private frame = 0;
  private loops = 0;
  private fadeIn = 0;
  private playing = true;
  private onScreen = true;
  private raf = 0;
  private last = 0;
  private carry = 0;
  private destroyed = false;
  private readonly resizeObserver: ResizeObserver;
  private readonly intersectionObserver: IntersectionObserver;

  constructor(private readonly host: HTMLElement, private readonly opts: PlayerOptions) {
    this.index = ((opts.start ?? 0) % CLAWD_ANIMATIONS.length + CLAWD_ANIMATIONS.length) % CLAWD_ANIMATIONS.length;
    this.run = this.current.create();
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'clawd-canvas';
    this.ctx = this.canvas.getContext('2d')!;
    host.appendChild(this.canvas);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.intersectionObserver = new IntersectionObserver((entries) => {
      this.onScreen = entries.some((e) => e.isIntersecting);
      this.schedule();
    });
    this.intersectionObserver.observe(this.canvas);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resize();
    this.schedule();
  }

  get current(): ClawdAnimation {
    return CLAWD_ANIMATIONS[this.index];
  }

  get currentIndex(): number {
    return this.index;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  select(index: number): void {
    const n = CLAWD_ANIMATIONS.length;
    this.index = ((index % n) + n) % n;
    this.run = this.current.create();
    this.frame = 0;
    this.loops = 0;
    this.fadeIn = 1;
    this.resize();
    this.opts.onChange?.(this.index, this.playing);
    this.draw();
  }

  next(): void {
    this.select(this.index + 1);
  }

  prev(): void {
    this.select(this.index - 1);
  }

  toggle(): void {
    this.playing = !this.playing;
    this.opts.onChange?.(this.index, this.playing);
    this.schedule();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.intersectionObserver.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  private readonly onVisibility = () => this.schedule();

  private get total(): number {
    return Math.round(this.current.seconds * FPS);
  }

  private resize(): void {
    const anim = this.current;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(this.host.clientWidth * dpr));
    const cell = width / anim.gw;
    const height = Math.max(1, Math.round(anim.gh * cell));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.host.style.background = anim.bg;
    this.draw();
  }

  private stage() {
    const anim = this.current;
    return makeStage(this.ctx, anim.gw, anim.gh, this.canvas.width / anim.gw);
  }

  private draw(): void {
    if (!this.canvas.width) return;
    const s = this.stage();
    this.ctx.globalAlpha = 1;
    this.run.draw(s, this.frame, this.total);
    // fade through the background colour when switching animations
    const lastLoop = this.opts.loopsEach > 0 && this.loops >= this.opts.loopsEach - 1;
    const out = lastLoop && this.playing ? Math.max(0, this.frame - (this.total - FADE_FRAMES)) / FADE_FRAMES : 0;
    const veil = Math.max(out, this.fadeIn);
    if (veil > 0) {
      s.alpha(Math.min(1, veil));
      s.rect(0, 0, s.gw, s.gh, this.current.bg);
      s.alpha(1);
    }
  }

  private schedule(): void {
    if (this.destroyed || this.raf) return;
    if (!this.playing || !this.onScreen || document.visibilityState === 'hidden') return;
    this.last = 0;
    this.raf = requestAnimationFrame(this.tick);
  }

  private readonly tick = (now: number) => {
    this.raf = 0;
    if (!this.canvas.isConnected) {
      this.destroy();
      return;
    }
    if (!this.playing || !this.onScreen || document.visibilityState === 'hidden') return;
    if (this.last) {
      this.carry += ((now - this.last) / 1000) * FPS;
      let steps = Math.min(MAX_CATCH_UP, Math.floor(this.carry));
      if (steps > 0) this.carry -= Math.floor(this.carry);
      while (steps-- > 0) this.advance();
    }
    this.last = now;
    this.raf = requestAnimationFrame(this.tick);
  };

  private advance(): void {
    this.frame++;
    if (this.fadeIn > 0) this.fadeIn = Math.max(0, this.fadeIn - 1 / FADE_FRAMES);
    if (this.frame >= this.total) {
      this.frame = 0;
      this.loops++;
      if (this.opts.loopsEach > 0 && this.loops >= this.opts.loopsEach) {
        this.select(this.index + 1);
        return;
      }
    }
    this.draw();
  }
}
