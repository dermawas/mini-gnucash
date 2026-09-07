// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// Ink / Parchment / Verdigris, from the 2026-09-08 design handoff.
//
// This replaced the warm-charcoal dark palette carried over from Ledgerize.
// The app now reads as a paper ledger rather than a utility: warm paper
// ground, a blue-black ink, and verdigris as the single "money" accent.
//
// Still a flat object rather than light/dark variants, for the same reason as
// before -- there is one scheme and every screen assumes it. What changed is
// which one. Adding a second later is additive rather than a rewrite.
//
// The KEY NAMES are deliberately unchanged from the dark palette even where
// the design handoff uses different words for them (`paper` for bg,
// `parchment` for surfaceSoft, and so on). Renaming would have touched every
// style block in the app for no behavioural gain and buried the actual colour
// change in the diff. The handoff's names are provided as aliases below, so
// new code can use the vocabulary the design speaks.

export const theme = {
  // Paper. The screen ground.
  bg: '#F4EEE2',
  // Card and input surface -- slightly brighter than the paper it sits on.
  surface: '#FFFDF9',
  // Parchment: chips, account avatars, the offline banner.
  surfaceSoft: '#E6DECF',

  ink: '#1C2430',
  inkSoft: '#3F4650',
  inkFaint: '#6E7268',

  // Two weights, and the difference matters. The soft one separates rows
  // inside a card; the strong one closes a section off.
  hairline: '#EDE6D8',
  hairlineStrong: '#DCD3C2',

  // Row press feedback.
  pressed: '#EAE3D5',

  // Status colours, carrying ledger state exactly as they did before:
  //
  //   verdigris  settled     a cleared split, money arriving
  //   copper     attention   the book is locked, the account list is stale
  //   copper     wrong       credentials rejected, a write refused
  //
  // The old palette had separate amber and coral for the last two. This one
  // has a single attention colour, so `amber` and `coral` now resolve to the
  // same hex -- kept as separate tokens for the same reason `accent` was kept
  // separate from `amber` before: they mean different things, and the day one
  // needs to move, a shared value would force a choice between two unrelated
  // meanings.
  moss: '#2F7D6D',
  amber: '#C2572E',
  coral: '#C2572E',

  // Copper's quieter forms, for a tinted banner rather than a tinted glyph.
  copperTint: '#F3D9CB',
  copperDark: '#5A2A14',

  // Interactive: buttons, links, the active tab, selected states.
  //
  // In the dark palette this was amber -- a warm accent against a dark ground.
  // On paper the emphatic colour is the ink itself, so a primary button is an
  // ink block with paper text. Still its own token, never substitute it for
  // `ink` just because they render identically today.
  accent: '#1C2430',

  // Chevrons, dashed borders, anything present but not yet actionable.
  disabled: '#B3AC9E',
  tabInactive: '#8E9188',
  toggleOff: '#C8C0B0',
  bezel: '#141A24',
} as const;

// The handoff's own vocabulary, for new code that is reading the spec
// alongside it. Same values, no second source of truth.
export const palette = {
  paper: theme.bg,
  card: theme.surface,
  parchment: theme.surfaceSoft,
  ink: theme.ink,
  verdigris: theme.moss,
  copper: theme.coral,
} as const;

// IBM Plex, per the handoff: Sans for everything, Mono for every amount.
//
// Mono on amounts is not decoration. Figures in a ledger are read in columns
// and compared down the page, and proportional digits make that harder than
// it needs to be -- a tabular figure keeps the decimal point in the same
// place whatever the number.
export const fonts = {
  sans: 'IBMPlexSans_400Regular',
  sansMedium: 'IBMPlexSans_500Medium',
  sansSemi: 'IBMPlexSans_600SemiBold',
  mono: 'IBMPlexMono_400Regular',
  monoMedium: 'IBMPlexMono_500Medium',
  /** Screen titles. Was DM Serif Display; the handoff sets them in Sans 500. */
  display: 'IBMPlexSans_500Medium',
} as const;
