// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Flowform Lab

import React, { useRef, useState } from 'react';
import { TextInput, TextInputProps } from 'react-native';
import { formatAmountInput, cleanAmountInput } from '../utils/currency';

interface AmountInputProps extends Omit<TextInputProps, 'value' | 'onChangeText' | 'keyboardType'> {
  value: string; // raw numeric string (e.g. "1000000"), no separators — same shape callers already store
  onChangeText: (raw: string) => void;
  currency?: string;
}

// ---------------------------------------------------------------------------
// Why this manages the caret itself
// ---------------------------------------------------------------------------
// This is a controlled input that reformats on every keystroke, and reformatting
// MOVES THE SEPARATORS. An earlier version passed no `selection`, so after each
// change the caret went wherever the platform put it, which is not where the
// user was typing.
//
// Reported 2026-09-09: in "5.500", put the caret between the 55 and the 00,
// delete the 55 and type 110, and the field ends up 10.100 rather than 11.000.
// Each keystroke re-grouped the digits, the caret slid, and the next keystroke
// landed somewhere else. Anyone correcting an amount mid-number hit it, and the
// result is a wrong number in a field whose entire job is the right one.
//
// The fix is to stop tracking the caret as a character offset, because that is
// the thing reformatting destroys. What survives is HOW MANY DIGITS are to the
// left of it: "5.500" and "55000" disagree on every index but agree that the
// caret sits after the second digit. So each edit records a digit count and the
// caret is rebuilt from it against the newly formatted string.
//
// Reported again 2026-09-12, because the rebuilt caret was being thrown away:
// typing 1 1 6 5 1 8 gave 116.185. Android reports the text change first and
// the caret move second, and that second message carries the caret from BEFORE
// the digits were regrouped. `onSelectionChange` believed it and overwrote the
// position this component had just worked out, so every keystroke after a
// separator appeared landed one place too far left. The echo is now recognised
// and dropped -- see the note on onSelectionChange below.
// ---------------------------------------------------------------------------

/** Digits in `text`, ignoring separators and sign. */
function countDigits(text: string): number {
  let n = 0;
  for (const ch of text) if (ch >= '0' && ch <= '9') n++;
  return n;
}

/** The offset just after the `n`th digit of `text`. Clamps to both ends. */
function caretAfterDigits(text: string, n: number): number {
  if (n <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch >= '0' && ch <= '9') {
      seen++;
      if (seen === n) return i + 1;
    }
  }
  return text.length;
}

/**
 * Where the caret ended up, worked out from the text alone.
 *
 * Only a fallback, for the very first edit before any selection has been
 * reported. It cannot be exact: inserting a 0 into "1.100" produces "1.1000"
 * whichever 0 was typed, so the edit's position is genuinely ambiguous when
 * the characters repeat. The tracked caret in `onChangeText` has no such
 * problem and is used whenever it is available.
 */
function caretFromDiff(before: string, after: string): number {
  let head = 0;
  const shortest = Math.min(before.length, after.length);
  while (head < shortest && before[head] === after[head]) head++;

  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > head && endAfter > head && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  return endAfter;
}

/** Remove the `index`th digit (0-based) from a raw value, keeping sign and point. */
function dropDigitAt(raw: string, index: number): string {
  let seen = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch >= '0' && ch <= '9') {
      if (seen === index) return raw.slice(0, i) + raw.slice(i + 1);
      seen++;
    }
  }
  return raw;
}

// Wraps TextInput to live-format amounts with locale-correct thousand
// separators as the user types (e.g. "1.000.000" for IDR, "1,000,000" for
// USD), while the value handed to onChangeText/parseFloat stays a plain
// digit string — callers don't need to change how they store/parse amounts.
export default function AmountInput({ value, onChangeText, currency = 'IDR', ...rest }: AmountInputProps) {
  const formatted = formatAmountInput(value, currency);
  const [selection, setSelection] = useState<{ start: number; end: number } | undefined>(undefined);

  // What the field is showing right now, so the next change can be diffed
  // against it. Assigned every render, so an amount arriving from elsewhere --
  // a receipt scan filling the row -- is accounted for too.
  const shown = useRef(formatted);
  shown.current = formatted;

  // Where the platform left its own caret on the last edit, before the digits
  // were regrouped. Held so the caret message that follows an edit can be told
  // apart from the user tapping somewhere.
  const platformCaret = useRef<number | null>(null);

  return (
    <TextInput
      {...rest}
      keyboardType="numeric"
      value={formatted}
      selection={selection}
      // Follows the caret when the user moves it by tapping, so the next edit
      // is diffed against the right place.
      //
      // But every edit is also followed by one of these, and it reports the
      // platform's caret in the text as the platform built it -- "1.1615" --
      // not in the regrouped text the field is about to show -- "11.615".
      // Taking it would undo the whole point of this component, so the one
      // that matches the position the last edit left behind is dropped. A real
      // tap lands somewhere else and comes through.
      onSelectionChange={(e) => {
        const { start, end } = e.nativeEvent.selection;
        const echo = platformCaret.current;
        platformCaret.current = null;
        if (echo !== null && start === echo && end === echo) return;
        setSelection({ start, end });
      }}
      onChangeText={(text) => {
        // The caret BEFORE this edit, plus however many characters it added or
        // removed. Exact, because a numeric keypad only ever edits at the
        // caret. `selection` holds the pre-edit position: either the one set
        // after the previous change, or the one the user tapped to.
        //
        // Measured from the END of the selection, not the start. They are the
        // same for a plain caret. They differ when a stretch of digits was
        // selected and typed over -- select all of "1.165", press 9, and the
        // new caret is after the 9, not before it.
        const caret =
          selection != null
            ? Math.max(0, Math.min(selection.end + (text.length - shown.current.length), text.length))
            : caretFromDiff(shown.current, text);
        let next = cleanAmountInput(text, currency);
        let digitsLeft = countDigits(text.slice(0, caret));

        // Backspacing onto a group separator removes a character that carries
        // no value, so the number would not change and the key would look
        // dead. Take the digit in front of it, which is what was meant.
        if (next === value && text.length < shown.current.length && digitsLeft > 0) {
          next = dropDigitAt(next, digitsLeft - 1);
          digitsLeft--;
        }

        // Rebuilt against the string the field is ABOUT to show, so the caret
        // is already right when the new value arrives back as a prop.
        const pos = caretAfterDigits(formatAmountInput(next, currency), digitsLeft);
        platformCaret.current = caret;
        setSelection({ start: pos, end: pos });
        onChangeText(next);
      }}
    />
  );
}
