// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// Where the thing being scanned comes from: the camera, the gallery, or a file.
//
// This was an `Alert.alert` with three buttons, and that is precisely why it is
// a sheet now. Android's AlertDialog has room for THREE buttons and no more --
// neutral, negative, positive -- so adding "Choose a file" beside "Photograph",
// "Choose photo" and "Cancel" would have silently dropped one of them on the
// only device this app runs on. React Native logs nothing; the button is just
// not there.
//
// It uses OverlayModal for the same reasons AccountSheet does, and the row
// styles are deliberately that file's: one sheet pattern, not two.
//
// The rows carry no icons. The drawn set in Icon.tsx has no glyph for a gallery
// or a file, and its header says what happens when a sixteenth is imported from
// elsewhere to fill a gap.

import { Text, Pressable, StyleSheet } from 'react-native';
import { OverlayModal } from './OverlayModal';
import { theme, fonts } from '../constants/theme';
import type { ScanSource } from '../services/scanReceipt';

const SOURCES: { source: ScanSource; label: string; note: string }[] = [
  {
    source: 'camera',
    label: 'Photograph',
    note: 'Point the camera at the paper.',
  },
  {
    source: 'library',
    label: 'Choose photo',
    note: 'A photo or screenshot already in the gallery.',
  },
  {
    source: 'document',
    label: 'Choose a file',
    note: 'A PDF invoice, or an image kept outside the gallery.',
  },
];

export function ScanSourceSheet({
  visible, onPick, onDismiss,
}: {
  visible: boolean;
  onPick: (source: ScanSource) => void;
  onDismiss: () => void;
}) {
  return (
    <OverlayModal visible={visible} onDismiss={onDismiss}>
      <Text style={styles.title}>Scan a receipt</Text>
      {/* Said here rather than discovered at the other end of a 14-second
          scan: one document becomes one entry. A card statement listing forty
          transactions has nowhere to go in this screen. */}
      <Text style={styles.blurb}>
        One receipt or invoice per scan. A statement listing many transactions
        belongs in GnuCash desktop.
      </Text>
      {SOURCES.map((s) => (
        <Pressable
          key={s.source}
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={() => onPick(s.source)}
        >
          <Text style={styles.rowLabel}>{s.label}</Text>
          <Text style={styles.rowNote}>{s.note}</Text>
        </Pressable>
      ))}
      <Pressable style={styles.cancel} onPress={onDismiss}>
        <Text style={styles.cancelText}>Cancel</Text>
      </Pressable>
    </OverlayModal>
  );
}

const styles = StyleSheet.create({
  title: { color: theme.ink, fontSize: 18, fontFamily: fonts.sansMedium },
  blurb: {
    color: theme.inkFaint, fontSize: 11, lineHeight: 16, marginTop: 6,
    fontFamily: fonts.sans,
  },
  row: {
    paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: theme.hairline,
  },
  rowPressed: { backgroundColor: theme.pressed },
  rowLabel: { color: theme.ink, fontSize: 14, fontFamily: fonts.sansMedium },
  rowNote: {
    color: theme.inkFaint, fontSize: 11, marginTop: 3, fontFamily: fonts.sans,
  },
  cancel: { marginTop: 14, alignItems: 'center', paddingVertical: 14 },
  cancelText: { color: theme.inkFaint, fontSize: 14, fontFamily: fonts.sansMedium },
});
