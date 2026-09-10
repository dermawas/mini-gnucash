// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// The project's one modal pattern, in one place so it is applied by
// construction rather than by remembering.
//
// It is NOT React Native's <Modal>, and it does NOT use KeyboardAvoidingView.
// Both are deliberate and both were settled the hard way in this codebase's
// predecessor: five separate KeyboardAvoidingView configurations were tried
// against a transparent native Modal on Android and every one of them was
// broken on-device -- covered fields, screen jumping, or oscillation.
//
// What works instead: an absolutely-positioned overlay View, with the sheet
// inside a plain ScrollView carrying a large paddingBottom while the keyboard
// is up, which gives the ScrollView real overflow to drag the sheet clear of it.
//
// That buffer used to be unconditional, and the claim here was that it is
// "invisible when the keyboard is closed". It is not. contentContainerStyle has
// justifyContent 'flex-end', so a permanent paddingBottom does not sit under the
// sheet as slack -- it holds the sheet 300dp OFF the bottom, permanently. A
// short sheet merely floats. A tall one is pushed far enough up that its top
// crosses the status bar, which is what ScanSourceSheet did on the S10: three
// sources and a blurb made it ~390dp tall and "Scan a receipt" was drawn behind
// the clock. Seen 2026-09-10, the first build that ever put that sheet on the
// phone.
//
// So the buffer is now applied only while a keyboard is actually up. The window
// is `adjustResize` (see AndroidManifest), so it already shrinks under the
// keyboard on its own; the padding is drag room on top of that, not the
// mechanism. Keyboard.addListener is NOT KeyboardAvoidingView and is not what
// was found broken above.
//
// paddingTop is the other half, and it is the guard rather than the fix: the
// overlay is absolutely positioned and so escapes the screens' SafeAreaView, and
// the app draws edge-to-edge. Without an inset here any sheet tall enough to
// fill the screen slides under the status bar again.
//
// Two further rules learned on-device, both encoded here:
//   * no maxHeight on the sheet -- a plain View does not scroll its own
//     overflow, so a maxHeight silently clips the buttons off the bottom once
//     content grows.
//   * chip rows inside must be flexWrap grids, never horizontal ScrollViews.
//     A nested horizontal GestureScrollView rendered completely empty on some
//     devices and the root cause was never isolated.

import React, { useEffect, useRef, useState } from 'react';
import { View, ScrollView, Pressable, StyleSheet, Keyboard } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { theme } from '../constants/theme';

type Props = {
  visible: boolean;
  onDismiss: () => void;
  children: React.ReactNode;
};

export function OverlayModal({ visible, onDismiss, children }: Props) {
  // When the sheet was opened, so the backdrop can ignore the touch that
  // opened it.
  //
  // The sheet appears UNDER the finger that summoned it. The finger lifting,
  // or an impatient second tap while a long list was still rendering, landed
  // on the backdrop and dismissed it again -- which read as "the list flashes
  // up and closes, so tap slowly". A short deaf period costs nothing: nobody
  // opens a sheet in order to close it a fifth of a second later.
  const openedAt = useRef(0);
  useEffect(() => { if (visible) openedAt.current = Date.now(); }, [visible]);

  const insets = useSafeAreaInsets();

  // Only while a keyboard is actually up; see the header for why this is not
  // unconditional any more.
  const [keyboardUp, setKeyboardUp] = useState(false);
  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', () => setKeyboardUp(true));
    const hidden = Keyboard.addListener('keyboardDidHide', () => setKeyboardUp(false));
    return () => { shown.remove(); hidden.remove(); };
  }, []);

  if (!visible) return null;
  return (
    <View style={styles.overlay}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + 12, paddingBottom: keyboardUp ? 300 : 0 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Tapping the dimmed area dismisses; the sheet itself must not. */}
        <Pressable
          style={styles.backdrop}
          onPress={() => { if (Date.now() - openedAt.current > 350) onDismiss(); }}
        />
        <View style={styles.sheet}>{children}</View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: '#00000080',
    zIndex: 1000,
    elevation: 1000,
  },
  // paddingTop and paddingBottom are both applied inline, from the safe-area
  // inset and the keyboard state. Do not put a static paddingBottom back here.
  scroll: {
    flexGrow: 1,
    justifyContent: 'flex-end',
  },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  sheet: {
    backgroundColor: theme.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingBottom: 40,
  },
});
