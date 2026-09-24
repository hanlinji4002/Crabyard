// Shared SVG icons used by both the sidebar project actions and the tab bar, so
// the same concept (Sessions / Team / Git) renders
// identically in both places. Single source of truth — edit here, not in
// sidebar.ts.
//
// Thin stroke-based (Lucide) outlines on a 24×24 grid — the glyphs from the
// "Studio" design system's active-project menu.

const STROKE_ICON = (body: string): string =>
  `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

// Project menu — exact glyphs from the Studio design system.
export const ICON_SESSIONS = STROKE_ICON('<circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 1.5"/>');

export const ICON_TEAM = STROKE_ICON('<circle cx="9" cy="9" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 6.5a3 3 0 0 1 0 5.6M16.5 13.5a5 5 0 0 1 4 5.5"/>');

export const ICON_GIT = STROKE_ICON('<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="17" cy="9" r="2.5"/><path d="M6 8.5v7M17 11.5a5 5 0 0 1-5 5H8.5"/>');

export const ICON_TERMINAL = STROKE_ICON('<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>');

export const ICON_GRID = STROKE_ICON('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>');
