// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital

// "Spending Weather" visual identity — see the design pitch this was
// chosen from for the full rationale. Grounded in the app's own
// "awareness" positioning: the accent isn't a fixed brand color, it's a
// real mechanic — calm moss at rest, warming toward amber then coral as
// spend approaches/exceeds a budget. Warm charcoal/stone base, deliberately
// not navy, to move away from the generic dark-fintech teal-on-navy look.
//
// The app has no light-mode support today (every screen hardcodes dark
// colors, no theme switching exists) — only the dark tokens are used for
// now. Kept as a flat object rather than light/dark variants so adding
// real light-mode support later is a smaller, additive change.

export const theme = {
  bg: '#14140f',
  surface: '#1e1d18',
  surfaceSoft: '#211f1a',
  ink: '#edeae1',
  inkSoft: '#9c9789',
  inkFaint: '#6b6659',
  hairline: 'rgba(237, 234, 225, 0.12)',

  // The "weather" states — moss (calm) -> amber (approaching) -> coral
  // (over). Used for anything reflecting budget/spend status: progress
  // bars, percentage text, alert banners. Never used decoratively.
  moss: '#6fa378',
  amber: '#d9a24b',
  coral: '#e17a63',

  
// Categorical palette for charts/legends (e.g. Budgets' category pie) —
// deliberately separate from the semantic weather colors above (a chart
// slice's color means "which category," not "good/warning/bad"). Kept in
// the same warm, desaturated register as the rest of the identity rather
// than a generic rainbow.
export const CHART_COLORS: string[] = [
  '#6fa378', // moss
  '#d9a24b', // amber
  '#e17a63', // coral
  '#7a93b0', // dusty blue
  '#a888b5', // muted plum
  '#c9a34a', // brass/ochre
  '#8fa87a', // sage
  '#b6714f', // terracotta
];
export const CHART_OTHER_COLOR: string = '#6b6659';

// Used to de-emphasize every slice except the one currently selected in
// an interactive chart (e.g. Budgets' pie) — a single flat muted tone
// rather than dimming each categorical color individually, so "everything
// else" reads as one clearly de-emphasized group.
export const CHART_DIM_COLOR: string = '#3a372f';

// Background wash for a category's icon tile: the category's own colour at
// ~15% alpha, with the icon itself drawn in the solid colour on top. Kept as a
// helper rather than a hardcoded "26" suffix at each call site so the tile
// reads identically everywhere it appears (transaction rows, Receipt Review
// group headers, budget cards, category pickers).
export function categoryTint(color: string): string {
  return `${color}26`;
}

export const fonts = {
  display: 'DMSerifDisplay',
} as const;
