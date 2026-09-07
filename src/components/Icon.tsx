// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// The app's icon set, from the 2026-09-08 design handoff: thin line, 24px
// grid, 1.5px stroke, round caps and joins. Every path below is copied
// verbatim from that spec -- do not "tidy" one, the set reads as a set
// because the weights and terminals match.
//
// This replaces @react-native-vector-icons/material-design-icons at every
// call site. Material's icons are drawn on a different grid at a heavier
// weight, and mixing the two put a 2px-stroke filled glyph next to a 1.5px
// outline one in the same row.
//
// The handoff draws 15 icons; the app has a few actions it did not cover
// (income, transfer). Those reuse the nearest drawn glyph rather than
// importing a sixteenth from somewhere else, which is what would break the
// set. They are marked below.
//
// `currentColor` in the spec becomes an explicit `color` prop: react-native-svg
// has no inherited colour to pick up.

import type { ColorValue } from 'react-native';
import Svg, { Path, Circle } from 'react-native-svg';
import { theme } from '../constants/theme';

export type IconName =
  | 'accounts' | 'spend' | 'receipt' | 'settings'
  | 'show' | 'hide' | 'sync' | 'offline'
  | 'cleared' | 'uncleared' | 'add' | 'edit'
  | 'split' | 'scan' | 'conflict' | 'chevron' | 'chevronLeft';

export function Icon({
  name, size = 24, color = theme.ink, strokeWidth = 1.5,
}: {
  name: IconName;
  size?: number;
  color?: ColorValue;
  strokeWidth?: number;
}) {
  const stroke = {
    stroke: color,
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none' as const,
  };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {paths(name, color, stroke)}
    </Svg>
  );
}

function paths(name: IconName, color: ColorValue, s: object) {
  switch (name) {
    case 'accounts':
      return (
        <>
          <Path d="M4 6h16M4 12h16M4 18h10" {...s} />
          <Circle cx="19" cy="18" r="1" fill={color} />
        </>
      );
    case 'spend':
      return <Path d="M12 19V5M6 11l6-6 6 6M5 20h14" {...s} />;
    case 'receipt':
      return (
        <>
          <Path d="M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5L6 21z" {...s} />
          <Path d="M9 8h6M9 12h6" {...s} />
        </>
      );
    case 'settings':
      return (
        <>
          <Path d="M4 7h10M18 7h2M4 17h4M12 17h8" {...s} />
          <Circle cx="16" cy="7" r="2" {...s} />
          <Circle cx="10" cy="17" r="2" {...s} />
        </>
      );
    case 'show':
      return (
        <>
          <Path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z" {...s} />
          <Circle cx="12" cy="12" r="2.5" {...s} />
        </>
      );
    case 'hide':
      return (
        <Path
          d="M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M6.5 6.7C4.3 8.2 3 10.2 3 12c0 0 3.5 6 9 6 1.6 0 3-.4 4.3-1.1M9.9 5.4A10 10 0 0112 5c5.5 0 9 7 9 7-.6 1-1.5 2.3-2.7 3.4"
          {...s}
        />
      );
    case 'sync':
      return (
        <>
          <Path d="M20 12a8 8 0 01-14.2 5M4 12a8 8 0 0114.2-5" {...s} />
          <Path d="M4 21v-4h4M20 3v4h-4" {...s} />
        </>
      );
    case 'offline':
      return (
        <>
          <Path d="M7 18a4 4 0 01-.7-7.9A6 6 0 0117 8.5M20 14a4 4 0 01-3 4H9" {...s} />
          <Path d="M3 3l18 18" {...s} />
        </>
      );
    // The cleared dot is drawn at 24 like everything else and rendered small.
    // Its hit area is the row's business, not the glyph's -- see the 28px
    // wrapper in the register.
    case 'cleared':
      return (
        <>
          <Circle cx="12" cy="12" r="5" {...s} />
          <Circle cx="12" cy="12" r="1.5" fill={color} />
        </>
      );
    case 'uncleared':
      return <Circle cx="12" cy="12" r="5" {...s} />;
    case 'add':
      return <Path d="M12 5v14M5 12h14" {...s} />;
    case 'edit':
      return <Path d="M4 20l4-1L19 8l-3-3L5 16z" {...s} />;
    case 'split':
      return <Path d="M4 4h16v16H4zM4 9h16M9 9v11" {...s} />;
    case 'scan':
      return (
        <>
          <Path d="M4 8V5h3M20 8V5h-3M4 16v3h3M20 16v3h-3" {...s} />
          <Path d="M8 12h8" {...s} />
        </>
      );
    case 'conflict':
      return (
        <>
          <Path d="M12 3l9 9-9 9-9-9z" {...s} />
          <Path d="M12 8v5M12 16v.5" {...s} />
        </>
      );
    case 'chevron':
      return <Path d="M9 6l6 6-6 6" {...s} />;
    // Not in the handoff, which only draws the forward chevron. Mirrored
    // rather than redrawn, so the two always match.
    case 'chevronLeft':
      return <Path d="M15 6l-6 6 6 6" {...s} />;
  }
}
