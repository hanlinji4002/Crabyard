// Claude plan usage limits — the 5-hour window and the weekly window — as
// Claude Code reports them in its statusLine payload's `rate_limits`, the same
// source claude-hud reads. They
// are account-wide, but each Claude Code process reports what it cached at
// its own last request, so an idle session keeps sending old numbers: reports
// are merged window by window, keeping the freshest (see mergeWindow). The
// last snapshot is kept in localStorage so the panel has numbers after a
// restart, until a running session reports again.

export interface PlanWindow {
  /** Share of the window used, 0–100; null when Claude Code sent no value. */
  percent: number | null;
  /** Epoch ms of the window's next reset; null when unknown. */
  resetsAt: number | null;
}

export interface PlanUsage {
  fiveHour: PlanWindow | null;
  sevenDay: PlanWindow | null;
  /** Epoch ms of the report this snapshot came from. */
  updatedAt: number;
}

/** A window as it stands at some moment: past its reset time it reads 0%. */
export interface PlanWindowNow extends PlanWindow {
  reset: boolean;
}

const STORAGE_KEY = 'myclaudetui.planUsage';
/** Unchanged reports still refresh the stored timestamp, but at most this often. */
const PERSIST_EVERY_MS = 60_000;

function toPercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

/** Unix seconds, epoch ms or an ISO-8601 string → epoch ms. */
function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string' && value.length <= 64) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function parseWindow(raw: unknown): PlanWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as { used_percentage?: unknown; resets_at?: unknown };
  const percent = toPercent(w.used_percentage);
  const resetsAt = toEpochMs(w.resets_at);
  if (percent === null && resetsAt === null) return null;
  return { percent, resetsAt };
}

/** Parse a statusLine `rate_limits` object; null when it carries nothing usable. */
export function parseRateLimits(raw: unknown, now: number): PlanUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { five_hour?: unknown; seven_day?: unknown };
  const fiveHour = parseWindow(r.five_hour);
  const sevenDay = parseWindow(r.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay, updatedAt: now };
}

/** Reset times within this of each other are the same window. */
const SAME_WINDOW_MS = 60_000;

/**
 * The fresher of two reports of one limit window: a later reset time means a
 * newer window (an old one from an idle session is ignored), and within one
 * window usage only grows.
 */
export function mergeWindow<W extends PlanWindow>(prev: W | null | undefined, next: W | null | undefined): W | null {
  if (!next) return prev ?? null;
  if (!prev) return next;
  const pr = prev.resetsAt ?? 0;
  const nr = next.resetsAt ?? 0;
  if (nr > pr + SAME_WINDOW_MS) return next;
  if (nr < pr - SAME_WINDOW_MS) return prev;
  return (next.percent ?? -1) >= (prev.percent ?? -1) ? next : prev;
}

/** `window` as of `now`: once its reset time has passed, the usage is back to 0%. */
export function windowAt(window: PlanWindow | null, now: number): PlanWindowNow | null {
  if (!window) return null;
  if (window.resetsAt !== null && window.resetsAt <= now) return { percent: 0, resetsAt: null, reset: true };
  return { ...window, reset: false };
}

/** Ring colour for a limit: blue up to 60%, yellow above that, red from 85%. */
export function limitLevel(percent: number): 'ok' | 'warn' | 'crit' {
  if (percent >= 85) return 'crit';
  if (percent > 60) return 'warn';
  return 'ok';
}

let current: PlanUsage | null | undefined;
let lastPersist = 0;
const listeners = new Set<() => void>();

function load(): PlanUsage | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PlanUsage;
    return parsed && typeof parsed.updatedAt === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

export function getPlanUsage(): PlanUsage | null {
  if (current === undefined) current = load();
  return current;
}

function sameWindows(a: PlanUsage, b: PlanUsage): boolean {
  return JSON.stringify([a.fiveHour, a.sevenDay]) === JSON.stringify([b.fiveHour, b.sevenDay]);
}

/**
 * Feed one statusLine `rate_limits` payload. The statusLine fires on every
 * render, so listeners only hear real changes; the stored timestamp still
 * moves forward so "updated …" stays honest.
 */
export function updatePlanUsage(raw: unknown, now = Date.now()): void {
  const report = parseRateLimits(raw, now);
  if (!report) return;
  const prev = getPlanUsage();
  const next: PlanUsage = prev
    ? {
        ...report,
        fiveHour: mergeWindow(prev.fiveHour, report.fiveHour),
        sevenDay: mergeWindow(prev.sevenDay, report.sevenDay),
      }
    : report;
  current = next;
  const changed = !prev || !sameWindows(prev, next);
  if (changed || now - lastPersist >= PERSIST_EVERY_MS) {
    lastPersist = now;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // storage unavailable
    }
  }
  if (changed) for (const cb of listeners) cb();
}

export function onPlanUsageChange(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/** @internal Test-only: reset all module state */
export function _resetForTesting(): void {
  current = undefined;
  lastPersist = 0;
  listeners.clear();
}
