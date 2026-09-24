// Pure sizing for the right column's panes (see usage-panel.ts), kept apart
// from the DOM so it can be tested.

export type ColumnPane = 'clawd' | 'turn' | 'session' | 'skills' | 'live' | 'totals';

/** Panes that always show at their content's height: the Clawd tub and 当前用量. */
export const FIXED_PANES: readonly ColumnPane[] = ['clawd', 'live'];

export function isFixedPane(pane: ColumnPane): boolean {
  return FIXED_PANES.includes(pane);
}

export interface PaneHeightInput {
  /** Height of the column. */
  avail: number;
  /** Open panes in the column, top to bottom. */
  panes: ColumnPane[];
  /** Heights the user dragged panes to (fixed panes are never resized, so they have none). */
  stored: Partial<Record<ColumnPane, number>>;
  /** Content heights of the fixed panes; each shows at this size (capped). */
  natural: Partial<Record<ColumnPane, number>>;
  /** Smallest height a pane may have. */
  min: number;
  /** Smallest height of the last pane — the totals keep their compact block. Defaults to `min`. */
  lastMin?: number;
  /** Cap on a fixed pane's natural height, as a share of the column. */
  fixedMaxShare: number;
}

/**
 * Heights for every open pane but the last, which fills what is left. The
 * fixed panes always take their natural height (capped) — they are not
 * resizable — a pane the user sized keeps its height, and the remaining panes
 * share the rest equally with the last one. When the total would squeeze the
 * last pane below `lastMin`, the resizable panes give way together (never
 * below `min`).
 */
export function planPaneHeights(input: PaneHeightInput): Partial<Record<ColumnPane, number>> {
  const { avail, panes, stored, natural, min, fixedMaxShare } = input;
  const lastMin = Math.max(min, input.lastMin ?? min);
  const upper = panes.slice(0, -1);
  const out: Partial<Record<ColumnPane, number>> = {};
  let fixedTotal = 0;
  for (const pane of upper) {
    if (!isFixedPane(pane)) continue;
    out[pane] = Math.floor(Math.min(natural[pane] ?? min, avail * fixedMaxShare));
    fixedTotal += out[pane]!;
  }

  const resizable = upper.filter((pane) => !isFixedPane(pane));
  const want: Partial<Record<ColumnPane, number>> = {};
  const shared: ColumnPane[] = [];
  let fixed = fixedTotal;
  for (const pane of resizable) {
    const h = stored[pane];
    if (h) {
      want[pane] = h;
      fixed += h;
    } else {
      shared.push(pane);
    }
  }
  const share = Math.max(min, (avail - fixed) / (shared.length + 1));
  for (const pane of shared) want[pane] = share;

  const total = resizable.reduce((n, pane) => n + want[pane]!, 0);
  const room = Math.max(0, avail - fixedTotal - lastMin);
  const scale = total > room && total > 0 ? room / total : 1;
  for (const pane of resizable) out[pane] = Math.max(min, Math.floor(want[pane]! * scale));
  return out;
}

/** Room the totals need beyond their compact block before they show everything. */
export const TOTALS_FULL_MARGIN = 8;

/**
 * The totals show everything (scrolling inside) as soon as their pane is taller
 * than the compact block — the ranges, the four cards and the mix line.
 */
export function totalsShowFull(paneHeight: number, compactHeight: number, alone: boolean): boolean {
  return alone || paneHeight > compactHeight + TOTALS_FULL_MARGIN;
}

/** Width one ring needs to show fully in the bottom dock, and the gap between rings. */
export const DOCK_RING_SLOT = 92;
export const DOCK_RING_GAP = 8;
/** The dock's horizontal padding (14px each side). */
export const DOCK_PADDING = 28;
/** Widest the dock gets (all three rings) and narrowest (just the 5-hour ring). */
export const DOCK_MAX_WIDTH = DOCK_PADDING + 3 * DOCK_RING_SLOT + 2 * DOCK_RING_GAP;
export const DOCK_MIN_WIDTH = DOCK_PADDING + DOCK_RING_SLOT;

/** How many rings fit fully in a dock this wide — 3, 2 (5-hour and weekly) or 1 (5-hour). */
export function ringsThatFit(width: number): 1 | 2 | 3 {
  const n = Math.floor((width - DOCK_PADDING + DOCK_RING_GAP) / (DOCK_RING_SLOT + DOCK_RING_GAP));
  return (n >= 3 ? 3 : n <= 1 ? 1 : 2);
}

