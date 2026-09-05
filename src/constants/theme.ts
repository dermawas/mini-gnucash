// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// Warm charcoal and stone rather than the usual dark-fintech teal-on-navy.
// Carried over from Ledgerize, which is where the palette was worked out.
//
// Kept as a flat object rather than light/dark variants because there is no
// light mode today and every screen hardcodes dark. Adding one later is then
// additive rather than a rewrite.

export const theme = {
  bg: '#14140f',
  surface: '#1e1d18',
  surfaceSoft: '#211f1a',
  ink: '#edeae1',
  inkSoft: '#9c9789',
  inkFaint: '#6b6659',
  hairline: 'rgba(237, 234, 225, 0.12)',

  // Status colours. In Ledgerize these tracked budget usage; here they carry
  // ledger state instead:
  //
  //   moss   settled     a cleared split, money arriving
  //   amber  attention   the book is locked, the account list is stale
  //   coral  wrong       credentials rejected, a write refused
  //
  // A rule worth keeping from Ledgerize: put the status colour on the
  // INDICATOR, not the label. A tinted glyph beside plain text reads as a
  // state; colouring the sentence as well makes a row shout something the
  // icon already said.
  moss: '#6fa378',
  amber: '#d9a24b',
  coral: '#e17a63',

  // Interactive: buttons, links, the active tab, selected states.
  //
  // Deliberately the same hex as `amber` but a separate token. They mean
  // different things, "needs attention" and "you can tap this", and the day
  // one of them needs to change, a single shared value would force a choice
  // between two unrelated meanings. Never substitute one for the other just
  // because they render identically today.
  accent: '#d9a24b',
} as const;

export const fonts = {
  display: 'DMSerifDisplay',
} as const;
